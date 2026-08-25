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
  // 랜딩 검사는 Apple Dark v2 구조(사이클 #2 재작성)의 훅을 검사한다 (plan.md D2).
  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const homeCss = readFileSync(path.join(ROOT, 'assets/css/home.css'), 'utf8');
  const homeJs = readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8');
  const systemCss = readFileSync(path.join(ROOT, 'assets/css/system.css'), 'utf8');
  const wordMasterCss = readFileSync(path.join(ROOT, 'WordMaster/assets/css/style.css'), 'utf8');
  const wordMasterJs = readFileSync(path.join(ROOT, 'WordMaster/assets/js/app.js'), 'utf8');
  const smstudyJs = readFileSync(path.join(ROOT, 'smstudy/assets/js/app.js'), 'utf8');

  check(homeHtml.includes('id="drawerStudy"') && homeHtml.includes('aria-hidden="true"'), 'home: authenticated STUDY drawer with default hidden state is missing');
  check(/id="loginModal"[^>]*role="dialog"[^>]*aria-modal="true"/u.test(homeHtml), 'home: login sheet must be a modal dialog');
  check(/class="brand"[^>]*>hvsdcm</u.test(homeHtml), 'home: topbar wordmark must render "hvsdcm" in one piece');
  check(homeHtml.includes('data-login-trigger'), 'home: login trigger hook is missing');
  check(homeHtml.includes('class="skip-link"'), 'home: skip navigation link is missing');
  check(/class="[^"]*\breveal\b/u.test(homeHtml), 'home: scroll-reveal sections are missing');
  check(homeHtml.includes('aria-expanded') && homeHtml.includes('aria-controls="drawer"'), 'home: menu button accessibility wiring is missing');
  check(homeCss.includes('.drawer.logged .drawer-study'), 'home: STUDY drawer must depend on logged-in state');
  check(homeCss.includes('.account.logged'), 'home: CTA switch must depend on logged-in state');
  check(homeCss.includes('.hero-title[data-user]'), 'home: personalized title responsive rule is missing');
  check(homeJs.includes("drawerStudy.setAttribute('aria-hidden', 'false')"), 'home: STUDY drawer accessibility state is not synchronized');
  check(homeJs.includes('prefers-reduced-motion'), 'home: scroll reveal must respect reduced-motion preference');

  // system.css 공통 프리미티브 — 3b에서 앱 3면이 이 위에 얹힌다.
  for (const primitive of ['.btn ', '.btn-primary ', '.field-input ', '.card ', '.sheet ', '.sheet-backdrop ', '.table ', '.badge ', '.segmented ', '.toolbar ', '.sidebar ', '.toast ', '.topbar ', '.app-shell ', '.segmented-btn ', '.sidebar-item ']) {
    check(systemCss.includes(primitive.trimEnd() + ' {') || systemCss.includes(primitive.trimEnd() + ','), `system.css: primitive ${primitive.trim()} is missing`);
  }

  check(wordMasterCss.includes('#app:focus { outline: none; }'), 'WordMaster: app focus outline fix is missing');
  check(wordMasterCss.includes('grid-template-columns: minmax(0, 1fr)'), 'WordMaster: desktop review actions must use a shrink-safe column');
  check(wordMasterJs.includes('wrongCount: cumulativeWrongCount'), 'WordMaster: wrong-rate ties must use cumulative mistakes');
  check(smstudyJs.includes('wrongCount: cumulativeWrongCount'), 'smstudy: wrong-rate ties must use cumulative mistakes');
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
  const notebookData = evaluateBrowserData('smstudy/assets/js/notebook-data.js', 'SMSTUDY_NOTEBOOK');
  const explanationData = evaluateBrowserData('smstudy/assets/js/explanation-data.js', 'SMSTUDY_EXPLANATIONS');
  check(Boolean(data), 'smstudy: SMSTUDY_DATA export is missing');
  check(Boolean(notebookData), 'smstudy: SMSTUDY_NOTEBOOK export is missing');
  check(Boolean(explanationData), 'smstudy: SMSTUDY_EXPLANATIONS export is missing');
  if (!data || !notebookData || !explanationData) return;

  const subunits = data.UNITS.flatMap((unit) => unit.subs);
  const subunitIds = new Set(subunits.map((subunit) => subunit.id));
  const questionIds = new Set(data.QUESTION_ROWS.map((question) => question.id));
  check(data.UNITS.length === 4, `smstudy: expected 4 units, found ${data.UNITS.length}`);
  check(subunits.length === 13, `smstudy: expected 13 subunits, found ${subunits.length}`);
  check(subunitIds.size === subunits.length, 'smstudy: subunit IDs must be unique');
  check(data.QUESTION_ROWS.length === 78, `smstudy: expected 78 questions, found ${data.QUESTION_ROWS.length}`);
  check(questionIds.size === data.QUESTION_ROWS.length, 'smstudy: question IDs must be unique');
  check(data.QUESTIONS.length === data.QUESTION_ROWS.length, 'smstudy: derived question count mismatch');
  check(data.CHOICE_MARKS.join('') === '12345', 'smstudy: answer choices must use plain 1-5 labels');
  const notebookIds = Object.keys(notebookData.NOTEBOOKS || {});
  check(notebookIds.length === 13, `smstudy: expected 13 concept notebooks, found ${notebookIds.length}`);
  check(notebookData.LEARNING_DESIGN?.steps?.length === 4, 'smstudy: learning design must contain four study steps');
  check(notebookData.LEARNING_DESIGN?.evidence?.length >= 3, 'smstudy: learning design evidence is incomplete');

  for (const subunit of subunits) {
    const questions = data.QUESTION_ROWS.filter((question) => question.sub === subunit.id);
    const notebook = notebookData.NOTEBOOKS?.[subunit.id];
    const explanation = explanationData.GUIDES?.[subunit.id];
    check(questions.length === 6, `smstudy: ${subunit.id} must contain 6 questions`);
    check(subunit.sections.length > 0, `smstudy: ${subunit.id} has no concept sections`);
    check(Boolean(subunit.visual?.question), `smstudy: ${subunit.id} has no visual-guide question`);
    check(subunit.visual?.flow?.length === 3, `smstudy: ${subunit.id} visual guide must contain 3 flow steps`);
    check(subunit.visual?.checks?.length === 3, `smstudy: ${subunit.id} visual guide must contain 3 checks`);
    check(Boolean(notebook?.oneLine && notebook?.examInsight), `smstudy: ${subunit.id} notebook summary is incomplete`);
    check(notebook?.keyPoints?.length === 3, `smstudy: ${subunit.id} must have three readable key points`);
    check(notebook?.keyPoints?.every((item) => item.label && item.text), `smstudy: ${subunit.id} has an incomplete key point`);
    check(notebook?.patterns?.length >= 1, `smstudy: ${subunit.id} notebook has no exam patterns`);
    check(notebook?.patterns?.every((pattern) => Number.isInteger(pattern.count) && pattern.count >= 1 && pattern.count <= 6), `smstudy: ${subunit.id} exam pattern count must be between 1 and 6`);
    check(notebook?.matrix?.headers?.length >= 3, `smstudy: ${subunit.id} comparison matrix has too few columns`);
    check(notebook?.matrix?.rows?.length >= 4, `smstudy: ${subunit.id} comparison matrix has too few rows`);
    check(notebook?.matrix?.rows?.every((row) => row.length === notebook.matrix.headers.length), `smstudy: ${subunit.id} comparison matrix row width mismatch`);
    check(notebook?.decision?.length >= 4, `smstudy: ${subunit.id} decision flow is too short`);
    check(notebook?.deepDive?.length >= 4, `smstudy: ${subunit.id} deep-dive notes are too short`);
    check(notebook?.recall?.length >= 3, `smstudy: ${subunit.id} recall practice is too short`);
    check(Boolean(explanation?.focus && explanation?.correctReason && explanation?.wrongReason), `smstudy: ${subunit.id} explanation guide is incomplete`);
    check(explanation?.checks?.length === 3, `smstudy: ${subunit.id} explanation guide must contain three checks`);
  }

  for (const notebookId of notebookIds) check(subunitIds.has(notebookId), `smstudy: notebook ${notebookId} references unknown subunit`);
  check(notebookData.NOTEBOOKS['I-02']?.keyPoints?.some((item) => item.text.includes('질문지·실험은 양적 연구')), 'smstudy: research methods must teach the standard quantitative pairing first');
  check(notebookData.NOTEBOOKS['I-02']?.recall?.some((item) => item.answer.includes('질문지법은 양적 연구, 면접법은 질적 연구')), 'smstudy: research-method recall must use the KICE-standard pairing');
  check(notebookData.NOTEBOOKS['III-03']?.matrix?.rows?.some((row) => row[0] === '1차적 발명'), 'smstudy: primary invention is missing from cultural change');
  check(notebookData.NOTEBOOKS['III-03']?.matrix?.rows?.some((row) => row[0] === '2차적 발명'), 'smstudy: secondary invention is missing from cultural change');
  check(notebookData.NOTEBOOKS['III-03']?.deepDive?.some((item) => item.term === '2차적 발명과 자극 전파'), 'smstudy: secondary invention and stimulus diffusion comparison is missing');
  check(explanationData.GUIDES['I-02']?.checks?.some((item) => item.includes('질문지·실험은 양적 연구')), 'smstudy: research-method feedback must use the standard quantitative pairing');
  check(explanationData.GUIDES['III-03']?.checks?.some((item) => item.includes('2차적 발명은 사회 내부')), 'smstudy: cultural-change feedback must distinguish secondary invention from stimulus diffusion');
  check(Object.keys(explanationData.GUIDES || {}).length === 13, 'smstudy: expected 13 explanation guides');
  check(Boolean(explanationData.EBS_PAST_EXAMS?.startsWith('https://www.ebsi.co.kr/')), 'smstudy: EBS explanation source link is missing');

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

