import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  corpusEntryId,
  DEFAULT_AVAILABILITY,
  expectedCorpusEntries,
  roundDescriptorsFor,
  trackDescriptorsFor,
  validateAvailability,
} from './availability.mjs';
import { canonicalFormForAnswer, canonicalFormFromProvenance } from './fetch-kice.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const DEFAULT_SOURCE_DIRECTORY = path.join(ROOT, 'gichul-src');
const DEFAULT_INVENTORY_PATH = path.join(DEFAULT_SOURCE_DIRECTORY, 'crawl-inventory.json');
const DEFAULT_OVERRIDES_PATH = path.join(SCRIPT_DIRECTORY, 'overrides.json');
const CMAP_URL = `${path.join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps')}${path.sep}`;

async function pdfFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await pdfFiles(absolute));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) files.push(absolute);
  }
  return files;
}

export function parseSourceFilename(file, availability = DEFAULT_AVAILABILITY) {
  validateAvailability(availability);
  const match = /^(20\d{2})-([a-z0-9_]+)-(.+)-(question|answer)\.pdf$/u
    .exec(path.basename(file));
  if (!match) throw new Error(`정규 파일명 계약에 맞지 않습니다: ${path.basename(file)}`);
  const year = Number(match[1]);
  const gradeYear = year + 1;
  if (gradeYear < availability.academic_years.from || gradeYear > availability.academic_years.to) {
    throw new Error(`학년도 범위를 벗어났습니다: ${path.basename(file)}`);
  }
  const sourcePart = match[3];
  const subjectDescriptor = [...availability.subjects]
    .sort((left, right) => right.id.length - left.id.length)
    .find(({ id }) => sourcePart === id || sourcePart.startsWith(`${id}-`));
  if (!subjectDescriptor) throw new Error(`지원하지 않는 과목입니다: ${path.basename(file)}`);
  const track = sourcePart === subjectDescriptor.id ? null : sourcePart.slice(subjectDescriptor.id.length + 1);
  const parsed = {
    year,
    gradeYear,
    round: match[2],
    subject: subjectDescriptor.id,
    track,
    kind: match[4],
  };
  if (!roundDescriptorsFor(availability, gradeYear).some(({ id }) => id === parsed.round)) {
    throw new Error(`지원하지 않는 회차입니다: ${path.basename(file)}`);
  }
  const allowedTracks = trackDescriptorsFor(availability, gradeYear, parsed.subject).map(({ id }) => id);
  // null is the collector's shared source for a subject whose manifest expands to several tracks.
  if (parsed.track !== null && !allowedTracks.includes(parsed.track)) {
    throw new Error(`과목 체제와 맞지 않는 선택과목입니다: ${path.basename(file)}`);
  }
  return parsed;
}

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function headerScore(pageText, header) {
  const wanted = compact(header);
  const lines = String(pageText || '').split(/\r?\n|\s{2,}/u).map(compact).filter(Boolean);
  if (lines.some((line) => line === wanted)) return 3;
  if (lines.some((line) => line.includes(wanted) && line.length <= wanted.length + 8)) return 2;
  return compact(pageText).includes(wanted) ? 1 : 0;
}

function hasPrintedQuestion(pageText, number) {
  if (!Number.isSafeInteger(number) || number < 1) return false;
  const normalized = String(pageText || '').normalize('NFKC');
  return new RegExp(`(?:^|[^0-9])${number}\\s*(?:[.]|번)`, 'u').test(normalized);
}

function questionFormFromText(pageText) {
  const value = compact(pageText);
  const odd = value.includes('홀수형');
  const even = value.includes('짝수형');
  if (odd && even) return 'conflict';
  if (odd) return 'odd';
  if (even) return 'even';
  return null;
}

export function deriveQuestionFormMetadata(pageTexts, provenanceForm = 'single', label = 'question') {
  if (!Array.isArray(pageTexts) || !pageTexts.length
    || !['odd', 'even', 'single'].includes(provenanceForm)) {
    throw new Error(`${label}: 문제지 형 판정 입력이 잘못되었습니다.`);
  }
  const explicit = pageTexts.map(questionFormFromText);
  if (explicit.includes('conflict')) throw new Error(`${label}: 한 페이지에 홀수형과 짝수형이 함께 표기됐습니다.`);
  if (explicit.every((form) => form === null)) {
    return {
      canonical_form: provenanceForm,
      canonical_pages: [1, pageTexts.length],
      source_forms: [provenanceForm],
    };
  }
  if (explicit.some((form) => form === null)) {
    throw new Error(`${label}: 일부 문제지 페이지의 형 표기를 판독하지 못했습니다.`);
  }
  const blocks = [];
  explicit.forEach((form, index) => {
    const previous = blocks.at(-1);
    if (previous?.form === form) previous.to = index + 1;
    else blocks.push({ form, from: index + 1, to: index + 1 });
  });
  const sourceForms = blocks.map(({ form }) => form);
  if (new Set(sourceForms).size !== sourceForms.length) {
    throw new Error(`${label}: 같은 문제지 형이 서로 떨어진 블록으로 반복됩니다.`);
  }
  if (provenanceForm !== 'single' && !sourceForms.includes(provenanceForm)) {
    throw new Error(`${label}: 파일명 형과 PDF 내부 형이 충돌합니다.`);
  }
  const canonicalForm = sourceForms.includes('odd') ? 'odd' : sourceForms[0];
  const canonical = blocks.find(({ form }) => form === canonicalForm);
  return {
    canonical_form: canonicalForm,
    canonical_pages: [canonical.from, canonical.to],
    source_forms: sourceForms,
  };
}

