import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KICE_ORIGIN = 'https://www.suneung.re.kr';
const LIST_PATH = '/boardCnts/list.do';
const DOWNLOAD_PATH = '/boardCnts/fileDown.do';
const ACADEMIC_YEARS = Object.freeze(Array.from({ length: 8 }, (_, index) => 2020 + index));
const AREAS = Object.freeze([
  { query: '국어', subject: 'korean' },
  { query: '수학', subject: 'math' },
  { query: '영어', subject: 'english' },
  { query: '사회탐구', subject: 'social' },
]);
const MOCK_ROUNDS = Object.freeze([
  { query: '6월', round: '06' },
  { query: '9월', round: '09' },
]);

const ENTITY_VALUES = Object.freeze({
  amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
});

function decodeHtml(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (match, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITY_VALUES[entity.toLowerCase()] ?? match;
  });
}

function attributesOf(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) {
    attributes.set(match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/[\s_.()[\]{}-]+/gu, '').toLowerCase();
}

function kindFromFilename(filename) {
  const value = compact(filename);
  if (/(?:정답|답안|해설)/u.test(value)) return 'answer';
  if (/(?:문제지|문제)/u.test(value)) return 'question';
  return null;
}

function socialSubjectFromFilename(filename) {
  const value = compact(filename).replaceAll('·', '');
  if (value.includes('사회문화')) return 'soc_culture';
  if (value.includes('정치와법') || value.includes('법과정치')) return 'politics_law';
  return null;
}

function legacyMathTrackFromFilename(filename) {
  const value = compact(filename);
  const hasGa = /(?:수학)?가형/u.test(value);
  const hasNa = /(?:수학)?나형/u.test(value);
  if (hasGa && hasNa) return null;
  if (hasGa) return 'ga';
  if (hasNa) return 'na';
  return null;
}

export function classifyAttachment(filename, context) {
  if (!/\.pdf$/iu.test(filename)) return null;
  const kind = kindFromFilename(filename);
  if (!kind) return null;

  const subject = context.subject === 'social'
    ? socialSubjectFromFilename(filename)
    : context.subject;
  if (!subject) return null;

  const track = subject === 'math' && context.academicYear <= 2021
    ? legacyMathTrackFromFilename(filename)
    : null;
  const year = context.academicYear - 1;
  const target = `${year}-${context.round}-${subject}${track ? `-${track}` : ''}-${kind}.pdf`;
  return {
    subject,
    track,
    kind,
    year,
    gradeYear: context.academicYear,
    round: context.round,
    target,
  };
}

