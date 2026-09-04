import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findDesignHeadingSequenceErrors } from './design-heading-sequence.mjs';
import {
  findIconBackgroundViolations, findMissingIconReferences, findRenderedEmoji, inspectSprite,
} from './icon-gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = readFileSync(path.join(ROOT, 'docs/DESIGN.md'), 'utf8');
const ADMIN_HTML = readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
const ADMIN_JS = readFileSync(path.join(ROOT, 'admin/assets/js/admin.js'), 'utf8');

test('DESIGN headings have continuous section numbers', () => {
  assert.deepEqual(findDesignHeadingSequenceErrors(DESIGN), []);
});

test('admin async forms use stable references and focus only a visible login', () => {
  assert.doesNotMatch(ADMIN_HTML, /\sautofocus(?=[\s>])/u);
  assert.doesNotMatch(ADMIN_JS, /await[^]*?event\.currentTarget\.reset\(\)/u);
  assert.match(ADMIN_JS, /elements\.addUserForm\.reset\(\)/u);
  assert.match(ADMIN_JS, /else\s*\{\s*elements\.adminPassword\.focus\(\);/u);
});

test('v14 icon gates reject pictographs and missing sprite ids', () => {
  const surfaces = [{ file: 'fixture.js', source: "node.innerHTML = '<span>📅</span><use href=\"/assets/ui-icons.svg#icon-missing\"></use>';" }];
  assert.deepEqual(findRenderedEmoji(surfaces).map(({ glyph }) => glyph), ['📅']);
  assert.deepEqual(findMissingIconReferences(surfaces, new Set(['icon-calendar'])), [
    { file: 'fixture.js', id: 'icon-missing', line: 1 },
  ]);
});

test('v14 sprite inspection exposes the complete stroke contract', () => {
  const [symbol] = inspectSprite('<svg><symbol id="icon-check" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></symbol></svg>');
  assert.deepEqual(symbol, {
    id: 'icon-check', fill: 'none', stroke: 'currentColor', strokeWidth: '1.75',
    strokeLinecap: 'round', strokeLinejoin: 'round',
  });
});

test('v14 icon background gate targets dedicated wrappers, not ordinary action buttons', () => {
  const failures = findIconBackgroundViolations([{ file: 'fixture.css', source: `
    .btn-primary { background: var(--accent-strong); }
    .list-row-lead { background: var(--accent-soft); }
  ` }]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].selector, '.list-row-lead');
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