export function detectSectionStarts(pageTexts, trackDefinitions, { pageRange = [1, pageTexts.length] } = {}) {
  const starts = new Map();
  for (const definition of trackDefinitions) {
    if (!Number.isSafeInteger(definition.firstQuestion) || definition.firstQuestion < 1) {
      throw new Error(`선택과목 첫 문항 번호가 없습니다: ${definition.header}`);
    }
    const candidates = pageTexts
      .map((text, index) => ({ page: index + 1, score: headerScore(text, definition.header) }))
      .filter((candidate) => candidate.page >= pageRange[0] && candidate.page <= pageRange[1]
        && candidate.score > 0 && hasPrintedQuestion(pageTexts[candidate.page - 1], definition.firstQuestion))
      .sort((left, right) => right.score - left.score || left.page - right.page);
    if (!candidates.length) {
      throw new Error(`선택과목 헤더를 찾지 못했습니다: ${definition.header}`);
    }
    starts.set(definition.track, candidates[0].page);
  }
  return starts;
}

export async function extractPdfText(file) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    throw new Error(`pdfjs-dist를 불러오지 못했습니다. 오케스트레이터가 npm install을 실행해야 합니다. (${error.message})`);
  }
  const buffer = await readFile(file);
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const document = await pdfjs.getDocument({
    data,
    disableWorker: true,
    useSystemFonts: true,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
  }).promise;
  const pageTexts = [];
  const pageLayouts = [];
  const pageRasterLayouts = [];
  const isAnswer = /-answer\.pdf$/u.test(path.basename(file));
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join(''));
      const viewport = page.getViewport({ scale: 1 });
      pageLayouts.push({
        width: viewport.width,
        height: viewport.height,
        items: content.items.map((item) => ({
          text: item.str || '',
          x: Number(item.transform?.[4]),
          y: Number(item.transform?.[5]),
          width: Number(item.width),
          height: Number(item.height),
        })).filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y)
          && Number.isFinite(item.width) && Number.isFinite(item.height)),
      });
      if (isAnswer && content.items.every((item) => !compact(item.str))) {
        const { createCanvas } = await import('@napi-rs/canvas');
        const rasterViewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.ceil(rasterViewport.width), Math.ceil(rasterViewport.height));
        const context = canvas.getContext('2d');
        await page.render({ canvasContext: context, viewport: rasterViewport }).promise;
        try {
          pageRasterLayouts.push(detectAnswerTableLayout(
            context.getImageData(0, 0, canvas.width, canvas.height),
          ));
        } catch (error) {
          pageRasterLayouts.push({ error: error.message });
        }
      } else {
        pageRasterLayouts.push(null);
      }
    }
  } finally {
    await document.destroy();
  }
  return { pageCount: pageTexts.length, pageTexts, pageLayouts, pageRasterLayouts };
}

function groupsOf(values, gap = 1) {
  const groups = [];
  for (const value of values) {
    const current = groups.at(-1);
    if (current && value <= current.at(-1) + gap) current.push(value);
    else groups.push([value]);
  }
  return groups;
}

export function detectAnswerTableLayout({ data, width, height }) {
  if (!(data instanceof Uint8ClampedArray || Buffer.isBuffer(data))
    || !Number.isInteger(width) || width < 100 || !Number.isInteger(height) || height < 100
    || data.length < width * height * 4) {
    throw new Error('답안 raster 크기가 잘못되었습니다.');
  }
  const dark = (x, y) => {
    const offset = (y * width + x) * 4;
    return data[offset] < 160 && data[offset + 1] < 160 && data[offset + 2] < 160;
  };
  const rowCandidates = [];
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = 0; x < width; x += 1) if (dark(x, y)) count += 1;
    if (count > width * 0.22) rowCandidates.push({ y, count });
  }
  const rowLines = groupsOf(rowCandidates.map(({ y }) => y), 2).map((group) => {
    const members = rowCandidates.filter(({ y }) => y >= group[0] && y <= group.at(-1));
    return members.reduce((best, candidate) => (candidate.count > best.count ? candidate : best));
  });
  let header = null;
  for (let index = 0; index + 2 < rowLines.length; index += 1) {
    const [top, selection, body] = rowLines.slice(index, index + 3);
    if (top.count > width * 0.55 && selection.count > width * 0.25
      && selection.count < width * 0.5 && body.count > width * 0.55
      && selection.y - top.y >= 10 && body.y - selection.y >= 10
      && body.y - top.y < height * 0.15) {
      header = { top: top.y, selection: selection.y, body: body.y };
      break;
    }
  }
  if (!header) throw new Error('이미지형 답안에서 선택과목 표 머리글을 찾지 못했습니다.');

  const verticalLines = (fromY, toY) => {
    const candidates = [];
    const bandHeight = toY - fromY + 1;
    for (let x = 0; x < width; x += 1) {
      let count = 0;
      for (let y = fromY; y <= toY; y += 1) if (dark(x, y)) count += 1;
      if (count > bandHeight * 0.7) candidates.push(x);
    }
    return groupsOf(candidates).filter((group) => group.length >= 2).map((group) => ({
      x: Math.round((group[0] + group.at(-1)) / 2),
    }));
  };
  const topLines = verticalLines(header.top + 5, header.selection - 5);
  if (topLines.length < 3) throw new Error('이미지형 답안에서 공통/선택 표 경계를 찾지 못했습니다.');
  const left = topLines[0].x;
  const right = topLines.at(-1).x;
  const midpoint = (left + right) / 2;
  const selectionLeft = topLines.slice(1, -1)
    .sort((a, b) => Math.abs(a.x - midpoint) - Math.abs(b.x - midpoint))[0]?.x;
  if (!Number.isFinite(selectionLeft) || Math.abs(selectionLeft - midpoint) > width * 0.08) {
    throw new Error('이미지형 답안에서 선택과목 표 시작점을 찾지 못했습니다.');
  }
  const lineEnd = (x) => {
    let last = header.selection;
    let gap = 0;
    for (let y = header.selection; y < height; y += 1) {
      const marked = [-1, 0, 1].some((offset) => x + offset >= 0 && x + offset < width
        && dark(x + offset, y));
      if (marked) {
        last = y;
        gap = 0;
      } else {
        gap += 1;
        if (gap > 6) break;
      }
    }
    return last;
  };
  const selectionLines = verticalLines(header.selection + 5, header.body - 5)
    .filter(({ x }) => x >= selectionLeft - 2 && x <= right + 2)
    .map(({ x }) => ({ x: x / width, end: lineEnd(x) / height }));
  if (selectionLines.length < 2) throw new Error('이미지형 답안에서 선택과목 열 경계를 찾지 못했습니다.');
  return { top: header.top / height, selection_lines: selectionLines };
}

