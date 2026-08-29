import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { extractPdfText } from './build-manifest.mjs';
import { createGichulRenderers } from '../render-sandbox.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const DEFAULT_SOURCE_DIRECTORY = path.join(ROOT, 'gichul-src');
const PDF_LIB_PATH = path.join(ROOT, 'assets', 'vendor', 'pdf-lib', 'pdf-lib.min.js');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function pageForm(text) {
  const value = compact(text);
  const odd = value.includes('홀수형');
  const even = value.includes('짝수형');
  if (odd && even) throw new Error('한 페이지에 홀수형과 짝수형이 함께 표기됐습니다.');
  return odd ? 'odd' : (even ? 'even' : null);
}

function hasPrintedQuestion(text, number) {
  return new RegExp(`(?:^|[^0-9])${number}\\s*(?:[.]|번)`, 'u')
    .test(String(text || '').normalize('NFKC'));
}

function descriptorFor(manifest, subject) {
  const descriptor = manifest.availability?.subjects?.find(({ id }) => id === subject);
  if (!descriptor || !Number.isSafeInteger(descriptor.selection_first_question)) {
    throw new Error(`${subject}: 독립 oracle에 필요한 선택 첫 문항 번호가 없습니다.`);
  }
  return descriptor;
}

function trackDefinitions(manifest, questions) {
  const descriptor = descriptorFor(manifest, questions[0].subject);
  const ids = new Set(questions.map(({ track }) => track));
  return descriptor.tracks
    .filter(({ id, section_header: header }) => ids.has(id) && header)
    .map(({ id: track, section_header: header }) => ({
      track,
      header,
      firstQuestion: descriptor.selection_first_question,
    }));
}

function hasPhysicalSectionHeader(layout, header) {
  if (!layout || !Number.isFinite(layout.height) || !Array.isArray(layout.items)) return false;
  const wanted = compact(header);
  return layout.items.some((item) => compact(item.text) === wanted
    && item.y / layout.height >= 0.8 && item.y / layout.height <= 0.87);
}

function questionOracle(manifest, questions, extracted) {
  const rawForms = extracted.pageTexts.map(pageForm);
  let forms;
  let canonicalForm;
  if (rawForms.every((form) => form === null)) {
    forms = rawForms.map(() => 'single');
    canonicalForm = 'single';
  } else {
    if (rawForms.some((form) => form === null)) {
      throw new Error(`${questions[0].r2_key}: 일부 문제지 페이지의 형 표기를 판독하지 못했습니다.`);
    }
    forms = rawForms;
    canonicalForm = forms.includes('odd') ? 'odd' : 'even';
  }
  const canonicalPages = forms.flatMap((form, index) => (
    form === canonicalForm ? [index + 1] : []
  ));
  if (!canonicalPages.length || canonicalPages.some((page, index) => (
    index > 0 && page !== canonicalPages[index - 1] + 1
  ))) {
    throw new Error(`${questions[0].r2_key}: 정본 형 페이지가 연속 블록이 아닙니다.`);
  }

  const definitions = trackDefinitions(manifest, questions);
  const starts = new Map();
  for (const definition of definitions) {
    const pages = canonicalPages.filter((page) => {
      const text = extracted.pageTexts[page - 1];
      return hasPhysicalSectionHeader(extracted.pageLayouts?.[page - 1], definition.header)
        && hasPrintedQuestion(text, definition.firstQuestion);
    });
    if (pages.length !== 1) {
      throw new Error(`${questions[0].r2_key}: ${definition.track} 첫 문항 페이지가 ${pages.length}개입니다.`);
    }
    starts.set(definition.track, pages[0]);
  }
  const ordered = definitions.map(({ track }) => starts.get(track));
  if (ordered.some((start, index) => index > 0 && start <= ordered[index - 1])) {
    throw new Error(`${questions[0].r2_key}: 선택과목 의미 순서가 잘못됐습니다.`);
  }
  const common = Array.from(
    { length: ordered[0] - canonicalPages[0] },
    (_, index) => canonicalPages[0] + index,
  );
  const selections = new Map(definitions.map(({ track }, index) => {
    const from = ordered[index];
    const to = index + 1 < ordered.length ? ordered[index + 1] - 1 : canonicalPages.at(-1);
    return [track, Array.from({ length: to - from + 1 }, (_, offset) => from + offset)];
  }));
  return { forms, canonicalForm, canonicalPages, common, selections, definitions };
}

function powerset(values) {
  return Array.from({ length: 2 ** values.length - 1 }, (_, maskIndex) => {
    const mask = maskIndex + 1;
    return values.filter((_, index) => mask & (1 << index));
  });
}

