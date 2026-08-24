import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function walk(directory, predicate) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.wrangler') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, predicate));
    else if (predicate(absolute)) files.push(absolute);
  }
  return files;
}

function relative(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join('/');
}

function validateJavaScriptSyntax() {
  for (const file of walk(ROOT, (item) => item.endsWith('.js') || item.endsWith('.mjs'))) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      check(true, '');
    } catch (error) {
      check(false, `${relative(file)}: JavaScript syntax error\n${error.stderr?.toString() || error.message}`);
    }
  }
}

function resolveAsset(htmlFile, reference) {
  const clean = reference.split(/[?#]/u, 1)[0];
  const absolute = clean.startsWith('/')
    ? path.join(ROOT, clean.slice(1))
    : path.resolve(path.dirname(htmlFile), clean);
  if (existsSync(absolute) && statSync(absolute).isDirectory()) return path.join(absolute, 'index.html');
  return absolute;
}

function validateHtmlAssets() {
  for (const file of walk(ROOT, (item) => item.endsWith('.html'))) {
    const source = readFileSync(file, 'utf8');
    check(!/<style\b/iu.test(source), `${relative(file)}: inline <style> is not allowed`);
    check(!/<script(?![^>]*\bsrc=)[^>]*>/iu.test(source), `${relative(file)}: inline executable <script> is not allowed`);

    const references = source.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)=["']([^"']+)["']/giu);
    for (const [, reference] of references) {
      if (/^(?:https?:|data:|#)/iu.test(reference)) continue;
      const target = resolveAsset(file, reference);
      check(existsSync(target), `${relative(file)}: missing local asset ${reference}`);
    }
  }
}

function validateUiContracts() {
  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const homeCss = readFileSync(path.join(ROOT, 'assets/css/home.css'), 'utf8');
  const homeJs = readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8');
  const wordMasterCss = readFileSync(path.join(ROOT, 'WordMaster/assets/css/style.css'), 'utf8');

  check(homeHtml.includes('id="drawerStudy"'), 'home: authenticated STUDY drawer is missing');
  check(homeHtml.includes('class="study-icon wordmaster-icon"'), 'home: WordMaster drawer icon is missing');
  check(homeHtml.includes('class="study-icon society-icon"'), 'home: social-studies drawer icon is missing');
  check(homeCss.includes('.drawer.logged .drawer-study'), 'home: STUDY drawer must depend on logged-in state');
  check(homeCss.includes('h1[data-user]'), 'home: personalized title responsive rule is missing');
  check(homeJs.includes("drawerStudy.setAttribute('aria-hidden', 'false')"), 'home: STUDY drawer accessibility state is not synchronized');
  check(wordMasterCss.includes('#app:focus { outline: none; }'), 'WordMaster: app focus outline fix is missing');
  check(wordMasterCss.includes('grid-template-columns: minmax(0, 1fr)'), 'WordMaster: desktop review actions must use a shrink-safe column');
}

function validateMigrations() {
  const migrationDirectory = path.join(ROOT, 'worker/migrations');
  const migrations = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  migrations.forEach((file, index) => {
    const expectedPrefix = String(index + 1).padStart(4, '0');
    check(file.startsWith(expectedPrefix), `worker: migration sequence gap at ${file}`);
  });
  const latestMigration = readFileSync(path.join(migrationDirectory, migrations.at(-1)), 'utf8');
  check(latestMigration.includes('ip_address'), 'worker: latest migration must add session IP storage');
}

function evaluateBrowserData(file, exportedName) {
  const context = {};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  return context[exportedName];
}

function readWebpDimensions(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 'VP8X' && size >= 10) {
      return {
        width: 1 + buffer.readUIntLE(start + 4, 3),
        height: 1 + buffer.readUIntLE(start + 7, 3)
      };
    }
    if (type === 'VP8 ' && size >= 10 && buffer[start + 3] === 0x9d && buffer[start + 4] === 0x01 && buffer[start + 5] === 0x2a) {
      return {
        width: buffer.readUInt16LE(start + 6) & 0x3fff,
        height: buffer.readUInt16LE(start + 8) & 0x3fff
      };
    }
    if (type === 'VP8L' && size >= 5 && buffer[start] === 0x2f) {
      const b1 = buffer[start + 1];
      const b2 = buffer[start + 2];
      const b3 = buffer[start + 3];
      const b4 = buffer[start + 4];
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10)
      };
    }
    offset = start + size + (size % 2);
  }
  return null;
}

