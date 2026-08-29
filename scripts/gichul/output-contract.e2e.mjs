import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { canonicalFormFromProvenance } from './fetch-kice.mjs';
import { createGichulRenderers } from '../render-sandbox.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const DEFAULT_SOURCE_DIRECTORY = path.join(ROOT, 'gichul-src');
const DEFAULT_MANIFEST_PATH = path.join(DEFAULT_SOURCE_DIRECTORY, 'manifest.json');
const DEFAULT_INVENTORY_PATH = path.join(DEFAULT_SOURCE_DIRECTORY, 'crawl-inventory.json');
const PDF_LIB_PATH = path.join(ROOT, 'assets', 'vendor', 'pdf-lib', 'pdf-lib.min.js');
const CMAP_URL = `${path.join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps')}${path.sep}`;
const EXPECTED_SELECTION_NUMBERS = Object.freeze(Array.from({ length: 11 }, (_, index) => 35 + index));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedText(items) {
  return items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`)
    .join('')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function canonicalOperatorValue(value, seen = new WeakSet(), references = new Map()) {
  if (value === null || value === undefined || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'string') {
    // PDF.js가 문서/페이지 로드 순서에서 만든 리소스 ID만 접는다. 실제 글자·좌표·연산자와
    // 이미지/폰트 내용은 아래 값과 typed-array hash에 남으므로 다른 페이지는 같아지지 않는다.
    if (/^\d+R$/u.test(value)) {
      if (!references.has(value)) references.set(value, `R${references.size + 1}`);
      return references.get(value);
    }
    return value.replace(/^g_d\d+_/u, 'g_d#_').replace(/([_-])p\d+_/gu, '$1p#_');
  }
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value);
  if (ArrayBuffer.isView(value)) {
    return { type: value.constructor.name, sha256: sha256(Buffer.from(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalOperatorValue(entry, seen, references));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalOperatorValue(value[key], seen, references);
  seen.delete(value);
  return result;
}

async function loadPdfJsDocument(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(bytes);
  return pdfjs.getDocument({
    data,
    disableWorker: true,
    useSystemFonts: true,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
  }).promise;
}

export async function inspectPdf(bytes) {
  const metadataDocument = await loadPdfJsDocument(bytes);
  const pageCount = metadataDocument.numPages;
  await metadataDocument.destroy();
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    // PDF.js dependency 연산자는 앞 페이지를 이미 읽었는지에 따라 생략될 수 있다. 페이지마다
    // 문서를 새로 열어 같은 source page가 병합 위치와 무관하게 같은 content hash를 갖게 한다.
    const document = await loadPdfJsDocument(bytes);
    try {
      const page = await document.getPage(pageNumber);
      const [textContent, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
      const text = normalizedText(textContent.items);
      const contentHash = sha256(JSON.stringify(canonicalOperatorValue({
        fn: operators.fnArray,
        args: operators.argsArray,
      })));
      pages.push({
        page: pageNumber,
        text,
        text_sha256: sha256(text),
        content_sha256: contentHash,
        fingerprint: sha256(`${sha256(text)}\0${contentHash}`),
      });
    } finally {
      await document.destroy();
    }
  }
  return pages;
}

async function loadPdfLib() {
  // 다른 VM realm에서 평가하면 pdf-lib의 Uint8Array 판정과 Node Buffer의 생성자가 달라져
  // 정상 PDF가 숫자 하나로 오인된다. 현재 realm에서 browser bundle만 평가해 타입 경계를 맞춘다.
  vm.runInThisContext(await readFile(PDF_LIB_PATH, 'utf8'), { filename: PDF_LIB_PATH });
  if (typeof globalThis.PDFLib?.PDFDocument?.load !== 'function') {
    throw new Error(`vendored pdf-lib를 불러오지 못했습니다: ${PDF_LIB_PATH}`);
  }
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
    for (const [from, to] of segment.ranges) {
      const indices = Array.from({ length: to - from + 1 }, (_, index) => from + index - 1);
      const copied = await output.copyPages(source, indices);
      for (const page of copied) output.addPage(page);
    }
  }
  return Buffer.from(await output.save({ useObjectStreams: false }));
}

function pageRecords(pages, range) {
  const [from, to] = range;
  return pages.slice(from - 1, to);
}

function fingerprintCounts(records) {
  const counts = new Map();
  for (const { fingerprint } of records) counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
  return counts;
}

function foreignPageCount(actual, expected) {
  const remaining = fingerprintCounts(expected);
  let foreign = 0;
  for (const { fingerprint } of actual) {
    const count = remaining.get(fingerprint) || 0;
    if (count === 0) foreign += 1;
    else remaining.set(fingerprint, count - 1);
  }
  return foreign;
}

function commonDuplicateCount(actual, common) {
  const actualCounts = fingerprintCounts(actual);
  const expectedCounts = fingerprintCounts(common);
  let duplicates = 0;
  for (const [fingerprint, expected] of expectedCounts) {
    duplicates += Math.max(0, (actualCounts.get(fingerprint) || 0) - expected);
  }
  return duplicates;
}

function questionNumbers(pageTexts) {
  const found = new Set();
  const source = pageTexts.join('\n').normalize('NFKC');
  for (const match of source.matchAll(/(?:^|\s)(3[5-9]|4[0-5])\s*[.)]/gmu)) found.add(Number(match[1]));
  return [...found].sort((left, right) => left - right);
}

function inventoryByTarget(inventory) {
  if (inventory?.version !== 1 || !Array.isArray(inventory.files)) {
    throw new Error('crawl-inventory.json 형식이 잘못되었습니다.');
  }
  return new Map(inventory.files.map((entry) => [entry.target, entry]));
}

function segmentsExpectedPages(sourcePages, segments) {
  return segments.flatMap((segment) => segment.ranges.flatMap((range) => pageRecords(sourcePages, range)));
}

export async function runOutputContract({
  cases,
  outDirectory,
  sourceDirectory = DEFAULT_SOURCE_DIRECTORY,
  manifestPath = DEFAULT_MANIFEST_PATH,
  inventoryPath = DEFAULT_INVENTORY_PATH,
} = {}) {
  if (!Array.isArray(cases) || cases.length < 2) throw new Error('--cases에는 실제 회차 ID를 최소 2개 지정해야 합니다.');
  if (!outDirectory) throw new Error('--out 경로가 필요합니다.');
  const [manifestBytes, inventoryBytes] = await Promise.all([readFile(manifestPath), readFile(inventoryPath)]);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const inventory = inventoryByTarget(JSON.parse(inventoryBytes.toString('utf8')));
  const byId = new Map((manifest.exams || []).map((exam) => [exam.id, exam]));
  const planner = createGichulRenderers();
  const { PDFDocument } = await loadPdfLib();
  const results = [];
  await mkdir(outDirectory, { recursive: true });

  for (const id of cases) {
    const exam = byId.get(id);
    if (!exam) throw new Error(`manifest에 E2E 회차가 없습니다: ${id}`);
    if (!Array.isArray(exam.sections?.common) || !Array.isArray(exam.sections?.selection)) {
      throw new Error(`${id}: common/selection 구간이 없습니다.`);
    }
    const provenance = inventory.get(exam.r2_key);
    if (!provenance) throw new Error(`${id}: inventory provenance가 없습니다 (${exam.r2_key}).`);
    const canonicalForm = canonicalFormFromProvenance(provenance.sourceFilename, provenance.archiveEntry);
    assert.equal(provenance.canonical_form, canonicalForm, `${id}: inventory canonical_form 불일치`);
    assert.equal(exam.canonical_form, canonicalForm, `${id}: manifest canonical_form 불일치`);

    const sourcePath = path.join(sourceDirectory, exam.r2_key);
    const sourceBytes = await readFile(sourcePath);
    const sourcePages = await inspectPdf(sourceBytes);
    assert.equal(sourcePages.length, exam.pages, `${id}: manifest와 source PDF 페이지 수 불일치`);
    const commonPages = pageRecords(sourcePages, exam.sections.common);
    const selectionPages = pageRecords(sourcePages, exam.sections.selection);

    const fullPlan = planner.planSegments([exam], manifest, { ...planner.defaultState(), mode: 'full' });
    const excerptPlan = planner.planSegments([exam], manifest, { ...planner.defaultState(), mode: 'excerpt' });
    assert.equal(fullPlan.missingAnswers.length, 0);
    assert.equal(excerptPlan.missingAnswers.length, 0);
    const fullBytes = await mergeSegments(PDFDocument, sourceDirectory, fullPlan.segments);
    const excerptBytes = await mergeSegments(PDFDocument, sourceDirectory, excerptPlan.segments);
    const fullPath = path.join(outDirectory, `${id}-full.pdf`);
    const excerptPath = path.join(outDirectory, `${id}-excerpt.pdf`);
    await Promise.all([writeFile(fullPath, fullBytes), writeFile(excerptPath, excerptBytes)]);

    // 저장된 바이트를 다시 열어 planner가 요청한 source page fingerprint와 대조한다.
    const [fullPages, excerptPages] = await Promise.all([inspectPdf(await readFile(fullPath)), inspectPdf(await readFile(excerptPath))]);
    const expectedFull = segmentsExpectedPages(sourcePages, fullPlan.segments);
    const expectedExcerpt = segmentsExpectedPages(sourcePages, excerptPlan.segments);
    assert.equal(fullPages.length, expectedFull.length, `${id}: full PDF 페이지 수 불일치`);
    assert.equal(excerptPages.length, expectedExcerpt.length, `${id}: excerpt PDF 페이지 수 불일치`);

    const full = {
      pages: fullPages.length,
      even_input_count: canonicalForm === 'even' ? 1 : 0,
      foreign_page_count: foreignPageCount(fullPages, expectedFull),
      common_duplicate_count: commonDuplicateCount(fullPages, commonPages),
      sha256: sha256(fullBytes),
    };
    const excerpt = {
      pages: excerptPages.length,
      common_page_count: excerptPages.filter(({ fingerprint }) => (
        commonPages.some((page) => page.fingerprint === fingerprint)
      )).length,
      foreign_page_count: foreignPageCount(excerptPages, expectedExcerpt),
      question_numbers: questionNumbers(excerptPages.map(({ text }) => text)),
      sha256: sha256(excerptBytes),
    };
    assert.equal(full.even_input_count, 0, `${id}: full output에 even 원본이 선택됐습니다.`);
    assert.equal(full.foreign_page_count, 0, `${id}: full output에 계약 밖 페이지가 있습니다.`);
    assert.equal(full.common_duplicate_count, 0, `${id}: full output에 공통 페이지가 중복됐습니다.`);
    assert.equal(excerpt.common_page_count, 0, `${id}: excerpt output에 공통 페이지가 있습니다.`);
    assert.equal(excerpt.foreign_page_count, 0, `${id}: excerpt output에 다른 선택과목 페이지가 있습니다.`);
    assert.deepEqual(excerpt.question_numbers, EXPECTED_SELECTION_NUMBERS, `${id}: 선택 문항 번호가 35..45가 아닙니다.`);
    results.push({
      id,
      canonical_form: canonicalForm,
      provenance: {
        target: provenance.target,
        fileSeq: provenance.fileSeq,
        sourceFilename: provenance.sourceFilename,
        archiveEntry: provenance.archiveEntry,
      },
      source_pdf_sha256: sha256(sourceBytes),
      full,
      excerpt,
    });
  }

  const evidence = {
    version: 1,
    generated_at: new Date().toISOString(),
    manifest_sha256: sha256(manifestBytes),
    cases: results,
  };
  const evidencePath = path.join(outDirectory, 'output-contract.json');
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidence;
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[++index];
    if (!value) throw new Error(`${argv[index - 1]}에 값이 필요합니다.`);
    if (argv[index - 1] === '--cases') options.cases = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (argv[index - 1] === '--out') options.outDirectory = path.resolve(value);
    else if (argv[index - 1] === '--source') options.sourceDirectory = path.resolve(value);
    else if (argv[index - 1] === '--manifest') options.manifestPath = path.resolve(value);
    else if (argv[index - 1] === '--inventory') options.inventoryPath = path.resolve(value);
    else throw new Error(`알 수 없는 인자: ${argv[index - 1]}`);
  }
  return options;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runOutputContract(cliOptions(process.argv.slice(2))).then((evidence) => {
    for (const item of evidence.cases) {
      console.log(`${item.id}: full even=${item.full.even_input_count} foreign=${item.full.foreign_page_count}`
        + ` common_duplicate=${item.full.common_duplicate_count}; excerpt common=${item.excerpt.common_page_count}`
        + ` foreign=${item.excerpt.foreign_page_count}; questions=${item.excerpt.question_numbers.join(',')}`);
    }
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