function explicitAnswerPageForms(pageTexts, label) {
  return pageTexts.map((text) => {
    const value = compact(text);
    const odd = value.includes('홀수형');
    const even = value.includes('짝수형');
    if (odd && even) throw new Error(`${label}: 한 답안 페이지에 홀수형과 짝수형 표기가 함께 있습니다.`);
    return odd ? 'odd' : (even ? 'even' : 'single');
  });
}

export function deriveAnswerFormOrders(records) {
  const orders = new Map();
  for (const { pageTexts, label = 'answer' } of records) {
    const forms = explicitAnswerPageForms(pageTexts, label);
    const marked = forms.filter((form) => form !== 'single');
    if (!marked.length) continue;
    if (marked.length !== forms.length) {
      throw new Error(`${label}: 형 표기가 있는 답안 페이지와 없는 페이지가 섞여 있습니다.`);
    }
    if (!forms.includes('odd') || !forms.includes('even')) continue;
    const existing = orders.get(forms.length);
    if (existing && existing.some((form, index) => form !== forms[index])) {
      throw new Error(`${label}: 같은 페이지 수의 KICE 답안 형 순서가 원본끼리 일치하지 않습니다.`);
    }
    orders.set(forms.length, forms);
  }
  return orders;
}

function answerFormPages(pageTexts, canonicalForm, label, answerFormOrder) {
  let forms = explicitAnswerPageForms(pageTexts, label);
  // 문제지 provenance가 single이면 그 원본 자체가 단일 자료다. 내부에 홀짝 묶음이
  // 있더라도 답안 쪽에서 새 형을 고르지 않고 문제지와 똑같이 전체 자료를 보존한다.
  if (canonicalForm === 'single') return forms.map((_, index) => index + 1);
  const hasMarkedForm = forms.some((form) => form !== 'single');
  if (hasMarkedForm && forms.some((form) => form === 'single')) {
    throw new Error(`${label}: 형 표기가 있는 답안 페이지와 없는 페이지가 섞여 있습니다.`);
  }
  if (!hasMarkedForm) {
    if (!Array.isArray(answerFormOrder) || answerFormOrder.length !== forms.length) {
      throw new Error(`${label}: ${canonicalForm} 문제지에 대응할 답안 형 표기가 없습니다.`);
    }
    // 이미지형 답안은 회차 목록이나 페이지 번호를 손으로 적지 않는다. 같은 KICE 원본
    // 코퍼스의 텍스트형 답안들에서 자동 도출해 전수 일치가 확인된 페이지 순서를 공유한다.
    forms = answerFormOrder;
  }
  const pages = forms.flatMap((form, index) => (form === canonicalForm ? [index + 1] : []));
  if (!pages.length) throw new Error(`${label}: ${canonicalForm} 답안 페이지가 없습니다.`);
  return pages;
}

function headerBox(items, header) {
  const wanted = compact(header);
  const direct = items.find(({ text }) => compact(text) === wanted);
  if (direct) return { ...direct, center: direct.x + direct.width / 2 };
  const ordered = items.filter(({ text }) => compact(text)).sort((left, right) => left.x - right.x);
  for (let start = 0; start < ordered.length; start += 1) {
    let value = '';
    let minimumY = ordered[start].y;
    let maximumY = ordered[start].y;
    for (let end = start; end < Math.min(ordered.length, start + 5); end += 1) {
      minimumY = Math.min(minimumY, ordered[end].y);
      maximumY = Math.max(maximumY, ordered[end].y);
      if (maximumY - minimumY > 4) break;
      value += compact(ordered[end].text);
      if (value === wanted) {
        const right = ordered[end].x + ordered[end].width;
        const members = ordered.slice(start, end + 1);
        return {
          x: ordered[start].x,
          y: Math.min(...members.map((item) => item.y)),
          width: right - ordered[start].x,
          height: Math.max(...members.map((item) => item.y + item.height))
            - Math.min(...members.map((item) => item.y)),
          center: (ordered[start].x + right) / 2,
        };
      }
      if (!wanted.startsWith(value)) break;
    }
  }
  return null;
}