function validateDesignTokens() {
  // 토큰 단일 원본 = assets/css/system.css (plan.md D5, C-3).
  // 재작성 완료 표면의 CSS는 :root를 정의하지 않는다. 앱 3면(WordMaster·smstudy·admin)은
  // 3b 재작성 전까지 레거시 토큰 검사(값 일치)로 유지하고, 3b에서 :root 금지로 전환한다.
  const systemCss = readFileSync(path.join(ROOT, 'assets/css/system.css'), 'utf8');
  const systemRoots = [...systemCss.matchAll(/:root\s*\{([^}]*)\}/gsu)];
  check(systemRoots.length === 1, `system.css: exactly one :root block must exist, found ${systemRoots.length}`);
  const canonical = {
    '--bg': '#000',
    '--surface': '#161617',
    '--surface-2': '#1d1d1f',
    '--text': '#f5f5f7',
    '--text-2': '#a1a1a6',
    '--line': 'rgba(255,255,255,.12)',
    '--green': '#30d158',
    '--red': '#ff453a',
    '--accent': '#2997ff',
  };
  const systemRoot = systemRoots[0]?.[1] ?? '';
  for (const [name, expectedValue] of Object.entries(canonical)) {
    const match = systemRoot.match(new RegExp(`${name}\\s*:\\s*([^;\\r\\n]+)`, 'u'));
    check(Boolean(match), `system.css: canonical token ${name} is not defined`);
    if (match) {
      check(
        match[1].trim().replace(/\s+/gu, '').toLowerCase() === expectedValue,
        `system.css: ${name} is ${match[1].trim()}, expected ${expectedValue}`,
      );
    }
  }

  // 재작성 완료 표면: 색 토큰 :root 정의 금지 (C-3).
  for (const file of ['assets/css/home.css']) {
    check(!/:root\s*\{/u.test(readFileSync(path.join(ROOT, file), 'utf8')), `${file}: tokens must come from system.css only (no :root block)`);
  }

  // 로드 계약: 모든 표면은 system.css를 자기 스타일보다 먼저 링크한다. (지금은 랜딩만)
  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const systemIndex = homeHtml.indexOf('/assets/css/system.css');
  check(systemIndex !== -1 && systemIndex < homeHtml.indexOf('/assets/css/home.css'), 'index.html: system.css must load before home.css');

  // 레거시 표면 (3b에서 :root 제거 후 이 블록을 삭제):
  const surfaces = {
    'WordMaster/assets/css/style.css': { bg: '--bg', surface: '--surface', text: '--text', line: '--line', green: '--green' },
    'smstudy/assets/css/style.css': { bg: '--bg', surface: '--surface', text: '--text', line: '--line', green: '--green' },
    'admin/assets/css/admin.css': { bg: '--bg', surface: '--surface', text: '--text', line: '--line', green: '--green' },
  };
  const expected = { bg: '#000', surface: '#161617', text: '#f5f5f7', line: 'rgba(255,255,255,.12)', green: '#30d158' };
  const legacyPalette = /#87f5b0|#86efac|#6dff9a|#5fe391|#4ade80|#ff7a7a|#fb7185|#7dd3fc|#a8f5bf|#8fffb0|#facc15|#fb923c|135, ?245, ?176|134, ?239, ?172|95, ?227, ?145|74, ?222, ?128|255, ?122, ?122|251, ?113, ?133|109, ?255, ?154|125, ?211, ?252|250, ?204, ?21/iu;
  const normalize = (value) => value.replace(/\s+/gu, '').replace(/\b0\./gu, '.').toLowerCase();

  for (const [file, tokens] of Object.entries(surfaces)) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    check(!legacyPalette.test(source), `${file}: legacy palette literal found`);

    // Effective value = last screen :root declaration wins; print/light roots are exempt.
    const roots = [...source.matchAll(/:root\s*\{([^}]*)\}/gu)]
      .map(([, body]) => body)
      .filter((body) => !body.includes('color-scheme:light') && !body.includes('--bg:#fff'));
    for (const [key, name] of Object.entries(tokens)) {
      let value = null;
      for (const body of roots) {
        const match = body.match(new RegExp(`${name}\\s*:\\s*([^;\\r\\n]+)`, 'u'));
        if (match) value = match[1].trim();
      }
      check(value !== null, `${file}: shared token ${name} is not defined`);
      if (value !== null) {
        check(
          normalize(value) === normalize(expected[key]),
          `${file}: ${name} is ${value}, expected ${expected[key]} (shared Apple dark palette)`,
        );
      }
    }
  }

  for (const file of walk(ROOT, (item) => item.endsWith('.html'))) {
    check(!legacyPalette.test(readFileSync(file, 'utf8')), `${relative(file)}: legacy palette literal found`);
  }
}

