import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findDesignHeadingSequenceErrors } from './design-heading-sequence.mjs';
import {
  findIconBackgroundViolations, findInvalidIconMarkup, findMissingIconReferences,
  findRenderedEmoji, findUnversionedIconSpriteReferences, ICON_SPRITE_URL, inspectSprite,
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

test('v14 icon markup gate pins the one sprite URL and rejects a second inline icon set', () => {
  const valid = [{ file: 'valid.html', source: `<svg class="ui-icon"><use href="${ICON_SPRITE_URL}#icon-info"></use></svg>` }];
  assert.deepEqual(findInvalidIconMarkup(valid), []);
  assert.deepEqual(findUnversionedIconSpriteReferences(valid), []);

  const invalid = [{ file: 'invalid.html', source: '<svg class="other-icon"><path d="M0 0"></path></svg><svg class="ui-icon"><use href="/assets/ui-icons.svg#icon-info"></use></svg>' }];
  assert.equal(findInvalidIconMarkup(invalid).length, 2);
  assert.equal(findUnversionedIconSpriteReferences(invalid).length, 1);
});

test('v14 rendered-snapshot background gate catches every requested regression shape', () => {
  const cases = [
    {
      name: 'deleted admin shield wrapper with the literal accent color',
      html: '<div class="ad-login-symbol"><svg class="ui-icon"></svg></div>',
      css: '.ad-login-symbol { background: rgba(41,151,255,.12); }',
      selector: '.ad-login-symbol',
    },
    {
      name: 'wrapper produced by DOM code and captured in the rendered snapshot',
      html: '<span class="runtime-icon-wrap"><svg class="ui-icon"></svg></span>',
      css: '.runtime-icon-wrap { background-image: linear-gradient(var(--accent), transparent); }',
      selector: '.runtime-icon-wrap',
    },
    {
      name: 'ui icon that is not the first child of its wrapper',
      html: '<button class="late-icon"><span>먼저</span><svg class="ui-icon"></svg></button>',
      css: '.late-icon { background-color: var(--orange-soft); }',
      selector: '.late-icon',
    },
  ];
  for (const fixture of cases) {
    const failures = findIconBackgroundViolations(
      [{ file: `${fixture.name}.html`, source: fixture.html }],
      [{ file: `${fixture.name}.css`, source: fixture.css }],
    );
    assert.equal(failures.length, 1, fixture.name);
    assert.equal(failures[0].selector, fixture.selector, fixture.name);
  }
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