function expandQuestionPages(segments, key) {
  return segments.filter((segment) => segment.key === key).flatMap(({ ranges = [] }) => (
    ranges.flatMap(([from, to]) => (
      Array.from({ length: to - from + 1 }, (_, index) => from + index)
    ))
  ));
}

function multisetMissing(expected, actual) {
  const remaining = new Map();
  actual.forEach((value) => remaining.set(value, (remaining.get(value) || 0) + 1));
  let missing = 0;
  for (const value of expected) {
    const count = remaining.get(value) || 0;
    if (count) remaining.set(value, count - 1);
    else missing += 1;
  }
  return missing;
}

function questionCounts(mode, actual, selectedTracks, oracle) {
  const expectedSelection = selectedTracks.flatMap((track) => oracle.selections.get(track));
  const expected = mode === 'full' ? [...oracle.common, ...expectedSelection] : expectedSelection;
  const expectedSet = new Set(expected);
  const commonSet = new Set(oracle.common);
  const actualCommon = actual.filter((page) => commonSet.has(page));
  const commonDuplicate = mode === 'full'
    ? Math.max(0, actualCommon.length - oracle.common.length) : actualCommon.length;
  return {
    noncanonical_form_page_count: actual.filter((page) => (
      oracle.forms[page - 1] !== oracle.canonicalForm
    )).length,
    foreign_page_count: actual.filter((page) => !expectedSet.has(page)).length,
    common_page_count: mode === 'excerpt' ? actualCommon.length : 0,
    common_duplicate_count: mode === 'full' ? commonDuplicate : 0,
    missing_page_count: multisetMissing(expected, actual),
    sequence_mismatch_count: JSON.stringify(actual) === JSON.stringify(expected) ? 0 : 1,
  };
}

function explicitAnswerForms(pageTexts) {
  return pageTexts.map((text) => pageForm(text) || 'single');
}

function answerFormOrders(extractions) {
  const orders = new Map();
  for (const { key, extracted } of extractions) {
    const forms = explicitAnswerForms(extracted.pageTexts);
    if (forms.every((form) => form === 'single')) continue;
    if (forms.includes('single')) throw new Error(`${key}: 답안 형 표기가 일부 페이지만 존재합니다.`);
    if (!forms.includes('odd') || !forms.includes('even')) continue;
    const previous = orders.get(forms.length);
    if (previous && previous.some((form, index) => form !== forms[index])) {
      throw new Error(`${key}: 답안 형 페이지 순서가 원본끼리 다릅니다.`);
    }
    orders.set(forms.length, forms);
  }
  return orders;
}

function canonicalAnswerPages(extracted, canonicalForm, formOrders, key) {
  let forms = explicitAnswerForms(extracted.pageTexts);
  if (canonicalForm === 'single') return forms.map((_, index) => index + 1);
  if (forms.every((form) => form === 'single')) {
    forms = formOrders.get(forms.length);
    if (!forms) throw new Error(`${key}: 이미지형 답안의 형 페이지 순서를 판독하지 못했습니다.`);
  }
  const pages = forms.flatMap((form, index) => form === canonicalForm ? [index + 1] : []);
  if (!pages.length) throw new Error(`${key}: ${canonicalForm} 답안 페이지가 없습니다.`);
  return pages;
}

function joinedHeaderBox(items, header) {
  const wanted = compact(header);
  const direct = items.find(({ text }) => compact(text) === wanted);
  if (direct) return {
    x: direct.x,
    y: direct.y,
    width: direct.width,
    height: direct.height,
    center: direct.x + direct.width / 2,
  };
  const ordered = items.filter(({ text }) => compact(text)).sort((left, right) => left.x - right.x);
  for (let start = 0; start < ordered.length; start += 1) {
    let value = '';
    let minY = ordered[start].y;
    let maxY = ordered[start].y;
    for (let end = start; end < Math.min(ordered.length, start + 5); end += 1) {
      minY = Math.min(minY, ordered[end].y);
      maxY = Math.max(maxY, ordered[end].y);
      if (maxY - minY > 4) break;
      value += compact(ordered[end].text);
      if (value === wanted) {
        const parts = ordered.slice(start, end + 1);
        const left = Math.min(...parts.map(({ x }) => x));
        const right = ordered[end].x + ordered[end].width;
        const bottom = Math.min(...parts.map(({ y }) => y));
        const top = Math.max(...parts.map(({ y, height = 0 }) => y + height));
        return {
          x: left,
          y: bottom,
          width: right - left,
          height: top - bottom,
          center: (left + right) / 2,
        };
      }
      if (!wanted.startsWith(value)) break;
    }
  }
  return null;
}