function validateBrandName() {
  // C-5: 브랜드는 소문자 "hvsdcm" 한 덩어리 (plan.md R-5). 분리 표기 전면 금지.
  const separated = /HVS[\s\-_]?DCM|hvs[\s\-_]dcm/u;
  for (const file of walk(ROOT, (item) => item.endsWith('.html') || item.endsWith('.css'))) {
    check(!separated.test(readFileSync(file, 'utf8')), `${relative(file)}: separated brand name found (use "hvsdcm" in one piece)`);
  }

  // 재작성 완료 표면은 슬래시·가운뎃점·대문자 변형도 금지 — 3b에서 전 표면으로 확대.
  const strict = /hvs\s*[/·]\s*dcm|HVSDCM|HvsDcm|Hvsdcm/u;
  for (const file of ['index.html', 'assets/css/home.css', 'assets/css/system.css', 'assets/js/home.js']) {
    check(!strict.test(readFileSync(path.join(ROOT, file), 'utf8')), `${file}: brand must appear only as lowercase "hvsdcm"`);
  }
}

function validateGlobalsAndOrder() {
  // C-6: classic script + window 전역 유지 (plan.md §3.1, D6). type="module" 전면 금지.
  for (const file of walk(ROOT, (item) => item.endsWith('.html'))) {
    check(!/type=["']module["']/u.test(readFileSync(file, 'utf8')), `${relative(file)}: type="module" is forbidden`);
  }

  const scriptSources = (file) =>
    [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/giu)].map(([, src]) => src);

  // 표면별 스크립트 로드 순서 (§3.1)
  const expectedOrders = {
    'index.html': ['/assets/js/home.js'],
    'WordMaster/index.html': ['/account.js', 'assets/js/words.js', '/assets/js/study-utils.js', 'assets/js/app.js'],
    'smstudy/index.html': ['/account.js', 'assets/js/data.js', 'assets/js/notebook-data.js', 'assets/js/explanation-data.js', '/assets/js/study-utils.js', 'assets/js/app.js'],
    'admin/index.html': ['/admin/assets/js/admin.js'],
  };
  for (const [file, order] of Object.entries(expectedOrders)) {
    check(scriptSources(file).join(' → ') === order.join(' → '), `${file}: script load order must be ${order.join(' → ')}`);
  }

  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check(/<script\b[^>]*src="\/assets\/js\/home\.js"[^>]*\bdefer\b/u.test(homeHtml), 'index.html: home.js must load with defer');
  check(readFileSync(path.join(ROOT, 'WordMaster/index.html'), 'utf8').includes('data-app="wordmaster"'), 'WordMaster: account.js must declare data-app="wordmaster"');
  check(readFileSync(path.join(ROOT, 'smstudy/index.html'), 'utf8').includes('data-app="smstudy"'), 'smstudy: account.js must declare data-app="smstudy"');

  // 저장 키 보존 (§3.2 — 이름 변경 금지)
  const homeJs = readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8');
  for (const key of ['hvsdcm.token', 'hvsdcm.user', 'hvsdcm.api']) {
    check(homeJs.includes(`'${key}'`), `home.js: storage key ${key} is missing`);
  }
  const accountJs = readFileSync(path.join(ROOT, 'account.js'), 'utf8');
  check(accountJs.includes('hvsdcm.token') && accountJs.includes('hvsdcm.loaded.'), 'account.js: sync storage keys are missing');
  check(readFileSync(path.join(ROOT, 'admin/assets/js/admin.js'), 'utf8').includes('hvsdcm.admin'), 'admin.js: admin session key is missing');
  check(readFileSync(path.join(ROOT, 'WordMaster/index.html'), 'utf8').includes('data-key="wordmaster2000.quiz.v1"'), 'WordMaster: study DB key is missing');
  check(readFileSync(path.join(ROOT, 'smstudy/index.html'), 'utf8').includes('data-key="samun2027.study.v1"'), 'smstudy: study DB key is missing');
}

validateJavaScriptSyntax();
validateHtmlAssets();
validateUiContracts();
validateDesignTokens();
validateBrandName();
validateGlobalsAndOrder();
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
