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
import { canonicalFormFromProvenance } from './fetch-kice.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const DEFAULT_SOURCE_DIRECTORY = path.join(ROOT, 'gichul-src');
const DEFAULT_INVENTORY_PATH = path.join(DEFAULT_SOURCE_DIRECTORY, 'crawl-inventory.json');
const DEFAULT_OVERRIDES_PATH = path.join(SCRIPT_DIRECTORY, 'overrides.json');

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

export function detectSectionStarts(pageTexts, trackDefinitions) {
  const starts = new Map();
  for (const definition of trackDefinitions) {
    const candidates = pageTexts
      .map((text, index) => ({ page: index + 1, score: headerScore(text, definition.header) }))
      .filter((candidate) => candidate.page > 1 && candidate.score > 0)
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
  const document = await pdfjs.getDocument({ data, disableWorker: true, useSystemFonts: true }).promise;
  const pageTexts = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join(''));
    }
  } finally {
    await document.destroy();
  }
  return { pageCount: pageTexts.length, pageTexts };
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
  return exams;
}

function sectionMapFor(source, pageTexts, pageCount, tracks, overrides, usedOverrides, availability) {
  if (source.kind !== 'question') return new Map();
  const definitions = trackDescriptorsFor(availability, source.gradeYear, source.subject)
    .filter(({ id, section_header: header }) => tracks.includes(id) && header)
    .map(({ id: track, section_header: header }) => ({ track, header }));
  if (!definitions.length) return new Map();
  const manual = new Map(definitions.map(({ track }) => {
    const id = idFor(source, track);
    const override = normalizedOverride(overrides[id], id);
    if (override) usedOverrides.add(id);
    return [track, override];
  }));
  const missingDefinitions = definitions.filter(({ track }) => !manual.get(track));
  const detected = missingDefinitions.length ? detectSectionStarts(pageTexts, missingDefinitions) : new Map();
  const starts = new Map(definitions.map(({ track }) => [
    track,
    manual.get(track)?.selection?.[0] ?? detected.get(track),
  ]));
  const orderedStarts = [...starts.values()].sort((left, right) => left - right);
  if (new Set(orderedStarts).size !== orderedStarts.length) {
    throw new Error(`${source.year}-${source.round}-${source.subject}: 선택과목 시작 페이지가 겹칩니다.`);
  }
  const common = [1, Math.min(...orderedStarts) - 1];
  const result = new Map();
  for (const { track } of definitions) {
    if (manual.get(track)) {
      result.set(track, manual.get(track));
      continue;
    }
    const start = starts.get(track);
    const next = orderedStarts.find((candidate) => candidate > start);
    result.set(track, { common, selection: [start, next ? next - 1 : pageCount] });
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
  for (const entry of inventory.files) {
    if (!entry || typeof entry.target !== 'string' || !/^[\da-f]{32}$/iu.test(entry.fileSeq || '')) {
      throw new Error('crawl inventory에 잘못된 target/fileSeq가 있습니다.');
    }
    if (targets.has(entry.target)) throw new Error(`crawl inventory target 중복: ${entry.target}`);
    const source = parseSourceFilename(entry.target, availability);
    const canonicalForm = canonicalFormFromProvenance(entry.sourceFilename, entry.archiveEntry);
    if (!['odd', 'even', 'single'].includes(entry.canonical_form)
      || entry.canonical_form !== (source.kind === 'question' ? canonicalForm : 'single')) {
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

  for (const file of files.sort()) {
    const source = parseSourceFilename(file, activeAvailability);
    const extracted = await extractText(file);
    const pageCount = Number(extracted?.pageCount);
    const pageTexts = extracted?.pageTexts;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1
      || !Array.isArray(pageTexts) || pageTexts.length !== pageCount) {
      throw new Error(`${path.basename(file)}: 텍스트 추출기가 유효한 pageCount/pageTexts를 반환하지 않았습니다.`);
    }
    const tracks = tracksForSource(source, activeAvailability);
    const sections = sectionMapFor(
      source, pageTexts, pageCount, tracks, overrides, usedOverrides, activeAvailability,
    );
    const r2Key = path.relative(sourceDirectory, file).split(path.sep).join('/');
    const canonicalForm = inventoryByTarget?.get(r2Key)?.canonical_form;
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
        ...(source.kind === 'question' && canonicalForm ? { canonical_form: canonicalForm } : {}),
        ...(sections.has(track) ? { sections: sections.get(track) } : {}),
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