function answerLastQuestion(firstQuestion) {
  if (firstQuestion === 35) return 45;
  if (firstQuestion === 23) return 30;
  throw new Error(`답안 oracle이 지원하지 않는 선택 첫 문항입니다: ${firstQuestion}`);
}

function normalizedBox(box, layout) {
  return {
    x: [box.x / layout.width, (box.x + box.width) / layout.width],
    y: [box.y / layout.height, (box.y + box.height) / layout.height],
  };
}

function boxInsideClip(box, clip, layout, tolerance = 0.002) {
  const normalized = normalizedBox(box, layout);
  return normalized.x[0] >= clip.x[0] - tolerance
    && normalized.x[1] <= clip.x[1] + tolerance
    && normalized.y[0] >= clip.y[0] - tolerance
    && normalized.y[1] <= clip.y[1] + tolerance;
}

function printedQuestionBox(items, number, headerBox) {
  const wanted = String(number);
  const candidates = items.filter((item) => compact(item.text) === wanted
    && item.y < headerBox.y
    && item.x + item.width / 2 <= headerBox.center + 2);
  candidates.sort((left, right) => (
    Math.abs((left.x + left.width / 2) - headerBox.center)
      - Math.abs((right.x + right.width / 2) - headerBox.center)
  ));
  return candidates[0] || null;
}

function printedCommonQuestionBox(items, number, commonHeader, selectionHeaders, descending) {
  const ordered = [...selectionHeaders].sort((left, right) => left.center - right.center);
  const selectionLeft = ordered[0].center - (ordered[1].center - ordered[0].center) / 2;
  const candidates = items.filter((item) => compact(item.text) === String(number)
    && item.y < commonHeader.y
    && item.x + item.width / 2 < selectionLeft);
  candidates.sort((left, right) => descending ? right.y - left.y : left.y - right.y);
  return candidates[0] || null;
}

function pointInsideClip(point, clip, tolerance = 0.002) {
  return point.x >= clip.x[0] - tolerance && point.x <= clip.x[1] + tolerance
    && point.y >= clip.y[0] - tolerance && point.y <= clip.y[1] + tolerance;
}

function textualAnswerSemantics(layout, definitions, clip) {
  const headers = definitions.map((definition) => ({
    ...definition,
    headerBox: joinedHeaderBox(layout.items, definition.header),
  }));
  if (headers.some(({ headerBox }) => !headerBox)) {
    throw new Error('답안 의미 oracle이 선택과목 헤더 일부를 찾지 못했습니다.');
  }
  const landmarks = headers.map((definition) => {
    const header = definition.headerBox;
    const first = printedQuestionBox(layout.items, definition.firstQuestion, header);
    const last = printedQuestionBox(layout.items, answerLastQuestion(definition.firstQuestion), header);
    if (!first || !last) {
      throw new Error(`답안 의미 oracle이 ${definition.track} 첫/마지막 문항 행을 찾지 못했습니다.`);
    }
    const inside = [header, first, last].map((box) => boxInsideClip(box, clip, layout));
    return {
      track: definition.track,
      complete: inside.every(Boolean),
      partial: inside.some(Boolean) && !inside.every(Boolean),
    };
  });
  const commonHeader = joinedHeaderBox(layout.items, '공통 과목');
  if (!commonHeader) throw new Error('답안 의미 oracle이 공통 과목 헤더를 찾지 못했습니다.');
  const firstCommon = printedCommonQuestionBox(layout.items, 1, commonHeader,
    headers.map(({ headerBox }) => headerBox), true);
  const lastCommon = printedCommonQuestionBox(layout.items,
    definitions[0].firstQuestion - 1, commonHeader, headers.map(({ headerBox }) => headerBox), false);
  if (!firstCommon || !lastCommon) {
    throw new Error('답안 의미 oracle이 공통 첫/마지막 문항 행을 찾지 못했습니다.');
  }
  const commonInside = [commonHeader, firstCommon, lastCommon]
    .map((box) => boxInsideClip(box, clip, layout));
  return {
    parts: [
      ...(commonInside.every(Boolean) ? ['common'] : []),
      ...landmarks.filter(({ complete }) => complete).map(({ track }) => track),
    ],
    partial_part_count: landmarks.filter(({ partial }) => partial).length
      + (commonInside.some(Boolean) && !commonInside.every(Boolean) ? 1 : 0),
  };
}