export function deriveAnswerMetadata({
  pageTexts, pageLayouts, pageRasterLayouts, tracks, canonicalForm, label = 'answer', availability = DEFAULT_AVAILABILITY,
  gradeYear, subject, answerFormOrder,
}) {
  const answerPages = answerFormPages(pageTexts, canonicalForm, label, answerFormOrder);
  const definitions = trackDescriptorsFor(availability, gradeYear, subject)
    .filter(({ id, section_header: header }) => tracks.includes(id) && header)
    .map(({ id: track, section_header: header }) => ({ track, header }));
  if (!definitions.length) return { answer_pages: answerPages, selections: new Map() };
  if (!Array.isArray(pageLayouts) || pageLayouts.length !== pageTexts.length || definitions.length < 2) {
    throw new Error(`${label}: 선택과목 답안 열 좌표를 도출할 PDF layout이 없습니다.`);
  }
  const selections = new Map(definitions.map(({ track }) => [track, []]));
  for (const pageNumber of answerPages) {
    const layout = pageLayouts[pageNumber - 1];
    if (!layout || !Number.isFinite(layout.width) || layout.width <= 0
      || !Number.isFinite(layout.height) || layout.height <= 0 || !Array.isArray(layout.items)) {
      throw new Error(`${label}: ${pageNumber}쪽 layout이 잘못되었습니다.`);
    }
    const centers = definitions.map((definition) => ({
      ...definition,
      headerBox: headerBox(layout.items, definition.header),
    }));
    centers.forEach((entry) => { entry.center = entry.headerBox?.center; });
    const present = centers.filter(({ center }) => Number.isFinite(center));
    if (!present.length && pageRasterLayouts?.[pageNumber - 1]?.error) {
      throw new Error(`${label}: ${pageNumber}쪽 ${pageRasterLayouts[pageNumber - 1].error}`);
    }
    if (!present.length && pageRasterLayouts?.[pageNumber - 1]) {
      const raster = pageRasterLayouts[pageNumber - 1];
      const candidates = raster.selection_lines;
      const left = candidates[0].x;
      const right = candidates.at(-1).x;
      const chosen = Array.from({ length: definitions.length + 1 }, (_, index) => {
        const target = left + (right - left) * index / definitions.length;
        return [...candidates].sort((a, b) => Math.abs(a.x - target) - Math.abs(b.x - target))[0];
      });
      if (new Set(chosen).size !== chosen.length
        || chosen.some((line, index) => Math.abs(line.x
          - (left + (right - left) * index / definitions.length)) > (right - left) / definitions.length * 0.2)) {
        throw new Error(`${label}: ${pageNumber}쪽 이미지형 선택과목 열 경계가 잘못되었습니다.`);
      }
      const bottom = Math.max(0, 1 - Math.min(...chosen.slice(1).map(({ end }) => end)) - 0.003);
      const top = Math.min(1, 1 - raster.top + 0.003);
      definitions.forEach(({ track }, index) => {
        selections.get(track).push({
          page: pageNumber,
          x: [Number(chosen[index].x.toFixed(6)), Number(chosen[index + 1].x.toFixed(6))],
          y: [Number(bottom.toFixed(6)), Number(top.toFixed(6))],
        });
      });
      continue;
    }
    if (!present.length) continue;
    if (present.length !== centers.length) {
      throw new Error(`${label}: ${pageNumber}쪽 선택과목 헤더 일부만 찾았습니다.`);
    }
    centers.sort((left, right) => left.center - right.center);
    for (let index = 1; index < centers.length; index += 1) {
      if (centers[index].center <= centers[index - 1].center) {
        throw new Error(`${label}: ${pageNumber}쪽 선택과목 열 순서가 잘못되었습니다.`);
      }
    }
    centers.forEach((entry, index) => {
      const left = index === 0
        ? entry.center - (centers[1].center - entry.center) / 2
        : (centers[index - 1].center + entry.center) / 2;
      const right = index === centers.length - 1
        ? entry.center + (entry.center - centers[index - 1].center) / 2
        : (entry.center + centers[index + 1].center) / 2;
      const from = Math.max(0, left / layout.width);
      const to = Math.min(1, right / layout.width);
      if (!(from < to)) throw new Error(`${label}: ${pageNumber}쪽 ${entry.track} 답안 crop이 잘못되었습니다.`);
      const top = Math.min(layout.height, entry.headerBox.y + entry.headerBox.height + 36);
      const columnItems = layout.items.filter((item) => {
        const center = item.x + item.width / 2;
        return compact(item.text) && center >= left && center <= right && item.y <= top;
      });
      const bottom = Math.max(0, Math.min(...columnItems.map((item) => item.y)) - 12);
      if (!columnItems.length || !(bottom < top)) {
        throw new Error(`${label}: ${pageNumber}쪽 ${entry.track} 답안 세로 crop이 잘못되었습니다.`);
      }
      selections.get(entry.track).push({
        page: pageNumber,
        x: [Number(from.toFixed(6)), Number(to.toFixed(6))],
        y: [Number((bottom / layout.height).toFixed(6)), Number((top / layout.height).toFixed(6))],
      });
    });
  }
  for (const [track, regions] of selections) {
    if (!regions.length) throw new Error(`${label}: ${track} 답안 열을 찾지 못했습니다.`);
  }
  return { answer_pages: answerPages, selections };
}

