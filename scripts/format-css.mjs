import { readFile, writeFile } from 'node:fs/promises';

function formatCss(source) {
  let output = '';
  let indent = 0;
  let quote = null;
  let inComment = false;
  let parentheses = 0;

  const indentation = () => '  '.repeat(indent);
  const trimLineEnd = () => {
    output = output.replace(/[ \t]+$/u, '');
  };
  const startLine = () => {
    if (!output || output.endsWith('\n')) output += indentation();
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inComment) {
      output += character;
      if (character === '*' && next === '/') {
        output += next;
        index += 1;
        inComment = false;
        if (parentheses === 0) output += '\n';
      }
      continue;
    }

    if (quote) {
      output += character;
      if (character === '\\') {
        output += next ?? '';
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '/' && next === '*') {
      startLine();
      output += '/*';
      index += 1;
      inComment = true;
      continue;
    }

    if (character === '"' || character === "'") {
      startLine();
      output += character;
      quote = character;
      continue;
    }

    if (character === '(') parentheses += 1;
    if (character === ')') parentheses = Math.max(0, parentheses - 1);

    if (parentheses === 0 && character === '{') {
      trimLineEnd();
      output += ' {\n';
      indent += 1;
      continue;
    }

    if (parentheses === 0 && character === ';') {
      trimLineEnd();
      output += ';\n';
      continue;
    }

    if (parentheses === 0 && character === '}') {
      trimLineEnd();
      if (!output.endsWith('\n')) output += '\n';
      indent = Math.max(0, indent - 1);
      output += `${indentation()}}\n`;
      continue;
    }

    if (/\s/u.test(character)) {
      if (output && !/[\s]/u.test(output.at(-1))) output += ' ';
      continue;
    }

    startLine();
    output += character;
  }

  return `${output.trim()}\n`;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/format-css.mjs <file...>');
  process.exitCode = 1;
} else {
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    await writeFile(file, formatCss(source));
  }
}
