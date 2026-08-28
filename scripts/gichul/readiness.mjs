import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planUploads } from './upload-r2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDirectory = path.join(ROOT, 'gichul-src');

export async function verifyGichulReadiness({
  manifestPath = path.join(sourceDirectory, 'manifest.json'),
  evidencePath = path.join(sourceDirectory, 'readiness.json'),
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const plan = await planUploads({ sourceDirectory: path.dirname(manifestPath), manifestPath });
  const referenced = new Set((manifest.exams || []).map((exam) => exam.r2_key));
  if (!Array.isArray(manifest.exams) || manifest.exams.length === 0) throw new Error('기출 manifest가 비어 있습니다.');
  if (plan.objects.length !== referenced.size + 1) throw new Error('기출 manifest와 업로드 object 수가 다릅니다.');

  const evidence = {
    version: 1,
    verified_at: new Date().toISOString(),
    exams: manifest.exams.length,
    objects: plan.objects.length,
    manifest_sha256: plan.objects.find((object) => object.key === 'manifest.json')?.hash,
    referenced_sha256: Object.fromEntries(plan.objects
      .filter((object) => object.key !== 'manifest.json')
      .map((object) => [object.key, object.hash])),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidence;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  verifyGichulReadiness().then((evidence) => {
    console.log(`Gichul R2 readiness PASS: ${evidence.exams} exams / ${evidence.objects} objects`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