async function readOverrides(file) {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('overrides.json은 객체여야 합니다.');
  }
  const sections = parsed.sections ?? parsed;
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    throw new Error('overrides.json의 sections는 객체여야 합니다.');
  }
  return sections;
}

function normalizedOverride(value, id) {
  if (value === undefined) return null;
  const sections = value?.sections ?? value;
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    throw new Error(`${id}: 수동 보정은 sections 객체여야 합니다.`);
  }
  const keys = Object.keys(sections).sort();
  if (keys.length !== 2 || keys[0] !== 'common' || keys[1] !== 'selection') {
    throw new Error(`${id}: 수동 보정은 common과 selection 구간만 정확히 포함해야 합니다.`);
  }
  return sections;
}

export function tracksForSource(source, availability = DEFAULT_AVAILABILITY) {
  if (source.track) return [source.track];
  return trackDescriptorsFor(availability, source.gradeYear, source.subject).map(({ id }) => id);
}

function idFor(source, track) {
  return `${source.year}-${source.round}-${source.subject}${track ? `-${track}` : ''}-${source.kind}`;
}

function assertRange(range, pages, label) {
  if (!Array.isArray(range) || range.length !== 2
    || !range.every(Number.isSafeInteger)
    || range[0] < 1 || range[0] > range[1] || range[1] > pages) {
    throw new Error(`${label}: 페이지 구간은 1..${pages} 안의 [시작, 끝]이어야 합니다.`);
  }
}

function rangesOverlap(left, right) {
  return left[0] <= right[1] && right[0] <= left[1];
}

export function validateManifest(exams, availability = DEFAULT_AVAILABILITY) {
  validateAvailability(availability);
  if (!Array.isArray(exams) || exams.length === 0) throw new Error('매니페스트 시험 목록이 비어 있습니다.');
  const ids = new Set();
  const selectionsByFile = new Map();
  const commonByFile = new Map();
  for (const exam of exams) {
    if (ids.has(exam.id)) throw new Error(`중복 매니페스트 ID: ${exam.id}`);
    ids.add(exam.id);
    if (!Number.isSafeInteger(exam.pages) || exam.pages < 1) throw new Error(`${exam.id}: 총 페이지 수가 비정상입니다.`);
    if (exam.canonical_form !== undefined && !['odd', 'even', 'single'].includes(exam.canonical_form)) {
      throw new Error(`${exam.id}: canonical_form 값이 잘못되었습니다.`);
    }
    if (exam.kind === 'question' && exam.canonical_form !== undefined) {
      assertRange(exam.canonical_pages, exam.pages, `${exam.id}.canonical_pages`);
      if (!Array.isArray(exam.source_forms) || !exam.source_forms.length
        || new Set(exam.source_forms).size !== exam.source_forms.length
        || exam.source_forms.some((form) => !['odd', 'even', 'single'].includes(form))
        || !exam.source_forms.includes(exam.canonical_form)
        || (exam.source_forms.length > 1 && exam.canonical_form === 'single')) {
        throw new Error(`${exam.id}: PDF 내부 형과 canonical_form이 충돌합니다.`);
      }
    }
    if (exam.answer_pages !== undefined) {
      if (exam.kind !== 'answer' || !Array.isArray(exam.answer_pages) || !exam.answer_pages.length
        || new Set(exam.answer_pages).size !== exam.answer_pages.length) {
        throw new Error(`${exam.id}: answer_pages 값이 잘못되었습니다.`);
      }
      for (const page of exam.answer_pages) {
        if (!Number.isInteger(page) || page < 1 || page > exam.pages) {
          throw new Error(`${exam.id}: answer_pages는 1..${exam.pages} 안의 페이지여야 합니다.`);
        }
      }
    }
    if (exam.answer_selection !== undefined) {
      if (exam.kind !== 'answer' || !Array.isArray(exam.answer_selection) || !exam.answer_selection.length) {
        throw new Error(`${exam.id}: answer_selection 값이 잘못되었습니다.`);
      }
      for (const region of exam.answer_selection) {
        if (!region || !Number.isInteger(region.page) || !exam.answer_pages?.includes(region.page)
          || !Array.isArray(region.x) || region.x.length !== 2
          || !region.x.every(Number.isFinite) || region.x[0] < 0 || region.x[1] > 1
          || region.x[0] >= region.x[1]
          || !Array.isArray(region.y) || region.y.length !== 2
          || !region.y.every(Number.isFinite) || region.y[0] < 0 || region.y[1] > 1
          || region.y[0] >= region.y[1]) {
          throw new Error(`${exam.id}: answer_selection crop이 잘못되었습니다.`);
        }
      }
    }
    const activeTrack = trackDescriptorsFor(availability, exam.grade_year, exam.subject)
      .find(({ id }) => id === exam.track);
    const needsSections = exam.kind === 'question' && Boolean(activeTrack?.section_header);
    if (needsSections && !exam.sections) {
      throw new Error(`${exam.id}: 현대 국어/수학 문제지는 common과 selection 구간이 필요합니다.`);
    }
    if (exam.sections) {
      const ranges = Object.entries(exam.sections);
      const rangeNames = ranges.map(([name]) => name).sort();
      if (rangeNames.length !== 2 || rangeNames[0] !== 'common' || rangeNames[1] !== 'selection') {
        throw new Error(`${exam.id}: sections는 common과 selection만 정확히 포함해야 합니다.`);
      }
      for (const [name, range] of ranges) assertRange(range, exam.pages, `${exam.id}.${name}`);
      if (exam.canonical_pages && ranges.some(([, range]) => (
        range[0] < exam.canonical_pages[0] || range[1] > exam.canonical_pages[1]
      ))) {
        throw new Error(`${exam.id}: sections가 정본 형 페이지 블록을 벗어납니다.`);
      }
      for (let left = 0; left < ranges.length; left += 1) {
        for (let right = left + 1; right < ranges.length; right += 1) {
          if (rangesOverlap(ranges[left][1], ranges[right][1])) {
            throw new Error(`${exam.id}: ${ranges[left][0]}과 ${ranges[right][0]} 구간이 겹칩니다.`);
          }
        }
      }
      if (exam.sections.selection) {
        const key = `${exam.r2_key}\0${exam.kind}`;
        const serializedCommon = JSON.stringify(exam.sections.common);
        const existingCommon = commonByFile.get(key);
        if (existingCommon && existingCommon !== serializedCommon) {
          throw new Error(`${exam.r2_key}: 같은 PDF의 common 구간이 선택과목마다 다릅니다.`);
        }
        commonByFile.set(key, serializedCommon);
        const selections = selectionsByFile.get(key) || [];
        if (selections.some((entry) => rangesOverlap(entry.range, exam.sections.selection))) {
          throw new Error(`${exam.r2_key}: 선택과목 페이지 구간이 서로 겹칩니다.`);
        }
        selections.push({ id: exam.id, range: exam.sections.selection });
        selectionsByFile.set(key, selections);
      }
    }
  }
  const byId = new Map(exams.map((exam) => [exam.id, exam]));
  for (const answer of exams.filter(({ kind }) => kind === 'answer')) {
    const question = byId.get(answer.id.replace(/-answer$/u, '-question'));
    if (!question?.canonical_form) continue;
    if (answer.canonical_form !== question.canonical_form || !Array.isArray(answer.answer_pages)) {
      throw new Error(`${answer.id}: 문제지 canonical_form과 답안 출력 메타데이터가 일치하지 않습니다.`);
    }
    if (question.sections?.selection && !Array.isArray(answer.answer_selection)) {
      throw new Error(`${answer.id}: 선택과목 발췌 답안 crop이 없습니다.`);
    }
  }
  return exams;
}

