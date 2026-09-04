const EMOJI_PATTERN = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?|\p{Emoji}\uFE0F|\u20E3/u;
const ICON_ID_PATTERN = /\bicon-[a-z0-9-]+\b/gu;
const DEDICATED_ICON_WRAPPER = /\.ui-icon\b|\.list-row-lead\b|\.sidebar-emblem\b|\.ad-secure-mark\b/u;
const FORBIDDEN_ICON_BACKGROUND = /background(?:-color)?\s*:\s*[^;}]*var\(--(?:accent(?:-[\w-]+)?|green(?:-[\w-]+)?|red(?:-[\w-]+)?|orange(?:-[\w-]+)?|status(?:-[\w-]+)?)\)/iu;

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
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

export function findMissingIconReferences(surfaces, symbolIds) {
  const missing = [];
  for (const { file, source } of surfaces) {
    for (const hit of source.matchAll(ICON_ID_PATTERN)) {
      if (!symbolIds.has(hit[0])) missing.push({ file, id: hit[0], line: lineOf(source, hit.index) });
    }
  }
  return missing;
}

export function findIconBackgroundViolations(stylesheets) {
  const failures = [];
  for (const { file, source } of stylesheets) {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '');
    for (const hit of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const selector = hit[1].trim();
      const body = hit[2];
      if (!DEDICATED_ICON_WRAPPER.test(selector) || !FORBIDDEN_ICON_BACKGROUND.test(body)) continue;
      failures.push({ file, selector, line: lineOf(withoutComments, hit.index) });
    }
  }
  return failures;
}