function validateWordMasterData() {
  const words = evaluateBrowserData('WordMaster/assets/js/words.js', 'WORDMASTER_WORDS');
  check(Array.isArray(words), 'WordMaster: exported data must be an array');
  if (!Array.isArray(words)) return;

  check(words.length === 2_000, `WordMaster: expected 2,000 words, found ${words.length}`);
  check(new Set(words.map((word) => word.id)).size === words.length, 'WordMaster: IDs must be unique');

  for (let day = 1; day <= 50; day += 1) {
    const dailyWords = words.filter((word) => word.day === day);
    check(dailyWords.length === 40, `WordMaster: DAY ${day} must contain 40 words`);
    check(
      new Set(dailyWords.map((word) => word.number)).size === 40,
      `WordMaster: DAY ${day} question numbers must be unique`,
    );
  }

  for (const word of words) {
    check(/^d\d{2}-\d{2}$/u.test(word.id), `WordMaster: invalid ID ${word.id}`);
    check(Boolean(word.word && word.meaning), `WordMaster: ${word.id} has empty content`);
  }
}

function validateSmStudyData() {
  const data = evaluateBrowserData('smstudy/assets/js/data.js', 'SMSTUDY_DATA');
  check(Boolean(data), 'smstudy: SMSTUDY_DATA export is missing');
  if (!data) return;

  const subunits = data.UNITS.flatMap((unit) => unit.subs);
  const subunitIds = new Set(subunits.map((subunit) => subunit.id));
  const questionIds = new Set(data.QUESTION_ROWS.map((question) => question.id));
  check(data.UNITS.length === 4, `smstudy: expected 4 units, found ${data.UNITS.length}`);
  check(subunits.length === 13, `smstudy: expected 13 subunits, found ${subunits.length}`);
  check(subunitIds.size === subunits.length, 'smstudy: subunit IDs must be unique');
  check(data.QUESTION_ROWS.length === 78, `smstudy: expected 78 questions, found ${data.QUESTION_ROWS.length}`);
  check(questionIds.size === data.QUESTION_ROWS.length, 'smstudy: question IDs must be unique');
  check(data.QUESTIONS.length === data.QUESTION_ROWS.length, 'smstudy: derived question count mismatch');

  for (const subunit of subunits) {
    const questions = data.QUESTION_ROWS.filter((question) => question.sub === subunit.id);
    check(questions.length === 6, `smstudy: ${subunit.id} must contain 6 questions`);
    check(subunit.sections.length > 0, `smstudy: ${subunit.id} has no concept sections`);
    check(Boolean(subunit.visual?.question), `smstudy: ${subunit.id} has no visual-guide question`);
    check(subunit.visual?.flow?.length === 3, `smstudy: ${subunit.id} visual guide must contain 3 flow steps`);
    check(subunit.visual?.checks?.length === 3, `smstudy: ${subunit.id} visual guide must contain 3 checks`);
  }

  const referencedImages = new Set();
  for (const question of data.QUESTION_ROWS) {
    const source = data.KICE_SOURCES[`${question.year}|${question.session}`];
    check(subunitIds.has(question.sub), `smstudy: ${question.id} references unknown subunit ${question.sub}`);
    check(Number.isInteger(question.answerNumber) && question.answerNumber >= 1 && question.answerNumber <= 5, `smstudy: ${question.id} has invalid answer`);
    check(question.correctRate + question.wrongRate === 100, `smstudy: ${question.id} rates must total 100`);
    check(Boolean(source?.question && source?.answer), `smstudy: ${question.id} source links are missing`);
    const imagePath = path.join(ROOT, 'smstudy', question.image);
    check(existsSync(imagePath), `smstudy: ${question.id} image is missing`);
    if (existsSync(imagePath)) {
      const dimensions = readWebpDimensions(imagePath);
      check(Boolean(dimensions), `smstudy: ${question.id} is not a readable WebP image`);
      check(dimensions?.width >= 700, `smstudy: ${question.id} image is too narrow to preserve the printed question`);
      // A shorter crop previously left "위 연구" visible but omitted its shared passage.
      check(dimensions?.height >= 500, `smstudy: ${question.id} image may omit its stem, passage or choices`);
    }
    referencedImages.add(path.basename(question.image));
  }

  const imageDirectory = path.join(ROOT, 'smstudy/assets/kice');
  const imageFiles = readdirSync(imageDirectory).filter((file) => file.endsWith('.webp'));
  check(imageFiles.length === 78, `smstudy: expected 78 WebP images, found ${imageFiles.length}`);
  check(imageFiles.every((file) => referencedImages.has(file)), 'smstudy: unreferenced WebP images exist');
}

validateJavaScriptSyntax();
validateHtmlAssets();
validateUiContracts();
validateMigrations();
validateWordMasterData();
validateSmStudyData();

if (failures.length > 0) {
  console.error(`Validation failed (${failures.length}/${checks})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validation passed (${checks} checks)`);
}