function sectionMapFor(
  source, pageTexts, pageCount, tracks, overrides, usedOverrides, availability,
  canonicalPages = [1, pageCount],
) {
  if (source.kind !== 'question') return new Map();
  const firstQuestion = availability.subjects
    .find(({ id }) => id === source.subject)?.selection_first_question;
  const definitions = trackDescriptorsFor(availability, source.gradeYear, source.subject)
    .filter(({ id, section_header: header }) => tracks.includes(id) && header)
    .map(({ id: track, section_header: header }) => ({ track, header, firstQuestion }));
  if (!definitions.length) return new Map();
  const manual = new Map(definitions.map(({ track }) => {
    const id = idFor(source, track);
    const override = normalizedOverride(overrides[id], id);
    if (override) usedOverrides.add(id);
    return [track, override];
  }));
  const missingDefinitions = definitions.filter(({ track }) => !manual.get(track));
  const detected = missingDefinitions.length
    ? detectSectionStarts(pageTexts, missingDefinitions, { pageRange: canonicalPages }) : new Map();
  const starts = new Map(definitions.map(({ track }) => [
    track,
    manual.get(track)?.selection?.[0] ?? detected.get(track),
  ]));
  const orderedStarts = [...starts.values()].sort((left, right) => left - right);
  if (new Set(orderedStarts).size !== orderedStarts.length) {
    throw new Error(`${source.year}-${source.round}-${source.subject}: 선택과목 시작 페이지가 겹칩니다.`);
  }
  const common = [canonicalPages[0], Math.min(...orderedStarts) - 1];
  const result = new Map();
  for (const { track } of definitions) {
    if (manual.get(track)) {
      result.set(track, manual.get(track));
      continue;
    }
    const start = starts.get(track);
    const next = orderedStarts.find((candidate) => candidate > start);
    result.set(track, { common, selection: [start, next ? next - 1 : canonicalPages[1]] });
  }
  return result;
}

export function validateCorpusManifest(exams, availability = DEFAULT_AVAILABILITY) {
  validateAvailability(availability);
  const ids = new Set(exams.map(({ id }) => id));
  const missing = [];
  for (const entry of expectedCorpusEntries(availability)) {
    const id = corpusEntryId(entry);
    if (!ids.has(id)) missing.push(id);
  }
  if (missing.length) {
    throw new Error(`매니페스트 코퍼스가 불완전합니다 (${missing.length}개 누락): ${missing.slice(0, 8).join(', ')}`);
  }
  return exams;
}

