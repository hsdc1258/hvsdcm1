import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const moves = [
  ['WordMaster/assets/js/words.js', '_learning/wordmaster/words.js'],
  ['smstudy/assets/js/data.js', '_learning/smstudy/data.js'],
  ['smstudy/assets/js/notebook-data.js', '_learning/smstudy/notebook-data.js'],
  ['smstudy/assets/js/explanation-data.js', '_learning/smstudy/explanation-data.js'],
  ['smstudy/assets/kice', '_learning/smstudy/kice'],
];

for (const [fromRelative, toRelative] of moves) {
  const from = path.join(ROOT, fromRelative);
  const to = path.join(ROOT, toRelative);
  if (existsSync(to)) continue;
  if (!existsSync(from)) throw new Error(`migration source is missing: ${fromRelative}`);
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
}
const wordsPath = path.join(ROOT, '_learning/wordmaster/words.js');
let wordsSource = readFileSync(wordsPath, 'utf8');
const delimiterRepairs = new Map([
  ['기쁨 0기쁘게하다', '기쁨, 기쁘게하다'],
  ['연료 0연료를가하다', '연료, 연료를가하다'],
  ['화나게하다 0분노, 화', '화나게하다, 분노, 화'],
]);

for (const [broken, repaired] of delimiterRepairs) {
  const matches = wordsSource.split(broken).length - 1;
  if (matches > 1) throw new Error(`ambiguous delimiter repair (${matches} matches): ${broken}`);
  if (matches === 1) wordsSource = wordsSource.replace(broken, repaired);
  if (!wordsSource.includes(repaired)) throw new Error(`delimiter repair is missing: ${repaired}`);
}

writeFileSync(wordsPath, wordsSource, 'utf8');
console.log('Learning content migration ready: _learning/ + 3 WordMaster delimiter repairs');