export function parseListPage(html, context) {
  const attachments = [];
  for (const [tag] of String(html).matchAll(/<a\b[^>]*>/giu)) {
    const attributes = attributesOf(tag);
    const onclick = attributes.get('onclick') || '';
    const fileSeq = /fn_fileDown\s*\(\s*['"]([\da-f]{32})['"]\s*\)/iu.exec(onclick)?.[1];
    const filename = path.basename(attributes.get('title') || '');
    if (!fileSeq || !filename) continue;
    const classified = classifyAttachment(filename, context);
    if (classified) attachments.push({ fileSeq, filename, ...classified });
  }
  return attachments;
}

export function lastPageFromHtml(html) {
  let lastPage = 1;
  const source = String(html);
  for (const pattern of [/[?&]page=(\d+)/giu, /fn_[\w]*link_page\s*\(\s*['"]?(\d+)/giu]) {
    for (const match of source.matchAll(pattern)) lastPage = Math.max(lastPage, Number(match[1]));
  }
  if (!Number.isSafeInteger(lastPage) || lastPage < 1 || lastPage > 100) {
    throw new Error(`목록 페이지 수가 비정상입니다: ${lastPage}`);
  }
  return lastPage;
}

function listContexts() {
  const contexts = [];
  for (const academicYear of ACADEMIC_YEARS) {
    for (const area of AREAS) {
      contexts.push({
        boardID: '1500234',
        academicYear,
        area: area.query,
        subject: area.subject,
        round: 'csat',
      });
      for (const mock of MOCK_ROUNDS) {
        contexts.push({
          boardID: '1500236',
          academicYear,
          month: mock.query,
          area: area.query,
          subject: area.subject,
          round: mock.round,
        });
      }
    }
  }
  return contexts;
}

export function listUrl(context, page = 1) {
  const url = new URL(LIST_PATH, KICE_ORIGIN);
  url.searchParams.set('boardID', context.boardID);
  url.searchParams.set('m', '0403');
  url.searchParams.set('s', 'suneung');
  url.searchParams.set('searchType', 'S');
  url.searchParams.set('page', String(page));
  url.searchParams.set('C01', String(context.academicYear));
  if (context.boardID === '1500234') {
    url.searchParams.set('C02', context.area);
  } else {
    url.searchParams.set('C02', context.month);
    url.searchParams.set('C03', context.area);
  }
  return url;
}

function downloadUrl(fileSeq) {
  const url = new URL(DOWNLOAD_PATH, KICE_ORIGIN);
  url.searchParams.set('fileSeq', fileSeq);
  return url;
}

async function responseText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`목록 요청 실패 ${response.status}: ${url}`);
  return response.text();
}

async function hasPdfMagic(file) {
  if (!existsSync(file) || (await stat(file)).size < 5) return false;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(5);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === 5 && buffer.toString('ascii') === '%PDF-';
  } finally {
    await handle.close();
  }
}

async function savePdf(fetchImpl, attachment, outputDirectory, previousFiles) {
  const target = path.join(outputDirectory, attachment.target);
  const previous = previousFiles.get(attachment.target);
  if (previous?.fileSeq === attachment.fileSeq && await hasPdfMagic(target)) {
    return { status: 'skipped', target };
  }

  const response = await fetchImpl(downloadUrl(attachment.fileSeq), {
    headers: { accept: 'application/pdf' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`PDF 요청 실패 ${response.status}: ${attachment.filename}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 5 || new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error(`PDF가 아닌 응답입니다: ${attachment.filename}`);
  }

  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { status: 'downloaded', target };
}

function defaultOutputDirectory() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gichul-src');
}

function expectedTracks(academicYear, subject) {
  if (subject === 'korean' && academicYear >= 2022) return ['hwajak', 'eonmae'];
  if (subject === 'math' && academicYear >= 2022) return ['hwaktong', 'mijeok', 'giha'];
  if (subject === 'math') return ['ga', 'na'];
  return [null];
}

function requiredRounds(academicYear) {
  return academicYear === 2027 ? ['06'] : ['06', '09', 'csat'];
}

export function validateAssignmentCoverage(attachments) {
  const coverage = new Set();
  for (const attachment of attachments) {
    const tracks = attachment.track === null
      ? expectedTracks(attachment.gradeYear, attachment.subject)
      : [attachment.track];
    for (const track of tracks) {
      coverage.add(`${attachment.gradeYear}-${attachment.round}-${attachment.subject}${track ? `-${track}` : ''}-${attachment.kind}`);
    }
  }
  const missing = [];
  for (const academicYear of ACADEMIC_YEARS) {
    for (const round of requiredRounds(academicYear)) {
      for (const subject of ['korean', 'math', 'english', 'soc_culture', 'politics_law']) {
        for (const track of expectedTracks(academicYear, subject)) {
          for (const kind of ['question', 'answer']) {
            const key = `${academicYear}-${round}-${subject}${track ? `-${track}` : ''}-${kind}`;
            if (!coverage.has(key)) missing.push(key);
          }
        }
      }
    }
  }
  if (missing.length) {
    throw new Error(`평가원 코퍼스가 불완전합니다 (${missing.length}개 누락): ${missing.slice(0, 8).join(', ')}`);
  }
  return attachments;
}

async function readInventory(file) {
  if (!existsSync(file)) return new Map();
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (parsed?.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error(`기존 crawl inventory 형식이 잘못되었습니다: ${file}`);
  }
  return new Map(parsed.files.map((entry) => [entry.target, entry]));
}

async function writeInventory(file, attachments) {
  const temporary = `${file}.${process.pid}.tmp`;
  const inventory = {
    version: 1,
    files: attachments.map((attachment) => ({
      target: attachment.target,
      fileSeq: attachment.fileSeq,
      sourceFilename: attachment.filename,
      grade_year: attachment.gradeYear,
      year: attachment.year,
      round: attachment.round,
      subject: attachment.subject,
      track: attachment.track,
      kind: attachment.kind,
    })),
  };
  await writeFile(temporary, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export async function fetchKice({
  fetchImpl = globalThis.fetch,
  outputDirectory = defaultOutputDirectory(),
  inventoryPath = path.join(outputDirectory, 'crawl-inventory.json'),
  delayMs = 250,
  contexts = listContexts(),
  allowPartial = false,
  log = console.log,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch 구현이 필요합니다.');
  await mkdir(outputDirectory, { recursive: true });
  const previousFiles = await readInventory(inventoryPath);
  const assignments = new Map();

  for (const [contextIndex, context] of contexts.entries()) {
    const firstHtml = await responseText(fetchImpl, listUrl(context, 1));
    const lastPage = lastPageFromHtml(firstHtml);
    for (let page = 1; page <= lastPage; page += 1) {
      const html = page === 1 ? firstHtml : await responseText(fetchImpl, listUrl(context, page));
      for (const attachment of parseListPage(html, context)) {
        const existing = assignments.get(attachment.target);
        if (existing && existing.fileSeq !== attachment.fileSeq) {
          throw new Error(`서로 다른 첨부가 같은 파일명으로 정규화됩니다: ${attachment.target}`);
        }
        assignments.set(attachment.target, attachment);
      }
      if (delayMs > 0 && (page < lastPage || contextIndex < contexts.length - 1)) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  const attachments = [...assignments.values()].sort((left, right) => left.target.localeCompare(right.target));
  if (!allowPartial) validateAssignmentCoverage(attachments);
  const results = [];
  for (const attachment of attachments) {
    const result = await savePdf(fetchImpl, attachment, outputDirectory, previousFiles);
    results.push(result);
    log(`${result.status === 'skipped' ? 'skip' : 'download'} ${path.basename(result.target)}`);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  await writeInventory(inventoryPath, attachments);
  return results;
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') options.outputDirectory = path.resolve(argv[++index]);
    else if (argv[index] === '--delay-ms') options.delayMs = Number(argv[++index]);
    else throw new Error(`알 수 없는 인자: ${argv[index]}`);
  }
  if (options.delayMs !== undefined && (!Number.isFinite(options.delayMs) || options.delayMs < 0)) {
    throw new Error('--delay-ms는 0 이상의 숫자여야 합니다.');
  }
  return options;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  fetchKice(cliOptions(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
