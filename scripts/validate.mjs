import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// hidden 속성이 붙은 채로 렌더되는 요소의 class 토큰을 뽑는다 (템플릿 보간 토큰은 제외).
function hiddenClassTokens(markup) {
  const tokens = new Set();
  for (const tag of markup.match(/<[a-z][\w-]*\b[^>]*>/gu) || []) {
    if (!/\shidden(?=[\s>])/u.test(tag)) continue;
    const classMatch = tag.match(/\sclass="([^"]*)"/u);
    if (!classMatch) continue;
    for (const token of classMatch[1].split(/\s+/u)) {
      if (token && !token.includes('$') && !token.includes('{')) tokens.add(token);
    }
  }
  return [...tokens];
}

// '.token { ... }' 단독 선택자 규칙의 display 값을 돌려준다 (규칙이나 선언이 없으면 null).
function baseRuleDisplay(css, token) {
  const rule = new RegExp(`(?:^|\\})\\s*\\.${token}\\s*\\{([^}]*)\\}`, 'su').exec(css);
  if (!rule) return null;
  const display = /display\s*:\s*([a-z-]+)/u.exec(rule[1]);
  return display ? display[1] : null;
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
  const wordMasterHtml = readFileSync(path.join(ROOT, 'WordMaster/index.html'), 'utf8');
  const smstudyHtml = readFileSync(path.join(ROOT, 'smstudy/index.html'), 'utf8');
  const smstudyCss = readFileSync(path.join(ROOT, 'smstudy/assets/css/style.css'), 'utf8');
  const adminHtml = readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
  const adminCss = readFileSync(path.join(ROOT, 'admin/assets/css/admin.css'), 'utf8');
  const adminJs = readFileSync(path.join(ROOT, 'admin/assets/js/admin.js'), 'utf8');

  // 조건을 includes 두 개로 나누면 서로 다른 요소를 봐도 통과한다 — 한 태그 안에서 매칭한다 (review-3a M-6).
  // 학습 드로어는 미로그인 문서에 렌더되면 안 된다 — <template data-study> 안에만 존재한다 (사이클 #3 게이팅).
  check(/<template data-study>[^]*?class="drawer-study"/u.test(homeHtml), 'home: STUDY drawer must live inside a <template data-study> (login-gated)');
  // 대화상자 의미는 백드롭이 아니라 시트 본체(form.sheet)에 붙는다 (review-3a N-7).
  check(/id="loginForm"[^>]*class="[^"]*\bsheet\b[^"]*"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="loginTitle"/u.test(homeHtml),
    'home: login sheet itself must carry role="dialog" aria-modal="true" aria-labelledby="loginTitle"');
  check(!/id="loginModal"[^>]*(?:role="dialog"|aria-modal=)/u.test(homeHtml),
    'home: sheet backdrop must not carry dialog semantics — they belong on the .sheet form');
  check(/id="loginTitle"/u.test(homeHtml), 'home: login dialog label target #loginTitle is missing');
  check(/class="brand"[^>]*>hvsdcm</u.test(homeHtml), 'home: topbar wordmark must render "hvsdcm" in one piece');
  check(homeHtml.includes('data-login-trigger'), 'home: login trigger hook is missing');
  check(homeHtml.includes('class="skip-link"'), 'home: skip navigation link is missing');
  check(/class="[^"]*\breveal\b/u.test(homeHtml), 'home: scroll-reveal sections are missing');
  check(/id="menuButton"[^>]*aria-expanded="false"[^>]*aria-controls="drawer"/u.test(homeHtml), 'home: menu button accessibility wiring is missing');
  check(homeCss.includes('.drawer.logged .drawer-study'), 'home: STUDY drawer must depend on logged-in state');
  check(homeCss.includes('.account.logged'), 'home: CTA switch must depend on logged-in state');
  check(homeCss.includes('.hero-title[data-user]'), 'home: personalized title responsive rule is missing');
  // 주입은 로그인 판정 분기 안에서만 일어나야 한다 — 무조건 mount하면 게이팅이 무너진다.
  check(/if \(savedUsername && token\) \{[^]*?mountStudyContent\(\);/u.test(homeJs),
    'home: mountStudyContent() must run only inside the logged-in branch');
  check(homeJs.includes("querySelectorAll('template[data-study]')"), 'home: study template mount routine is missing');
  check(homeJs.includes('prefers-reduced-motion'), 'home: scroll reveal must respect reduced-motion preference');

  // system.css 공통 프리미티브 — 3b에서 앱 3면이 이 위에 얹힌다.
  for (const primitive of ['.btn ', '.btn-primary ', '.field-input ', '.card ', '.sheet ', '.sheet-backdrop ', '.table ', '.badge ', '.segmented ', '.toolbar ', '.sidebar ', '.toast ', '.topbar ', '.app-shell ', '.segmented-btn ', '.sidebar-item ']) {
    check(systemCss.includes(primitive.trimEnd() + ' {') || systemCss.includes(primitive.trimEnd() + ','), `system.css: primitive ${primitive.trim()} is missing`);
  }

  // 앱 3면 공통 셸 (사이클 #2 3b 재작성): topbar + app-shell + 사이드바 + 접근성 훅.
  const appSurfaces = {
    'WordMaster/index.html': wordMasterHtml,
    'smstudy/index.html': smstudyHtml,
    'admin/index.html': adminHtml,
  };
  for (const [name, source] of Object.entries(appSurfaces)) {
    check(/<header class="topbar">/u.test(source), `${name}: shared topbar landmark is missing`);
    check(/class="brand"[^>]*>hvsdcm</u.test(source), `${name}: topbar wordmark must render "hvsdcm" in one piece`);
    check(source.includes('class="skip-link"'), `${name}: skip navigation link is missing`);
    check(source.includes('class="app-shell"'), `${name}: app shell layout is missing`);
    check(/<aside class="sidebar"[^>]*aria-label=/u.test(source), `${name}: labelled sidebar landmark is missing`);
    check(/<main [^>]*class="app-main"[^>]*tabindex="-1"/u.test(source), `${name}: focusable main region is missing`);
    check(!source.includes('site-nav.css'), `${name}: stale site-nav.css link`);
  }

  // 학습 앱 2면: 사이드바 화면 전환 훅과 토스트 상태 영역.
  const studySurfaces = {
    'WordMaster/index.html': [wordMasterHtml, 'homeLogo', 'openStatsBtn'],
    'smstudy/index.html': [smstudyHtml, 'homeLogo', 'openStats'],
  };
  for (const [name, [source, homeId, statsId]] of Object.entries(studySurfaces)) {
    check(new RegExp(`id="${homeId}"[^>]*data-nav="home"`, 'u').test(source), `${name}: sidebar home switch hook is missing`);
    check(new RegExp(`id="${statsId}"[^>]*data-nav="stats"`, 'u').test(source), `${name}: sidebar stats switch hook is missing`);
    check(/<div id="toast" class="toast" role="status" aria-live="polite">/u.test(source), `${name}: polite toast region is missing`);
  }

  check(wordMasterCss.includes('.app-main:focus { outline: none; }'), 'WordMaster: programmatic main focus must not paint an outline');
  check(wordMasterCss.includes('grid-template-columns: minmax(0, 1fr) auto'), 'WordMaster: answer row must use a shrink-safe column');
  check(wordMasterJs.includes('function setNav('), 'WordMaster: sidebar state must follow the rendered view');
  check(wordMasterJs.includes("toast.classList.add('open')"), 'WordMaster: toast must use the shared .toast.open contract');
  check(wordMasterJs.includes('wrongCount: cumulativeWrongCount'), 'WordMaster: wrong-rate ties must use cumulative mistakes');

  check(smstudyCss.includes('.app-main:focus { outline: none; }'), 'smstudy: programmatic main focus must not paint an outline');
  check(smstudyCss.includes('@media print'), 'smstudy: printable concept-note stylesheet is missing');
  check(smstudyCss.includes('.sm-media-fallback'), 'smstudy: KICE image fallback styling is missing');
  check(smstudyJs.includes('function setNav('), 'smstudy: sidebar state must follow the rendered view');
  check(smstudyJs.includes("toast.classList.add('open')"), 'smstudy: toast must use the shared .toast.open contract');
  check(smstudyJs.includes('data-question-image') && smstudyJs.includes('.sm-media-fallback'), 'smstudy: KICE image error fallback hook is missing');
  check(smstudyJs.includes("addEventListener('error', markFailed, { once: true })"), 'smstudy: image error handler must bind once');
  check(smstudyJs.includes("addEventListener('load', markLoaded, { once: true })"), 'smstudy: image success handler must be bound');
  check(smstudyJs.includes('image.naturalWidth > 0'), 'smstudy: cached images must be judged by naturalWidth, not by complete alone');
  check(/markLoaded = \(\) => \{[^}]*fallback\.hidden = true/su.test(smstudyJs), 'smstudy: image success path must re-hide the fallback block');
  check(/\.sm-media\.is-failed \.sm-media-fallback \{[^}]*display: grid/su.test(smstudyCss), 'smstudy: fallback must be revealed by an explicit failure-state rule');
  check(baseRuleDisplay(smstudyCss, 'sm-media-fallback') === 'none', 'smstudy: .sm-media-fallback must default to display: none so a rendered-but-hidden fallback stays invisible');

  // 회귀 방지: hidden 속성으로 렌더되는 블록을 저자 CSS의 display 선언이 되살리는 결함을 잡는다.
  // UA 스타일시트의 [hidden] { display: none } 은 저자 규칙에 항상 지므로, hidden 만으로는 숨겨지지 않는다.
  for (const [surface, markup, css] of [
    ['smstudy', smstudyJs + smstudyHtml, smstudyCss],
    ['WordMaster', wordMasterJs + wordMasterHtml, wordMasterCss],
  ]) {
    for (const token of hiddenClassTokens(markup)) {
      const display = baseRuleDisplay(css, token);
      if (display === null || display === 'none') continue;
      const guarded = css.includes(`.${token}[hidden]`) || /\[hidden\]\s*\{[^}]*display\s*:\s*none/su.test(css);
      check(guarded, `${surface}: .${token} renders with a hidden attribute but its CSS sets display: ${display}; add a [hidden] guard or default it to none`);
    }
  }
  check(smstudyJs.includes('wrongCount: cumulativeWrongCount'), 'smstudy: wrong-rate ties must use cumulative mistakes');

  check(adminHtml.includes('content="noindex, nofollow"'), 'admin: dashboard must stay unindexed');
  check(/<table class="table">/u.test(adminHtml), 'admin: tables must use the shared table primitive');
  check(/id="panel"[^>]*\bhidden\b/u.test(adminHtml), 'admin: dashboard panel must start hidden');
  check(adminCss.includes('.hidden { display: none !important; }'), 'admin: hidden-state utility is missing');
  check(adminJs.includes('class="ad-stat"'), 'admin: stat cards must render on the rewritten markup');
  check(adminJs.includes('btn btn-danger btn-sm delete-user'), 'admin: destructive user action must use the danger button primitive');
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

// CSS를 중괄호 깊이로 훑어 커스텀 프로퍼티 *정의*를 셀렉터·at-rule 맥락과 함께 모은다.
// 이전의 stripPrint 정규식(/@media print\s*\{[\s\S]*?\n\}/)은 닫는 중괄호가 0열에 있다고 가정해
// 중첩 @media·다중 print 블록·들여쓰기 규약 변경에 조용히 오작동할 수 있었다
// (review-3a N-10, review-3b §4 nit). 깊이 계산으로 대체한다.
function collectCustomProperties(cssSource) {
  const text = cssSource.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
  const definitions = [];
  const stack = [];
  let buffer = '';
  let bufferStart = 0;

  const flush = () => {
    const match = buffer.match(/^\s*(--[\w-]+)\s*:([\s\S]*)$/u);
    if (match) {
      const offset = bufferStart + buffer.indexOf(match[1]);
      definitions.push({
        name: match[1],
        value: match[2].trim(),
        selector: stack.length > 0 ? stack[stack.length - 1] : '',
        atRules: stack.filter((entry) => entry.startsWith('@')),
        depth: stack.length,
        line: text.slice(0, offset).split('\n').length,
      });
    }
    buffer = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const close = text.indexOf(char, index + 1);
      const end = close === -1 ? text.length - 1 : close;
      buffer += text.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === '{') {
      stack.push(buffer.trim().replace(/\s+/gu, ' '));
      buffer = '';
      bufferStart = index + 1;
      continue;
    }
    if (char === '}') {
      flush();
      stack.pop();
      bufferStart = index + 1;
      continue;
    }
    if (char === ';') {
      flush();
      bufferStart = index + 1;
      continue;
    }
    buffer += char;
  }
  return definitions;
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

  // 로드 계약: 모든 표면은 system.css를 자기 스타일보다 먼저 링크한다 (4면 전체).
  const styleOrder = {
    'index.html': '/assets/css/home.css',
    'WordMaster/index.html': 'assets/css/style.css',
    'smstudy/index.html': 'assets/css/style.css',
    'admin/index.html': '/admin/assets/css/admin.css',
  };
  for (const [file, ownStylesheet] of Object.entries(styleOrder)) {
    const html = readFileSync(path.join(ROOT, file), 'utf8');
    const systemIndex = html.indexOf('/assets/css/system.css');
    const ownIndex = html.indexOf(ownStylesheet);
    check(systemIndex !== -1, `${file}: system.css must be linked`);
    check(ownIndex !== -1 && systemIndex < ownIndex, `${file}: system.css must load before ${ownStylesheet}`);
  }

  // site-nav.css는 system.css .topbar가 흡수했다 — 파일도 링크도 남으면 안 된다.
  check(!existsSync(path.join(ROOT, 'assets/css/site-nav.css')), 'assets/css/site-nav.css must be deleted (absorbed by system.css .topbar)');

  // C-3 / D5 — 디자인 토큰 단일 원본. 검사 대상 토큰 목록은 system.css의 :root에서 자동 도출한다.
  // 하드코딩하면 토큰이 늘어날 때마다 게이트가 조용히 뒤처진다 — 실제로 색 토큰 9종만 지키고
  // --text-3 등 나머지는 아무 셀렉터에서나 재정의 가능했다 (review-3b §4 major, review-3a M-7).
  const legacyPalette = /#87f5b0|#86efac|#6dff9a|#5fe391|#4ade80|#ff7a7a|#fb7185|#7dd3fc|#a8f5bf|#8fffb0|#facc15|#fb923c|135, ?245, ?176|134, ?239, ?172|95, ?227, ?145|74, ?222, ?128|255, ?122, ?122|251, ?113, ?133|109, ?255, ?154|125, ?211, ?252|250, ?204, ?21/iu;
  const systemTokens = new Set(
    [...systemRoot.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/gu)].map(([, token]) => token),
  );
  // 도출이 깨지면 아래 재정의 금지가 통째로 무력해지므로 도출 결과 자체를 검사한다.
  check(systemTokens.size >= 60, `system.css: :root token set looks truncated (parsed ${systemTokens.size}, expected >= 60)`);
  for (const name of Object.keys(canonical)) {
    check(systemTokens.has(name), `system.css: canonical token ${name} must appear in the parsed :root token set`);
  }

  // 자체 작성 CSS 등록부. 미등록 CSS는 실패시키므로 서드파티 CSS를 슬쩍 끼워 넣어
  // 게이트를 우회할 수 없고, var(--) 소비 강제는 자체 작성 CSS에만 적용된다 (review-3a N-11).
  const firstPartyCss = new Set([
    'assets/css/system.css',
    'assets/css/home.css',
    'WordMaster/assets/css/style.css',
    'smstudy/assets/css/style.css',
    'admin/assets/css/admin.css',
  ]);
  const vendorCss = new Set();

  // 유일한 정당한 재정의: smstudy 개념노트 인쇄용 라이트 팔레트 (plan.md §2).
  // 파일 + @media print + html 셀렉터 + at-rule 1겹 + system.css가 아는 토큰 — 5중으로 좁혀
  // 화이트리스트가 다른 파일·다른 위치의 위반을 덮지 않게 한다.
  const printPalette = { file: 'smstudy/assets/css/style.css', selector: 'html' };
  const isPrintPalette = (name, definition) => name === printPalette.file
    && definition.selector === printPalette.selector
    && definition.depth === 2
    && definition.atRules.length === 1
    && /^@media\b[^{]*\bprint\b/u.test(definition.atRules[0])
    && systemTokens.has(definition.name);
  let printPaletteOverrides = 0;

  for (const file of walk(ROOT, (item) => item.endsWith('.css'))) {
    const name = relative(file);
    const source = readFileSync(file, 'utf8');

    check(!legacyPalette.test(source), `${name}: legacy palette literal found`);
    check(firstPartyCss.has(name) || vendorCss.has(name),
      `${name}: unregistered stylesheet — add it to firstPartyCss or vendorCss in scripts/validate.mjs`);
    if (name === 'assets/css/system.css') continue;

    if (firstPartyCss.has(name)) check(/var\(--/u.test(source), `${name}: stylesheet must consume system.css tokens`);
    check(!/:root\s*\{/u.test(source), `${name}: tokens must come from system.css only (no :root block)`);

    // 토큰 이름도 셀렉터도 가리지 않는다 — system.css 밖의 커스텀 프로퍼티 *정의*는 전면 금지.
    const redefinitions = collectCustomProperties(source).filter((definition) => {
      if (!isPrintPalette(name, definition)) return true;
      printPaletteOverrides += 1;
      return false;
    });
    check(redefinitions.length === 0,
      `${name}: design tokens must be defined only in assets/css/system.css — `
      + redefinitions.map((item) => `${item.name} at line ${item.line} in "${item.selector || '(top level)'}"`).join('; '));
  }

  // 화이트리스트가 죽은 채 남아 다른 위반을 덮는 일이 없도록 실제 사용을 확인한다.
  check(printPaletteOverrides >= 20,
    `smstudy: @media print light palette must remap the shared tokens on html (found ${printPaletteOverrides})`);

  for (const file of walk(ROOT, (item) => item.endsWith('.html'))) {
    const source = readFileSync(file, 'utf8');
    check(!legacyPalette.test(source), `${relative(file)}: legacy palette literal found`);
    // style="--token: …" 인라인 정의도 같은 우회로다.
    check(!/style="[^"]*--[\w-]+\s*:/u.test(source), `${relative(file)}: inline style must not define design tokens`);
  }
}

function validateBrandName() {
  // C-5: 브랜드는 소문자 "hvsdcm" 한 덩어리 (plan.md R-5). 분리 표기 전면 금지.
  const separated = /HVS[\s\-_]?DCM|hvs[\s\-_]dcm/u;
  for (const file of walk(ROOT, (item) => item.endsWith('.html') || item.endsWith('.css'))) {
    check(!separated.test(readFileSync(file, 'utf8')), `${relative(file)}: separated brand name found (use "hvsdcm" in one piece)`);
  }

  // 슬래시·가운뎃점·마침표 분리와 대문자 변형은 전 표면에서 금지 (3b에서 확대).
  const separator = /hvs\s*[/·.]\s*dcm/iu;
  const casing = /HVSDCM|HvsDcm|Hvsdcm|hvsDcm|HVSdcm|hvsDCM/u;
  const brandSurfaces = [
    ...walk(ROOT, (item) => item.endsWith('.html') || item.endsWith('.css')).map(relative),
    'assets/js/home.js',
    'account.js',
    'WordMaster/assets/js/app.js',
    'smstudy/assets/js/app.js',
    'admin/assets/js/admin.js',
  ];
  for (const file of brandSurfaces) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    check(!separator.test(source), `${file}: brand must not be split (use "hvsdcm" in one piece)`);
    check(!casing.test(source), `${file}: brand must appear only as lowercase "hvsdcm"`);
  }

  // R-5의 "자간 분해 금지"는 문자열 스캔으로 잡히지 않는다 — .brand 규칙의 letter-spacing을 직접 본다
  // (review-3a N-8). h v s d c m 처럼 벌어진 워드마크는 문자열상 "hvsdcm"이라 통과해 버린다.
  check(/^\.brand\s*\{[^}]*letter-spacing\s*:\s*normal\s*;/mu.test(readFileSync(path.join(ROOT, 'assets/css/system.css'), 'utf8')),
    'system.css: .brand must pin letter-spacing: normal (R-5 forbids a spaced-out wordmark)');
  for (const cssFile of walk(ROOT, (item) => item.endsWith('.css'))) {
    for (const [, selector, body] of readFileSync(cssFile, 'utf8').matchAll(/([^{}]*\.brand[^{}]*)\{([^{}]*)\}/gu)) {
      const spacing = body.match(/letter-spacing\s*:\s*([^;]+)/u);
      check(!spacing || spacing[1].trim() === 'normal',
        `${relative(cssFile)}: ${selector.replace(/\/\*[\s\S]*?\*\//gu, " ").trim()} must not spread the wordmark (letter-spacing: ${spacing?.[1].trim()})`);
    }
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
    'smstudy/index.html': ['/account.js', '/assets/vendor/lucide/icons.js', 'assets/js/data.js', 'assets/js/notebook-data.js', 'assets/js/explanation-data.js', '/assets/js/study-utils.js', 'assets/js/diagram.js', 'assets/js/app.js'],
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

function validateOgImageLock() {
  // B-1 재발 방지 — og.png 픽셀 속 글자는 텍스트 스캔(validateBrandName)이 볼 수 없다.
  // 그래서 "랜딩 워드마크 문자열 <-> assets/og.png 바이트 해시"를 잠금쌍으로 고정한다.
  // 브랜드 표기를 바꾸는 커밋은 (1) 아래 brand가 어긋나 즉시 실패하고,
  // (2) 잠금을 갱신하려면 og.png를 실제로 재생성해 sha256을 다시 계산해야 한다.
  const OG_LOCK = {
    brand: 'hvsdcm',
    sha256: '4d702de6f212f303c88a51d99eb63344ed0503bce69bb255ddb490fe61dcf6ad',
  };
  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check(new RegExp(`class="brand"[^>]*>${OG_LOCK.brand}<`, 'u').test(homeHtml),
    'og lock: index.html wordmark != OG_LOCK.brand — regenerate assets/og.png with the new brand, then update OG_LOCK (brand + sha256) together');
  check(/property="og:image"[^>]*assets\/og\.png/u.test(homeHtml) && /name="twitter:image"[^>]*assets\/og\.png/u.test(homeHtml),
    'og lock: index.html og:image/twitter:image must reference assets/og.png');
  check(createHash('sha256').update(readFileSync(path.join(ROOT, 'assets/og.png'))).digest('hex') === OG_LOCK.sha256,
    'og lock: assets/og.png bytes do not match OG_LOCK.sha256 — regenerate the image and update the lock in one commit');
}

function validateLandingGating() {
  // 사이클 #3 게이팅 잠금 (plan.md D7 철회) — 미로그인 랜딩은 "개인 웹사이트"여야 한다.
  // 학습 콘텐츠는 <template data-study>에만 존재하고 로그인 판정 후 home.js가 주입한다.
  // 마크업을 재작성하더라도 이 계약이 조용히 풀리지 않도록 정적으로 확인한다.
  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const homeJs = readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8');
  const templatePattern = /<template data-study>[^]*?<\/template>/gu;
  const studyTemplates = homeHtml.match(templatePattern) || [];
  const staticMarkup = homeHtml.replace(templatePattern, '');

  // 1) 미로그인 상태로 렌더되는 정적 마크업에 학습 앱 경로가 있으면 실패.
  for (const appPath of ['/WordMaster/', '/smstudy/', '/admin/']) {
    check(!new RegExp(`(?:href|src|action)=["']${appPath.replaceAll('/', '\\/')}`, 'u').test(staticMarkup),
      `index.html: logged-out static markup must not link to study app path ${appPath}`);
  }
  // 2) 학습을 드러내는 문구도 정적 마크업에 남으면 안 된다 (메타/OG 포함 전체 소스 기준).
  for (const keyword of ['학습', 'WordMaster', 'smstudy', 'Study']) {
    check(!staticMarkup.includes(keyword),
      `index.html: logged-out static markup must not contain study keyword "${keyword}"`);
  }
  // 3) 복원 계약 — 로그인 시 주입될 템플릿 안에는 두 학습 앱 링크가 반드시 있어야 한다.
  const templateMarkup = studyTemplates.join('\n');
  check(studyTemplates.length > 0, 'index.html: <template data-study> blocks are missing');
  check(templateMarkup.includes('href="/WordMaster/"'), 'index.html: study templates must restore the /WordMaster/ link on login');
  check(templateMarkup.includes('href="/smstudy/"'), 'index.html: study templates must restore the /smstudy/ link on login');
  // 4) 주입 루틴 존재 — 템플릿만 있고 주입 코드가 사라지면 로그인 화면이 빈다.
  check(homeJs.includes('mountStudyContent'), 'home.js: mountStudyContent is missing — study templates would never render');
}

validateJavaScriptSyntax();
validateHtmlAssets();
validateUiContracts();
validateLandingGating();
validateDesignTokens();
validateBrandName();
validateOgImageLock();
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