async function validateCrawlInventory(inventoryPath, sourceDirectory, files) {
  if (!existsSync(inventoryPath)) {
    throw new Error(`crawl inventory가 없습니다. fetch-kice.mjs를 먼저 실행하십시오: ${inventoryPath}`);
  }
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  if (inventory?.version !== 1 || !Array.isArray(inventory.files)) {
    throw new Error(`crawl inventory 형식이 잘못되었습니다: ${inventoryPath}`);
  }
  const availability = validateAvailability(inventory.availability ?? DEFAULT_AVAILABILITY);
  const targets = new Set();
  const entriesByTarget = new Map();
  const questionProvenance = [];
  for (const entry of inventory.files) {
    if (!entry || typeof entry.target !== 'string') continue;
    const source = parseSourceFilename(entry.target, availability);
    if (source.kind === 'question') {
      questionProvenance.push({
        ...source,
        target: entry.target,
        sourceFilename: entry.sourceFilename,
        archiveEntry: entry.archiveEntry,
        canonical_form: canonicalFormFromProvenance(entry.sourceFilename, entry.archiveEntry),
      });
    }
  }
  for (const entry of inventory.files) {
    if (!entry || typeof entry.target !== 'string' || !/^[\da-f]{32}$/iu.test(entry.fileSeq || '')) {
      throw new Error('crawl inventory에 잘못된 target/fileSeq가 있습니다.');
    }
    if (targets.has(entry.target)) throw new Error(`crawl inventory target 중복: ${entry.target}`);
    const source = parseSourceFilename(entry.target, availability);
    const canonicalForm = source.kind === 'question'
      ? questionProvenance.find(({ target }) => target === entry.target)?.canonical_form
      : canonicalFormForAnswer({ ...source, target: entry.target }, questionProvenance);
    if (!['odd', 'even', 'single'].includes(entry.canonical_form)
      || entry.canonical_form !== canonicalForm) {
      throw new Error(`crawl inventory canonical_form 불일치: ${entry.target}`);
    }
    const provenanceFields = {
      grade_year: source.gradeYear,
      year: source.year,
      round: source.round,
      subject: source.subject,
      track: source.track,
      kind: source.kind,
    };
    for (const [name, value] of Object.entries(provenanceFields)) {
      if (entry[name] !== value) throw new Error(`crawl inventory provenance 불일치: ${entry.target}.${name}`);
    }
    targets.add(entry.target);
    entriesByTarget.set(entry.target, entry);
  }
  const sourceTargets = new Set(files.map((file) => path.relative(sourceDirectory, file).split(path.sep).join('/')));
  for (const target of targets) {
    if (!sourceTargets.has(target)) throw new Error(`crawl inventory의 PDF가 없습니다: ${target}`);
  }
  for (const target of sourceTargets) {
    if (!targets.has(target)) throw new Error(`crawl inventory에 없는 PDF가 있습니다: ${target}`);
  }
  return { availability, entriesByTarget };
}

function rank(values, value) {
  const index = values.indexOf(value);
  return index === -1 ? values.length : index;
}

function compareExams(left, right, availability) {
  const rounds = availability.rounds.map(({ id }) => id);
  const subjects = availability.subjects.map(({ id }) => id);
  const tracks = trackDescriptorsFor(availability, left.grade_year, left.subject).map(({ id }) => id);
  return left.year - right.year
    || rank(rounds, left.round) - rank(rounds, right.round)
    || rank(subjects, left.subject) - rank(subjects, right.subject)
    || rank(tracks, left.track) - rank(tracks, right.track)
    || left.kind.localeCompare(right.kind);
}

function paperIdentity(source) {
  return `${source.year}\0${source.round}\0${source.subject}`;
}

function checkedExtraction(extracted, label) {
  const pageCount = Number(extracted?.pageCount);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1
    || !Array.isArray(extracted?.pageTexts) || extracted.pageTexts.length !== pageCount) {
    throw new Error(`${label}: 텍스트 추출기가 유효한 pageCount/pageTexts를 반환하지 않았습니다.`);
  }
  return extracted;
}

