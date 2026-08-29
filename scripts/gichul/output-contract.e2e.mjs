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
  if (direct) return { center: direct.x + direct.width / 2 };
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
        const right = ordered[end].x + ordered[end].width;
        return { center: (ordered[start].x + right) / 2 };
      }
      if (!wanted.startsWith(value)) break;
    }
  }
  return null;
}

function textualTrackColumns(layout, definitions) {
  const centers = definitions.map((definition) => ({
    ...definition,
    center: joinedHeaderBox(layout.items, definition.header)?.center,
  }));
  if (centers.every(({ center }) => !Number.isFinite(center))) return null;
  if (centers.some(({ center }) => !Number.isFinite(center))) {
    throw new Error('답안 선택과목 헤더 일부만 판독됐습니다.');
  }
  centers.sort((left, right) => left.center - right.center);
  return new Map(centers.map((entry, index) => {
    const left = index === 0
      ? entry.center - (centers[1].center - entry.center) / 2
      : (centers[index - 1].center + entry.center) / 2;
    const right = index === centers.length - 1
      ? entry.center + (entry.center - centers[index - 1].center) / 2
      : (entry.center + centers[index + 1].center) / 2;
    return [entry.track, [Math.max(0, left / layout.width), Math.min(1, right / layout.width)]];
  }));
}

function rasterTrackColumns(raster, definitions) {
  if (!raster || raster.error || !Array.isArray(raster.selection_lines)) {
    throw new Error(`이미지형 답안 표 판독 실패: ${raster?.error || 'raster 없음'}`);
  }
  const lines = raster.selection_lines;
  const left = lines[0].x;
  const right = lines.at(-1).x;
  const chosen = Array.from({ length: definitions.length + 1 }, (_, index) => {
    const target = left + (right - left) * index / definitions.length;
    return [...lines].sort((a, b) => Math.abs(a.x - target) - Math.abs(b.x - target))[0];
  });
  if (new Set(chosen).size !== chosen.length) throw new Error('이미지형 답안 열 경계가 중복됩니다.');
  return new Map(definitions.map(({ track }, index) => (
    [track, [chosen[index].x, chosen[index + 1].x]]
  )));
}

function nearPair(actual, expected, tolerance = 0.012) {
  return Array.isArray(actual) && actual.length === 2
    && Math.abs(actual[0] - expected[0]) <= tolerance
    && Math.abs(actual[1] - expected[1]) <= tolerance;
}

function answerCounts({
  segments, answerKey, answerEntryByTrack, selectedTracks, extracted, oracle, formOrders, mutation,
}) {
  const matches = segments.filter(({ key }) => key === answerKey);
  if (matches.length !== 1) {
    return {
      noncanonical_form_page_count: 0,
      common_entry_count: 0,
      foreign_track_entry_count: 0,
      dual_form_count: 0,
      missing_track_count: selectedTracks.length,
      segment_count_error: Math.abs(matches.length - 1),
    };
  }
  const segment = structuredClone(matches[0]);
  if (mutation === 'full-answer') {
    segment.ranges = [[1, answerEntryByTrack.get(selectedTracks[0]).pages]];
    delete segment.clips;
  }
  const canonicalPages = canonicalAnswerPages(extracted, oracle.canonicalForm, formOrders, answerKey);
  const explicitForms = explicitAnswerForms(extracted.pageTexts);
  const forms = explicitForms.every((form) => form === 'single') && oracle.canonicalForm !== 'single'
    ? formOrders.get(explicitForms.length) : explicitForms;
  const wholePages = (segment.ranges || []).flatMap(([from, to]) => (
    Array.from({ length: to - from + 1 }, (_, index) => from + index)
  ));
  if (wholePages.length) {
    const actualForms = new Set(wholePages.map((page) => forms?.[page - 1] || 'single'));
    return {
      noncanonical_form_page_count: wholePages.filter((page) => !canonicalPages.includes(page)).length,
      common_entry_count: wholePages.length,
      foreign_track_entry_count: Math.max(0, oracle.definitions.length - selectedTracks.length),
      dual_form_count: actualForms.size > 1 ? 1 : 0,
      missing_track_count: 0,
      segment_count_error: 0,
    };
  }

  const found = new Set();
  let foreign = 0;
  let noncanonical = 0;
  for (const clip of segment.clips || []) {
    if (!canonicalPages.includes(clip.page)) noncanonical += 1;
    const layout = extracted.pageLayouts?.[clip.page - 1];
    if (!layout) {
      foreign += 1;
      continue;
    }
    const columns = textualTrackColumns(layout, oracle.definitions)
      || rasterTrackColumns(extracted.pageRasterLayouts?.[clip.page - 1], oracle.definitions);
    const matched = [...columns].find(([, expected]) => nearPair(clip.x, expected));
    if (!matched || !selectedTracks.includes(matched[0])) foreign += 1;
    else found.add(matched[0]);
  }
  return {
    noncanonical_form_page_count: noncanonical,
    common_entry_count: 0,
    foreign_track_entry_count: foreign,
    dual_form_count: 0,
    missing_track_count: selectedTracks.filter((track) => !found.has(track)).length,
    segment_count_error: 0,
  };
}