function rasterAnswerSemantics(raster, definitions, clip) {
  if (!raster || raster.error || !Array.isArray(raster.selection_lines)) {
    throw new Error(`이미지형 답안 의미 oracle 판독 실패: ${raster?.error || 'raster 없음'}`);
  }
  const lines = [...raster.selection_lines].sort((left, right) => left.x - right.x);
  if (lines.length !== definitions.length + 1
    || !Array.isArray(raster.common_lines) || raster.common_lines.length !== 2
    || !Number.isFinite(raster.top)
    || [...lines, ...raster.common_lines]
      .some(({ x, end }) => !Number.isFinite(x) || !Number.isFinite(end))) {
    throw new Error('이미지형 답안 의미 oracle의 표 경계 수가 선택과목 수와 다릅니다.');
  }
  const landmarks = definitions.map(({ track }, index) => {
    const left = lines[index];
    const right = lines[index + 1];
    const x = (left.x + right.x) / 2;
    const top = 1 - raster.top - 0.006;
    const bottom = 1 - Math.min(left.end, right.end) + 0.006;
    const inside = [
      pointInsideClip({ x, y: top }, clip),
      pointInsideClip({ x, y: bottom }, clip),
    ];
    return {
      track,
      complete: inside.every(Boolean),
      partial: inside.some(Boolean) && !inside.every(Boolean),
    };
  });
  const commonLines = [...raster.common_lines].sort((left, right) => left.x - right.x);
  const commonX = (commonLines[0].x + commonLines[1].x) / 2;
  const commonInside = [
    pointInsideClip({ x: commonX, y: 1 - raster.top - 0.006 }, clip),
    pointInsideClip({ x: commonX, y: 1 - Math.min(...commonLines.map(({ end }) => end)) + 0.006 }, clip),
  ];
  return {
    parts: [
      ...(commonInside.every(Boolean) ? ['common'] : []),
      ...landmarks.filter(({ complete }) => complete).map(({ track }) => track),
    ],
    partial_part_count: landmarks.filter(({ partial }) => partial).length
      + (commonInside.some(Boolean) && !commonInside.every(Boolean) ? 1 : 0),
  };
}

export function inspectAnswerClip({ clip, layout, raster, definitions }) {
  if (!clip || !Array.isArray(clip.x) || !Array.isArray(clip.y)
    || clip.x.length !== 2 || clip.y.length !== 2
    || !(clip.x[0] < clip.x[1]) || !(clip.y[0] < clip.y[1])) {
    throw new Error('답안 crop 좌표가 잘못되었습니다.');
  }
  if (layout?.items?.some(({ text }) => compact(text))) {
    return textualAnswerSemantics(layout, definitions, clip);
  }
  return rasterAnswerSemantics(raster, definitions, clip);
}

function answerPartsFromQuestionPages(questionPages, oracle) {
  const pages = new Set(questionPages);
  return [
    ...(oracle.common.every((page) => pages.has(page)) ? ['common'] : []),
    ...oracle.definitions.filter(({ track }) => (
      oracle.selections.get(track).every((page) => pages.has(page))
    )).map(({ track }) => track),
  ];
}