export async function buildManifest({
  sourceDirectory = DEFAULT_SOURCE_DIRECTORY,
  outputPath = path.join(sourceDirectory, 'manifest.json'),
  overridesPath = DEFAULT_OVERRIDES_PATH,
  inventoryPath = sourceDirectory === DEFAULT_SOURCE_DIRECTORY
    ? DEFAULT_INVENTORY_PATH
    : path.join(sourceDirectory, 'crawl-inventory.json'),
  availability = DEFAULT_AVAILABILITY,
  allowPartial = false,
  extractText = extractPdfText,
} = {}) {
  let activeAvailability = validateAvailability(availability);
  const files = await pdfFiles(sourceDirectory);
  if (!files.length) throw new Error(`PDF가 없습니다: ${sourceDirectory}`);
  let inventoryByTarget = null;
  if (!allowPartial) {
    const inventory = await validateCrawlInventory(inventoryPath, sourceDirectory, files);
    activeAvailability = inventory.availability;
    inventoryByTarget = inventory.entriesByTarget;
    validateCorpusManifest(files.flatMap((file) => {
      const source = parseSourceFilename(file, activeAvailability);
      return tracksForSource(source, activeAvailability).map((track) => ({ id: idFor(source, track) }));
    }), activeAvailability);
  }
  const overrides = await readOverrides(overridesPath);
  const usedOverrides = new Set();
  const exams = [];
  const extractedAnswers = new Map();
  const extractedQuestions = new Map();
  const questionForms = new Map();
  let answerFormOrders = new Map();

  if (inventoryByTarget) {
    const formRecords = [];
    for (const file of files) {
      if (parseSourceFilename(file, activeAvailability).kind !== 'answer') continue;
      const label = path.relative(sourceDirectory, file).split(path.sep).join('/');
      const extracted = checkedExtraction(await extractText(file), label);
      extractedAnswers.set(file, extracted);
      formRecords.push({ pageTexts: extracted.pageTexts, label });
    }
    answerFormOrders = deriveAnswerFormOrders(formRecords);
  }

  for (const file of files) {
    const source = parseSourceFilename(file, activeAvailability);
    if (source.kind !== 'question') continue;
    const r2Key = path.relative(sourceDirectory, file).split(path.sep).join('/');
    const extracted = checkedExtraction(await extractText(file), r2Key);
    const form = deriveQuestionFormMetadata(
      extracted.pageTexts,
      inventoryByTarget?.get(r2Key)?.canonical_form ?? 'single',
      r2Key,
    );
    extractedQuestions.set(file, extracted);
    const key = paperIdentity(source);
    const previous = questionForms.get(key);
    if (previous && previous.canonical_form !== form.canonical_form) {
      throw new Error(`${r2Key}: 같은 시험의 문제지 정본 형이 서로 다릅니다.`);
    }
    questionForms.set(key, form);
  }

  for (const file of files.sort()) {
    const source = parseSourceFilename(file, activeAvailability);
    const extracted = checkedExtraction(
      extractedQuestions.get(file) ?? extractedAnswers.get(file) ?? await extractText(file),
      path.basename(file),
    );
    const pageCount = Number(extracted.pageCount);
    const pageTexts = extracted?.pageTexts;
    const tracks = tracksForSource(source, activeAvailability);
    const r2Key = path.relative(sourceDirectory, file).split(path.sep).join('/');
    const questionForm = questionForms.get(paperIdentity(source));
    const canonicalForm = source.kind === 'question'
      ? questionForm?.canonical_form
      : questionForm?.canonical_form ?? inventoryByTarget?.get(r2Key)?.canonical_form;
    const sections = sectionMapFor(
      source, pageTexts, pageCount, tracks, overrides, usedOverrides, activeAvailability,
      questionForm?.canonical_pages,
    );
    const answerMetadata = source.kind === 'answer' && canonicalForm
      ? deriveAnswerMetadata({
        pageTexts,
        pageLayouts: extracted?.pageLayouts,
        pageRasterLayouts: extracted?.pageRasterLayouts,
        tracks,
        canonicalForm,
        label: r2Key,
        availability: activeAvailability,
        gradeYear: source.gradeYear,
        subject: source.subject,
        answerFormOrder: answerFormOrders.get(pageCount),
      })
      : null;
    for (const track of tracks) {
      exams.push({
        id: idFor(source, track),
        subject: source.subject,
        year: source.year,
        grade_year: source.gradeYear,
        round: source.round,
        track,
        kind: source.kind,
        r2_key: r2Key,
        pages: pageCount,
        ...(canonicalForm ? { canonical_form: canonicalForm } : {}),
        ...(source.kind === 'question' && questionForm ? {
          canonical_pages: questionForm.canonical_pages,
          source_forms: questionForm.source_forms,
        } : {}),
        ...(sections.has(track) ? { sections: sections.get(track) } : {}),
        ...(answerMetadata ? { answer_pages: answerMetadata.answer_pages } : {}),
        ...(answerMetadata?.selections.has(track)
          ? { answer_selection: answerMetadata.selections.get(track) } : {}),
      });
    }
  }

  validateManifest(exams, activeAvailability);
  if (!allowPartial) validateCorpusManifest(exams, activeAvailability);
  const unusedOverrides = Object.keys(overrides).filter((id) => !usedOverrides.has(id));
  if (unusedOverrides.length) {
    throw new Error(`사용되지 않은 section override ID: ${unusedOverrides.join(', ')}`);
  }
  exams.sort((left, right) => compareExams(left, right, activeAvailability));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const manifest = { availability: activeAvailability, exams };
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--allow-partial') {
      options.allowPartial = true;
      continue;
    }
    const value = argv[++index];
    if (!value) throw new Error(`${argv[index - 1]}에 값이 필요합니다.`);
    if (argv[index - 1] === '--source') options.sourceDirectory = path.resolve(value);
    else if (argv[index - 1] === '--output') options.outputPath = path.resolve(value);
    else if (argv[index - 1] === '--overrides') options.overridesPath = path.resolve(value);
    else if (argv[index - 1] === '--inventory') options.inventoryPath = path.resolve(value);
    else throw new Error(`알 수 없는 인자: ${argv[index - 1]}`);
  }
  return options;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  buildManifest(cliOptions(process.argv.slice(2)))
    .then(({ exams }) => console.log(`manifest.json 생성 완료: ${exams.length}개 항목`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
