// CSS 포매터. 인자를 주지 않으면 **대상을 저장소에서 도출한다** — 손으로 적은 목록은
// 새 화면의 CSS를 빠뜨리고, 그러면 "명령은 있는데 저장소와 어긋난" 상태로 되돌아간다
// (review WP1 M-4 / M-3, LESSONS "파생 가능한 것을 손으로 적지 않는다").
// `--check`는 쓰지 않고 어긋난 파일만 알린다 — npm test가 이 모드로 포맷을 잠근다.
import { readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 벤더 CSS는 남의 파일이라 손대지 않는다. 그 밖의 저장소 CSS는 전부 대상이다.
function repoStylesheets(directory = ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.wrangler') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue;
      files.push(...repoStylesheets(absolute));
    } else if (entry.name.endsWith('.css')) {
      files.push(absolute);
    }
  }
  return files;
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const named = args.filter((argument) => argument !== '--check');
const files = named.length > 0 ? named : repoStylesheets();

const unformatted = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const formatted = formatCss(source);
  if (source === formatted) continue;
  if (checkOnly) unformatted.push(path.relative(ROOT, path.resolve(file)).split(path.sep).join('/'));
  else await writeFile(file, formatted);
}

if (checkOnly && unformatted.length > 0) {
  console.error(`format:css — ${unformatted.length} stylesheet(s) are not formatted: ${unformatted.join(', ')}`);
  console.error('run: npm run format:css');
  process.exitCode = 1;
}
