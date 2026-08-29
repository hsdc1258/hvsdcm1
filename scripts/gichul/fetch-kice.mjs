import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

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
const SOCIAL_SUBJECTS = Object.freeze(['soc_culture', 'politics_law']);
const MAX_ZIP_ENTRY_BYTES = 128 * 1024 * 1024;
const DEFAULT_ARCHIVE_FILE_OPERATIONS = Object.freeze({ rename, stat, unlink, writeFile });

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

function formFromFilename(filename) {
  const value = compact(filename);
  // 2020 수능 영어는 긴 "홀수형/짝수형"이 아니라 "영어_홀.pdf/영어_짝.pdf"로
  // 게시됐다. 확장자 직전의 한 글자 표기도 같은 form 계약으로 접어 canonical target
  // 충돌에서 홀수형을 선택한다.
  if (value.includes('홀수형') || /홀pdf$/u.test(value)) return 'odd';
  if (value.includes('짝수형') || /짝pdf$/u.test(value)) return 'even';
  return null;
}

export function canonicalFormFromProvenance(sourceFilename, archiveEntry) {
  return formFromFilename(archiveEntry || sourceFilename) || 'single';
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

function isAccessoryFilename(filename) {
  return /(?:듣기|음원|대본|mp3|점자)/u.test(compact(filename));
}

function matchesAreaContext(filename, context) {
  const value = compact(filename);
  const markers = {
    korean: ['국어', '1교시'],
    math: ['수학', '2교시'],
    english: ['영어', '3교시'],
    social: ['사회탐구', '4교시'],
  }[context.subject] || [];
  return markers.some((marker) => value.includes(marker));
}

function derivedOutputSpecs(context) {
  if (context.subject === 'social') {
    return SOCIAL_SUBJECTS.map((subject) => ({ subject, track: null }));
  }
  if (context.subject === 'math' && context.academicYear <= 2021) {
    return ['ga', 'na'].map((track) => ({ subject: 'math', track }));
  }
  return [{ subject: context.subject, track: null }];
}

export function classifyAttachment(filename, context) {
  const isPdf = /\.pdf$/iu.test(filename);
  const isZip = /\.zip$/iu.test(filename);
  if ((!isPdf && !isZip) || isAccessoryFilename(filename)) return null;
  const kind = kindFromFilename(filename);
  const year = context.academicYear - 1;
  if (isZip) {
    if (!matchesAreaContext(filename, context)) return null;
    const archiveKind = kind || 'question';
    return {
      archive: true,
      outputSpecs: derivedOutputSpecs(context),
      subject: context.subject,
      track: null,
      kind: archiveKind,
      year,
      gradeYear: context.academicYear,
      round: context.round,
      target: `${year}-${context.round}-${context.subject}-${archiveKind}.zip`,
    };
  }
  if (!kind) return null;

  const socialSubject = context.subject === 'social' ? socialSubjectFromFilename(filename) : null;
  if (context.subject === 'social' && !socialSubject && kind === 'answer' && matchesAreaContext(filename, context)) {
    return {
      archive: false,
      replicate: true,
      outputSpecs: derivedOutputSpecs(context),
      subject: 'social',
      track: null,
      kind,
      year,
      gradeYear: context.academicYear,
      round: context.round,
      target: `${year}-${context.round}-social-${kind}.pdf`,
    };
  }

  const subject = context.subject === 'social' ? socialSubject : context.subject;
  if (!subject) return null;

  const track = subject === 'math' && context.academicYear <= 2021
    ? legacyMathTrackFromFilename(filename)
    : null;
  const target = `${year}-${context.round}-${subject}${track ? `-${track}` : ''}-${kind}.pdf`;
  return {
    archive: false,
    subject,
    track,
    kind,
    form: kind === 'question' ? formFromFilename(filename) : null,
    year,
    gradeYear: context.academicYear,
    round: context.round,
    target,
  };
}

function attachmentAnchors(html) {
  const anchors = [];
  for (const [tag] of String(html).matchAll(/<a\b[^>]*>/giu)) {
    const attributes = attributesOf(tag);
    const onclick = attributes.get('onclick') || '';
    const fileSeq = /fn_fileDown\s*\(\s*['"]([\da-f]{32})['"]\s*\)/iu.exec(onclick)?.[1];
    if (fileSeq) anchors.push({ attributes, fileSeq });
  }
  return anchors;
}

function listPageAttachmentFingerprint(html) {
  const fileSeqs = [...new Set(attachmentAnchors(html).map(({ fileSeq }) => fileSeq.toLowerCase()))];
  return fileSeqs.length > 0 ? fileSeqs.sort().join(':') : null;
}

function contextDescription(context) {
  const round = { '06': '6월', '09': '9월', csat: '수능' }[context.round] || context.round;
  return `학년도 ${context.academicYear} / 회차 ${round} / 영역 ${context.area || context.subject} / boardID ${context.boardID}`;
}

function originalFilename(attachment) {
  return attachment.archiveEntry || attachment.filename;
}

function attachmentDescription(attachment) {
  return `원본 파일명="${originalFilename(attachment)}", fileSeq=${attachment.fileSeq}, 게시판 문맥="${contextDescription(attachment.context)}"`;
}

function collisionError(target, first, second) {
  return new Error(`서로 다른 첨부가 같은 파일명으로 정규화됩니다: ${target}; 첫 번째[${attachmentDescription(first)}]; 두 번째[${attachmentDescription(second)}]`);
}

function expectedDerivedOutputs(attachment) {
  return attachment.outputSpecs.map(({ subject, track }) => ({
    ...attachment,
    subject,
    track,
    target: `${attachment.year}-${attachment.round}-${subject}${track ? `-${track}` : ''}-${attachment.kind}.pdf`,
  }));
}

function registerDirectAssignment(assignments, attachment, log) {
  const existing = assignments.get(attachment.target);
  if (!existing) {
    assignments.set(attachment.target, attachment);
    return;
  }
  if (existing.fileSeq.toLowerCase() === attachment.fileSeq.toLowerCase()
    && originalFilename(existing) === originalFilename(attachment)) return;

  const isOddEvenPair = existing.kind === 'question'
    && attachment.kind === 'question'
    && new Set([existing.form, attachment.form]).size === 2
    && [existing.form, attachment.form].every((form) => form === 'odd' || form === 'even');
  if (!isOddEvenPair) throw collisionError(attachment.target, existing, attachment);

  const odd = existing.form === 'odd' ? existing : attachment;
  const even = existing.form === 'even' ? existing : attachment;
  assignments.set(attachment.target, odd);
  log(`skip even form ${originalFilename(even)}; keep odd form ${originalFilename(odd)} (${contextDescription(odd.context)})`);
}

function registerAssignment(assignments, attachment, log) {
  if (!attachment.outputSpecs) {
    registerDirectAssignment(assignments, attachment, log);
    return;
  }
  for (const output of expectedDerivedOutputs(attachment)) {
    const existing = assignments.get(output.target);
    if (existing && existing.fileSeq.toLowerCase() !== attachment.fileSeq.toLowerCase()) {
      throw collisionError(output.target, existing, attachment);
    }
  }
  for (const output of expectedDerivedOutputs(attachment)) assignments.set(output.target, attachment);
}

export function parseListPage(html, context, { log } = {}) {
  const attachments = [];
  for (const { attributes, fileSeq } of attachmentAnchors(html)) {
    const filename = path.basename(attributes.get('title') || '');
    if (!filename) continue;
    const classified = classifyAttachment(filename, context);
    if (classified) attachments.push({ fileSeq, filename, context: { ...context }, ...classified });
    else if (typeof log === 'function') log(`skip accessory ${filename} (${contextDescription(context)})`);
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

const ZIP_CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
}));

function zipCrc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = ZIP_CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function unicodeZipPath(extra, encodedName) {
  for (let offset = 0; offset + 4 <= extra.length;) {
    const type = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const end = offset + 4 + size;
    if (end > extra.length) throw new Error('ZIP extra field 길이가 잘못되었습니다.');
    if (type === 0x7075 && size >= 5) {
      const value = extra.subarray(offset + 4, end);
      if (value[0] === 1 && value.readUInt32LE(1) === zipCrc32(encodedName)) {
        return value.subarray(5).toString('utf8');
      }
    }
    offset = end;
  }
  return null;
}

function decodeZipPath(encodedName, flags, extra) {
  if (flags & 0x0800) return encodedName.toString('utf8');
  const unicodePath = unicodeZipPath(extra, encodedName);
  if (unicodePath) return unicodePath;
  return new TextDecoder('euc-kr').decode(encodedName);
}

function findZipEnd(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  throw new Error('ZIP 중앙 디렉터리 끝 레코드를 찾을 수 없습니다.');
}

function zipEntries(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 22) throw new Error('ZIP 파일이 너무 짧습니다.');
  const endOffset = findZipEnd(bytes);
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error('분할 ZIP은 지원하지 않습니다.');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 형식은 지원하지 않습니다.');
  }
  if (centralOffset + centralSize > endOffset) throw new Error('ZIP 중앙 디렉터리 범위가 잘못되었습니다.');

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`ZIP 중앙 디렉터리 엔트리 ${index + 1}이 잘못되었습니다.`);
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new Error(`ZIP 중앙 디렉터리 엔트리 ${index + 1} 범위가 잘못되었습니다.`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 엔트리는 지원하지 않습니다.');
    }
    const encodedName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    entries.push({
      name: decodeZipPath(encodedName, flags, extra),
      flags,
      method,
      checksum,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new Error('ZIP 중앙 디렉터리 크기가 일치하지 않습니다.');
  return { bytes, entries };
}

function extractZipEntry(zip, entry) {
  if (entry.flags & 0x0001) throw new Error(`암호화된 ZIP 엔트리는 지원하지 않습니다: ${entry.name}`);
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    throw new Error(`ZIP 엔트리가 허용 크기를 초과합니다: ${entry.name}`);
  }
  if (entry.localOffset + 30 > zip.bytes.length || zip.bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error(`ZIP 로컬 엔트리가 잘못되었습니다: ${entry.name}`);
  }
  const nameLength = zip.bytes.readUInt16LE(entry.localOffset + 26);
  const extraLength = zip.bytes.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > zip.bytes.length) throw new Error(`ZIP 압축 데이터 범위가 잘못되었습니다: ${entry.name}`);
  const compressed = zip.bytes.subarray(start, end);
  let output;
  if (entry.method === 0) output = Buffer.from(compressed);
  else if (entry.method === 8) output = inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
  else throw new Error(`지원하지 않는 ZIP 압축 방식 ${entry.method}: ${entry.name}`);
  if (output.length !== entry.uncompressedSize || zipCrc32(output) !== entry.checksum) {
    throw new Error(`ZIP 엔트리 무결성 검사 실패: ${entry.name}`);
  }
  return output;
}

