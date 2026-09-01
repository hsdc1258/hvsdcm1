import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildLearningPayloads } from './build-payloads.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUTPUT = path.join(ROOT, '.learning-dist');
const DEFAULT_BUCKET = 'hvsdcm-gichul';

async function readState(file) {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  return parsed?.objects && typeof parsed.objects === 'object' ? parsed.objects : {};
}
function wranglerInvocation() {
  const cli = path.join(ROOT, 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(cli)) throw new Error('worker/node_modules의 Wrangler를 찾지 못했습니다.');
  return { command: process.execPath, arguments: [cli] };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Wrangler가 종료 코드 ${code}로 실패했습니다.`)));
  });
}

async function writeState(file, objects) {
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({
    version: 1,
    objects: Object.fromEntries(objects.map(({ key, sha256 }) => [key, sha256])),
  }, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export async function uploadLearningR2({
  outputDirectory = DEFAULT_OUTPUT,
  statePath = path.join(outputDirectory, '.r2-upload-state.json'),
  bucket = DEFAULT_BUCKET,
  run = runProcess,
  executable,
  log = console.log,
} = {}) {
  const manifest = buildLearningPayloads({ outputDirectory });
  const previous = await readState(statePath);
  // 이미지는 먼저, 세 JSON payload는 visibility switch로 마지막에 올린다.
  const changed = manifest.objects.filter((object) => previous[object.key] !== object.sha256);
  const invocation = executable ? { command: executable, arguments: [] } : wranglerInvocation();
  for (const object of changed) {
    await run(invocation.command, [...invocation.arguments,
      'r2', 'object', 'put', `${bucket}/${object.key}`,
      '--file', path.join(ROOT, object.file),
      '--content-type', object.content_type,
      '--remote',
    ]);
    log(`upload ${object.key}`);
  }
  await writeState(statePath, manifest.objects);
  return { uploaded: changed.map(({ key }) => key), skipped: manifest.objects.length - changed.length };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const bucketIndex = process.argv.indexOf('--bucket');
  const bucket = bucketIndex >= 0 ? process.argv[bucketIndex + 1] : DEFAULT_BUCKET;
  uploadLearningR2({ bucket }).then((result) => {
    console.log(`Learning R2 upload complete: ${result.uploaded.length} uploaded / ${result.skipped} skipped`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