function sameRegion(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function answerCounts({
  segments, answerKey, expectedParts, extracted, oracle, formOrders, mutation, mode,
  answerPageCount, commonRegions = [], foreignRegions = [],
}) {
  const matches = segments.filter(({ key }) => key === answerKey);
  if (matches.length !== 1) {
    return {
      noncanonical_form_page_count: 0,
      missing_common_count: expectedParts.includes('common') ? 1 : 0,
      foreign_common_count: 0,
      foreign_track_entry_count: 0,
      dual_form_count: 0,
      missing_track_count: expectedParts.filter((part) => part !== 'common').length,
      duplicate_entry_count: 0,
      partial_entry_count: 0,
      segment_count_error: Math.abs(matches.length - 1),
    };
  }
  const segment = structuredClone(matches[0]);
  if (mutation === 'full-answer') {
    segment.ranges = [[1, answerPageCount]];
    delete segment.clips;
  } else if (mutation === 'answer-remove-common' && mode === 'full') {
    segment.clips = (segment.clips || []).filter((clip) => (
      !commonRegions.some((region) => sameRegion(clip, region))
    ));
  } else if (mutation === 'answer-empty') {
    segment.ranges = [];
    segment.clips = [];
  } else if (mutation === 'answer-partial') {
    segment.ranges = [];
    segment.clips = (segment.clips || []).slice(0, 1);
  } else if (mutation === 'answer-add-common' && mode === 'excerpt' && commonRegions[0]) {
    segment.clips = [...(segment.clips || []), commonRegions[0]];
  } else if (mutation === 'answer-add-foreign' && foreignRegions[0]) {
    segment.clips = [...(segment.clips || []), foreignRegions[0]];
  }
  const canonicalPages = canonicalAnswerPages(extracted, oracle.canonicalForm, formOrders, answerKey);
  const explicitForms = explicitAnswerForms(extracted.pageTexts);
  const forms = explicitForms.every((form) => form === 'single') && oracle.canonicalForm !== 'single'
    ? formOrders.get(explicitForms.length) : explicitForms;
  if (mutation === 'answer-dual-form') {
    const otherPage = forms?.findIndex((form) => form !== oracle.canonicalForm);
    const sourceRegion = segment.clips?.[0];
    if (otherPage >= 0 && sourceRegion) {
      segment.clips.push({ ...sourceRegion, page: otherPage + 1 });
    }
  }
  const wholePages = (segment.ranges || []).flatMap(([from, to]) => (
    Array.from({ length: to - from + 1 }, (_, index) => from + index)
  ));
  const regions = [
    ...wholePages.map((page) => ({ page, x: [0, 1], y: [0, 1] })),
    ...(segment.clips || []),
  ];
  const found = new Map();
  let noncanonical = 0;
  let partial = 0;
  let segmentErrors = 0;
  const clippedForms = new Set();
  for (const clip of regions) {
    if (!canonicalPages.includes(clip.page)) noncanonical += 1;
    clippedForms.add(forms?.[clip.page - 1] || 'single');
    const layout = extracted.pageLayouts?.[clip.page - 1];
    if (!layout) {
      segmentErrors += 1;
      continue;
    }
    const inspected = inspectAnswerClip({
      clip,
      layout,
      raster: extracted.pageRasterLayouts?.[clip.page - 1],
      definitions: oracle.definitions,
    });
    partial += inspected.partial_part_count;
    for (const part of inspected.parts) {
      found.set(part, (found.get(part) || 0) + 1);
    }
  }
  const expected = new Set(expectedParts);
  const foreignCommon = expected.has('common') ? 0 : (found.get('common') || 0);
  const foreignTracks = [...found].filter(([part]) => part !== 'common' && !expected.has(part))
    .reduce((sum, [, count]) => sum + count, 0);
  return {
    noncanonical_form_page_count: noncanonical,
    missing_common_count: expected.has('common') && !found.has('common') ? 1 : 0,
    foreign_common_count: foreignCommon,
    foreign_track_entry_count: foreignTracks,
    dual_form_count: clippedForms.size > 1 ? 1 : 0,
    missing_track_count: expectedParts.filter((part) => part !== 'common' && !found.has(part)).length,
    duplicate_entry_count: [...found.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    partial_entry_count: partial,
    segment_count_error: segmentErrors,
  };
}

function numericTotal(value) {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((sum, child) => sum + numericTotal(child), 0);
}

function anomalyTotal(result) {
  return numericTotal(result.full) + numericTotal(result.excerpt);
}

function mutateManifest(manifest, mutation) {
  const result = structuredClone(manifest);
  if (mutation === 'b1-start-plus-one') {
    for (const exam of result.exams.filter(({ id }) => /^2025-(?:06|09)-math-.+-question$/u.test(id))) {
      exam.sections.common[1] += 1;
      exam.sections.selection[0] += 1;
      if (exam.track !== 'giha') exam.sections.selection[1] += 1;
    }
  } else if (mutation === 'combined-form-as-single') {
    const combinedKeys = new Set(result.exams.filter(({ kind, source_forms: forms, sections }) => (
      kind === 'question' && Array.isArray(forms) && forms.length > 1 && sections?.selection
    )).map(({ r2_key: key }) => key));
    for (const exam of result.exams) {
      if (combinedKeys.has(exam.r2_key)) {
        exam.canonical_form = 'single';
        exam.canonical_pages = [1, exam.pages];
        exam.source_forms = ['single'];
      }
    }
    for (const key of combinedKeys) {
      const questions = result.exams.filter(({ kind, r2_key: r2Key, sections }) => (
        kind === 'question' && r2Key === key && sections?.selection
      ));
      if (!questions.length) continue;
      questions.sort((left, right) => left.sections.selection[0] - right.sections.selection[0]);
      questions.at(-1).sections.selection[1] = questions.at(-1).pages;
      const sample = questions[0];
      for (const answer of result.exams.filter((exam) => exam.kind === 'answer'
        && exam.year === sample.year && exam.round === sample.round && exam.subject === sample.subject)) {
        answer.canonical_form = 'single';
      }
    }
  } else if (mutation === 'answer-crop-empty') {
    for (const exam of result.exams.filter(({ kind }) => kind === 'answer')) {
      for (const field of ['answer_common', 'answer_selection']) {
        if (Array.isArray(exam[field])) {
          exam[field] = exam[field].map((clip) => ({ ...clip, y: [0, 0.01] }));
        }
      }
    }
  } else if (mutation && !new Set([
    'full-answer',
    'answer-remove-common',
    'answer-empty',
    'answer-partial',
    'answer-add-common',
    'answer-add-foreign',
    'answer-dual-form',
  ]).has(mutation)) {
    throw new Error(`알 수 없는 mutation: ${mutation}`);
  }
  return result;
}

async function loadPdfLib() {
  vm.runInThisContext(await readFile(PDF_LIB_PATH, 'utf8'), { filename: PDF_LIB_PATH });
  return globalThis.PDFLib;
}

async function mergeSegments(PDFDocument, sourceDirectory, segments) {
  const output = await PDFDocument.create();
  const loaded = new Map();
  for (const segment of segments) {
    if (!loaded.has(segment.key)) {
      const bytes = await readFile(path.join(sourceDirectory, segment.key));
      loaded.set(segment.key, await PDFDocument.load(bytes, { ignoreEncryption: true }));
    }
    const source = loaded.get(segment.key);
    for (const [from, to] of segment.ranges || []) {
      const indices = Array.from({ length: to - from + 1 }, (_, index) => from + index - 1);
      for (const page of await output.copyPages(source, indices)) output.addPage(page);
    }
    for (const clip of segment.clips || []) {
      const [page] = await output.copyPages(source, [clip.page - 1]);
      const { width, height } = page.getSize();
      page.setCropBox(width * clip.x[0], height * clip.y[0],
        width * (clip.x[1] - clip.x[0]), height * (clip.y[1] - clip.y[0]));
      output.addPage(page);
    }
  }
  return Buffer.from(await output.save({ useObjectStreams: false }));
}

async function inspectMergedCropBoxes(PDFDocument, bytes, segments) {
  const output = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = output.getPages();
  const crops = [];
  let pageIndex = 0;
  for (const segment of segments) {
    for (const [from, to] of segment.ranges || []) pageIndex += to - from + 1;
    for (const clip of segment.clips || []) {
      const page = pages[pageIndex];
      assert.ok(page, `${segment.key}: 병합 답안 crop 페이지가 없습니다.`);
      const { width, height } = page.getSize();
      const actual = page.getCropBox();
      const normalized = {
        x: [actual.x / width, (actual.x + actual.width) / width],
        y: [actual.y / height, (actual.y + actual.height) / height],
      };
      for (const axis of ['x', 'y']) {
        assert.ok(Math.abs(normalized[axis][0] - clip[axis][0]) <= 0.00001
          && Math.abs(normalized[axis][1] - clip[axis][1]) <= 0.00001,
        `${segment.key}: 실제 병합 PDF의 ${axis} CropBox가 계획과 다릅니다.`);
      }
      crops.push({ page: pageIndex + 1, source_page: clip.page, x: normalized.x, y: normalized.y });
      pageIndex += 1;
    }
  }
  assert.equal(pageIndex, pages.length, '병합 PDF 페이지 수와 계획한 range/crop 수가 다릅니다.');
  return crops;
}

async function writeRepresentativeOutputs({ manifest, groups, planner, sourceDirectory, outDirectory }) {
  const representatives = [
    { key: '2022-csat-korean-question.pdf', track: 'hwajak', mode: 'full' },
    { key: '2025-06-math-question.pdf', track: 'hwaktong', mode: 'full' },
    { key: '2024-csat-korean-question.pdf', track: 'hwajak', mode: 'excerpt' },
    { key: '2024-csat-math-question.pdf', track: 'hwaktong', mode: 'excerpt' },
  ];
  const { PDFDocument } = await loadPdfLib();
  const files = [];
  for (const representative of representatives) {
    const questions = groups.get(representative.key);
    const selected = questions?.filter(({ track }) => track === representative.track);
    if (!selected?.length) continue;
    const plan = planner.planSegments(selected, manifest, {
      ...planner.defaultState(), mode: representative.mode, includeAnswers: true,
    });
    const bytes = await mergeSegments(PDFDocument, sourceDirectory, plan.segments);
    const answerCrops = await inspectMergedCropBoxes(PDFDocument, bytes, plan.segments);
    assert.ok(answerCrops.length > 0, `${representative.key}: 실제 병합 답안 crop이 없습니다.`);
    const file = path.join(outDirectory,
      `${representative.key.replace(/-question[.]pdf$/u, '')}-${representative.track}-${representative.mode}.pdf`);
    await writeFile(file, bytes);
    files.push({ file: path.basename(file), sha256: sha256(bytes), answer_crops: answerCrops });
  }
  return files;
}

function validateAllAnswerPlans(manifest, planner) {
  const byId = new Map(manifest.exams.map((exam) => [exam.id, exam]));
  const groups = new Map();
  for (const question of manifest.exams.filter(({ kind }) => kind === 'question')) {
    const list = groups.get(question.r2_key) || [];
    list.push(question);
    groups.set(question.r2_key, list);
  }
  let answerSegments = 0;
  for (const [questionKey, questions] of groups) {
    const answers = questions.map((question) => byId.get(
      question.id.replace(/-question$/u, '-answer'),
    ));
    assert.ok(answers.every(Boolean), `${questionKey}: 대응 답안이 없습니다.`);
    const plan = planner.planSegments(questions, manifest, {
      ...planner.defaultState(), mode: 'full', includeAnswers: true,
    });
    assert.equal(JSON.stringify(plan.missingAnswers), '[]', `${questionKey}: 답안 계획이 누락됐습니다.`);
    const expectedKeys = new Set(answers.map(({ r2_key: key }) => key));
    const planned = plan.segments.filter(({ key }) => expectedKeys.has(key));
    assert.equal(new Set(planned.map(({ key }) => key)).size, expectedKeys.size,
      `${questionKey}: 답안 PDF 계획 수가 맞지 않습니다.`);
    for (const segment of planned) {
      const matchingAnswers = answers.filter(({ r2_key: key }) => key === segment.key);
      const selectionAnswer = matchingAnswers.some(({ answer_selection: regions }) => Array.isArray(regions));
      if (selectionAnswer) {
        const expected = [
          ...matchingAnswers.flatMap(({ answer_common: regions = [] }) => regions),
          ...matchingAnswers.flatMap(({ answer_selection: regions = [] }) => regions),
        ]
          .map((region) => JSON.stringify(region));
        const actual = Array.from(segment.clips || [], (region) => JSON.stringify(region));
        assert.deepEqual(actual, [...new Set(expected)], `${questionKey}: 선택 답안 crop이 맞지 않습니다.`);
        assert.equal((segment.ranges || []).length, 0, `${questionKey}: 선택 답안에 전체 페이지가 섞였습니다.`);
      } else {
        const expected = matchingAnswers.flatMap(({ answer_pages: pages = [] }) => pages)
          .map((page) => JSON.stringify([page, page]));
        const actual = Array.from(segment.ranges || [], (range) => JSON.stringify(range));
        assert.deepEqual(actual, [...new Set(expected)], `${questionKey}: 정본 답안 페이지가 맞지 않습니다.`);
        assert.equal((segment.clips || []).length, 0, `${questionKey}: 비선택형 답안에 crop이 생겼습니다.`);
      }
      answerSegments += 1;
    }
  }
  return { question_pdf_plans: groups.size, answer_segments: answerSegments, errors: 0 };
}

export async function runFullCorpusContract({
  sourceDirectory = DEFAULT_SOURCE_DIRECTORY,
  manifestPath = path.join(sourceDirectory, 'manifest.json'),
  outDirectory,
  mutation = null,
  includeAnswers = false,
} = {}) {
  if (!outDirectory) throw new Error('--out이 필요합니다.');
  if (!includeAnswers) throw new Error('--include-answers가 필요합니다.');
  const manifestBytes = await readFile(manifestPath);
  const baseManifest = JSON.parse(manifestBytes.toString('utf8'));
  const manifest = mutateManifest(baseManifest, mutation);
  const questions = manifest.exams.filter(({ kind, grade_year: year, subject, sections }) => (
    kind === 'question' && year >= 2022 && ['korean', 'math'].includes(subject) && sections?.selection
  ));
  const groups = new Map();
  for (const question of questions) {
    const list = groups.get(question.r2_key) || [];
    list.push(question);
    groups.set(question.r2_key, list);
  }
  for (const list of groups.values()) {
    const order = trackDefinitions(manifest, list).map(({ track }) => track);
    list.sort((left, right) => order.indexOf(left.track) - order.indexOf(right.track));
  }
  const combinationCount = [...groups.values()]
    .reduce((sum, list) => sum + 2 ** list.length - 1, 0);
  assert.equal(groups.size, 32, '공유 문제 PDF 자동 도출 수가 32가 아닙니다.');
  assert.equal(combinationCount, 160, '선택과목 부분집합 자동 도출 수가 160이 아닙니다.');

  const questionExtractions = new Map();
  const answerExtractions = new Map();
  const answerKeys = new Set(questions.map((question) => (
    manifest.exams.find(({ id }) => id === question.id.replace(/-question$/u, '-answer'))?.r2_key
  )).filter(Boolean));
  for (const [key] of groups) {
    questionExtractions.set(key, await extractPdfText(path.join(sourceDirectory, key)));
  }
  for (const key of answerKeys) {
    answerExtractions.set(key, await extractPdfText(path.join(sourceDirectory, key)));
  }
  const formOrders = answerFormOrders([...answerExtractions].map(([key, extracted]) => ({ key, extracted })));
  const planner = createGichulRenderers();
  const allAnswerPlans = validateAllAnswerPlans(manifest, planner);
  const answerById = new Map(manifest.exams.filter(({ kind }) => kind === 'answer')
    .map((exam) => [exam.id, exam]));
  const results = [];
  let anomalous = 0;

  for (const [key, group] of groups) {
    const oracle = questionOracle(manifest, group, questionExtractions.get(key));
    for (const selected of powerset(group)) {
      const tracks = selected.map(({ track }) => track);
      const fullPlan = planner.planSegments(selected, manifest, {
        ...planner.defaultState(), mode: 'full', includeAnswers: true,
      });
      const excerptPlan = planner.planSegments(selected, manifest, {
        ...planner.defaultState(), mode: 'excerpt', includeAnswers: true,
      });
      const fullQuestionPages = expandQuestionPages(fullPlan.segments, key);
      const excerptQuestionPages = expandQuestionPages(excerptPlan.segments, key);
      const fullQuestion = questionCounts('full', fullQuestionPages, tracks, oracle);
      const excerptQuestion = questionCounts('excerpt', excerptQuestionPages, tracks, oracle);
      const answerEntries = new Map(selected.map((question) => {
        const answer = answerById.get(question.id.replace(/-question$/u, '-answer'));
        return [question.track, answer];
      }));
      const firstAnswer = answerEntries.values().next().value;
      const answerKey = firstAnswer?.r2_key;
      const commonRegions = firstAnswer?.answer_common || [];
      const foreignAnswer = group.filter((question) => !tracks.includes(question.track))
        .map((question) => answerById.get(question.id.replace(/-question$/u, '-answer')))
        .find((answer) => answer?.r2_key === answerKey);
      const sharedAnswerInput = {
        answerKey,
        extracted: answerExtractions.get(answerKey),
        oracle,
        formOrders,
        mutation,
        answerPageCount: firstAnswer?.pages,
        commonRegions,
        foreignRegions: foreignAnswer?.answer_selection || [],
      };
      const fullAnswer = answerCounts({
        ...sharedAnswerInput,
        segments: fullPlan.segments,
        expectedParts: answerPartsFromQuestionPages(fullQuestionPages, oracle),
        mode: 'full',
      });
      const excerptAnswer = answerCounts({
        ...sharedAnswerInput,
        segments: excerptPlan.segments,
        expectedParts: answerPartsFromQuestionPages(excerptQuestionPages, oracle),
        mode: 'excerpt',
      });
      const result = {
        key,
        subject: group[0].subject,
        grade_year: group[0].grade_year,
        round: group[0].round,
        tracks,
        full: { question: fullQuestion, answer: fullAnswer },
        excerpt: { question: excerptQuestion, answer: excerptAnswer },
      };
      if (anomalyTotal(result) !== 0) anomalous += 1;
      results.push(result);
    }
  }
  if (results.length !== 160) throw new Error(`전수 조합 수가 ${results.length}입니다.`);

  await mkdir(outDirectory, { recursive: true });
  const representativeFiles = mutation || anomalous ? [] : await writeRepresentativeOutputs({
    manifest, groups, planner, sourceDirectory, outDirectory,
  });
  const evidence = {
    schema: 'gichul-full-corpus-output-contract',
    version: 2,
    generated_at: new Date().toISOString(),
    source_manifest_sha256: sha256(manifestBytes),
    shared_question_pdfs: groups.size,
    subset_combinations: results.length,
    anomalous_combinations: anomalous,
    all_answer_plans: allAnswerPlans,
    mutation,
    results,
    representative_files: representativeFiles,
  };
  await writeFile(path.join(outDirectory, 'output-contract.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  if (anomalous !== 0) {
    const first = results.find((result) => anomalyTotal(result) !== 0);
    throw new Error(`${mutation || 'normal'}: 이상 조합 ${anomalous}/160; 첫 오류 ${JSON.stringify(first)}`);
  }
  return evidence;
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--all') options.all = true;
    else if (name === '--include-answers') options.includeAnswers = true;
    else {
      const value = argv[++index];
      if (!value) throw new Error(`${name}에 값이 필요합니다.`);
      if (name === '--source') options.sourceDirectory = path.resolve(value);
      else if (name === '--manifest') options.manifestPath = path.resolve(value);
      else if (name === '--out') options.outDirectory = path.resolve(value);
      else if (name === '--mutation') options.mutation = value;
      else throw new Error(`알 수 없는 인자: ${name}`);
    }
  }
  if (!options.all) throw new Error('--all이 필요합니다.');
  delete options.all;
  return options;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runFullCorpusContract(cliOptions(process.argv.slice(2))).then((evidence) => {
    console.log(`shared=${evidence.shared_question_pdfs} combinations=${evidence.subset_combinations}`
      + ` anomalies=${evidence.anomalous_combinations}`);
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
