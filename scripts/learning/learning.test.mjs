import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLearningPayloads } from './build-payloads.mjs';
import { uploadLearningR2 } from './upload-r2.mjs';

test('learning payload builder locks the protected corpus and uploads JSON visibility switches last', async (t) => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'hvs-learning-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(outputDirectory, { recursive: true, force: true })));
  const manifest = buildLearningPayloads({ outputDirectory });

  assert.deepEqual(manifest.counts, { words: 2000, subunits: 17, questions: 98, images: 78, pl_subunits: 18, pl_questions: 90 });
  assert.equal(manifest.objects.length, 81);
  assert.equal(manifest.objects.at(-3).key, 'learning/wordmaster.json');
  assert.equal(manifest.objects.at(-2).key, 'learning/smstudy.json');
  assert.equal(manifest.objects.at(-1).key, 'learning/plstudy.json');
  const wordmaster = JSON.parse(await readFile(path.join(outputDirectory, 'learning/wordmaster.json'), 'utf8'));
  assert.equal(wordmaster.words.length, 2000);

  const calls = [];
  const result = await uploadLearningR2({
    outputDirectory,
    statePath: path.join(outputDirectory, 'state.json'),
    executable: 'wrangler-fixture',
    run: async (command, args) => calls.push({ command, args }),
    log: () => {},
  });
  assert.equal(result.uploaded.length, 81);
  assert.ok(calls[0].args.some((value) => value.endsWith('/learning/smstudy/kice/2022-csat-02.webp')));
  assert.ok(calls.at(-3).args.some((value) => value.endsWith('/learning/wordmaster.json')));
  assert.ok(calls.at(-2).args.some((value) => value.endsWith('/learning/smstudy.json')));
  assert.ok(calls.at(-1).args.some((value) => value.endsWith('/learning/plstudy.json')));
});