function archiveBasename(name) {
  return String(name).replaceAll('\\', '/').split('/').at(-1) || '';
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

async function cachedDerivedOutputs(attachment, outputDirectory, previousFiles) {
  const outputs = expectedDerivedOutputs(attachment).map((output) => ({
    ...output,
    archiveEntry: previousFiles.get(output.target)?.archiveEntry,
  }));
  for (const output of outputs) {
    const previous = previousFiles.get(output.target);
    if (previous?.fileSeq !== attachment.fileSeq
      || (attachment.archive && !previous.archiveEntry)
      || !await hasPdfMagic(path.join(outputDirectory, output.target))) return null;
  }
  return {
    outputs,
    results: outputs.map((output) => ({ status: 'skipped', target: path.join(outputDirectory, output.target) })),
  };
}

async function existingRegularFile(file, fileOperations) {
  try {
    const metadata = await fileOperations.stat(file);
    if (!metadata.isFile()) throw new Error(`ZIP 추출 대상이 일반 파일 경로가 아닙니다: ${file}`);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function cleanFiles(files, fileOperations) {
  await Promise.all(files.map((file) => fileOperations.unlink(file).catch(() => {})));
}

async function commitArchiveOutputs(prepared, fileOperations, log) {
  for (const item of prepared) item.hadOriginal = await existingRegularFile(item.target, fileOperations);

  const writes = await Promise.allSettled(prepared.map(({ bytes, temporary }) => (
    fileOperations.writeFile(temporary, bytes)
  )));
  const writeFailure = writes.find(({ status }) => status === 'rejected');
  if (writeFailure) {
    await cleanFiles(prepared.map(({ temporary }) => temporary), fileOperations);
    throw writeFailure.reason;
  }

  try {
    for (const item of prepared) {
      if (!item.hadOriginal) continue;
      await fileOperations.rename(item.target, item.backup);
      item.backupStaged = true;
    }
    for (const item of prepared) {
      await fileOperations.rename(item.temporary, item.target);
      item.outputInstalled = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...prepared].reverse()) {
      if (!item.outputInstalled) continue;
      try {
        await fileOperations.unlink(item.target);
        item.outputInstalled = false;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const item of [...prepared].reverse()) {
      if (!item.backupStaged) continue;
      try {
        await fileOperations.rename(item.backup, item.target);
        item.backupStaged = false;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    await cleanFiles(prepared.map(({ temporary }) => temporary), fileOperations);
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], '복수 산출물 저장 실패 후 원본 복구도 완료하지 못했습니다.');
    }
    throw error;
  }

  const backupCleanup = await Promise.allSettled(prepared
    .filter(({ backupStaged }) => backupStaged)
    .map(({ backup }) => fileOperations.unlink(backup)));
  if (backupCleanup.some(({ status }) => status === 'rejected')) {
    log('warning stale output backup file remains after successful write');
  }
}

async function saveArchive(fetchImpl, attachment, outputDirectory, previousFiles, log, fileOperations) {
  const cached = await cachedDerivedOutputs(attachment, outputDirectory, previousFiles);
  if (cached) return cached;

  const response = await fetchImpl(downloadUrl(attachment.fileSeq), {
    headers: { accept: 'application/zip,application/octet-stream' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`ZIP 요청 실패 ${response.status}: ${attachment.filename}`);
  const archiveBytes = Buffer.from(await response.arrayBuffer());
  const archive = zipEntries(archiveBytes);
  const expected = new Map(expectedDerivedOutputs(attachment).map((output) => [output.target, output]));
  const selected = new Map();

  for (const entry of archive.entries) {
    const filename = archiveBasename(entry.name);
    if (!filename || entry.name.endsWith('/')) continue;
    const entryKind = /\.pdf$/iu.test(filename) ? kindFromFilename(filename) : null;
    if (!/\.pdf$/iu.test(filename)
      || isAccessoryFilename(filename)
      || (entryKind && entryKind !== attachment.kind)) {
      log(`skip archive entry ${filename} from ${attachment.filename} (${contextDescription(attachment.context)})`);
      continue;
    }
    const subject = attachment.subject === 'social'
      ? socialSubjectFromFilename(filename)
      : attachment.subject;
    const track = attachment.subject === 'math' && attachment.gradeYear <= 2021
      ? legacyMathTrackFromFilename(filename)
      : null;
    const target = `${attachment.year}-${attachment.round}-${subject}${track ? `-${track}` : ''}-${attachment.kind}.pdf`;
    const output = subject && expected.get(target);
    if (!output) {
      log(`skip archive entry ${filename} from ${attachment.filename} (${contextDescription(attachment.context)})`);
      continue;
    }
    registerDirectAssignment(selected, {
      ...output,
      archiveEntry: entry.name,
      form: output.kind === 'question' ? formFromFilename(filename) : null,
      zipEntry: entry,
    }, log);
  }

  const missing = [...expected.values()].filter((output) => !selected.has(output.target));
  if (missing.length) {
    const names = archive.entries.map(({ name }) => archiveBasename(name)).filter(Boolean);
    const label = attachment.subject === 'social' ? '탐구 ZIP' : 'ZIP';
    throw new Error(`${label} 결측 목록 (${missing.length}개): ${missing.map(({ target }) => target).join(', ')}; ${attachmentDescription(attachment)}; ZIP 엔트리=${names.join(', ')}`);
  }

  const prepared = [];
  const transaction = `${process.pid}-${Date.now()}`;
  for (const candidate of selected.values()) {
    const bytes = extractZipEntry(archive, candidate.zipEntry);
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error(`ZIP 엔트리가 PDF가 아닙니다: ${candidate.archiveEntry} (${attachment.filename})`);
    }
    const target = path.join(outputDirectory, candidate.target);
    const temporary = `${target}.${transaction}.tmp`;
    const backup = `${target}.${transaction}.bak`;
    prepared.push({ bytes, candidate, target, temporary, backup });
  }

  await commitArchiveOutputs(prepared, fileOperations, log);

  return {
    outputs: prepared.map(({ candidate }) => {
      const { zipEntry, ...output } = candidate;
      return output;
    }),
    results: prepared.map(({ target }) => ({ status: 'downloaded', target })),
  };
}

async function saveReplicatedPdf(fetchImpl, attachment, outputDirectory, previousFiles, log, fileOperations) {
  const cached = await cachedDerivedOutputs(attachment, outputDirectory, previousFiles);
  if (cached) return cached;

  const response = await fetchImpl(downloadUrl(attachment.fileSeq), {
    headers: { accept: 'application/pdf' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`PDF 요청 실패 ${response.status}: ${attachment.filename}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error(`PDF가 아닌 응답입니다: ${attachment.filename}`);
  }

  const transaction = `${process.pid}-${Date.now()}`;
  const prepared = expectedDerivedOutputs(attachment).map((candidate) => {
    const target = path.join(outputDirectory, candidate.target);
    return {
      bytes,
      candidate,
      target,
      temporary: `${target}.${transaction}.tmp`,
      backup: `${target}.${transaction}.bak`,
    };
  });
  await commitArchiveOutputs(prepared, fileOperations, log);
  return {
    outputs: prepared.map(({ candidate }) => candidate),
    results: prepared.map(({ target }) => ({ status: 'downloaded', target })),
  };
}

async function saveSource(fetchImpl, attachment, outputDirectory, previousFiles, log, fileOperations) {
  if (attachment.archive) {
    return saveArchive(fetchImpl, attachment, outputDirectory, previousFiles, log, fileOperations);
  }
  if (attachment.replicate) {
    return saveReplicatedPdf(fetchImpl, attachment, outputDirectory, previousFiles, log, fileOperations);
  }
  return {
    outputs: [attachment],
    results: [await savePdf(fetchImpl, attachment, outputDirectory, previousFiles)],
  };
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
    throw new Error(`평가원 코퍼스가 불완전합니다 (${missing.length}개 누락): ${missing.join(', ')}`);
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
      archiveEntry: attachment.archiveEntry,
      canonical_form: attachment.kind === 'question'
        ? canonicalFormFromProvenance(attachment.filename, attachment.archiveEntry)
        : 'single',
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
  archiveFileOperations = DEFAULT_ARCHIVE_FILE_OPERATIONS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch 구현이 필요합니다.');
  const fileOperations = { ...DEFAULT_ARCHIVE_FILE_OPERATIONS, ...archiveFileOperations };
  await mkdir(outputDirectory, { recursive: true });
  const previousFiles = await readInventory(inventoryPath);
  const assignments = new Map();
  const seenFileSeqs = new Set();

  for (const [contextIndex, context] of contexts.entries()) {
    const firstHtml = await responseText(fetchImpl, listUrl(context, 1));
    const lastPage = lastPageFromHtml(firstHtml);
    const seenPageFingerprints = new Set();
    for (let page = 1; page <= lastPage; page += 1) {
      const html = page === 1 ? firstHtml : await responseText(fetchImpl, listUrl(context, page));
      // KICE can repeat a boundary page for an out-of-range number; stop cycles before stale rows are classified.
      const pageFingerprint = listPageAttachmentFingerprint(html);
      if (pageFingerprint && seenPageFingerprints.has(pageFingerprint)) break;
      if (pageFingerprint) seenPageFingerprints.add(pageFingerprint);

      for (const attachment of parseListPage(html, context, { log })) {
        const fileSeqKey = attachment.fileSeq.toLowerCase();
        if (seenFileSeqs.has(fileSeqKey)) continue;
        registerAssignment(assignments, attachment, log);
        seenFileSeqs.add(fileSeqKey);
      }
      if (delayMs > 0 && (page < lastPage || contextIndex < contexts.length - 1)) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  const sources = [...new Map([...assignments.values()].map((attachment) => [
    attachment.fileSeq.toLowerCase(), attachment,
  ])).values()].sort((left, right) => left.target.localeCompare(right.target));
  const results = [];
  const outputs = [];
  for (const attachment of sources) {
    const saved = await saveSource(fetchImpl, attachment, outputDirectory, previousFiles, log, fileOperations);
    outputs.push(...saved.outputs);
    for (const result of saved.results) {
      results.push(result);
      log(`${result.status === 'skipped' ? 'skip' : 'download'} ${path.basename(result.target)}`);
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  outputs.sort((left, right) => left.target.localeCompare(right.target));
  await writeInventory(inventoryPath, outputs);
  if (!allowPartial) validateAssignmentCoverage(outputs);
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
