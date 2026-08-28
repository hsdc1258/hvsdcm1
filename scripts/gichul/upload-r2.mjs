import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const DEFAULT_SOURCE_DIRECTORY = path.join(ROOT, 'gichul-src');
const DEFAULT_BUCKET = 'hvsdcm-gichul';

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function resolveInside(root, relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`안전하지 않은 R2 키입니다: ${relativePath}`);
  }
  const absolute = path.resolve(root, ...normalized.split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error(`소스 디렉터리를 벗어난 R2 키입니다: ${relativePath}`);
  return absolute;
}

async function readState(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed?.objects && typeof parsed.objects === 'object' ? parsed.objects : {};
  } catch (error) {
    throw new Error(`업로드 상태 파일을 읽지 못했습니다: ${error.message}`);
  }
}

export async function planUploads({
  sourceDirectory = DEFAULT_SOURCE_DIRECTORY,
  manifestPath = path.join(sourceDirectory, 'manifest.json'),
  statePath = path.join(sourceDirectory, '.r2-upload-state.json'),
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.exams)) throw new Error('manifest.json에 exams 배열이 없습니다.');
  const keys = new Set(['manifest.json']);
  for (const exam of manifest.exams) keys.add(exam.r2_key);
  const previous = await readState(statePath);
  const objects = [];
  for (const key of [...keys].sort()) {
    const file = key === 'manifest.json' ? manifestPath : resolveInside(sourceDirectory, key);
    if (!existsSync(file)) throw new Error(`업로드할 파일이 없습니다: ${key}`);
    const hash = await sha256File(file);
    objects.push({ key, file, hash, changed: previous[key] !== hash });
  }
  return { objects, statePath };
}

function wranglerInvocation() {
  const cli = path.join(ROOT, 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(cli)) {
    throw new Error('worker/node_modules의 Wrangler를 찾지 못했습니다. 오케스트레이터가 먼저 worker에서 npm install을 실행해야 합니다.');
  }
  return { command: process.execPath, arguments: [cli] };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Wrangler가 종료 코드 ${code}로 실패했습니다.`)));
  });
}

async function writeState(file, objects) {
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({
    version: 1,
    objects: Object.fromEntries(objects.map(({ key, hash }) => [key, hash])),
  }, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export async function uploadR2({
  sourceDirectory = DEFAULT_SOURCE_DIRECTORY,
  manifestPath = path.join(sourceDirectory, 'manifest.json'),
  statePath = path.join(sourceDirectory, '.r2-upload-state.json'),
  bucket = DEFAULT_BUCKET,
  run = runProcess,
  executable,
  log = console.log,
} = {}) {
  const plan = await planUploads({ sourceDirectory, manifestPath, statePath });
  // Publish immutable/content objects first. The manifest is the visibility switch and must be last.
  const changed = plan.objects
    .filter((object) => object.changed)
    .sort((left, right) => (left.key === 'manifest.json') - (right.key === 'manifest.json')
      || left.key.localeCompare(right.key));
  const invocation = executable
    ? { command: executable, arguments: [] }
    : wranglerInvocation();
  for (const object of changed) {
    const contentType = object.key === 'manifest.json' ? 'application/json' : 'application/pdf';
    await run(invocation.command, [...invocation.arguments,
      'r2', 'object', 'put', `${bucket}/${object.key}`,
      '--file', object.file,
      '--content-type', contentType,
      '--remote',
    ]);
    log(`upload ${object.key}`);
  }
  await writeState(plan.statePath, plan.objects);
  log(`R2 업로드 완료: 변경 ${changed.length}개, 건너뜀 ${plan.objects.length - changed.length}개`);
  return { uploaded: changed.map(({ key }) => key), skipped: plan.objects.length - changed.length };
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--source') options.sourceDirectory = path.resolve(value);
    else if (argv[index] === '--manifest') options.manifestPath = path.resolve(value);
    else if (argv[index] === '--state') options.statePath = path.resolve(value);
    else if (argv[index] === '--bucket') options.bucket = value;
    else throw new Error(`알 수 없는 인자: ${argv[index]}`);
    index += 1;
  }
  return options;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  uploadR2(cliOptions(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
