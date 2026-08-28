import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findDesignHeadingSequenceErrors } from './design-heading-sequence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = readFileSync(path.join(ROOT, 'docs/DESIGN.md'), 'utf8');

test('DESIGN headings have continuous section numbers', () => {
  assert.deepEqual(findDesignHeadingSequenceErrors(DESIGN), []);
});

test('validate.mjs rejects a real DESIGN copy with a duplicate section number', () => {
  const misnumbered = DESIGN.replace('## 9. 카피 (문구)', '## 8. 카피 (문구)');
  assert.notEqual(misnumbered, DESIGN, 'negative fixture must alter the real document');
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'hvsdcm-design-order-'));
  const temporaryDesign = path.join(temporaryDirectory, 'DESIGN.md');
  try {
    writeFileSync(temporaryDesign, misnumbered, 'utf8');
    const result = spawnSync(process.execPath, ['scripts/validate.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HVSDCM_VALIDATE_DESIGN_PATH: temporaryDesign,
      },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /expected section 9, found 8/u);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