function anomalyTotal(result) {
  return Object.values(result.full).reduce((sum, value) => sum + value, 0)
    + Object.values(result.excerpt).reduce((sum, value) => sum + value, 0)
    + Object.values(result.answer).reduce((sum, value) => sum + value, 0);
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
  } else if (mutation && mutation !== 'full-answer') {
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

async function writeRepresentativeOutputs({ manifest, groups, planner, sourceDirectory, outDirectory }) {
  const representatives = [
    { key: '2025-06-math-question.pdf', track: 'hwaktong', mode: 'excerpt' },
    { key: '2022-csat-korean-question.pdf', track: 'hwajak', mode: 'full' },
    { key: '2024-csat-korean-question.pdf', track: 'hwajak', mode: 'excerpt' },
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
    const file = path.join(outDirectory,
      `${representative.key.replace(/-question[.]pdf$/u, '')}-${representative.track}-${representative.mode}.pdf`);
    await writeFile(file, bytes);
    files.push({ file: path.basename(file), sha256: sha256(bytes) });
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
        const expected = matchingAnswers.flatMap(({ answer_selection: regions = [] }) => regions)
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
      const full = questionCounts('full', expandQuestionPages(fullPlan.segments, key), tracks, oracle);
      const excerpt = questionCounts('excerpt', expandQuestionPages(excerptPlan.segments, key), tracks, oracle);
      const answerEntries = new Map(selected.map((question) => {
        const answer = answerById.get(question.id.replace(/-question$/u, '-answer'));
        return [question.track, answer];
      }));
      const answerKey = answerEntries.values().next().value?.r2_key;
      const answer = answerCounts({
        segments: excerptPlan.segments,
        answerKey,
        answerEntryByTrack: answerEntries,
        selectedTracks: tracks,
        extracted: answerExtractions.get(answerKey),
        oracle,
        formOrders,
        mutation,
      });
      const result = {
        key,
        subject: group[0].subject,
        grade_year: group[0].grade_year,
        round: group[0].round,
        tracks,
        full,
        excerpt,
        answer,
      };
      if (anomalyTotal(result) !== 0) anomalous += 1;
      results.push(result);
    }
  }
  if (results.length !== 160) throw new Error(`전수 조합 수가 ${results.length}입니다.`);
  if (anomalous !== 0) {
    const first = results.find((result) => anomalyTotal(result) !== 0);
    throw new Error(`${mutation || 'normal'}: 이상 조합 ${anomalous}/160; 첫 오류 ${JSON.stringify(first)}`);
  }

  await mkdir(outDirectory, { recursive: true });
  const representativeFiles = mutation ? [] : await writeRepresentativeOutputs({
    manifest, groups, planner, sourceDirectory, outDirectory,
  });
  const evidence = {
    schema: 'gichul-full-corpus-output-contract',
    version: 1,
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
