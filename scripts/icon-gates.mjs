import { load } from 'cheerio';

const EMOJI_PATTERN = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?|\p{Emoji}\uFE0F|\u20E3/u;
const ICON_ID_PATTERN = /\bicon-[a-z0-9-]+\b/gu;
const COLOR_TOKEN_PATTERN = /var\(--(?:accent(?:-[\w-]+)?|green(?:-[\w-]+)?|red(?:-[\w-]+)?|orange(?:-[\w-]+)?|status(?:-[\w-]+)?)\)/iu;
const LEGACY_COLOR_LITERAL_PATTERN = /#(?:2997ff|30d158|ff453a|ff9f0a)\b|(?:rgb|rgba)\(\s*(?:41\s*,\s*151\s*,\s*255|48\s*,\s*209\s*,\s*88|255\s*,\s*69\s*,\s*58|255\s*,\s*159\s*,\s*10)(?:\s*,[^)]*)?\)/iu;
const BACKGROUND_DECLARATION_PATTERN = /\bbackground(?:-[\w-]+)?\s*:\s*([^;}]+)/giu;

export const ICON_SPRITE_VERSION = '20260904-icons-v2';
export const ICON_SPRITE_URL = `/assets/ui-icons.svg?v=${ICON_SPRITE_VERSION}`;

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function withoutComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[ \t]*\/\/.*$/gmu, '');
}

export function findRenderedEmoji(surfaces) {
  const failures = [];
  for (const { file, source } of surfaces) {
    const pattern = new RegExp(EMOJI_PATTERN.source, 'gu');
    for (const hit of source.matchAll(pattern)) {
      failures.push({ file, glyph: hit[0], line: lineOf(source, hit.index) });
    }
  }
  return failures;
}

function attributeValue(attributes, name) {
  return new RegExp(`\\b${name}=["']([^"']+)["']`, 'u').exec(attributes)?.[1] ?? null;
}

export function inspectSprite(sprite) {
  const symbols = [];
  for (const hit of sprite.matchAll(/<symbol\b([^>]*)>/gu)) {
    const attributes = hit[1];
    symbols.push({
      id: attributeValue(attributes, 'id'),
      fill: attributeValue(attributes, 'fill'),
      stroke: attributeValue(attributes, 'stroke'),
      strokeWidth: attributeValue(attributes, 'stroke-width'),
      strokeLinecap: attributeValue(attributes, 'stroke-linecap'),
      strokeLinejoin: attributeValue(attributes, 'stroke-linejoin'),
    });
  }
  return symbols;
}

export function referencedIconIds(surfaces) {
  const ids = new Set();
  for (const { source } of surfaces) {
    for (const hit of withoutComments(source).matchAll(ICON_ID_PATTERN)) ids.add(hit[0]);
  }
  return ids;
}

export function findMissingIconReferences(surfaces, symbolIds) {
  const missing = [];
  for (const { file, source } of surfaces) {
    const executable = withoutComments(source);
    for (const hit of executable.matchAll(ICON_ID_PATTERN)) {
      if (!symbolIds.has(hit[0])) missing.push({ file, id: hit[0], line: lineOf(executable, hit.index) });
    }
  }
  return missing;
}

export function findInvalidIconMarkup(surfaces, allowedNonUi = new Map()) {
  const failures = [];
  const escapedUrl = ICON_SPRITE_URL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const expectedUse = new RegExp(`^\\s*<use\\b[^>]*\\bhref=["']${escapedUrl}#(?:icon-[a-z0-9-]+|\\$\\{id\\})["'][^>]*>\\s*</use>\\s*$`, 'u');
  for (const { file, source } of surfaces) {
    for (const hit of source.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gu)) {
      const attributes = hit[1];
      const body = hit[2];
      const classes = new Set((attributeValue(attributes, 'class') || '').split(/\s+/u).filter(Boolean));
      const allowedClasses = allowedNonUi.get(file) || new Set();
      if ([...classes].some((className) => allowedClasses.has(className))) continue;
      if (!classes.has('ui-icon') || !expectedUse.test(body)) {
        failures.push({ file, line: lineOf(source, hit.index), classes: [...classes], body: body.trim() });
      }
    }
  }
  return failures;
}

export function findUnversionedIconSpriteReferences(surfaces) {
  const failures = [];
  const expected = `${ICON_SPRITE_URL}#`;
  for (const { file, source } of surfaces) {
    for (const hit of source.matchAll(/\/assets\/ui-icons\.svg(?:\?v=[^#"'`)\s]+)?#/gu)) {
      if (hit[0] !== expected) failures.push({ file, value: hit[0], line: lineOf(source, hit.index) });
    }
  }
  return failures;
}

function literalStatusColors(stylesheets) {
  const literals = new Set();
  for (const { source } of stylesheets) {
    for (const hit of source.matchAll(/--(?:accent(?:-[\w-]+)?|green(?:-[\w-]+)?|red(?:-[\w-]+)?|orange(?:-[\w-]+)?|status(?:-[\w-]+)?)\s*:\s*([^;}]+)/giu)) {
      const value = hit[1].trim().toLowerCase().replace(/\s+/gu, '');
      if (/^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([^)]*\))$/u.test(value)) literals.add(value);
    }
  }
  return literals;
}

function hasForbiddenBackground(body, literals) {
  for (const hit of body.matchAll(BACKGROUND_DECLARATION_PATTERN)) {
    const value = hit[1];
    if (COLOR_TOKEN_PATTERN.test(value) || LEGACY_COLOR_LITERAL_PATTERN.test(value)) return true;
    const normalized = value.toLowerCase().replace(/\s+/gu, '');
    if ([...literals].some((literal) => normalized.includes(literal))) return true;
  }
  return false;
}

export function iconAncestorClassSets(snapshots) {
  const classSets = [new Set(['ui-icon'])];
  for (const { source } of snapshots) {
    const $ = load(source);
    $('svg.ui-icon').each((index, element) => {
      let ancestor = $(element).parent();
      for (let depth = 0; depth < 2 && ancestor.length; depth += 1) {
        const classes = new Set((ancestor.attr('class') || '').split(/\s+/u).filter(Boolean));
        if (classes.size) classSets.push(classes);
        ancestor = ancestor.parent();
      }
    });
  }
  return classSets;
}

export function findIconBackgroundViolations(snapshots, stylesheets) {
  const protectedClassSets = iconAncestorClassSets(snapshots);
  const literals = literalStatusColors(stylesheets);
  const failures = [];
  for (const { file, source } of stylesheets) {
    const css = withoutComments(source);
    for (const hit of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      if (!hasForbiddenBackground(hit[2], literals)) continue;
      for (const rawSelector of hit[1].split(',')) {
        const selector = rawSelector.trim();
        // background는 셀렉터의 마지막 compound가 가리키는 요소에 적용된다. `.choice.is-active`의
        // 공용 `is-active`만 우연히 일치하는 오탐을 막고, 실제 래퍼의 클래스 조합 전체를 확인한다.
        const targetCompound = selector.split(/\s+|[>+~]/u).filter(Boolean).at(-1) || '';
        const targetClasses = [...targetCompound.matchAll(/\.([a-z][\w-]*)/giu)].map((match) => match[1]);
        if (!targetClasses.length || !protectedClassSets.some((set) => targetClasses.every((className) => set.has(className)))) continue;
        failures.push({ file, selector, classes: [...new Set(targetClasses)], line: lineOf(css, hit.index) });
      }
    }
  }
  return failures;
}
