export function findDesignHeadingSequenceErrors(markdown) {
  const errors = [];
  const currentAtDepth = new Map();
  const lastSibling = new Map();
  let lastTopLevel = null;

  const lines = String(markdown).split(/\r?\n/u);
  lines.forEach((line, index) => {
    const heading = /^(#{2,6})\s+(.+)$/u.exec(line);
    if (!heading) return;

    const numbered = /^(\d+(?:\.\d+)*)(?:\.)?(?=\s|$)/u.exec(heading[2]);
    if (!numbered) {
      errors.push(`line ${index + 1}: heading is missing a numeric section prefix`);
      return;
    }

    const depth = heading[1].length - 1;
    const parts = numbered[1].split('.').map(Number);
    if (parts.length !== depth) {
      errors.push(
        `line ${index + 1}: heading level ${heading[1].length} requires ${depth} numeric parts, found ${numbered[1]}`,
      );
      return;
    }

    for (const savedDepth of [...currentAtDepth.keys()]) {
      if (savedDepth > depth) currentAtDepth.delete(savedDepth);
    }

    if (depth === 1) {
      const expected = lastTopLevel === null ? 0 : lastTopLevel + 1;
      if (parts[0] !== expected) {
        errors.push(`line ${index + 1}: expected section ${expected}, found ${parts[0]}`);
      }
      lastTopLevel = parts[0];
      currentAtDepth.set(depth, parts);
      return;
    }

    const parent = currentAtDepth.get(depth - 1);
    const prefix = parts.slice(0, -1);
    if (!parent || parent.join('.') !== prefix.join('.')) {
      errors.push(
        `line ${index + 1}: section ${numbered[1]} is outside its current parent ${parent?.join('.') || '(none)'}`,
      );
    }

    const siblingKey = `${depth}:${prefix.join('.')}`;
    const expected = (lastSibling.get(siblingKey) || 0) + 1;
    const actual = parts.at(-1);
    if (actual !== expected) {
      errors.push(`line ${index + 1}: expected subsection ${prefix.join('.')}.${expected}, found ${numbered[1]}`);
    }
    lastSibling.set(siblingKey, actual);
    currentAtDepth.set(depth, parts);
  });

  return errors;
}
