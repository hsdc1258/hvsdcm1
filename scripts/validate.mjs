import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync as readFileRaw, statSync } from 'node:fs';
import path from 'node:path';
import {
  APP_SOURCE, DIAGRAM_SOURCE, ICON_SOURCE,
  createAppSandbox, evaluateBrowserData, evaluateDiagramRenderer, functionBody, readSource, trackReads,
} from './render-sandbox.mjs';
import { findDesignHeadingSequenceErrors } from './design-heading-sequence.mjs';
import { DEFAULT_AVAILABILITY } from './gichul/availability.mjs';
import { buildSnapshots, SNAPSHOT_BY_SCREEN, SNAPSHOT_FILES } from './snapshot.mjs';

const ROOT = process.cwd();
const DESIGN_HEADING_PATH = process.env.HVSDCM_VALIDATE_DESIGN_PATH
  ? path.resolve(process.env.HVSDCM_VALIDATE_DESIGN_PATH)
  : path.join(ROOT, 'docs/DESIGN.md');
const failures = [];
let checks = 0;

// ---- R3-M-1. 줄바꿈 정규화 ----
// 윈도우 기본값 `core.autocrlf=true`로 체크아웃하면 소스가 CRLF로 내려온다. 함수 경계
// 정규식과 스냅샷 바이트 대조는 LF를 전제하므로, 정상 커밋이 머신에 따라 거짓 실패했다.
// 텍스트로 읽는 순간 CRLF를 LF로 접어 판정이 체크아웃 설정에 좌우되지 않게 한다.
// 인코딩 인자가 없는 호출(Buffer)은 손대지 않는다 — 해시 잠금과 WebP 파싱은 원본 바이트를 봐야 한다.
function readFileSync(file, encoding) {
  if (!encoding) return readFileRaw(file);
  return readFileRaw(file, encoding).replace(/\r\n/gu, '\n');
}

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

// 검사 대상은 이 체크아웃의 소스뿐이다. `.claude/`는 에이전트가 만든 중첩 워크트리가
// 사는 곳이라 저장소 전체의 사본이 그 안에 또 들어 있다 — 걸러내지 않으면 남의 브랜치
// 파일이 이 체크아웃의 위반으로 보고돼 게이트가 상시 빨간불이 된다(2026-08-30 실측).
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.wrangler', '.claude']);

function walk(directory, predicate) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, predicate));
    else if (predicate(absolute)) files.push(absolute);
  }
  return files;
}

// ---- B-1. "실제로 게시되는 HTML"을 저장소 상태에서 도출한다 ----
// 저장소 루트가 곧 GitHub Pages의 배포 루트다. 그래서 "이 디렉터리는 배포면이 아니다"를
// 손으로 적을 수 없다 — 이전 walk()가 docs/snapshots를 그렇게 제외했고, 그 전제가 틀려서
// 로그인 없이 열리는 개념 본문이 공개됐다(B-1).
// 게시 여부는 Pages의 규칙이 정한다: .nojekyll이 없으면 Jekyll이 빌드하고, Jekyll은
// 경로의 어느 조각이든 '_'나 '.'로 시작하면 출력하지 않는다. .nojekyll이 생기는 순간
// 저장소의 모든 HTML이 그대로 게시되므로 밑줄 디렉터리도 검사 대상이 된다.
// 즉 배포 설정이 바뀌면 이 함수의 결과가 따라 바뀌고, 게이트가 자동으로 더 넓어진다.
const JEKYLL_DISABLED = () => existsSync(path.join(ROOT, '.nojekyll'));
function isJekyllHidden(relativePath) {
  return relativePath.split('/').some((segment) => segment.startsWith('_') || segment.startsWith('.'));
}
function publishedHtml() {
  const jekyllOff = JEKYLL_DISABLED();
  return walk(ROOT, (item) => item.endsWith('.html'))
    .filter((file) => jekyllOff || !isJekyllHidden(relative(file)));
}

function scriptReferences(source) {
  return [...source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/giu)].map(([, src]) => src);
}

// 게시되는 HTML이 **실제로 로드하는** 로컬 스크립트. 검사 대상 JS 목록을 손으로 적으면
// 새 화면(/usage/ 같은)이 생겨도 게이트가 그 화면의 스크립트를 보지 않는다 —
// 목록을 마크업에서 도출해 화면이 늘면 검사도 함께 늘어나게 한다 (LESSONS 규칙 5).
function publishedScripts() {
  const scripts = new Set();
  for (const file of publishedHtml()) {
    for (const source of scriptReferences(readFileSync(file, 'utf8'))) {
      if (/^https?:/iu.test(source)) continue;
      const absolute = resolveAsset(file, source);
      if (existsSync(absolute)) scripts.add(relative(absolute));
    }
  }
  return [...scripts].sort();
}

// ---- 로그인 게이트의 판정 ----------------------------------------------------
// 파일 이름(account.js / admin.js)을 적는 대신 **게이트가 하는 일**을 스크립트 소스에서
// 찾는다: 랜딩으로 되돌리는 리다이렉트이거나, 관리자 토큰을 요구하거나.
// 게이트 스크립트를 새로 만들거나 이름을 바꿔도 계약이 따라온다.
//
// 이 판정이 **못 보는 것**: 게이트가 *실제로 렌더 전에 도는지*(코드 순서), 조건이
// 올바른지, 그리고 서버가 같은 규칙을 강제하는지. 여기서 보는 것은 "가리려는 코드가
// 이 화면에 실려 있는가"까지다.
const GATE_MARKERS = [
  { name: 'login redirect', test: (js) => /location\.replace\(/u.test(js) && js.includes('login=1') },
  { name: 'admin token', test: (js) => js.includes('hvsdcm.admin') },
  { name: 'owner bearer gate', test: (js) => js.includes("localStorage.getItem('hvsdcm.token')")
    && js.includes('authorization: `Bearer ${ownerToken()}`') && js.includes('ownerVerified') },
];
function loginGateOf(htmlFile, source) {
  for (const reference of scriptReferences(source)) {
    if (/^https?:/iu.test(reference)) continue;
    const absolute = resolveAsset(htmlFile, reference);
    if (!existsSync(absolute)) continue;
    const js = readFileSync(absolute, 'utf8');
    const marker = GATE_MARKERS.find((candidate) => candidate.test(js));
    if (marker) return { script: relative(absolute), marker: marker.name };
  }
  return null;
}

// 미로그인 방문자에게 학습 내용을 노출하지 않는다는 계약을 **게시되는 모든 HTML**에 건다
// (plan.md §3). 랜딩은 <template data-study>로, 나머지 화면은 자기 게이트 스크립트로
// 가려진다. 그 어느 쪽도 아닌 게시 HTML은 학습 문구를 담고 있으면 안 된다.
const STUDY_KEYWORDS = ['학습', 'WordMaster', 'smstudy', 'Study'];
function validateStudyExposure() {
  const pages = publishedHtml();
  check(!JEKYLL_DISABLED(), 'learning content: .nojekyll would publish the protected _learning directory');
  const jekyllConfigPath = path.join(ROOT, '_config.yml');
  const jekyllConfig = existsSync(jekyllConfigPath) ? readFileSync(jekyllConfigPath, 'utf8') : '';
  check(!/include\s*:[^\n]*_learning/u.test(jekyllConfig), 'learning content: _config.yml must not include the protected _learning directory');
  check(!existsSync(path.join(ROOT, 'smstudy/assets/kice')), 'learning content: public smstudy/assets/kice must stay absent');
  const wordLoader = readFileSync(path.join(ROOT, 'WordMaster/assets/js/words.js'), 'utf8');
  const smstudyLoader = readFileSync(path.join(ROOT, 'smstudy/assets/js/data.js'), 'utf8');
  check(wordLoader.includes('/api/learning/wordmaster') && !wordLoader.includes('d01-01'),
    'learning content: public WordMaster loader must contain only the authenticated API bootstrap');
  check(smstudyLoader.includes('/api/learning/smstudy') && !smstudyLoader.includes('QUESTION_ROWS'),
    'learning content: public smstudy loader must contain only the authenticated API bootstrap');
  for (const file of walk(path.join(ROOT, '_learning'), () => true)) {
    check(isJekyllHidden(relative(file)), `${relative(file)}: protected source escaped the Jekyll-hidden _learning boundary`);
  }
  check(pages.length >= 4, `study exposure: only ${pages.length} published HTML files were derived — this check is inert`);
  for (const file of pages) {
    const name = relative(file);
    if (name === 'index.html') continue;   // validateLandingGating()이 따로 본다
    const source = readFileSync(file, 'utf8');
    if (loginGateOf(file, source)) continue;
    for (const keyword of STUDY_KEYWORDS) {
      check(!source.includes(keyword),
        `${name}: published without a login gate but contains study keyword "${keyword}" — move it out of the published surface (a "_" directory) or gate it (plan.md §3)`);
    }
  }
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
  for (const file of publishedHtml()) {
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
  const usageHtml = readFileSync(path.join(ROOT, 'usage/index.html'), 'utf8');
  const usageCss = readFileSync(path.join(ROOT, 'usage/assets/css/usage.css'), 'utf8');
  const usageJs = readFileSync(path.join(ROOT, 'usage/assets/js/usage.js'), 'utf8');

  // 조건을 includes 두 개로 나누면 서로 다른 요소를 봐도 통과한다 — 한 태그 안에서 매칭한다 (review-3a M-6).
  // 학습 드로어는 미로그인 문서에 렌더되면 안 된다 — <template data-study> 안에만 존재한다 (사이클 #3 게이팅).
  check(/<template data-study>[^]*?class="drawer-study"/u.test(homeHtml), 'home: STUDY drawer must live inside a <template data-study> (login-gated)');
  // 대화상자 의미는 백드롭이 아니라 시트 본체(form.sheet)에 붙는다 (review-3a N-7).
  check(/id="loginForm"[^>]*class="[^"]*\bsheet\b[^"]*"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="loginTitle"/u.test(homeHtml),
    'home: login sheet itself must carry role="dialog" aria-modal="true" aria-labelledby="loginTitle"');
  check(!/id="loginModal"[^>]*(?:role="dialog"|aria-modal=)/u.test(homeHtml),
    'home: sheet backdrop must not carry dialog semantics — they belong on the .sheet form');
  check(/id="loginTitle"/u.test(homeHtml), 'home: login dialog label target #loginTitle is missing');
  // 랜딩 3곳(상단바·드로어·푸터)은 텍스트 앞에 .brand-mark 인라인 로고가 온다(DESIGN.md §8).
  // 예전 검사는 마크를 선택(`?`)으로 두고 `.test()` 한 번만 돌려, 로고를 전부 지워도
  // 통과했다 — review M-1이 변이 실험으로 실증. 로고의 단일 원본은 assets/logo.svg
  // 하나뿐이므로(DESIGN.md §8 "단일 원본") 사각형 3개의 좌표를 거기서 뽑아 쓴다 —
  // 좌표를 여기 다시 적으면 원본이 바뀌어도 검사만 따로 남는다 (LESSONS 단일 원본 자동 도출).
  const logoSvg = readFileSync(path.join(ROOT, 'assets/logo.svg'), 'utf8');
  const logoRects = [...logoSvg.matchAll(/<rect\b[^>]*\/>/gu)].map(([rect]) => rect);
  check(logoRects.length === 3, `assets/logo.svg: expected exactly 3 <rect> shapes but found ${logoRects.length} — the brand-mark contract cannot be derived`);
  // .brand는 정확히 3개여야 하고(상단바·드로어·푸터), 그 셋 모두가 원본과 같은 사각형 3개를
  // 품은 완전한 brand-mark SVG를 "hvsdcm" 바로 앞에 가지고 있어야 한다 — 개수가 모자라거나
  // 넘쳐도, 마크가 비었거나 원본과 달라져도 실패한다. 클래스는 토큰으로 비교한다
  // (`footer-brand`처럼 하이픈으로 이어진 이름이 `\bbrand\b`에 걸려 오탐하지 않도록).
  const brandContainers = [...homeHtml.matchAll(/<(a|span)\b[^>]*\sclass="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/gu)]
    .filter(([, , classValue]) => classValue.split(/\s+/u).includes('brand'));
  check(brandContainers.length === 3,
    `home: expected exactly 3 .brand containers (topbar·drawer·footer) but found ${brandContainers.length}`);
  const intactBrandMarks = brandContainers.filter(([, , , inner]) => {
    const svgMatch = /^<svg\b[^>]*class="brand-mark"[^>]*>([\s\S]*?)<\/svg>hvsdcm$/u.exec(inner.trim());
    return Boolean(svgMatch) && logoRects.every((rect) => svgMatch[1].includes(rect));
  }).length;
  check(intactBrandMarks === brandContainers.length,
    `home: ${brandContainers.length - intactBrandMarks} of ${brandContainers.length} .brand containers are missing an intact brand-mark logo (matching assets/logo.svg) directly before "hvsdcm"`);
  check(homeHtml.includes('data-login-trigger'), 'home: login trigger hook is missing');
  check(homeHtml.includes('class="skip-link"'), 'home: skip navigation link is missing');
  check(/class="[^"]*\breveal\b/u.test(homeHtml), 'home: scroll-reveal sections are missing');
  check(/id="menuButton"[^>]*aria-expanded="false"[^>]*aria-controls="drawer"/u.test(homeHtml), 'home: menu button accessibility wiring is missing');
  check(homeCss.includes('.drawer.logged .drawer-study'), 'home: STUDY drawer must depend on logged-in state');
  check(homeCss.includes('.drawer.logged .drawer-owner'), 'home: owner-only drawer group must depend on logged-in state');
  check(homeCss.includes('.account.logged'), 'home: CTA switch must depend on logged-in state');
  check(homeCss.includes('.hero-title[data-user]'), 'home: personalized title responsive rule is missing');
  // 주입은 로그인 판정 분기 안에서만 일어나야 한다 — 무조건 mount하면 게이팅이 무너진다.
  check(/if \(savedUsername && token\) \{[^]*?mountDrawerTemplates\(/u.test(homeJs),
    'home: mountDrawerTemplates() must run only inside the logged-in branch');
  check(homeJs.includes("selector: 'template[data-study]'"), 'home: study template mount routine is missing');
  check(homeJs.includes('prefers-reduced-motion'), 'home: scroll reveal must respect reduced-motion preference');
  check(homeJs.includes('setLoginBackgroundInert(true)') && homeJs.includes('setLoginBackgroundInert(false)'),
    'home: the modal must make page siblings inert only while it is open');
  check(homeJs.includes("event.key === 'Tab'") && homeJs.includes('loginFocusables()'),
    'home: the login dialog must trap Tab and Shift+Tab focus');
  check(homeJs.includes('target?.focus()'),
    'home: closing the login dialog must restore focus to its opener');

  check(wordMasterJs.includes('wrongVisible: 50')
    && wordMasterJs.includes('.slice(0, state.wrongVisible)')
    && wordMasterJs.includes('state.wrongVisible += 50'),
  'WordMaster: wrong-answer history must render in bounded 50-row batches');
  check(smstudyJs.includes('data-mistake-id=')
    && smstudyJs.includes('data-mistake-body')
    && smstudyJs.includes('bindMistakeDisclosures'),
  'smstudy: wrong-answer detail cards must render lazily inside disclosures');

  // ---- 랜딩 학습 은닉 완결 (plan.md §1-1) ----
  // 로그인해도 **본문**에는 학습이 없다. 진입은 좌상단 드로어 하나뿐이다.
  // 두 조건이 함께 있어야 계약이 닫힌다: (1) 로그인-후 템플릿이 드로어 안에만 있고,
  // (2) 주입 루틴이 드로어만 훑는다. 하나만 걸면 나머지 한쪽으로 학습이 본문에 돌아온다.
  //
  // 이 검사가 **못 보는 것**: 본문에 학습 문구를 *정적으로* 적는 경우는 여기가 아니라
  // validateLandingGating()의 키워드·경로 검사가 잡는다. 그리고 home.js 밖에서
  // (다른 스크립트가) DOM을 조립해 넣는 경로는 정적으로 볼 수 없다.
  const drawerMarkup = /<aside id="drawer"[^]*?<\/aside>/u.exec(homeHtml)?.[0] ?? '';
  check(drawerMarkup.length > 0,
    'home: the drawer landmark could not be located — the drawer-only study contract cannot be checked');
  // 템플릿 종류(data-study / data-owner)를 손으로 적지 않는다 — 문서에 있는 것을 센다.
  const templateTag = /<template data-(study|owner)>/gu;
  const studyTemplateCount = (homeHtml.match(templateTag) || []).length;
  const drawerTemplateCount = (drawerMarkup.match(templateTag) || []).length;
  check(studyTemplateCount > 0 && studyTemplateCount === drawerTemplateCount,
    `home: ${studyTemplateCount - drawerTemplateCount} of ${studyTemplateCount} login-gated <template> blocks live outside the drawer — gated entry points belong to the drawer only (plan.md §1-1)`);
  check(/elements\.drawer\.querySelectorAll\(selector\)/u.test(homeJs),
    'home: mountDrawerTemplates() must scope its query to the drawer so a template placed in the body can never mount (plan.md §1-1)');
  // 소유자 전용 템플릿은 소유자 판정에서만 복제된다 (review WP1 M-5).
  // 이 검사가 **못 보는 것**: 판정 자체가 옳은지(소유자 이름의 정오)와 서버의 강제 여부.
  // 서버 쪽은 worker/test.mjs가 본다 — 두 검사가 함께 있어야 계약이 닫힌다.
  check(/\{ selector: 'template\[data-owner\]', ownerOnly: true \}/u.test(homeJs),
    'home: the owner-only drawer template must be declared with ownerOnly: true (review WP1 M-5)');
  check(/if \(ownerOnly && !owner\) continue;/u.test(homeJs),
    'home: an ownerOnly template must never be cloned for a non-owner — hiding it with CSS is not gating (LESSONS)');

  // ---- 사용량 화면 (plan.md §1-2 / §3.2) ----
  // 여기서 보는 것은 **마크업 구조 계약**뿐이다. 렌더 로직(버킷 키 도출, 모르는 키 폴백,
  // resets_at 파싱, 24시간 stale, 게이지 색 구간)은 소스 문자열 grep이 아니라
  // `scripts/usage.test.mjs`가 buildDashboard()를 **실제로 실행해** 검증한다 (review WP1 M-2).
  // grep은 변수명만 바꿔도 깨지고 로직이 틀려도 통과했다 — 그래서 지웠다.
  //
  // 이 검사가 **못 보는 것**: API 응답의 실제 모양(런타임 계약은 worker/test.mjs가 본다),
  // 게이지 폭이 퍼센트와 맞는지(스냅샷의 고정 표본이 사람 눈에 보여 준다).
  check(usageHtml.includes('id="usageBody"'), 'usage: the dashboard mount point #usageBody is missing');
  check(usageJs.includes('login=1&next='),
    'usage: the redirect must carry ?login=1&next= so the visitor returns here after login');
  check(usageCss.includes('.us-body'), 'usage: the screen stylesheet lost its layout rules');

  // 화면이 그리는 단계 목록과 **Worker가 받아 주는 단계 목록**은 같아야 한다.
  // 다르면 둘 중 하나가 반드시 거짓말이 된다: 화면이 영원히 이벤트가 오지 않는 단계를
  // 그리거나(review WPA2 M4가 요구한 8단계가 이 경우다), 받은 단계를 못 그린다.
  // 두 목록을 손으로 맞추지 않고 **원본 대 원본**으로 비교한다 (LESSONS: 파생 가능한
  // 것을 손으로 적지 않는다). 계약을 넓히려면 worker의 허용 집합을 먼저 넓혀야 하고,
  // 그때 이 검사가 화면 갱신을 강제한다.
  const routerJs = readFileSync(path.join(ROOT, 'worker/src/router.js'), 'utf8');
  const workerPhases = [...(/VALID_HARNESS_PHASES = new Set\(\[([^\]]*)\]\)/u.exec(routerJs)?.[1] || '')
    .matchAll(/'([a-z0-9-]+)'/gu)].map((match) => match[1]);
  const screenPhases = [...(/\n  const PHASES = \[([\s\S]*?)\n  \];/u.exec(usageJs)?.[1] || '')
    .matchAll(/key: '([a-z0-9-]+)'/gu)].map((match) => match[1]);
  check(workerPhases.length > 0,
    'usage: could not derive VALID_HARNESS_PHASES from worker/src/router.js — this cross-check is inert');
  check(screenPhases.length > 0,
    'usage: could not derive the PHASES list from usage.js — this cross-check is inert');
  check(workerPhases.join(',') === screenPhases.join(','),
    `usage: the screen's phase chain [${screenPhases.join(', ')}] must equal the phases the Worker accepts`
    + ` [${workerPhases.join(', ')}] — a stage the reporter cannot emit can never carry status, model, or duration`);

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

  // 3c에서 앱 셸 보조 규칙(.app-main / .view-head / .side-* / .app-footer / .app-page)을
  // system.css로 승격했다. 화면마다 같은 규칙을 다시 두지 않으므로 단일 원본에서 확인한다.
  // 조판이 아니라 규칙을 본다 — 포매터가 한 줄 규칙을 펼쳐도 계약은 그대로다 (review WP1 M-4).
  check(/\.app-main:focus\s*\{\s*outline:\s*none;?\s*\}/u.test(systemCss), 'system.css: programmatic main focus must not paint an outline');
  for (const primitive of ['.app-page', '.app-main', '.view-head', '.view-head-main', '.side-facts', '.side-note', '.app-footer', '.sr-only', '.list-row-stretch', '.list-row-accessory', '.disclosure', '.disclosure-head', '.disclosure-body', '.list-group-head-row',
    // 사이클5 — 콘솔 대시보드 프리미티브 (plan.md §3.4). admin과 usage가 공유한다.
    '.sidebar-label', '.summary-strip', '.summary-cell', '.status-dot', '.gauge-track', '.gauge-fill']) {
    check(systemCss.includes(primitive + ' {') || systemCss.includes(primitive + ','),
      `system.css: primitive ${primitive} is missing`);
  }
  // 승격된 규칙이 화면 CSS에 되살아나면(같은 모양의 재구현) 톤이 다시 갈라진다.
  // 인쇄 블록은 제외한다 — 거기서 프리미티브를 숨기는 것은 재구현이 아니라 소비다.
  const withoutPrint = (css) => css.replace(/@media\s+print\s*\{[\s\S]*$/u, '');
  for (const [name, css] of [['WordMaster', wordMasterCss], ['smstudy', withoutPrint(smstudyCss)], ['admin', adminCss], ['usage', usageCss]]) {
    for (const primitive of ['.app-main', '.view-head', '.side-facts', '.side-note', '.app-footer',
      '.summary-strip', '.summary-cell', '.status-dot', '.gauge-track', '.gauge-fill']) {
      check(!new RegExp(`(^|[\\s,}])\\${primitive}\\s*(\\{|,)`, 'mu').test(css),
        `${name}: ${primitive} is promoted to system.css — do not redefine it in a screen stylesheet (DESIGN.md §7)`);
    }
  }
  check(wordMasterCss.includes('grid-template-columns: minmax(0, 1fr) auto'), 'WordMaster: answer row must use a shrink-safe column');
  check(wordMasterJs.includes('function setNav('), 'WordMaster: sidebar state must follow the rendered view');
  check(wordMasterJs.includes("toast.classList.add('open')"), 'WordMaster: toast must use the shared .toast.open contract');
  check(wordMasterJs.includes('wrongCount: cumulativeWrongCount'), 'WordMaster: wrong-rate ties must use cumulative mistakes');

  check(smstudyCss.includes('@media print'), 'smstudy: printable concept-note stylesheet is missing');
  check(smstudyCss.includes('.sm-media-fallback'), 'smstudy: KICE image fallback styling is missing');
  check(smstudyJs.includes('function setNav('), 'smstudy: sidebar state must follow the rendered view');
  check(smstudyJs.includes("toast.classList.add('open')"), 'smstudy: toast must use the shared .toast.open contract');
  // 이미지 폴백 — 존재 검사 두 개를 AND로 묶으면 서로 다른 요소를 봐도 통과한다 (LESSONS 규칙 4).
  // 실제로 마크업의 속성만 바꿔도 바인더 쪽 선택자 문자열이 남아 모든 검사가 통과했다 (review B-4).
  // 그래서 선택자를 **바인더에서 도출**해 그 값으로 마크업 한 덩어리를 검사한다.
  // 어느 한쪽만 이름을 바꾸면 도출값과 마크업이 어긋나 즉시 실패한다.
  const binderBody = /function bindQuestionImages\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/u.exec(smstudyJs)?.[1] ?? '';
  const imageHook = /querySelectorAll\('\[([\w-]+)\]'\)/u.exec(binderBody)?.[1];
  const figureClass = /closest\('\.([\w-]+)'\)/u.exec(binderBody)?.[1];
  const fallbackClass = /querySelector\('\.([\w-]+)'\)/u.exec(binderBody)?.[1];
  check(Boolean(imageHook && figureClass && fallbackClass),
    `smstudy: could not derive the image-fallback selectors from bindQuestionImages() (hook=${imageHook}, figure=${figureClass}, fallback=${fallbackClass})`);
  if (imageHook && figureClass && fallbackClass) {
    // 마크업 쪽 대상은 **renderQuestionMedia() 함수 본문 안**으로 한정한다.
    // 소스 전체 정규식은 함수 앞에 놓인 같은 모양의 미사용 문자열을 먼저 잡아, 실제로 깨진
    // 이미지 바인딩을 가린다 (review R2-B-3에서 이 우회가 13204 checks로 통과했다).
    const mediaBody = functionBody(smstudyJs, 'renderQuestionMedia') ?? '';
    check(mediaBody.length > 0, 'smstudy: renderQuestionMedia() body could not be located in app.js — the media contract cannot be checked');
    const mediaFigure = new RegExp(`<figure class="${figureClass}[^"]*"[\\s\\S]*?</figure>`, 'u').exec(mediaBody)?.[0] ?? '';
    check(mediaFigure.length > 0, `smstudy: renderQuestionMedia() must emit a <figure class="${figureClass}"> that the binder can find with closest()`);
    // 같은 모양의 <figure>가 함수 밖에 또 있으면 검사 대상이 흔들린다 — 하나뿐이어야 한다.
    const figureOpen = new RegExp(`<figure class="${figureClass}[^"]*"`, 'gu');
    check((smstudyJs.match(figureOpen) || []).length === (mediaBody.match(figureOpen) || []).length,
      `smstudy: app.js emits <figure class="${figureClass}"> outside renderQuestionMedia() — the image-fallback contract must have exactly one target`);
    check(new RegExp(`<img\\b[^>]*\\s${imageHook}(?:="[^"]*")?(?=[\\s>])`, 'u').test(mediaFigure),
      `smstudy: the question <img> inside <figure class="${figureClass}"> must carry the ${imageHook} attribute the binder selects on`);
    check(new RegExp(`<div\\b[^>]*class="${fallbackClass}"[^>]*\\shidden(?=[\\s>])`, 'u').test(mediaFigure),
      `smstudy: the same <figure> must hold a <div class="${fallbackClass}" hidden> for the binder to unhide`);
    check(/\.sm-media\.is-failed \.sm-media-fallback \{[^}]*display: grid/su.test(smstudyCss), 'smstudy: fallback must be revealed by an explicit failure-state rule');
    check(baseRuleDisplay(smstudyCss, fallbackClass) === 'none', `smstudy: .${fallbackClass} must default to display: none so a rendered-but-hidden fallback stays invisible`);
    check(smstudyCss.includes(`.${fallbackClass}`), `smstudy: KICE image fallback styling for .${fallbackClass} is missing`);
  }
  check(smstudyJs.includes("HvsAccount.request(`/api/learning/smstudy/image/"), 'smstudy: question images must cross the authenticated Worker boundary');
  check(smstudyJs.includes("addEventListener('error', () =>"), 'smstudy: protected image error handler must be bound');
  check(smstudyJs.includes("addEventListener('load', () =>"), 'smstudy: protected image success handler must be bound');
  check(smstudyJs.includes('URL.revokeObjectURL(objectUrl)'), 'smstudy: protected image object URLs must be released');
  check(/markLoaded = \(\) => \{[^}]*fallback\.hidden = true/su.test(smstudyJs), 'smstudy: image success path must re-hide the fallback block');

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
  // 조판이 아니라 규칙을 본다 — `npm run format:css`가 한 줄 규칙을 펼쳐도 계약은 그대로다 (review WP1 M-4).
  check(/\.hidden\s*\{\s*display:\s*none\s*!important;?\s*\}/u.test(adminCss),
    'admin: hidden-state utility (.hidden { display: none !important }) is missing');
  check(adminJs.includes('btn btn-danger btn-sm delete-user'), 'admin: destructive user action must use the danger button primitive');

  // ---- 어드민 카테고리 뷰 (plan.md §3 요구사항 3 / §3.4) ----
  // 뷰 목록을 여기에 적지 않는다 — 사이드바의 data-view가 원본이고, 뷰 컨테이너와 초기
  // 표시 상태를 거기서 도출한다. 사이드바에 항목을 더하면 짝이 되는 뷰가 없을 때 실패한다.
  //
  // 이 검사가 **못 보는 것**: 런타임의 뷰 전환(클릭했을 때 정말 하나만 남는지)과 각 뷰의
  // 내용 적절성. 정적으로 볼 수 있는 것은 "문서 초기 상태에서 뷰가 하나만 열려 있는가"와
  // "hidden이 CSS에 지지 않는가"까지다. 나머지는 사람이 스냅샷과 화면에서 본다.
  const adminNavViews = [...adminHtml.matchAll(/<button class="sidebar-item"[^>]*\sdata-view="([\w-]+)"/gu)]
    .map(([, name]) => name);
  const adminViewSections = [...adminHtml.matchAll(/<section class="ad-view" data-view="([\w-]+)"([^>]*)>/gu)];
  check(adminNavViews.length >= 3,
    `admin: only ${adminNavViews.length} sidebar views were derived — the category check is inert`);
  check(adminViewSections.length === adminNavViews.length,
    `admin: ${adminNavViews.length} sidebar entries but ${adminViewSections.length} view containers — every category needs exactly one view (plan.md §3.4)`);
  for (const name of adminNavViews) {
    check(adminViewSections.some(([, view]) => view === name),
      `admin: sidebar entry data-view="${name}" has no matching <section class="ad-view">`);
  }
  const adminVisibleViews = adminViewSections.filter(([, , attributes]) => !/\shidden(?=[\s>]|$)/u.test(attributes));
  check(adminVisibleViews.length === 1,
    `admin: ${adminVisibleViews.length} views render without the hidden attribute — exactly one category may be on screen at a time (plan.md §3 requirement 3)`);
  // UA 스타일시트의 [hidden] { display: none }은 저자 규칙에 항상 진다. 뷰 컨테이너의
  // 기본 display가 none이어야 hidden이 실제로 숨긴다 (사이클4의 같은 결함 계열).
  check(/\.ad-view\s*\{[^}]*display:\s*none/su.test(adminCss),
    'admin: .ad-view must default to display: none so the hidden attribute actually hides a view');
  check((adminHtml.match(/<p class="sidebar-label">/gu) || []).length >= 3,
    'admin: sidebar entries must be grouped under uppercase section labels (plan.md §3.4)');
  check(adminHtml.includes('id="stats" class="summary-strip"'),
    'admin: the overview view must open with the shared summary strip (plan.md §3.4)');
  check(adminJs.includes('class="summary-cell"'),
    'admin: the summary strip must be filled with .summary-cell tiles derived from /api/admin/stats');
  check(/<header class="view-head">[^]*?<div class="toolbar-group">\s*<button/u.test(adminHtml),
    'admin: the content header must carry its action buttons on the right (plan.md §3.4)');
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
  const sessionIpMigration = readFileSync(path.join(migrationDirectory, '0004_session_ip_address.sql'), 'utf8');
  check(sessionIpMigration.includes('ip_address'), 'worker: migration 0004 must add session IP storage');
  const usageMigration = readFileSync(path.join(migrationDirectory, '0005_usage_snapshots.sql'), 'utf8');
  check(
    /CREATE TABLE usage_snapshots[\s\S]*source TEXT PRIMARY KEY[\s\S]*captured_at TEXT NOT NULL[\s\S]*payload TEXT NOT NULL/u
      .test(usageMigration),
    'worker: migration 0005 must define the usage snapshot contract',
  );
  const harnessMigration = readFileSync(path.join(migrationDirectory, '0006_harness_tasks.sql'), 'utf8');
  check(
    /CREATE TABLE harness_tasks[\s\S]*task_id TEXT PRIMARY KEY[\s\S]*status TEXT NOT NULL[\s\S]*updated_at TEXT NOT NULL[\s\S]*payload TEXT NOT NULL/u
      .test(harnessMigration),
    'worker: migration 0006 must define the harness task contract',
  );
  const loginLimitsMigration = readFileSync(path.join(migrationDirectory, '0008_login_attempt_limits.sql'), 'utf8');
  check(
    /CREATE TABLE login_attempt_limits[\s\S]*key_hash TEXT PRIMARY KEY[\s\S]*minute_attempts INTEGER NOT NULL[\s\S]*failure_count INTEGER NOT NULL[\s\S]*locked_until INTEGER NOT NULL/u
      .test(loginLimitsMigration),
    'worker: migration 0008 must define hashed login attempt and lockout counters',
  );
}

function validateGichulBackend() {
  const requiredFiles = [
    'scripts/gichul/availability.mjs',
    'scripts/gichul/fetch-kice.mjs',
    'scripts/gichul/build-manifest.mjs',
    'scripts/gichul/output-contract.e2e.mjs',
    'scripts/gichul/upload-r2.mjs',
    'scripts/gichul/overrides.json',
    'scripts/gichul/gichul.test.mjs',
  ];
  for (const file of requiredFiles) {
    check(existsSync(path.join(ROOT, file)), `${file}: gichul backend artifact is missing`);
  }

  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check(Boolean(packageJson.devDependencies?.['pdfjs-dist']),
    'package.json: pdfjs-dist must be declared as a devDependency for manifest extraction');
  check(Boolean(packageJson.devDependencies?.['@napi-rs/canvas']),
    'package.json: @napi-rs/canvas must be declared for image-only answer table extraction');
  check(!packageJson.dependencies?.['pdfjs-dist'],
    'package.json: pdfjs-dist must not be a production dependency');
  check(String(packageJson.scripts?.test || '').includes('scripts/gichul/gichul.test.mjs'),
    'package.json: npm test must include the gichul script tests');

  const ignoreLines = readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    .split('\n').map((line) => line.trim());
  check(ignoreLines.includes('gichul-src/'), '.gitignore: gichul-src/ must stay outside Git');
  check(!existsSync(path.join(ROOT, 'scripts/gichul/sources.json')),
    'scripts/gichul/sources.json: hard-coded post seeds are forbidden; the KICE list page is the source');

  const fetchSource = readFileSync(path.join(ROOT, 'scripts/gichul/fetch-kice.mjs'), 'utf8');
  const availabilitySource = readFileSync(path.join(ROOT, 'scripts/gichul/availability.mjs'), 'utf8');
  const crawlContractSource = `${availabilitySource}\n${fetchSource}`;
  for (const marker of ['1500234', '1500236', 'C01', 'C02', 'C03', 'fileDown.do']) {
    check(crawlContractSource.includes(marker), `scripts/gichul: missing crawl-contract marker ${marker}`);
  }
  check(availabilitySource.includes('academic_years: { from: 2020, to: 2027 }'),
    'scripts/gichul/availability.mjs: academic years 2020-2027 must be one bounded descriptor range');
  const fetchProduction = /export async function fetchKice\([^]*?\n\}\n\nfunction cliOptions/u.exec(fetchSource)?.[0] || '';
  const inventoryWriteIndex = fetchProduction.indexOf('await writeInventory(inventoryPath, outputs, availability, allowPartial)');
  const coverageGateIndex = fetchProduction.indexOf('validateAssignmentCoverage(outputs, availability)');
  check(fetchSource.includes('crawl-inventory.json')
    && inventoryWriteIndex >= 0
    && coverageGateIndex > inventoryWriteIndex
    && fetchSource.includes('previous?.fileSeq === attachment.fileSeq'),
    'scripts/gichul/fetch-kice.mjs: current fileSeq inventory and complete-corpus gates are missing');
  for (const { id: subject } of DEFAULT_AVAILABILITY.subjects) {
    check(availabilitySource.includes(`id: '${subject}'`),
      `scripts/gichul/availability.mjs: target subject ${subject} is missing`);
  }

  const manifestSource = readFileSync(path.join(ROOT, 'scripts/gichul/build-manifest.mjs'), 'utf8');
  check(manifestSource.includes("import('pdfjs-dist/legacy/build/pdf.mjs')"),
    'scripts/gichul/build-manifest.mjs: pdfjs-dist must be loaded only by the real extractor');
  check(manifestSource.includes('extractText = extractPdfText'),
    'scripts/gichul/build-manifest.mjs: PDF text extraction must remain injectable for fixture tests');
  const manifestProduction = /export async function buildManifest\([^]*?\n\}\n\nfunction cliOptions/u.exec(manifestSource)?.[0] || '';
  check(manifestProduction.includes('validateManifest(exams, activeAvailability)'),
    'scripts/gichul/build-manifest.mjs: generated exams must pass range validation before write');
  check(manifestProduction.includes('validateCrawlInventory(')
    && manifestProduction.includes('validateCorpusManifest(')
    && manifestProduction.includes('unusedOverrides'),
    'scripts/gichul/build-manifest.mjs: crawl inventory, corpus, or exact override gate is missing');

  const uploadSource = readFileSync(path.join(ROOT, 'scripts/gichul/upload-r2.mjs'), 'utf8');
  check(uploadSource.includes('.r2-upload-state.json') && uploadSource.includes("'--remote'"),
    'scripts/gichul/upload-r2.mjs: remote uploads must use a local content-hash checkpoint');
  check(uploadSource.includes("left.key === 'manifest.json'")
    && uploadSource.indexOf('await run(') < uploadSource.indexOf('await writeState('),
    'scripts/gichul/upload-r2.mjs: manifest-last ordering or post-success checkpoint is missing');

  const wrangler = readFileSync(path.join(ROOT, 'worker/wrangler.toml'), 'utf8');
  check(/\[\[r2_buckets\]\][^]*?binding\s*=\s*"GICHUL"[^]*?bucket_name\s*=\s*"hvsdcm-gichul"/u.test(wrangler),
    'worker/wrangler.toml: the GICHUL R2 binding is missing or incomplete');

  const router = readFileSync(path.join(ROOT, 'worker/src/router.js'), 'utf8');
  check(router.includes('/api/gichul/manifest'),
    'worker/src/router.js: missing /api/gichul/manifest route');
  check(router.includes('const gichulPdfMatch = path.match(') && router.includes('return gichulPdf('),
    'worker/src/router.js: missing /api/gichul/pdf/:id route');
  check(router.includes("'cache-control': 'no-store'"),
    'worker/src/router.js: gichul responses must disable caching');

  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const architecture = readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  check(readme.includes('/gichul/'), 'README.md: the gichul screen is missing from the application list');
  check(architecture.includes('GET /api/gichul/manifest') && architecture.includes('GET /api/gichul/pdf/:id'),
    'docs/ARCHITECTURE.md: the authenticated gichul API surface is incomplete');
}

// ---- WP2. 기출 프런트 ----
// 이 게이트가 **못 보는 것**을 먼저 적는다 (승격 규칙 "자동 게이트 사각지대 점검"):
//   - 실제 병합 결과물. pdf-lib은 브라우저에서 돌고, 페이지 구간이 실 PDF와 맞는지는
//     매니페스트 생성기가 실 PDF로 대조한다. 여기서는 "부분 병합 금지" 계약이 코드에
//     남아 있는지까지만 본다.
//   - R2·Worker 실접근, 그리고 화면의 시각 품질. 후자는 docs/_snapshots/gichul.html이
//     사람 눈으로 볼 수 있게 남긴다.
//   - 벤더 번들의 내용. 압축된 한 줄이라 읽을 수 없으므로 **바이트 해시로 잠근다** —
//     번들을 갈아치우려면 이 해시를 같은 커밋에서 갱신해야 한다.
function validateGichulFrontend() {
  for (const file of ['gichul/index.html', 'gichul/app.js', 'gichul/gichul.css',
    'assets/vendor/pdf-lib/pdf-lib.min.js', 'assets/vendor/pdf-lib/LICENSE']) {
    check(existsSync(path.join(ROOT, file)), `${file}: gichul frontend artifact is missing`);
    if (!existsSync(path.join(ROOT, file))) return;
  }

  const PDF_LIB_LOCK = {
    version: 'pdf-lib@1.17.1',
    sha256: '36f3a04b9f61f15bc06a32182cb576c4f188d88ed99427ee9857e59ba46a713d',
  };
  const bundle = readFileSync(path.join(ROOT, 'assets/vendor/pdf-lib/pdf-lib.min.js'), 'utf8');
  check(createHash('sha256').update(readFileSync(path.join(ROOT, 'assets/vendor/pdf-lib/pdf-lib.min.js'))).digest('hex') === PDF_LIB_LOCK.sha256,
    'assets/vendor/pdf-lib/pdf-lib.min.js: bytes do not match PDF_LIB_LOCK.sha256 — re-vendor from npm and update the lock in the same commit');
  check(bundle.includes(PDF_LIB_LOCK.version) && bundle.includes('assets/vendor/pdf-lib/LICENSE'),
    `assets/vendor/pdf-lib/pdf-lib.min.js: the provenance header must name ${PDF_LIB_LOCK.version} and point at the vendored LICENSE`);
  check(readFileSync(path.join(ROOT, 'assets/vendor/pdf-lib/LICENSE'), 'utf8').includes('MIT License'),
    'assets/vendor/pdf-lib/LICENSE: the upstream MIT text is missing');

  // 과목·선택과목·시행의 어휘는 매니페스트 생성기가 단일 원본이다. 화면의 라벨 표를
  // 손으로 적은 사본으로 두면, 백엔드가 과목을 늘려도 화면은 그 항목을 코드값 그대로
  // 노출하거나 아예 빠뜨린다 (승격 규칙 "파생 가능한 것을 손으로 적지 않는다").
  const appSource = readFileSync(path.join(ROOT, 'gichul/app.js'), 'utf8');
  const labelKeys = (name) => {
    const block = new RegExp(`const ${name} = \\{([^}]*)\\}`, 'u').exec(appSource)?.[1] || '';
    return [...block.matchAll(/(?:^|\s)([\w']+):/gu)].map(([, key]) => key.replaceAll("'", ''));
  };
  const vocabulary = [
    {
      name: 'subject',
      keys: DEFAULT_AVAILABILITY.subjects.map(({ id }) => id),
      maps: ['SUBJECT_LABEL'],
    },
    {
      name: 'track',
      keys: [...new Set(DEFAULT_AVAILABILITY.subjects.flatMap(({ tracks }) => tracks.map(({ id }) => id)))]
        .filter((key) => key !== null),
      maps: ['TRACK_LABEL', 'TRACK_SHORT'],
    },
    { name: 'round', keys: DEFAULT_AVAILABILITY.rounds.map(({ id }) => id), maps: ['ROUND_LABEL', 'ROUND_FILE'] },
  ];
  for (const { name, keys, maps } of vocabulary) {
    check(keys.length >= 3,
      `gichul: only ${keys.length} ${name} keys were derived from scripts/gichul/build-manifest.mjs — this check is inert`);
    for (const map of maps) {
      const declared = labelKeys(map);
      check(declared.length >= 3, `gichul/app.js: ${map} could not be parsed — the vocabulary check is inert`);
      for (const key of declared) {
        check(keys.includes(key),
          `gichul/app.js: ${map} carries "${key}", which the availability descriptor never produces — dead label`);
      }
    }
    // 그 어휘가 정적 문서에 있으면, 미로그인 방문자의 DOM에 시험 목록의 일부가 있는 것이다.
    // 낱말 경계로 본다 — 'na'(나형) 같은 두 글자 키는 부분 문자열로 보면 'nav'에도 걸린다.
    const staticDocument = readFileSync(path.join(ROOT, 'gichul/index.html'), 'utf8');
    for (const key of keys) {
      check(!new RegExp(`\\b${key}\\b`, 'u').test(staticDocument),
        `gichul/index.html: the static document carries manifest vocabulary "${key}" — exam data must arrive only from GET /api/gichul/manifest`);
    }
  }

  // 데이터 경로와 계약이 코드에 남아 있는지.
  check(appSource.includes("'/api/gichul/manifest'"),
    'gichul/app.js: the exam list must be fetched from /api/gichul/manifest');
  check(appSource.includes('/api/gichul/pdf/'),
    'gichul/app.js: PDFs must be fetched through the authenticated worker route');
  check(appSource.includes('id="gichulRetry"') && appSource.includes("closest('#gichulRetry')"),
    'gichul/app.js: a manifest failure must provide an in-place retry action');
  check(/location\.replace\(loginPath\(\)\)/u.test(appSource) && appSource.includes('login=1'),
    'gichul/app.js: the login redirect gate is missing — the screen must not render for anonymous visitors');
  check(appSource.includes('window.GICHUL_RENDER'),
    'gichul/app.js: renderers must be reachable as window.GICHUL_RENDER so the snapshot renders the real markup');
  check(appSource.includes('window.PDFLib'),
    'gichul/app.js: merging must use the vendored window.PDFLib');
  // 부분 병합 금지 — 실패 목록을 만든 뒤 PDFDocument.create()에 도달하기 전에 되돌아야 한다.
  check(appSource.includes('Promise.allSettled')
    && appSource.indexOf('if (failures.length)') !== -1
    && appSource.indexOf('if (failures.length)') < appSource.indexOf('PDFDocument.create()'),
    'gichul/app.js: a failed fetch must abort before any merging — no partial merge may be produced (plan.md §4)');
  check(appSource.includes('isExcerptable'),
    'gichul/app.js: items without sections.selection must be rejected in excerpt mode (plan.md §4)');
  check(!/\bstate\.includeCommon\b/u.test(appSource)
    && !appSource.includes('data-option="includeCommon"')
    && !appSource.includes('공통 파트 포함'),
    'gichul/app.js: excerpt mode must ignore the removed includeCommon state and emit selection pages only');
  check(appSource.includes('questionRange: exam.sections.common')
    && appSource.includes('questionRange: exam.sections.selection'),
  'gichul/app.js: full modern papers must be planned from common plus the selected track range');
  check(appSource.includes('answer.canonical_form !== exam.canonical_form')
    && appSource.includes("answerField: 'answer_common'")
    && appSource.includes("answerField: 'answer_selection'")
    && appSource.includes('answer?.[answerField]')
    && appSource.includes('planned.clips.push')
    && appSource.includes('setCropBox'),
  'gichul/app.js: answers must share the question canonical form and mirror common/selection question parts');

  const css = readFileSync(path.join(ROOT, 'gichul/gichul.css'), 'utf8');
  check(!/box-shadow|backdrop-filter|linear-gradient|radial-gradient/u.test(css),
    'gichul/gichul.css: shadows, blur and gradients are forbidden (DESIGN.md §3·§4)');
  check(appSource.includes('class="list-row-stretch gi-pick-hit"')
    && /\.gi-pick-hit\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*auto;/u.test(css),
    'gichul: the row-wide pick label must be an overlay, not a 100%-wide flex item');
}

function validateDesignHeadingSequence() {
  const errors = findDesignHeadingSequenceErrors(
    readFileSync(DESIGN_HEADING_PATH, 'utf8'),
  );
  check(
    errors.length === 0,
    `docs/DESIGN.md: numbered headings must be continuous and nested under their current parent\n${errors.join('\n')}`,
  );
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
  const words = evaluateBrowserData('_learning/wordmaster/words.js', 'WORDMASTER_WORDS');
  check(Array.isArray(words), 'WordMaster: exported data must be an array');
  if (!Array.isArray(words)) return;

  check(words.length === 2_000, `WordMaster: expected 2,000 words, found ${words.length}`);
  check(new Set(words.map((word) => word.id)).size === words.length, 'WordMaster: IDs must be unique');

  // WordMaster content owner: audited stable IDs lock confirmed transcription repairs.
  const auditedSpellings = new Map([
    ['d46-15', 'cuisine'],
    ['d50-15', 'insane'],
  ]);
  for (const [id, spelling] of auditedSpellings) {
    const word = words.find((entry) => entry.id === id);
    check(word?.word === spelling, `WordMaster: ${id} must remain ${spelling}`);
  }

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

// ---- smstudy 개념 노트 구조 계약 (plan.md §5) --------------------------------
// 콘텐츠 문자열 하드코딩을 대신하는 검사들이다. 검사 대상 목록(허용 kind, 아이콘 키,
// 길이를 잴 필드)을 여기에 열거하지 않고 전부 단일 원본에서 도출한다 (LESSONS 규칙 5).

// 필드 이름 → 길이 상한 (plan.md §4.1). 표에 없는 문자열은 본문으로 보고 60자를 적용하므로
// 스키마에 필드가 새로 생겨도 검사가 자동으로 따라간다.
const NOTEBOOK_STRING_LIMITS = {
  headline: 30,
  label: 12,
  items: 20,
  title: 20,
  term: 20,
  tags: 24,
  headers: 24,
  rows: 24,
};

// 다이어그램 *안쪽* 문자열 상한. 이 값은 smstudy/assets/js/diagram.js 머리 주석과
// **같은 숫자여야 한다** (review 3c M-2).
// 사이클3 후속에서 완화했다: 조판이 SVG 좌표에서 CSS 그리드로 바뀌어 줄바꿈을 브라우저가
// 하므로, 상한을 정하는 것은 더 이상 "도형 안에 들어가는가"가 아니라 가독성이다.
// label 8 -> 14 (한국어 명사구 한 어절 + 수식어), items 16 -> 28 (한 줄에 담기는 짧은 문장),
// center 8 -> 14 (label과 같은 성격). 예전 값은 SVG 좌표 계산의 부산물이었다.
const DIAGRAM_TEXT_LIMITS = {
  label: 14,
  items: 28,
  center: 14,
  title: 20,
};

// kind별 nodes 개수와 node.items 개수 상·하한 (docs/kice-analysis.md 부록 D).
// kind 목록 자체는 여기서 정하지 않는다 — 아래 derivedDiagramKinds()가 렌더러에서 뽑고,
// 뽑힌 kind에 여기 항목이 없으면 실패시킨다. 즉 레이아웃을 새로 만들면 상·하한을 함께
// 적는 일이 강제된다.
// nodes 개수는 형식의 의미가 정한다(2×2는 넷, 저울은 둘). items 상한은 사이클3 후속에서
// 완화했다 — CSS 조판은 줄이 늘면 컨테이너가 같이 늘어나므로 "그릴 수 있는 줄 수" 제약이
// 사라졌고, 남은 것은 한 칸에 담아 읽을 만한 양이다.
// art: 이 kind가 장식 SVG(.sm-d-art)를 내는가. **venn 하나만 true다** — 원의 겹침은
// 목록으로 옮길 수 없는 정보다. scale의 저울 그림은 두 열 조판이 이미 말하는 대립을
// 반복할 뿐이라 제거했다(사이클3 후속 사용자 피드백).
// 이 값이 있어야 "layoutVenn의 원 그리기를 통째로 지운" 변형이 잡히고, 반대로
// 존재 이유 없는 그림이 슬그머니 되살아나는 것도 잡힌다 (R2-B-2의 후신).
const DIAGRAM_SHAPE_BOUNDS = {
  flow: { nodes: [3, 5], items: [0, 4], art: false },        // 세로 단계 조판 (좌: 기준 / 우: 결과)
  scale: { nodes: [2, 2], items: [0, 6], art: false },       // 대립 2열 (저울 그림 없음)
  matrix2x2: { nodes: [4, 4], items: [0, 6], art: false },   // 2×2 그리드
  venn: { nodes: [2, 3], items: [0, 5], art: true },         // 원 SVG(번호만) + 범례 — 유일한 그림
  timeline: { nodes: [3, 5], items: [0, 4], art: false },    // 그리드 열
  pyramid: { nodes: [3, 5], items: [0, 4], art: false },     // 폭이 줄어드는 가로 막대
  radial: { nodes: [3, 5], items: [0, 4], art: false },      // 중심 제목 + 카드 그리드
};

// 마크업 구조를 세는 선택자.
// - 노드는 kind와 무관하게 data-node를 단 <li> 하나다 (조판이 SVG에서 CSS로 바뀌며 통일됐다).
// - 아이콘은 **다이어그램에 하나도 없어야 한다.** 노드마다 하나씩 붙는 아이콘은 노드를
//   구별해 주지 않아 전부 걷어냈다 (DESIGN.md §4). LIST_ICON_PATTERN은 이제 "0이어야 한다"를
//   재는 잠금이다 — 아이콘이 되살아나면 실패한다.
const NODE_PATTERN = /<li class="sm-d-node[^"]*" data-node>/gu;
const ITEM_PATTERN = /<ul class="sm-d-items">/gu;
const LIST_ICON_PATTERN = /<svg class="sm-icon"/gu;
const ART_PATTERN = /<div class="sm-d-art">/gu;
// 조판을 CSS에 넘긴 뒤로 SVG 안에 남는 글자는 벤의 한 글자짜리 번호뿐이다.
// 문장이 다시 SVG로 들어가면(= 좌표 조판이 부활하면) 여기서 잡힌다.
const SVG_TEXT_PATTERN = /<text\b[^>]*>([^<]*)<\/text>/gu;
const countMatches = (markup, pattern) => (markup.match(pattern) || []).length;

// 렌더러가 실제로 읽는 필드의 구조 계약 (B-2). 배열 길이만 세던 검사를 대체한다.
// **이 표는 하드코딩된 "검사 대상 목록"이 아니다** — 아래 derivedRenderedFields()가
// 렌더러 소스에서 읽는 필드를 도출해 이 표와 양방향으로 대조하므로, 렌더러가 새 필드를
// 읽기 시작하거나 읽기를 그만두면 표를 고치기 전까지 게이트가 실패한다 (LESSONS 규칙 5).
//   min/max: 배열 길이. cell: 배열 원소 타입. optional: 값이 없어도 되지만 있으면 타입을 지킨다.
const NOTEBOOK_FIELD_CONTRACT = {
  headline: { type: 'string' },
  summary: { type: 'array', cell: 'string', min: 2, max: 3 },
  keyPoints: { type: 'array', cell: 'object', min: 3, max: 3 },
  'keyPoints[].label': { type: 'string' },
  'keyPoints[].text': { type: 'string' },
  // keyPoints[].icon / deepDive[].icon은 계약에 없다 — 아이콘을 화면에서 걷어내 렌더되지 않는다.
  // 아래 양방향 대조가 "렌더러가 다시 읽으면 계약을 적어라"를 강제한다.
  'exam.trend': { type: 'string' },
  'exam.trap': { type: 'string' },
  'exam.tags': { type: 'array', cell: 'string', min: 1 },
  diagrams: { type: 'array', cell: 'object', min: 1, max: 2 },
  'matrix.title': { type: 'string' },
  'matrix.headers': { type: 'array', cell: 'string', min: 3 },
  'matrix.rows': { type: 'array', cell: 'array', min: 4 },
  decision: { type: 'array', cell: 'string', min: 4, max: 5 },
  deepDive: { type: 'array', cell: 'object', min: 4, max: 5 },
  'deepDive[].term': { type: 'string' },
  'deepDive[].points': { type: 'array', cell: 'string', min: 2, max: 4 },
  recall: { type: 'array', cell: 'object', min: 3, max: 4 },
  'recall[].question': { type: 'string' },
  'recall[].answer': { type: 'string' },
};

// diagram.js가 읽는 필드. 개수 상·하한은 DIAGRAM_SHAPE_BOUNDS가 kind별로 따로 본다.
// why는 계약에서 뺐다 — 화면에 낼 정보가 아니어서 데이터에서도 제거했다.
// 단원별 형식 선택 근거는 docs/kice-analysis.md 부록 D가 소유한다.
const DIAGRAM_FIELD_CONTRACT = {
  kind: { type: 'string' },
  title: { type: 'string' },
  center: { type: 'string', optional: true },
  nodes: { type: 'array', cell: 'object', min: 2, max: 5 },
  'nodes[].label': { type: 'string' },
  'nodes[].items': { type: 'array', cell: 'string', optional: true },
};

// 프로퍼티 경로 도출에서 잘라 낼 JS 내장 멤버. 여기서 끊어야 note.matrix.headers.length가
// 'matrix.headers.length'가 아니라 'matrix.headers'로 잡힌다.
const JS_MEMBERS = new Set([
  'length', 'map', 'filter', 'join', 'some', 'every', 'slice', 'forEach', 'reduce',
  'find', 'findIndex', 'sort', 'includes', 'concat', 'flatMap', 'flat', 'indexOf', 'at',
  'toString', 'push', 'keys', 'values', 'entries', 'split', 'trim', 'replace',
  'startsWith', 'endsWith', 'padStart', 'reverse',
]);

// openIndex가 가리키는 '(' 부터 짝이 맞는 ')' 까지의 본문을 돌려준다.
function balancedSlice(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return source.slice(openIndex + 1);
}

// 렌더러 소스에서 "root 객체의 어떤 필드를 읽는가"를 도출한다.
//   root.a.b       -> 'a.b'
//   root.a.map((x) => x.b)  -> 'a[].b'
function derivedRenderedFields(source, root) {
  const fields = new Set();
  const addChain = (chain) => {
    const clean = [];
    for (const segment of chain.split(/\??\./u).filter(Boolean)) {
      if (JS_MEMBERS.has(segment)) break;
      clean.push(segment);
    }
    if (clean.length > 0) fields.add(clean.join('.'));
  };
  for (const [, chain] of source.matchAll(new RegExp(`\\b${root}((?:\\??\\.[A-Za-z_$][\\w$]*)+)`, 'gu'))) {
    addChain(chain);
  }
  for (const match of source.matchAll(new RegExp(`\\b${root}\\.([A-Za-z_$][\\w$]*)\\.map\\(\\(\\s*([A-Za-z_$][\\w$]*)`, 'gu'))) {
    const open = source.indexOf('(', match.index + `${root}.${match[1]}.map`.length);
    const body = balancedSlice(source, open);
    for (const [, member] of body.matchAll(new RegExp(`\\b${match[2]}\\??\\.([A-Za-z_$][\\w$]*)`, 'gu'))) {
      if (JS_MEMBERS.has(member)) continue;
      fields.add(`${match[1]}[].${member}`);
    }
  }
  return fields;
}

// 계약이 다루는 필드 집합 (부모 경로 포함). 'exam.trend'가 있으면 'exam'도 다뤄진 것으로 본다.
function contractCoverage(contract) {
  const covered = new Set();
  for (const key of Object.keys(contract)) {
    const segments = key.split('.');
    for (let index = 1; index <= segments.length; index += 1) covered.add(segments.slice(0, index).join('.'));
  }
  return covered;
}

// 문자열 리터럴과 템플릿 리터럴의 *텍스트*만 뽑는다 (주석·식별자·${식} 제외).
// ${...} 자리는 한 글자 placeholder로 접는다 — 그 안의 값은 스키마 길이 계약이 따로 잰다.
function extractLiteralText(source) {
  const chunks = [];
  let index = 0;
  const readString = (quote) => {
    let text = '';
    index += 1;
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') { text += source[index + 1] === 'n' ? '\n' : source[index + 1]; index += 2; continue; }
      text += source[index];
      index += 1;
    }
    index += 1;
    chunks.push(text);
  };
  const readTemplate = () => {
    let text = '';
    index += 1;
    while (index < source.length && source[index] !== '`') {
      if (source[index] === '\\') { text += source[index + 1]; index += 2; continue; }
      if (source[index] === '$' && source[index + 1] === '{') {
        let depth = 0;
        while (index < source.length) {
          if (source[index] === '{') depth += 1;
          else if (source[index] === '}') { depth -= 1; if (depth === 0) { index += 1; break; } }
          index += 1;
        }
        text += '§';
        continue;
      }
      text += source[index];
      index += 1;
    }
    index += 1;
    chunks.push(text);
  };
  // 정규식 리터럴을 건너뛴다. /[&<>"']/ 같은 리터럴 안의 따옴표를 문자열 시작으로 오인하면
  // 그 뒤 전체가 어긋나 주석이 문구로 잡힌다. 앞의 유효 토큰으로 나눗셈과 구분한다.
  const readRegExp = () => {
    let inClass = false;
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') { index += 2; continue; }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) { index += 1; break; }
      else if (char === '\n') break;
      index += 1;
    }
    while (index < source.length && /[a-z]/u.test(source[index])) index += 1;
  };
  const REGEXP_PRECEDERS = new Set(['=', '(', '[', '{', ',', ';', ':', '!', '&', '|', '?', '+', '-', '*', '%', '~', '^', '<', '>', '\n']);
  const REGEXP_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await']);
  let lastSignificant = '\n';
  let lastWord = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    if (char === '/' && source[index + 1] === '*') { const end = source.indexOf('*/', index + 2); index = end === -1 ? source.length : end + 2; continue; }
    if (char === '"' || char === "'") { readString(char); lastSignificant = char; lastWord = ''; continue; }
    if (char === '`') { readTemplate(); lastSignificant = '`'; lastWord = ''; continue; }
    if (char === '/' && (REGEXP_PRECEDERS.has(lastSignificant) || REGEXP_KEYWORDS.has(lastWord))) { readRegExp(); lastSignificant = '/'; lastWord = ''; continue; }
    if (/\s/u.test(char)) { if (char === '\n') { lastSignificant = '\n'; lastWord = ''; } index += 1; continue; }
    lastWord = /[A-Za-z_$]/u.test(char) ? lastWord + char : '';
    lastSignificant = char;
    index += 1;
  }
  return chunks;
}

// 마크업 조각에서 태그를 걷어내고 화면에 실제로 읽히는 텍스트 런만 남긴다.
function visibleTextRuns(chunk) {
  return chunk
    .replace(/<[^>]*>/gu, '\n')
    .split('\n')
    .map((run) => run.replace(/\s+/gu, ' ').trim())
    .filter((run) => /[가-힣]/u.test(run));
}

// 허용 kind는 렌더러의 레이아웃 함수 이름에서 뽑는다. LAYOUTS 등록부와 교차 대조해
// "함수는 있는데 등록이 안 된" 또는 그 반대의 상태를 잡는다.
function derivedDiagramKinds() {
  const source = readSource(DIAGRAM_SOURCE);
  const kinds = new Set(
    [...source.matchAll(/function layout([A-Z][\w$]*)\s*\(/gu)]
      .map(([, name]) => name[0].toLowerCase() + name.slice(1)),
  );
  const layoutBlock = /const LAYOUTS = \{([^}]*)\}/su.exec(source);
  const registered = new Set(
    [...(layoutBlock?.[1] ?? '').matchAll(/^\s*([\w$]+)\s*:/gmu)].map(([, name]) => name),
  );
  return { kinds, registered, source };
}

// 스키마를 재귀 순회하며 모든 문자열에 방문자를 적용한다 (검사할 필드를 열거하지 않는다).
function walkNotebookStrings(node, location, key, visit) {
  if (typeof node === 'string') {
    visit(node, location, key);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkNotebookStrings(item, `${location}[${index}]`, key, visit));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [childKey, value] of Object.entries(node)) {
      walkNotebookStrings(value, `${location}.${childKey}`, childKey, visit);
    }
  }
}

// 실제 데이터가 들고 있는 필드 경로를 모은다 ('keyPoints[].icon' 같은 형태).
// 계약 표와 대조해 "데이터에는 있는데 아무도 안 읽는" 죽은 필드를 잡는다.
function collectDataFields(node, prefix, into, stopAt) {
  if (Array.isArray(node)) {
    for (const item of node) collectDataFields(item, `${prefix}[]`, into, stopAt);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    into.add(path);
    if (!stopAt.has(key) && value && typeof value === 'object') collectDataFields(value, path, into, stopAt);
  }
}

// 계약 키('keyPoints[].label')를 실제 값들로 펼친다.
function resolveContractTargets(root, key, location) {
  let nodes = [[root, location]];
  for (const segment of key.split('.')) {
    const isArray = segment.endsWith('[]');
    const name = isArray ? segment.slice(0, -2) : segment;
    const next = [];
    for (const [value, where] of nodes) {
      const child = value === null || value === undefined ? undefined : value[name];
      if (!isArray) { next.push([child, `${where}.${name}`]); continue; }
      if (!Array.isArray(child)) { next.push([undefined, `${where}.${name}[]`]); continue; }
      child.forEach((item, index) => next.push([item, `${where}.${name}[${index}]`]));
    }
    nodes = next;
  }
  return nodes;
}

function applyFieldRule(value, rule, where, iconKeys) {
  if (value === undefined || value === null) {
    check(Boolean(rule.optional), `smstudy: ${where} is read by the renderer but missing (render contract)`);
    return;
  }
  if (rule.type === 'string' || rule.type === 'icon') {
    const ok = typeof value === 'string' && value.trim().length > 0;
    check(ok, `smstudy: ${where} must be a non-empty string (render contract)`);
    if (ok && rule.type === 'icon') {
      check(iconKeys.has(value), `smstudy: ${where} uses icon key "${value}" that is not vendored in ${ICON_SOURCE}`);
    }
    return;
  }
  check(Array.isArray(value), `smstudy: ${where} must be an array (render contract)`);
  if (!Array.isArray(value)) return;
  if (rule.min !== undefined) check(value.length >= rule.min, `smstudy: ${where} must hold at least ${rule.min} entries, found ${value.length}`);
  if (rule.max !== undefined) check(value.length <= rule.max, `smstudy: ${where} must hold at most ${rule.max} entries, found ${value.length}`);
  value.forEach((item, index) => {
    if (rule.cell === 'string') check(typeof item === 'string' && item.trim().length > 0, `smstudy: ${where}[${index}] must be a non-empty string`);
    else if (rule.cell === 'array') check(Array.isArray(item), `smstudy: ${where}[${index}] must be an array`);
    else if (rule.cell === 'object') check(Boolean(item) && typeof item === 'object' && !Array.isArray(item), `smstudy: ${where}[${index}] must be an object`);
  });
}

function enforceContract(contract, root, location, iconKeys) {
  for (const [key, rule] of Object.entries(contract)) {
    for (const [value, where] of resolveContractTargets(root, key, location)) applyFieldRule(value, rule, where, iconKeys);
  }
}

// 화면에 그대로 나가는 렌더러 고정 문구도 R1(한 문장 60자)을 지켜야 한다.
// 데이터 순회만으로는 app.js·diagram.js의 문구가 검사 밖에 남는다 (review B-1).
function validateRenderedCopy() {
  for (const file of [APP_SOURCE, DIAGRAM_SOURCE]) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    let sentences = 0;
    for (const chunk of extractLiteralText(source)) {
      for (const run of visibleTextRuns(chunk)) {
        for (const sentence of run.split(/(?<=[.!?])\s+/u)) {
          const text = sentence.trim();
          if (!/[가-힣]/u.test(text)) continue;
          sentences += 1;
          const length = [...text].length;
          check(length <= 60, `${file}: rendered copy is ${length} characters, over the 60 limit — "${text}"`);
        }
      }
    }
    // 도출이 조용히 깨지면 이 검사가 통째로 무력해진다. 기대치는 파일에서 직접 뽑는다 —
    // 주석이 아닌 줄 중 한글이 있는 줄 수의 절반은 문구로 잡혀야 한다 (하드코딩 금지, LESSONS 5).
    const hangulCodeLines = source.split('\n')
      .filter((line) => /[가-힣]/u.test(line) && !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).length;
    check(sentences >= Math.floor(hangulCodeLines / 2),
      `${file}: rendered-copy scan looks truncated (found ${sentences} sentences for ${hangulCodeLines} Korean code lines) — extractLiteralText may be broken`);
  }
}

function validateSmStudyData() {
  const data = evaluateBrowserData('_learning/smstudy/data.js', 'SMSTUDY_DATA');
  const notebookData = evaluateBrowserData('_learning/smstudy/notebook-data.js', 'SMSTUDY_NOTEBOOK');
  const explanationData = evaluateBrowserData('_learning/smstudy/explanation-data.js', 'SMSTUDY_EXPLANATIONS');
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

  // ---- 구조 계약 (plan.md §5) : 콘텐츠 문자열 하드코딩 검사를 대체한다 ----
  const { kinds: diagramKinds, registered: registeredKinds, source: diagramSource } = derivedDiagramKinds();
  const iconKeys = new Set(Object.keys(evaluateBrowserData(ICON_SOURCE, 'SM_ICONS')?.ICONS || {}));

  // 도출이 조용히 깨지면 아래 계약이 통째로 무력해지므로 도출 결과 자체를 먼저 검사한다.
  check(diagramKinds.size >= 4, `smstudy: diagram kind derivation looks broken (parsed ${diagramKinds.size} layout functions in ${DIAGRAM_SOURCE})`);
  check(iconKeys.size >= 1, `smstudy: icon key derivation looks broken (parsed ${iconKeys.size} keys in ${ICON_SOURCE})`);
  // 벤더 세트에 죽은 아이콘을 쌓아 두지 않는다. 화면이 실제로 부르는 키는 app.js의
  // icon('…') 호출뿐이므로 그 집합과 벤더 집합이 **정확히 같아야** 한다.
  // 아이콘을 새로 쓰려면 벤더링이 강제되고, 안 쓰게 되면 정리가 강제된다.
  const calledIconKeys = new Set(
    [...readSource(APP_SOURCE).matchAll(/\bicon\('([^']+)'\)/gu)].map(([, key]) => key),
  );
  check(calledIconKeys.size >= 1, `smstudy: icon call derivation looks broken (parsed ${calledIconKeys.size} icon() calls in ${APP_SOURCE})`);
  for (const key of calledIconKeys) {
    check(iconKeys.has(key), `smstudy: ${APP_SOURCE} calls icon('${key}') but that key is not vendored in ${ICON_SOURCE}`);
  }
  for (const key of iconKeys) {
    check(calledIconKeys.has(key), `smstudy: ${ICON_SOURCE} vendors "${key}" but nothing renders it — drop it (dead icon)`);
  }
  // 다이어그램 렌더러는 아이콘을 내지 않는다 (DESIGN.md §4). 주석을 걷어낸 소스에서 직접 잠근다
  // (renderIcon(key, …) 선언 한 줄만 허용한다 — 그 함수는 app.js가 쓰는 공용 유틸이다).
  const diagramCode = diagramSource.replace(/^[ \t]*\/\/.*$/gmu, '');
  check(!/renderIcon\((?!key\b)/u.test(diagramCode),
    `smstudy: ${DIAGRAM_SOURCE} must not call renderIcon() inside a layout — diagram nodes carry no icons`);
  // 게이트가 검사하는 아이콘 집합과 렌더러가 실제로 쓰는 집합이 같은 물건이어야 한다.
  // includes()로 보면 window.SM_ICONS_RENAMED 같은 이름 변경이 부분 문자열로 통과한다 (음성 테스트로 확인).
  check(/window\.SM_ICONS(?![\w$])/u.test(diagramSource), `smstudy: ${DIAGRAM_SOURCE} must read icons from window.SM_ICONS so the gate checks the set the renderer uses`);
  for (const kind of diagramKinds) {
    check(registeredKinds.has(kind), `smstudy: ${DIAGRAM_SOURCE} defines layout ${kind} but never registers it in LAYOUTS`);
    check(Array.isArray(DIAGRAM_SHAPE_BOUNDS[kind]?.nodes) && Array.isArray(DIAGRAM_SHAPE_BOUNDS[kind]?.items),
      `smstudy: diagram kind ${kind} has no node/item bound — add it to DIAGRAM_SHAPE_BOUNDS in scripts/validate.mjs`);
    check(typeof DIAGRAM_SHAPE_BOUNDS[kind]?.art === 'boolean',
      `smstudy: diagram kind ${kind} does not declare art — say whether it draws a decorative SVG in DIAGRAM_SHAPE_BOUNDS`);
  }
  for (const kind of registeredKinds) {
    check(diagramKinds.has(kind), `smstudy: LAYOUTS registers ${kind} but ${DIAGRAM_SOURCE} has no layout${kind[0].toUpperCase()}${kind.slice(1)} function`);
  }

  // ---- B-3. 아이콘 집합 → 렌더러 → 마크업 연결을 실제 평가로 확인한다 ----
  const PROBE_KEY = 'gate-probe-icon';
  const PROBE_BODY = '<path d="M1 2 3 4" data-gate-probe="1"/>';
  const probeRenderer = evaluateDiagramRenderer({ [PROBE_KEY]: PROBE_BODY });
  check(typeof probeRenderer?.renderIcon === 'function' && typeof probeRenderer?.renderDiagram === 'function',
    `smstudy: ${DIAGRAM_SOURCE} must publish renderIcon/renderDiagram on window.SMSTUDY_DIAGRAM`);
  if (typeof probeRenderer?.renderIcon === 'function') {
    check(probeRenderer.renderIcon(PROBE_KEY).includes(PROBE_BODY),
      `smstudy: ${DIAGRAM_SOURCE} renderIcon() did not emit the body injected through window.SM_ICONS — the vendored icon set is not wired to the renderer`);
    check(probeRenderer.renderIcon('gate-missing-icon') === '',
      `smstudy: ${DIAGRAM_SOURCE} renderIcon() must emit nothing for an unknown key (no broken markup)`);
  }
  // kind 하나(radial)만 보면 다른 레이아웃이 통째로 비어도 초록이다
  // (R2-B-2: layoutFlow()의 아이콘 한 줄을 지운 변형이 통과했다).
  // 그래서 **도출된 kind 전부**를 렌더해 데이터의 노드·항목·아이콘 개수와 출력 개수를 맞춰 본다.
  // 조판이 SVG 좌표에서 CSS 그리드로 바뀌었으므로 "캔버스가 무엇을 그렸는가" 대신
  // **"출력 요소 수 = 데이터 노드 수"** 라는 구조 검사를 쓴다. kind 목록은 여기서 정하지 않는다.
  if (typeof probeRenderer?.renderDiagram === 'function') {
    for (const kind of diagramKinds) {
      const bounds = DIAGRAM_SHAPE_BOUNDS[kind];
      if (!bounds) continue;
      const nodeCount = bounds.nodes[1];
      const itemCount = bounds.items[1];
      const probeDiagram = {
        kind, title: '게이트 탐침', center: '탐침',
        nodes: Array.from({ length: nodeCount }, (item, index) => ({
          label: `갈래${index + 1}`,
          icon: PROBE_KEY,
          items: Array.from({ length: itemCount }, (cell, cellIndex) => `항목${cellIndex + 1}`),
        })),
      };
      const markup = probeRenderer.renderDiagram(probeDiagram);
      const kindLabel = `layout${kind[0].toUpperCase()}${kind.slice(1)}()`;
      const nodes = countMatches(markup, NODE_PATTERN);
      const itemLists = countMatches(markup, ITEM_PATTERN);
      const listIcons = countMatches(markup, LIST_ICON_PATTERN);
      const arts = countMatches(markup, ART_PATTERN);
      check(nodes === nodeCount,
        `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} emitted ${nodes} node cells for ${nodeCount} data nodes — the layout dropped nodes`);
      check(itemLists === nodeCount,
        `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} emitted ${itemLists} item lists for ${nodeCount} nodes carrying items — the layout dropped node.items`);
      // 항목 텍스트가 실제로 마크업에 도달하는지도 본다 (<ul>만 남기고 <li>를 비운 변형 차단).
      for (let index = 1; index <= itemCount; index += 1) {
        check(markup.split(`<li>항목${index}</li>`).length - 1 === nodeCount,
          `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} did not render item ${index} of every node`);
      }
      // 아이콘은 하나도 나오면 안 된다 — 데이터가 icon 키를 들고 있어도 무시해야 한다.
      // (탐침 노드에는 일부러 icon을 넣어 두었다. 렌더러가 다시 읽기 시작하면 여기서 잡힌다.)
      check(listIcons === 0,
        `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} emitted ${listIcons} icons — diagram layouts must render no icons (DESIGN.md §4)`);
      check(!markup.includes(PROBE_BODY),
        `smstudy: ${DIAGRAM_SOURCE} ${kind} put an icon body into the markup — diagram layouts must render no icons`);
      check(arts === (bounds.art ? 1 : 0),
        `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} emitted ${arts} decorative SVG blocks but DIAGRAM_SHAPE_BOUNDS declares art: ${bounds.art}`);
      // 겹침의 근원이던 "SVG 안 문장"이 되살아나지 않는지 본다 — 한 글자짜리 표지만 허용한다.
      for (const [, text] of markup.matchAll(SVG_TEXT_PATTERN)) {
        check([...text].length <= 1,
          `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} put "${text}" inside the SVG — labels belong in the CSS layout, not in hand-placed <text>`);
      }
    }
  }
  // 실제 벤더 집합으로 21개 다이어그램을 렌더해, 데이터의 icon 키가 마크업까지 도달하는지 본다.
  const liveRenderer = evaluateDiagramRenderer(evaluateBrowserData(ICON_SOURCE, 'SM_ICONS')?.ICONS || {});

  // ---- B-2 / R2-B-1. 계약표가 렌더러보다 뒤처지지 않게 양방향으로 대조한다 (LESSONS 규칙 5) ----
  // 라운드 1은 필드 이름을 **소스 정규식**으로 긁었다. 그 방식은 표현에 취약해서
  // `const alias = note` 뒤 `alias.gateGhost`를 화면에 추가한 변형이 그대로 통과했다 (R2-B-1).
  // 그래서 접근을 뒤집는다 — 렌더러를 **실제 데이터로 실행**하고, 데이터를 Proxy로 감싸
  // 렌더 중 읽힌 키를 런타임에 모은다. 어떤 별칭·구조분해를 거치든 get 트랩은 반드시 지난다.
  // 정규식 도출은 버리지 않고 **보조**로 합집합에 넣는다 (여기서 실행되지 않는 경로를 덮는다).
  const smstudyJsSource = readSource(APP_SOURCE);
  const notebookCoverage = contractCoverage(NOTEBOOK_FIELD_CONTRACT);
  const diagramCoverage = contractCoverage(DIAGRAM_FIELD_CONTRACT);

  const runtimeNotebookFields = new Set();
  // diagrams 아래는 diagram.js의 계약이 따로 보므로 여기서는 더 내려가지 않는다.
  const sandbox = createAppSandbox({ trackNoteFields: runtimeNotebookFields, stopAt: new Set(['diagrams']) });
  let conceptMarkup = '';
  for (const id of sandbox.notebookIds) {
    const markup = sandbox.renderConcept(id);
    check(markup.length > 5000, `smstudy: renderConcept('${id}') produced ${markup.length} characters — the concept screen did not render`);
    conceptMarkup += markup;
  }
  // 이름을 몰라도 누락이 잡히는 출력 검사. 계약에 없는 필드를 화면에 새로 끼우면
  // 값이 없어 undefined·null이 그대로 텍스트로 나가거나 빈 슬롯이 남는다.
  const undefinedSlot = /\bundefined\b|\bnull\b|\bNaN\b/u.exec(conceptMarkup);
  check(!undefinedSlot, `smstudy: rendered concept markup contains "${undefinedSlot?.[0]}" — a template reads a field the data does not carry`);
  const emptySlot = /<(strong|p|li|h1|h2|h3|h4|td|th|dd|dt|summary|figcaption)\b[^>]*>\s*<\/\1>/u.exec(conceptMarkup);
  check(!emptySlot, `smstudy: rendered concept markup holds an empty <${emptySlot?.[1]}> slot — a template renders a field with no value`);

  const runtimeDiagramFields = new Set();
  for (const notebook of Object.values(notebookData.NOTEBOOKS || {})) {
    for (const diagram of notebook.diagrams || []) liveRenderer.renderDiagram(trackReads(diagram, runtimeDiagramFields));
  }

  const renderedNotebookFields = new Set([
    ...runtimeNotebookFields,
    ...derivedRenderedFields(smstudyJsSource, 'note'),
  ]);
  const renderedDiagramFields = new Set([
    ...runtimeDiagramFields,
    ...derivedRenderedFields(diagramSource, 'diagram'),
    ...[...diagramSource.matchAll(/\bnode\??\.([A-Za-z_$][\w$]*)/gu)]
      .map(([, member]) => member).filter((member) => !JS_MEMBERS.has(member)).map((member) => `nodes[].${member}`),
  ]);
  check(runtimeNotebookFields.size >= 15,
    `smstudy: runtime notebook field collection looks broken (observed ${runtimeNotebookFields.size} reads while rendering ${sandbox.notebookIds.length} concept screens)`);
  check(runtimeDiagramFields.size >= 6,
    `smstudy: runtime diagram field collection looks broken (observed ${runtimeDiagramFields.size} reads)`);
  check(renderedNotebookFields.size >= 15,
    `smstudy: notebook field derivation looks broken (parsed ${renderedNotebookFields.size} fields from ${APP_SOURCE})`);
  check(renderedDiagramFields.size >= 6,
    `smstudy: diagram field derivation looks broken (parsed ${renderedDiagramFields.size} fields from ${DIAGRAM_SOURCE})`);
  for (const field of renderedNotebookFields) {
    check(notebookCoverage.has(field),
      `smstudy: ${APP_SOURCE} renders note.${field} but NOTEBOOK_FIELD_CONTRACT in scripts/validate.mjs does not declare it`);
  }
  for (const field of Object.keys(NOTEBOOK_FIELD_CONTRACT)) {
    check(renderedNotebookFields.has(field),
      `smstudy: NOTEBOOK_FIELD_CONTRACT declares ${field} but ${APP_SOURCE} never reads it — drop the contract entry or the field is dead`);
  }
  for (const field of renderedDiagramFields) {
    check(diagramCoverage.has(field),
      `smstudy: ${DIAGRAM_SOURCE} renders diagram.${field} but DIAGRAM_FIELD_CONTRACT in scripts/validate.mjs does not declare it`);
  }
  for (const field of Object.keys(DIAGRAM_FIELD_CONTRACT)) {
    check(renderedDiagramFields.has(field),
      `smstudy: DIAGRAM_FIELD_CONTRACT declares ${field} but ${DIAGRAM_SOURCE} never reads it — drop the contract entry or the field is dead`);
  }

  // 문자열 계약 — 길이 상한 / 1문장 / 평문. 스키마를 재귀 순회해 전 문자열에 적용한다.
  // 아이콘 키 정합도 같은 순회에서 본다 (icon 값이 곧 문자열이므로 별도 목록이 필요 없다).
  // 순회 대상은 노트뿐 아니라 **화면에 실제로 렌더되는 data.js의 개념 섹션·시각 가이드**까지다
  // (review B-1: NOTEBOOKS·LEARNING_DESIGN만 보던 순회가 60자 초과 본문을 통과시켰다).
  let visitedStrings = 0;
  let visitedIcons = 0;
  let visitedHrefs = 0;
  const inspectString = (value, location, key) => {
    if (key === 'href') {
      // href는 esc()가 아니라 URL 형식으로 잠근다. 건너뛰면 속성 삽입 지점이 계약 사각지대가 된다.
      visitedHrefs += 1;
      check(/^https:\/\/[\w.-]+(?:\/[\w\-./~%+=&?#:@!$'()*,;]*)?$/u.test(value),
        `smstudy: ${location} must be a plain https URL without quotes, spaces or angle brackets — "${value}"`);
      return;
    }
    if (key === 'icon') {
      // 아이콘은 이제 데이터가 아니라 렌더러가 고정한다 (app.js의 두 콜아웃뿐).
      // 콘텐츠 데이터에 icon 키가 되살아나면 실패시킨다.
      visitedIcons += 1;
      check(false, `smstudy: ${location} carries an icon key "${value}" — icons are chosen by the renderer, not by content data`);
      return;
    }
    visitedStrings += 1;
    // 다이어그램 안쪽 문자열은 SVG 좌표가 걸려 있어 더 좁은 상한을 쓴다 (M-2).
    const inDiagram = location.includes('.diagrams[');
    const limit = (inDiagram ? DIAGRAM_TEXT_LIMITS[key] : undefined) ?? NOTEBOOK_STRING_LIMITS[key] ?? 60;
    const length = [...value].length;
    check(length <= limit, `smstudy: ${location} is ${length} characters, over the ${limit} limit — "${value}"`);
    check((value.match(/[.!?]/gu) || []).length <= 1, `smstudy: ${location} must be a single sentence — "${value}"`);
    check(!/[<>\r\n]/u.test(value), `smstudy: ${location} must be plain text without angle brackets or line breaks — "${value}"`);
  };
  walkNotebookStrings(notebookData.NOTEBOOKS, 'NOTEBOOKS', '', inspectString);
  walkNotebookStrings(notebookData.LEARNING_DESIGN, 'LEARNING_DESIGN', '', inspectString);
  for (const subunit of subunits) {
    walkNotebookStrings(subunit.sections, `UNITS.${subunit.id}.sections`, 'sections', inspectString);
    walkNotebookStrings(subunit.visual, `VISUAL_GUIDES.${subunit.id}`, 'visual', inspectString);
    walkNotebookStrings(subunit.keywords, `UNITS.${subunit.id}.keywords`, 'keywords', inspectString);
  }
  // explanationData.GUIDES는 이 순회에 넣지 않는다 — 오답 해설은 개념 파트가 아니라
  // 퀴즈 피드백이고, R1의 "한 문장 60자"는 개념 파트 본문에 건 계약이다 (plan.md §1).
  check(visitedStrings >= 800, `smstudy: notebook string walk looks truncated (visited ${visitedStrings} strings)`);
  check(visitedIcons === 0, `smstudy: notebook data still carries ${visitedIcons} icon keys — icons belong to the renderer, not the content`);
  check(visitedHrefs >= 3, `smstudy: href walk looks truncated (visited ${visitedHrefs} URLs)`);
  // 속성 보간 지점 — URL을 이스케이프 없이 속성에 넣으면 값이 깨질 때 뒤 마크업까지 깨진다.
  for (const [attribute, expression] of smstudyJsSource.matchAll(/\s(?:href|src)="\$\{([^}]+)\}/gu)) {
    check(expression.trim().startsWith('esc('),
      `smstudy: URL attribute interpolation must be escaped — found ${attribute.trim()} in ${APP_SOURCE}`);
  }

  // 형식 다양성 하한(최소 4종)은 **제거했다.** 그 게이트는 "형식을 채우기 위해 형식을 쓰는"
  // 압력을 만들었고, 존재 이유 없는 장식(저울 그림)이 그렇게 들어왔다. 형식은 내용이 고르며,
  // 그 근거는 docs/kice-analysis.md 부록 D가 단원별로 기록한다. 게이트가 재는 것은
  // "쓴 형식이 렌더러에 존재하는가"뿐이다 (아래 단원별 kind 검사).

  for (const subunit of subunits) {
    const questions = data.QUESTION_ROWS.filter((question) => question.sub === subunit.id);
    const notebook = notebookData.NOTEBOOKS?.[subunit.id];
    const explanation = explanationData.GUIDES?.[subunit.id];
    // 3a에서 sub 오분류 5건을 정정해 단원별 문항 수가 2~10으로 갈라졌다 (kice-analysis.md §3).
    // 총합 78은 위에서 따로 검사하므로 여기서는 "빈 단원이 없다"만 본다.
    check(questions.length >= 1, `smstudy: ${subunit.id} must contain at least one question`);
    check(subunit.sections.length > 0, `smstudy: ${subunit.id} has no concept sections`);
    check(Boolean(subunit.visual?.question), `smstudy: ${subunit.id} has no visual-guide question`);
    check(subunit.visual?.flow?.length === 3, `smstudy: ${subunit.id} visual guide must contain 3 flow steps`);
    check(subunit.visual?.checks?.length === 3, `smstudy: ${subunit.id} visual guide must contain 3 checks`);
    // ---- B-2. 렌더 필수 필드의 존재·타입·개수를 계약표로 검사한다 ----
    // (배열 길이만 세던 이전 검사는 matrix.title / deepDive[].term·icon / recall[].answer를
    //  통째로 지워도 초록이었다.)
    enforceContract(NOTEBOOK_FIELD_CONTRACT, notebook || {}, subunit.id, iconKeys);
    check(notebook?.matrix?.rows?.every((row) => Array.isArray(row) && row.length === notebook.matrix.headers.length),
      `smstudy: ${subunit.id} comparison matrix row width mismatch`);
    // 수기 count가 자동 집계로 대체됐으므로 옛 필드가 되살아나면 실패시킨다 (plan.md §4.1).
    check(!('oneLine' in (notebook || {})) && !('examInsight' in (notebook || {})) && !('patterns' in (notebook || {})),
      `smstudy: ${subunit.id} still carries a removed field (oneLine / examInsight / patterns)`);
    // 렌더되지 않는 필드가 데이터에 남는 것도 막는다 — D-3의 keyPoints[].icon이 이 사례였다.
    const notebookFields = new Set();
    collectDataFields(notebook || {}, '', notebookFields, new Set(['diagrams']));
    for (const field of notebookFields) {
      check(notebookCoverage.has(field),
        `smstudy: NOTEBOOKS.${subunit.id}.${field} is not read by any renderer — remove it or declare it in NOTEBOOK_FIELD_CONTRACT`);
    }
    // 다이어그램 형태 — kind 허용 집합, nodes/items 개수 상·하한, 렌더 필수 필드 (plan.md §5, M-2).
    (notebook?.diagrams || []).forEach((diagram, index) => {
      const where = `${subunit.id}.diagrams[${index}]`;
      check(diagramKinds.has(diagram.kind), `smstudy: ${where} uses kind "${diagram.kind}" but ${DIAGRAM_SOURCE} has no layout for it`);
      enforceContract(DIAGRAM_FIELD_CONTRACT, diagram, where, iconKeys);
      const bounds = DIAGRAM_SHAPE_BOUNDS[diagram.kind];
      const nodeCount = Array.isArray(diagram.nodes) ? diagram.nodes.length : 0;
      check(Boolean(bounds) && nodeCount >= bounds.nodes[0] && nodeCount <= bounds.nodes[1],
        `smstudy: ${where} (${diagram.kind}) must hold ${bounds ? `${bounds.nodes[0]}-${bounds.nodes[1]}` : '?'} nodes, found ${nodeCount}`);
      (diagram.nodes || []).forEach((node, nodeIndex) => {
        const itemCount = Array.isArray(node.items) ? node.items.length : 0;
        check(Boolean(bounds) && itemCount >= bounds.items[0] && itemCount <= bounds.items[1],
          `smstudy: ${where}.nodes[${nodeIndex}] (${diagram.kind}) must hold ${bounds ? `${bounds.items[0]}-${bounds.items[1]}` : '?'} items, found ${itemCount} — the SVG layout has no room for more`);
      });
      check(diagram.kind !== 'radial' || Boolean(diagram.center), `smstudy: ${where} is radial and must carry a center label`);
      const diagramFields = new Set();
      collectDataFields(diagram, '', diagramFields, new Set());
      for (const field of diagramFields) {
        check(diagramCoverage.has(field),
          `smstudy: ${where}.${field} is not read by ${DIAGRAM_SOURCE} — remove it or declare it in DIAGRAM_FIELD_CONTRACT`);
      }
      // 렌더러를 실제로 돌려 마크업까지 확인한다 (아이콘 도달 + figure 콘텐츠 모델).
      if (typeof liveRenderer?.renderDiagram === 'function') {
        const markup = liveRenderer.renderDiagram(diagram);
        check(countMatches(markup, LIST_ICON_PATTERN) === 0,
          `smstudy: ${where} renders ${countMatches(markup, LIST_ICON_PATTERN)} icons — diagrams carry no icons (DESIGN.md §4)`);
        // 형식 이름표 칩과 '왜 이 형식인가' 문장은 화면에서 걷어냈다. 되살아나면 실패시킨다.
        check(!/<span class="badge">/u.test(markup),
          `smstudy: ${where} renders a kind-label chip — the format name is not learner-facing`);
        check(!/이 형식으로 그렸다/u.test(markup),
          `smstudy: ${where} renders the planning note "why" — that belongs in docs/kice-analysis.md 부록 D`);
        // 출력 노드 수 = 데이터 노드 수. matrix2x2·venn·scale은 렌더러가 앞에서 잘라 쓰므로
        // 데이터 개수 상한(DIAGRAM_SHAPE_BOUNDS.nodes[1])까지만 기대한다.
        const drawnNodes = Math.min(nodeCount, DIAGRAM_SHAPE_BOUNDS[diagram.kind]?.nodes[1] ?? nodeCount);
        check(countMatches(markup, NODE_PATTERN) === drawnNodes,
          `smstudy: ${where} emits ${countMatches(markup, NODE_PATTERN)} node cells for ${drawnNodes} nodes`);
        for (const [, text] of markup.matchAll(SVG_TEXT_PATTERN)) {
          check([...text].length <= 1,
            `smstudy: ${where} put "${text}" inside the SVG — labels belong in the CSS layout, not in hand-placed <text>`);
        }
        check((markup.match(/<figcaption\b/gu) || []).length === 1,
          `smstudy: ${where} must render exactly one <figcaption> — a <figure> may hold only one caption (HTML content model)`);
      }
    });
    check(Boolean(explanation?.focus && explanation?.correctReason && explanation?.wrongReason), `smstudy: ${subunit.id} explanation guide is incomplete`);
    check(explanation?.checks?.length === 3, `smstudy: ${subunit.id} explanation guide must contain three checks`);
  }

  for (const notebookId of notebookIds) check(subunitIds.has(notebookId), `smstudy: notebook ${notebookId} references unknown subunit`);
  // 콘텐츠 문자열 하드코딩 검사는 전부 구조 계약으로 대체했다 (plan.md R7, review M-7).
  // 기준선 2c49cb5에 있던 7건(NOTEBOOKS 5건 + explanation-data 2건)이 모두 사라졌다.
  check(Object.keys(explanationData.GUIDES || {}).length === 13, 'smstudy: expected 13 explanation guides');
  check(Boolean(explanationData.EBS_PAST_EXAMS?.startsWith('https://www.ebsi.co.kr/')), 'smstudy: EBS explanation source link is missing');

  // 태그 양방향 정합 — 문항의 태그는 전부 그 단원의 exam.tags 안에 있어야 하고,
  // 역으로 exam.tags는 전부 최소 1문항에 쓰여야 한다 (죽은 태그 금지, plan.md §5).
  const tagUsage = new Set();
  for (const question of data.QUESTION_ROWS) {
    const declared = notebookData.NOTEBOOKS?.[question.sub]?.exam?.tags || [];
    check(Array.isArray(question.tags) && question.tags.length >= 1 && question.tags.length <= 3,
      `smstudy: ${question.id} must carry 1-3 concept tags`);
    for (const tag of question.tags || []) {
      check(declared.includes(tag), `smstudy: ${question.id} tag "${tag}" is not declared in NOTEBOOKS.${question.sub}.exam.tags`);
      tagUsage.add(`${question.sub}|${tag}`);
    }
  }
  for (const [notebookId, notebook] of Object.entries(notebookData.NOTEBOOKS || {})) {
    for (const tag of notebook.exam?.tags || []) {
      check(tagUsage.has(`${notebookId}|${tag}`), `smstudy: NOTEBOOKS.${notebookId}.exam.tags "${tag}" is never used by any question (dead tag)`);
    }
  }

  const referencedImages = new Set();
  for (const question of data.QUESTION_ROWS) {
    const source = data.KICE_SOURCES[`${question.year}|${question.session}`];
    check(subunitIds.has(question.sub), `smstudy: ${question.id} references unknown subunit ${question.sub}`);
    check(Number.isInteger(question.answerNumber) && question.answerNumber >= 1 && question.answerNumber <= 5, `smstudy: ${question.id} has invalid answer`);
    check(question.correctRate + question.wrongRate === 100, `smstudy: ${question.id} rates must total 100`);
    check(Boolean(source?.question && source?.answer), `smstudy: ${question.id} source links are missing`);
    const imagePath = path.join(ROOT, '_learning/smstudy/kice', path.basename(question.image));
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

  const imageDirectory = path.join(ROOT, '_learning/smstudy/kice');
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

  // 자체 작성 CSS 목록은 **파일 시스템에서 도출한다** (review WP1 M-3 / LESSONS 규칙 5).
  // 손으로 적은 등록부는 새 화면의 CSS를 빠뜨리는 순간 토큰 검사 전체가 그 파일을
  // 조용히 건너뛴다 — 검사가 초록불인 채 결함이 통과하는 형태다.
  //
  // 서드파티 차단 목적은 등록부 없이도 산다: (1) 저장소 안의 CSS는 **전부** 검사 대상이고
  // (벤더 경로만 규칙으로 제외), (2) 게시 HTML이 참조하는 스타일시트가 저장소 파일 집합의
  // 부분집합인지 아래에서 확인한다. 즉 외부 CSS를 끼워 넣으면 (2)에서 걸린다.
  const isVendorCss = (name) => name.includes('assets/vendor/');
  const repoCss = walk(ROOT, (item) => item.endsWith('.css')).map(relative);
  const firstPartyCss = new Set(repoCss.filter((name) => !isVendorCss(name)));
  const vendorCss = new Set(repoCss.filter(isVendorCss));
  check(firstPartyCss.size >= 5,
    `design tokens: only ${firstPartyCss.size} first-party stylesheets were derived from the repository — this check is inert`);

  // 게시 HTML이 로드하는 **로컬** 스타일시트는 전부 저장소 파일이어야 한다. 저장소 밖
  // 경로(../../)를 가리키면 위 도출 집합에 없으므로 토큰 검사를 통째로 비껴간다.
  //
  // 이 검사가 **못 보는 것**: 외부 호스트 스타일시트(현재는 Pretendard 웹폰트 CDN 하나뿐이고
  // 폰트 @font-face만 들어 있다 — 자산을 받아오지 않으면 내용을 볼 수 없다),
  // @import로 끌어오는 CSS, 런타임에 주입되는 <link>.
  const publishedCss = new Set();
  for (const file of publishedHtml()) {
    for (const [, href] of readFileSync(file, 'utf8').matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gu)) {
      if (/^https?:/iu.test(href)) continue;
      publishedCss.add(relative(resolveAsset(file, href)));
    }
  }
  check(publishedCss.size >= 2,
    `design tokens: only ${publishedCss.size} local stylesheet links were derived from the published pages — this check is inert`);
  for (const name of publishedCss) {
    check(firstPartyCss.has(name) || vendorCss.has(name),
      `${name}: a published page links this stylesheet but it is not a file in the repository — the design token gate cannot see it`);
  }

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

  for (const file of publishedHtml()) {
    const source = readFileSync(file, 'utf8');
    check(!legacyPalette.test(source), `${relative(file)}: legacy palette literal found`);
    // style="--token: …" 인라인 정의도 같은 우회로다.
    check(!/style="[^"]*--[\w-]+\s*:/u.test(source), `${relative(file)}: inline style must not define design tokens`);
  }
}

// ==========================================================================
// 이모지 체계 (DESIGN.md §5 / plan.md §2.4·§4)
//
// 검사 대상 이모지 목록을 하드코딩하지 않는다 (LESSONS 규칙 5). 유니코드 속성으로
// 소스에서 자동 도출하므로 새 이모지를 도입해도 검사가 뒤처지지 않는다.
//
// 이 검사가 **못 보는 것** (LESSONS 규칙 6 — 사각지대를 먼저 적는다):
//  - 이모지의 *의미 적절성*. 📘가 사회·문화에 어울리는지는 사람만 판단한다.
//  - 이미지·SVG 안에 그려진 그림 문자. 텍스트 스캔의 범위 밖이다.
//  - 데이터 파일의 이모지 값 자체(매핑 원본). 값이 슬롯을 거쳐 렌더되는지만 본다.
//  - 런타임에 문자열을 조립해 만든 이모지(String.fromCodePoint 등).
// ==========================================================================

// 그림문자 = 이모지 표현이 기본인 문자 + VS16으로 이모지 표현을 강제한 문자 + 키캡.
const EMOJI_PATTERN = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|⃣/u;
// system.css가 제공하는 이모지 슬롯 클래스 (DESIGN.md §5·§7.3).
const EMOJI_SLOT_CLASS = /\bemoji(?:-box|-lg)?\b/u;

// 랜딩의 이모지 단일 원본. 앱 키는 앱 디렉터리 이름이다 (assets/js/site-emoji.js 주석 참조).
const SITE_EMOJI_SOURCE = 'assets/js/site-emoji.js';
const siteEmoji = () => evaluateBrowserData(SITE_EMOJI_SOURCE, 'SITE_EMOJI') || {};

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'source', 'track', 'wbr']);

// ---- R4-M-6. 중첩을 세는 요소 절단 ----
// 이전 행 검사는 `<(\w+)...>[^]*?</\1>`로 조각을 떴다. 비탐욕 매칭은 **같은 태그의 첫
// 닫힘**에서 멈추므로 중첩된 div가 있으면 행이 중간에서 잘리고, 잘린 뒤의 두 번째 이모지가
// "행 바깥"으로 오인돼 실제 위반이 통과했다. 여기서는 깊이를 추적해 짝이 맞는 닫는 태그까지
// 간다 — 즉 행의 전체 자손이 검사 대상이 된다.
//
// 이 절단이 **못 보는 것**: 따옴표 안에 '>'가 들어간 속성값(`title="a > b"`)이나
// 템플릿 보간(`${a > b}`)이 여는 태그를 일찍 끝내는 경우. 저장소 소스에는 없고,
// 생기면 조각이 짧아져 **놓칠 뿐 거짓 실패는 내지 않는다**.
function htmlElementSlice(source, openIndex) {
  const name = /^<([a-z][\w-]*)/iu.exec(source.slice(openIndex, openIndex + 40));
  if (!name) return '';
  const tag = name[1].toLowerCase();
  if (VOID_TAGS.has(tag)) return source.slice(openIndex, source.indexOf('>', openIndex) + 1);
  const boundary = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'giu');
  boundary.lastIndex = openIndex;
  let depth = 0;
  for (let hit = boundary.exec(source); hit; hit = boundary.exec(source)) {
    if (hit[0].startsWith('</')) {
      depth -= 1;
      if (depth <= 0) return source.slice(openIndex, hit.index + hit[0].length);
    } else if (!hit[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return source.slice(openIndex);
}

// 조각이 이모지를 **몇 개 만들어 내는가**. 리터럴 글리프만 세면 매핑을 거치는 렌더러
// (emojiLead('x') / emojiOf(id) / data-emoji="key")에서는 언제나 0이 되어 검사가 죽는다.
// 템플릿 보간 `${...}` 하나는 문자열 하나를 내므로 1로 센다 — 삼항의 두 가지
// (`cond ? emojiLead('a') : emojiLead('b')`)는 동시에 렌더되지 않는다.
//
// 이 셈이 **못 보는 것**: 보간 하나가 map()으로 여러 조각을 만드는 경우(그 경우 행은
// 보통 보간 안에서 생성되므로 이 조각 밖이다), 그리고 런타임에만 정해지는 반복 횟수.
function emojiSourceCount(chunk) {
  let count = 0;
  let plain = '';
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] === '$' && chunk[index + 1] === '{') {
      let depth = 0;
      let end = index + 1;
      for (; end < chunk.length; end += 1) {
        if (chunk[end] === '{') depth += 1;
        else if (chunk[end] === '}') { depth -= 1; if (depth === 0) break; }
      }
      const expression = chunk.slice(index + 2, end);
      if (/\b(?:emojiLead|emojiOf)\(/u.test(expression)
        || new RegExp(EMOJI_PATTERN.source, 'u').test(expression)) count += 1;
      index = end;
      continue;
    }
    plain += chunk[index];
  }
  count += (plain.match(new RegExp(EMOJI_PATTERN.source, 'gu')) || []).length;
  count += (plain.match(/\sdata-emoji="/gu) || []).length;
  return count;
}

// 마크업 문자열에서 "여는 태그 직후에 등장하는 그림문자"를 모은다.
// HTML 파일과 JS 렌더러(템플릿 문자열)에 같은 판정을 적용할 수 있다.
function emojiInMarkup(source) {
  const found = [];
  const pattern = new RegExp(EMOJI_PATTERN.source, 'gu');
  const withoutComments = source.replace(/<!--[^]*?-->/gu, (match) => ' '.repeat(match.length));
  for (const hit of withoutComments.matchAll(pattern)) {
    const index = hit.index;
    const before = withoutComments.slice(0, index);
    const tagEnd = before.lastIndexOf('>');
    // 여는 태그와 그림문자 사이에 공백 말고 다른 것이 있으면 슬롯 밖이다.
    const gap = tagEnd === -1 ? before : before.slice(tagEnd + 1);
    const tagStart = before.lastIndexOf('<', tagEnd);
    const tag = tagStart === -1 || tagEnd === -1 ? '' : before.slice(tagStart, tagEnd + 1);
    const classAttribute = /\sclass="([^"]*)"/u.exec(tag);
    found.push({
      index,
      glyph: hit[0],
      inMarkupTextPosition: tagEnd !== -1 && gap.trim() === '',
      slotted: Boolean(classAttribute) && EMOJI_SLOT_CLASS.test(classAttribute[1]),
      line: withoutComments.slice(0, index).split('\n').length,
      after: withoutComments.slice(index + hit[0].length, index + hit[0].length + 700),
    });
  }
  return found;
}

function validateEmojiSystem() {
  const labelPattern = /class="[^"]*\b(?:list-row-title|title-1|title-2|title-3|sidebar-item|list-group-head)\b[^"]*"[^>]*>\s*([^<]+?)\s*</u;
  // 대상 ↔ 이모지는 사이트 전체에서 일대일이어야 한다 (같은 대상엔 같은 이모지).
  const labelToGlyph = new Map();
  const glyphToLabel = new Map();
  const site = siteEmoji();
  let sloted = 0;

  check(Object.keys(site).length > 0,
    `${SITE_EMOJI_SOURCE}: SITE_EMOJI mapping is missing — the landing emoji need a single source (DESIGN.md §5.1)`);

  // 검사 대상 표면은 게시 HTML과 **그 HTML이 로드하는 스크립트 전부**다 (하드코딩 금지).
  const surfaces = [...publishedHtml().map(relative), ...publishedScripts()];

  for (const file of surfaces) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    const occurrences = emojiInMarkup(source);
    const isHtml = file.endsWith('.html');

    // ---- R4-M-4. HTML 마크업에는 글리프 리터럴을 두지 않는다 ----
    // 리터럴이 허용되면 같은 대상의 이모지가 두 곳에 적히고 한쪽만 바뀌어도 아무도 모른다.
    // 모든 글리프는 매핑(SITE_EMOJI / SMSTUDY_DATA.EMOJI / WORDMASTER_EMOJI)에서 나온다.
    if (isHtml) {
      for (const occurrence of occurrences) {
        check(false,
          `${file}:${occurrence.line}: emoji literal "${occurrence.glyph}" in markup — put it in a mapping and use a data-emoji slot (DESIGN.md §5)`);
      }
      for (const hit of source.matchAll(/<[^>]*\sdata-emoji="([^"]*)"[^>]*>/gu)) {
        const [tag, key] = hit;
        const classAttribute = /\sclass="([^"]*)"/u.exec(tag);
        check(Boolean(classAttribute) && EMOJI_SLOT_CLASS.test(classAttribute[1]),
          `${file}: data-emoji="${key}" is not on an .emoji / .emoji-box / .emoji-lg slot (DESIGN.md §5)`);
        check(Object.prototype.hasOwnProperty.call(site, key),
          `${file}: data-emoji="${key}" has no entry in SITE_EMOJI (${SITE_EMOJI_SOURCE})`);
        const glyph = site[key];
        if (!glyph) continue;
        sloted += 1;
        const label = labelPattern.exec(source.slice(hit.index + tag.length, hit.index + tag.length + 700));
        if (!label) continue;
        const text = label[1].replace(/\s+/gu, ' ');
        const knownGlyph = labelToGlyph.get(text);
        const knownLabel = glyphToLabel.get(glyph);
        check(knownGlyph === undefined || knownGlyph === glyph,
          `${file}: "${text}" is marked with "${glyph}" here but with "${knownGlyph}" elsewhere — one target, one emoji (DESIGN.md §5)`);
        check(knownLabel === undefined || knownLabel === text,
          `${file}: emoji "${glyph}" marks both "${knownLabel}" and "${text}" — one emoji, one target (DESIGN.md §5)`);
        labelToGlyph.set(text, glyph);
        glyphToLabel.set(glyph, text);
      }
    }

    for (const occurrence of occurrences) {
      // JS는 데이터 위치의 이모지(매핑 단일 원본)를 허용한다 — 마크업에 박힌 것만 본다.
      if (isHtml || !occurrence.inMarkupTextPosition) continue;
      check(occurrence.slotted,
        `${file}:${occurrence.line}: emoji "${occurrence.glyph}" must sit directly inside an .emoji / .emoji-box / .emoji-lg slot (DESIGN.md §5)`);
      if (!occurrence.slotted) continue;
      sloted += 1;

      // 한 슬롯에 이모지 하나 (같은 슬롯 안에서 닫는 태그 전까지).
      const slotBody = occurrence.after.slice(0, Math.max(occurrence.after.indexOf('<'), 0));
      check(!new RegExp(EMOJI_PATTERN.source, 'u').test(slotBody),
        `${file}:${occurrence.line}: an emoji slot must hold exactly one emoji (DESIGN.md §5)`);
    }

    // "한 행에 이모지 1개" — .list-row 하나가 이모지를 둘 이상 만들어 내면 안 된다.
    // \blist-row\b는 "list-row-title"에도 걸린다 — 클래스 토큰 경계까지 맞춘다.
    // 조각은 중첩을 세며 뜬다 (R4-M-6) — 행의 전체 자손이 검사 대상이다.
    let rows = 0;
    for (const hit of source.matchAll(/<[a-z][\w-]*\b[^>]*class="[^"]*\blist-row(?:\s[^"]*)?"[^>]*>/giu)) {
      const row = htmlElementSlice(source, hit.index);
      const count = emojiSourceCount(row);
      rows += 1;
      check(count <= 1,
        `${file}: a .list-row produces ${count} emoji — one emoji per row (DESIGN.md §5)`);
    }
    if (file === 'index.html') {
      check(rows >= 3, `${file}: only ${rows} .list-row elements were sliced — the per-row emoji check is inert`);
    }
  }

  // 검사가 죽은 채 통과하지 않도록, 이모지 슬롯이 실제로 존재하는지 확인한다.
  // 사이클4에서 이모지 체계를 도입했으므로 0이면 회귀다 (LESSONS 규칙 6·7).
  check(sloted > 0, 'emoji system: no emoji slot found on any surface — the DESIGN.md §5 system has regressed');
  check(labelToGlyph.size > 0, 'emoji system: no emoji↔label pair could be derived — the consistency check is inert');
}

// smstudy의 단원 이모지는 마크업이 아니라 데이터 매핑(SMSTUDY_DATA.EMOJI)에서 나온다.
// 그것이 §5.2가 적어 둔 위 검사의 사각지대다 — 위 스캔은 "슬롯을 거쳤는가"만 보고
// 매핑 자체의 일대일성은 못 본다. 여기서 매핑을 소스에서 도출해 직접 잠근다.
// 검사 대상 목록을 하드코딩하지 않는다 (LESSONS 규칙 5): 키는 data.js의 UNITS에서,
// 비교 대상 글리프는 마크업 스캔에서 도출한다.
//
// 이 검사가 **못 보는 것**: 글리프의 의미 적절성(🧩가 문화의 속성에 맞는지).
// 3c에서 WordMaster가 같은 방식의 매핑(WORDMASTER_EMOJI)을 도입했으므로,
// 앱 사이의 교차 충돌은 아래 validateWordMasterEmoji() + validateEmojiCrossMaps()가 본다.
// (admin은 매핑을 두지 않는다 — macOS HIG 어법의 조작 화면이라 이모지를 쓰지 않는다.)
function validateSmStudyEmoji() {
  const data = evaluateBrowserData('_learning/smstudy/data.js', 'SMSTUDY_DATA');
  const map = data?.EMOJI;
  check(Boolean(map), 'smstudy: SMSTUDY_DATA.EMOJI mapping is missing — unit emoji need a single source (DESIGN.md §5)');
  if (!map) return;

  const subunitIds = (data.UNITS || []).flatMap((unit) => unit.subs.map((sub) => sub.id));
  const expectedKeys = new Set([...subunitIds, 'app']);
  check(subunitIds.length > 0, 'smstudy: subunit id derivation for the emoji map looks broken');
  for (const id of expectedKeys) {
    check(typeof map[id] === 'string' && map[id].length > 0,
      `smstudy: SMSTUDY_DATA.EMOJI has no glyph for "${id}"`);
  }
  for (const key of Object.keys(map)) {
    check(expectedKeys.has(key),
      `smstudy: SMSTUDY_DATA.EMOJI carries "${key}", which is neither a subunit id nor "app" — dead mapping`);
  }
  const glyphs = Object.values(map);
  check(new Set(glyphs).size === glyphs.length,
    'smstudy: SMSTUDY_DATA.EMOJI reuses a glyph for two targets — one target, one emoji (DESIGN.md §5)');
  for (const [key, glyph] of Object.entries(map)) {
    check(new RegExp(EMOJI_PATTERN.source, 'u').test(glyph),
      `smstudy: SMSTUDY_DATA.EMOJI["${key}"] = "${glyph}" is not a pictograph`);
  }

  // 랜딩의 매핑과 교차 대조한다. ---- R4-M-5 ----
  // 이전 검사는 markupGlyphSet().has(map.app), 즉 "사이트가 쓰는 글리프 집합에 들어
  // 있는가"만 봤다. 집합 포함 여부는 대상을 구분하지 못하므로 WordMaster의 📗와
  // smstudy의 📘를 서로 바꿔도 두 글리프가 그대로 집합에 남아 통과했다. 이제 SITE_EMOJI의
  // **키로** 대조한다 — 키는 앱 디렉터리 이름이라 대상이 한 벌로 정해진다.
  const site = siteEmoji();
  check(Object.keys(site).length > 0, 'smstudy: SITE_EMOJI is empty — this cross-check is inert');
  check(map.app === site.smstudy,
    `smstudy: SMSTUDY_DATA.EMOJI.app is "${map.app}" but SITE_EMOJI.smstudy is "${site.smstudy}" — one target, one emoji (DESIGN.md §5.1)`);
  const siteGlyphs = new Set(Object.values(site));
  for (const id of subunitIds) {
    check(!siteGlyphs.has(map[id]),
      `smstudy: subunit ${id} takes "${map[id]}", which SITE_EMOJI already assigns to another target — one emoji, one target (DESIGN.md §5)`);
  }

  // 마크업이 이모지를 리터럴로 박지 않고 매핑을 거치는지 — 렌더러가 실제로 매핑을 읽는가.
  const appSource = readFileSync(path.join(ROOT, APP_SOURCE), 'utf8');
  check(/emojiOf\(/u.test(appSource) && /EMOJI\[/u.test(appSource),
    `smstudy: ${APP_SOURCE} must read glyphs from the SMSTUDY_DATA.EMOJI mapping, not from literals`);
  const slots = (appSource.match(/class="emoji(?:-box|-lg| emoji-lg)?"/gu) || []).length;
  check(slots >= 2, `smstudy: ${APP_SOURCE} renders ${slots} emoji slots — the §5 system has regressed`);
}

// WordMaster의 이모지도 마크업이 아니라 데이터 매핑(words.js의 WORDMASTER_EMOJI)에서
// 나온다. smstudy와 같은 사각지대이므로 같은 도출을 여기서 한 벌 더 한다.
// 검사 대상 키를 하드코딩하지 않는다 (LESSONS 규칙 5): 키는 **렌더러의 호출부**에서
// 도출한다. 그래서 렌더러가 키를 리터럴로 넘기는지도 함께 강제한다 — 동적 키가 하나라도
// 있으면 도출이 조용히 뒤처지기 때문이다.
//
// 이 검사가 **못 보는 것**: 글리프의 의미 적절성(🎲가 출제 순서에 맞는지),
// 그리고 런타임에 조립한 키(`emojiLead('a' + b)`처럼 리터럴이 아닌 호출) —
// 후자는 아래 "동적 호출 금지" 검사가 대신 막는다.
const WORDMASTER_APP_SOURCE = 'WordMaster/assets/js/app.js';

function validateWordMasterEmoji() {
  const map = evaluateBrowserData('_learning/wordmaster/words.js', 'WORDMASTER_EMOJI');
  check(Boolean(map), 'WordMaster: WORDMASTER_EMOJI mapping is missing — row emoji need a single source (DESIGN.md §5)');
  if (!map) return;

  const source = readFileSync(path.join(ROOT, WORDMASTER_APP_SOURCE), 'utf8');
  // 렌더러가 매핑을 통해서만 글리프를 얻는지 — 슬롯에 리터럴을 박으면 여기서 걸린다.
  check(/window\.WORDMASTER_EMOJI/u.test(source),
    `WordMaster: ${WORDMASTER_APP_SOURCE} must read glyphs from window.WORDMASTER_EMOJI, not from literals`);
  const slots = (source.match(/class="emoji(?:-box|-lg| emoji-lg)?"/gu) || []).length;
  check(slots >= 2, `WordMaster: ${WORDMASTER_APP_SOURCE} renders ${slots} emoji slots — the §5 system has regressed`);

  // 키 도출: emojiLead('key') 호출부. 함수 정의를 제외한 모든 호출은 리터럴이어야 한다.
  const calls = [...source.matchAll(/emojiLead\('([\w-]+)'/gu)].map(([, key]) => key);
  const dynamic = source.replace(/function emojiLead\(/gu, 'function __def(')
    .match(/emojiLead\((?!')/gu) || [];
  check(dynamic.length === 0,
    `WordMaster: emojiLead() must be called with a literal key (${dynamic.length} dynamic calls) — the mapping derivation depends on it`);
  const usedKeys = new Set(calls);
  check(usedKeys.size > 0, 'WordMaster: emoji key derivation from the renderer looks broken');

  const expectedKeys = new Set([...usedKeys, 'app']);
  for (const key of expectedKeys) {
    check(typeof map[key] === 'string' && map[key].length > 0,
      `WordMaster: WORDMASTER_EMOJI has no glyph for "${key}"`);
  }
  for (const key of Object.keys(map)) {
    check(expectedKeys.has(key),
      `WordMaster: WORDMASTER_EMOJI carries "${key}", which the renderer never asks for — dead mapping`);
  }
  const glyphs = Object.values(map);
  check(new Set(glyphs).size === glyphs.length,
    'WordMaster: WORDMASTER_EMOJI reuses a glyph for two targets — one target, one emoji (DESIGN.md §5)');
  for (const [key, glyph] of Object.entries(map)) {
    check(new RegExp(EMOJI_PATTERN.source, 'u').test(glyph),
      `WordMaster: WORDMASTER_EMOJI["${key}"] = "${glyph}" is not a pictograph`);
  }

  // 앱 글리프는 랜딩이 이 앱에 준 글리프와 **같아야** 하고(집합 포함이 아니라 키 대조 —
  // R4-M-5), 나머지 키는 SITE_EMOJI가 다른 대상에 쓰는 글리프를 가져가면 안 된다.
  const site = siteEmoji();
  check(Object.keys(site).length > 0, 'WordMaster: SITE_EMOJI is empty — this cross-check is inert');
  check(map.app === site.WordMaster,
    `WordMaster: WORDMASTER_EMOJI.app is "${map.app}" but SITE_EMOJI.WordMaster is "${site.WordMaster}" — one target, one emoji (DESIGN.md §5.1)`);
  const siteGlyphs = new Set(Object.values(site));
  for (const key of usedKeys) {
    if (key === 'app') continue;
    check(!siteGlyphs.has(map[key]),
      `WordMaster: "${key}" takes "${map[key]}", which SITE_EMOJI already assigns to another target — one emoji, one target (DESIGN.md §5)`);
  }
}

// 앱별 매핑이 둘 이상이 되면 각각의 검사만으로는 **앱 사이의 중복 배정**을 못 본다
// (smstudy의 🔭와 WordMaster의 🔭가 서로 다른 대상을 가리켜도 각자는 통과한다).
// 여기서 두 매핑을 한 레지스트리로 합쳐 글리프 소유자를 하나로 강제한다.
// 매핑 목록도 하드코딩하지 않는다 — 아래 sources는 "전역 이름 → 파일" 한 쌍이고,
// 새 앱이 매핑을 도입하면 그 항목만 늘린다.
function validateEmojiCrossMaps() {
  const sources = [
    { app: 'site', file: SITE_EMOJI_SOURCE, global: 'SITE_EMOJI', pick: (data) => data },
    { app: 'smstudy', file: '_learning/smstudy/data.js', global: 'SMSTUDY_DATA', pick: (data) => data?.EMOJI },
    { app: 'WordMaster', file: '_learning/wordmaster/words.js', global: 'WORDMASTER_EMOJI', pick: (data) => data },
  ];

  // 대상 이름 정규화. 앱 자신을 가리키는 항목은 랜딩과 앱 매핑 **양쪽에** 있는 것이
  // 정상이므로 같은 대상으로 접어야 한다. 접는 조건도 손으로 적지 않는다 —
  // SITE_EMOJI의 키가 저장소의 앱 디렉터리 이름이면 그것이 앱 자신이다.
  const targetOf = (source, key) => {
    if (key === 'app') return `app:${source.app}`;
    const asDirectory = path.join(ROOT, key);
    if (source.app === 'site' && existsSync(asDirectory) && statSync(asDirectory).isDirectory()) {
      return `app:${key}`;
    }
    return `${source.app}:${key}`;
  };

  const owner = new Map();   // glyph -> target
  let pairs = 0;

  for (const source of sources) {
    const map = source.pick(evaluateBrowserData(source.file, source.global)) || {};
    for (const [key, glyph] of Object.entries(map)) {
      const target = targetOf(source, key);
      const known = owner.get(glyph);
      check(known === undefined || known === target,
        `emoji registry: "${glyph}" is assigned to both ${known} and ${target} — one emoji, one target (DESIGN.md §5)`);
      owner.set(glyph, target);
      pairs += 1;
    }
  }
  // 세 매핑이 모두 살아 있는지 — 하나가 사라지면 교차 검사는 무의미해진다.
  check(sources.length >= 3 && pairs >= 25,
    `emoji registry: only ${pairs} glyph assignments were derived from ${sources.length} maps — the cross-app check is inert`);
}

function validateBrandName() {
  // C-5: 브랜드는 소문자 "hvsdcm" 한 덩어리 (plan.md R-5). 분리 표기 전면 금지.
  const separated = /HVS[\s\-_]?DCM|hvs[\s\-_]dcm/u;
  for (const file of [...publishedHtml(), ...walk(ROOT, (item) => item.endsWith('.css'))]) {
    check(!separated.test(readFileSync(file, 'utf8')), `${relative(file)}: separated brand name found (use "hvsdcm" in one piece)`);
  }

  // 슬래시·가운뎃점·마침표 분리와 대문자 변형은 전 표면에서 금지 (3b에서 확대).
  const separator = /hvs\s*[/·.]\s*dcm/iu;
  const casing = /HVSDCM|HvsDcm|Hvsdcm|hvsDcm|HVSdcm|hvsDCM/u;
  const brandSurfaces = [
    ...[...publishedHtml(), ...walk(ROOT, (item) => item.endsWith('.css'))].map(relative),
    ...publishedScripts(),
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
  for (const file of publishedHtml()) {
    check(!/type=["']module["']/u.test(readFileSync(file, 'utf8')), `${relative(file)}: type="module" is forbidden`);
  }

  const scriptSources = (file) =>
    [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/giu)].map(([, src]) => src);

  // 표면별 스크립트 로드 순서 (§3.1)
  const expectedOrders = {
    'index.html': ['/assets/js/site-emoji.js', '/assets/js/home.js?v=20260831-owner-boundary-v2'],
    'WordMaster/index.html': ['/account.js', 'assets/js/words.js', '/assets/js/study-utils.js', 'assets/js/app.js'],
    'smstudy/index.html': ['/account.js', '/assets/vendor/lucide/icons.js', 'assets/js/data.js', 'assets/js/notebook-data.js', 'assets/js/explanation-data.js', '/assets/js/study-utils.js', 'assets/js/diagram.js', 'assets/js/app.js'],
    'admin/index.html': ['/admin/assets/js/admin.js'],
    'usage/index.html': ['/usage/assets/js/competition.js?v=20260831-competition-v5', '/usage/assets/js/usage.js?v=20260831-competition-v5'],
    // 기출은 전역 데이터 선행 계약을 따른다: 세션(account) → 아이콘 → pdf-lib → 컨트롤러.
    // 목록 데이터는 이 순서 어디에도 없다 — 로그인 뒤 API에서만 온다 (plan.md §3).
    'gichul/index.html': ['/account.js', '/assets/vendor/lucide/icons.js', '/assets/vendor/pdf-lib/pdf-lib.min.js', '/gichul/app.js?v=20260829-n7'],
    'behavior-lab/index.html': ['/behavior-lab/assets/js/core.js?v=20260831-v2', '/behavior-lab/assets/js/app.js?v=20260901-v10'],
  };
  for (const [file, order] of Object.entries(expectedOrders)) {
    check(scriptSources(file).join(' → ') === order.join(' → '), `${file}: script load order must be ${order.join(' → ')}`);
  }
  // 화면 목록을 손으로 적으면 새 화면이 검사 밖에 남는다 — 게시되는 진입 HTML에서 도출해
  // 위 표와 대조한다 (LESSONS "파생 가능한 것을 손으로 적지 않는다").
  for (const screen of publishedHtml().map(relative).filter((file) => file === 'index.html' || file.endsWith('/index.html'))) {
    check(Object.prototype.hasOwnProperty.call(expectedOrders, screen),
      `${screen}: no script load order is declared — add it to expectedOrders in scripts/validate.mjs (load order is the deployment contract)`);
  }

  // 수정 라운드 M-1: 상태 계약이 CSS에만 있는 경우(.is-accent/.is-idle 등)는 구캐시
  // 스타일시트만으로도 화면이 어긋난다 — 스크립트처럼 스타일시트 href(버전 쿼리 포함)도
  // 표면별로 고정한다. usage는 JS와 같은 ?v= 토큰을 CSS 두 장 모두에 싣는다.
  const stylesheetSources = (file) =>
    [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/giu)].map(([, href]) => href);
  const expectedStylesheets = {
    'index.html': ['/assets/css/system.css', '/assets/css/home.css'],
    'WordMaster/index.html': ['/assets/css/system.css', 'assets/css/style.css'],
    'smstudy/index.html': ['/assets/css/system.css', 'assets/css/style.css'],
    'admin/index.html': ['/assets/css/system.css', '/admin/assets/css/admin.css'],
    'usage/index.html': ['/assets/css/system.css?v=20260831-competition-v5', '/usage/assets/css/usage.css?v=20260831-competition-v5'],
    'gichul/index.html': ['/assets/css/system.css', '/gichul/gichul.css?v=20260829-n4'],
    'behavior-lab/index.html': ['/assets/css/system.css', '/behavior-lab/assets/css/app.css?v=20260901-v8'],
  };
  for (const [file, order] of Object.entries(expectedStylesheets)) {
    check(stylesheetSources(file).join(' → ') === order.join(' → '), `${file}: stylesheet hrefs (order + cache-buster) must be ${order.join(' → ')}`);
  }
  for (const screen of publishedHtml().map(relative).filter((file) => file === 'index.html' || file.endsWith('/index.html'))) {
    check(Object.prototype.hasOwnProperty.call(expectedStylesheets, screen),
      `${screen}: no stylesheet contract is declared — add it to expectedStylesheets in scripts/validate.mjs (href + version query is the cache contract)`);
  }
  // usage의 JS·CSS 버전 토큰이 서로 어긋나면 절반만 새로 실리는 배포가 된다 — 같은 토큰인지 잠근다.
  {
    const versionOf = (src) => (src.split('?v=')[1] || '');
    const usageJsVersion = versionOf(expectedOrders['usage/index.html'][0]);
    const usageCssVersions = expectedStylesheets['usage/index.html'].map(versionOf);
    check(usageJsVersion && usageCssVersions.every((token) => token === usageJsVersion),
      'usage/index.html: JS and CSS cache-buster tokens must be one identical ?v= value');
  }

  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check(/<script\b[^>]*src="\/assets\/js\/home\.js(?:\?[^"']*)?"[^>]*\bdefer\b/u.test(homeHtml),
    'index.html: home.js must load with defer');
  check(readFileSync(path.join(ROOT, 'WordMaster/index.html'), 'utf8').includes('data-app="wordmaster"'), 'WordMaster: account.js must declare data-app="wordmaster"');
  check(readFileSync(path.join(ROOT, 'smstudy/index.html'), 'utf8').includes('data-app="smstudy"'), 'smstudy: account.js must declare data-app="smstudy"');
  // 기출은 계정에 저장할 진도가 없다 — account.js를 게이트 전용 모드(data-key 없음)로 싣는다.
  // data-key가 붙는 순간 없는 진도를 /api/progress/gichul에 밀고, Worker의 VALID_APPS에
  // 없는 앱이라 매 방문이 404가 된다.
  {
    const gichulHtml = readFileSync(path.join(ROOT, 'gichul/index.html'), 'utf8');
    const accountTag = /<script\b[^>]*\bsrc="\/account\.js"[^>]*>/u.exec(gichulHtml)?.[0] || '';
    check(accountTag.includes('data-app="gichul"'), 'gichul: account.js must declare data-app="gichul"');
    check(!accountTag.includes('data-key'), 'gichul: account.js must load in gate-only mode (no data-key — there is no study progress to sync)');
  }

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
  // .brand-mark 인라인 로고(DESIGN.md §8)가 텍스트 앞에 올 수 있다 — og.png가 잠그는 것은
  // 브랜드 문자열 자체이지 마크업 구조가 아니다.
  check(new RegExp(`class="brand"[^>]*>(?:<svg\\b[^>]*class="brand-mark"[^>]*>[\\s\\S]*?<\\/svg>)?${OG_LOCK.brand}<`, 'u').test(homeHtml),
    'og lock: index.html wordmark != OG_LOCK.brand — regenerate assets/og.png with the new brand, then update OG_LOCK (brand + sha256) together');
  check(/property="og:image"[^>]*assets\/og\.png/u.test(homeHtml) && /name="twitter:image"[^>]*assets\/og\.png/u.test(homeHtml),
    'og lock: index.html og:image/twitter:image must reference assets/og.png');
  check(createHash('sha256').update(readFileSync(path.join(ROOT, 'assets/og.png'))).digest('hex') === OG_LOCK.sha256,
    'og lock: assets/og.png bytes do not match OG_LOCK.sha256 — regenerate the image and update the lock in one commit');
}

// ---- R4-M-3. 섹션 라벨은 제목이어야 한다 ----
// 사이클4 재조판에서 WordMaster의 rangeHead / sessionMistakes / wrongNoteTitle이 h2에서
// 시각용 p로 바뀌었다. aria-labelledby는 그대로라 이름은 붙었지만, 스크린리더의 제목
// 탐색점과 문서 위계는 사라졌다 — 문자열 검사로는 보이지 않는 종류의 회귀다.
// 대상 목록을 하드코딩하지 않는다: 표면에서 aria-labelledby 값을 전부 뽑아 같은 소스 안의
// id 정의와 맞춘다.
//
// 이 검사가 **못 보는 것**: 제목 레벨의 논리적 순서(h2 아래 h4), 라벨 문구의 적절성,
// 런타임에 조립한 id, 그리고 다른 파일에 정의된 id. <summary> 안의 span처럼 제목이
// 아니어도 정당한 라벨이 있으므로 "p 금지 + .list-group-head는 제목"까지만 강제한다.
function validateLabelledBy() {
  const surfaces = [...publishedHtml().map(relative), ...publishedScripts()];
  let resolved = 0;
  for (const file of surfaces) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const [, id] of source.matchAll(/aria-labelledby="([^"]+)"/gu)) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const target = new RegExp(`<([a-z][\\w-]*)\\b([^>]*\\sid="${escaped}"[^>]*)>`, 'u').exec(source);
      if (!target) continue;
      resolved += 1;
      const [, tag, attributes] = target;
      const isHeading = /^h[1-6]$/u.test(tag);
      const isGroupHead = /\sclass="[^"]*\blist-group-head\b/u.test(attributes);
      check(tag !== 'p',
        `${file}: aria-labelledby="${id}" points at a <p> — a section label must be a heading (DESIGN.md §7.1)`);
      check(!isGroupHead || isHeading,
        `${file}: aria-labelledby="${id}" is a .list-group-head on <${tag}> — section labels must be h1–h6 so the heading outline survives`);
    }
  }
  check(resolved >= 15, `aria-labelledby: only ${resolved} targets resolved — this check is inert`);
}

// ---- R4-M-9. 대비표를 손으로 적지 않는다 ----
// system.css 상단 대비표의 숫자 9개가 실제 알파 합성값과 어긋나 있었다. 주석은 사람이
// 적는 순간 낡으므로, 여기서 주석을 **파싱해** :root 토큰에서 다시 계산한 값과 대조한다.
// 검사 대상 목록은 표 자신에서 도출한다 — 표에 행을 추가하면 그 행도 자동으로 검산된다.
//
// 이 검사가 **못 보는 것**: (1) 어떤 조합이 실제 화면에 등장하는지 — 표에 없는 조합은
// 검산되지 않으므로 아래 "모든 색 토큰이 표에 등장하는가"를 함께 건다. (2) 글자 크기에
// 따른 하한 분기(큰 글자 3:1)와 ✗ 표시의 타당성. (3) opacity·filter로 합성되는 상태.
// (4) CSS가 그 토큰을 실제로 규칙에 얹었는지 — 값이 맞아도 잘못된 곳에 쓰면 못 본다.
const CONTRAST_SURFACES_LINE = /전경 \\ 배경\s+(.+)/u;
function srgbToLinear(channel) {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}
function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
function compositeOver(color, background) {
  return color.rgb.map((channel, index) => channel * color.alpha + background[index] * (1 - color.alpha));
}
function parseCssColor(value) {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d) : [0, 2, 4].map((i) => hex[1].slice(i, i + 2));
    return { rgb: digits.map((pair) => parseInt(pair, 16)), alpha: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/iu.exec(text);
  if (rgba) {
    return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  return null;
}
function validateContrastTable() {
  const css = readFileSync(path.join(ROOT, 'assets/css/system.css'), 'utf8');
  const header = /\/\*[^]*?대비 전수표[^]*?\*\//u.exec(css);
  check(Boolean(header), 'system.css: the contrast table comment is missing — DESIGN.md §3.1 requires it');
  if (!header) return;
  const table = header[0];

  const rootBlock = /:root\s*\{([^]*?)\n\}/u.exec(css);
  const tokens = new Map();
  for (const [, name, value] of (rootBlock?.[1] || '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
    const color = parseCssColor(value.replace(/\/\*[^]*?\*\//gu, '').trim());
    if (color) tokens.set(name, color);
  }
  check(tokens.size >= 15, `system.css: only ${tokens.size} color tokens were parsed from :root — the contrast gate is inert`);

  const opaque = (name) => {
    const token = tokens.get(name.startsWith('--') ? name : `--${name}`);
    if (!token || token.alpha !== 1) return null;
    return token.rgb;
  };
  const stated = (value) => Number(value).toFixed(2);
  const computed = (ratio) => ratio.toFixed(2);
  let compared = 0;
  const compare = (label, expectedRatio, statedValue) => {
    compared += 1;
    check(computed(expectedRatio) === stated(statedValue),
      `system.css contrast table: ${label} says ${stated(statedValue)} but the tokens compute ${computed(expectedRatio)}`);
  };

  // 1) 전경 × 배경 격자
  const surfaceNames = (CONTRAST_SURFACES_LINE.exec(table)?.[1] || '').trim().split(/\s+/u);
  check(surfaceNames.length >= 4, 'system.css contrast table: the surface header row could not be parsed');
  for (const line of table.split('\n')) {
    const row = /^\s*(--[\w-]+)\s+((?:\d+\.\d+\s+)*\d+\.\d+)/u.exec(line);
    if (!row) continue;
    const foreground = opaque(row[1]);
    if (!foreground) continue;
    const values = row[2].trim().split(/\s+/u);
    if (values.length !== surfaceNames.length) continue;
    surfaceNames.forEach((surface, index) => {
      const background = opaque(surface);
      if (!background) return;
      compare(`${row[1]} on ${surface}`, contrastRatio(foreground, background), values[index]);
    });
  }

  // 2) -soft 뱃지 (알파 배경을 부모 표면과 합성)
  const softRows = table.matchAll(/(--[\w-]+)\s*\+\s*(--[\w-]+)((?:[^\n]*\n\s*\/[^\n]*)*[^\n]*)/gu);
  for (const [, softName, foregroundName, body] of softRows) {
    const soft = tokens.get(softName);
    const foreground = opaque(foregroundName);
    if (!soft || !foreground) continue;
    for (const [, surface, value] of body.matchAll(/\b([a-z][\w-]*)\s+(\d+\.\d+)/gu)) {
      const background = opaque(surface);
      if (!background) continue;
      compare(`${softName} + ${foregroundName} on ${surface}`,
        contrastRatio(foreground, compositeOver(soft, background)), value);
    }
  }

  // 3) "X on (TOKEN .aa over SURFACE) = N" — 알파 오버레이 위 전경
  for (const [, foregroundName, tintName, alpha, surface, value] of
    table.matchAll(/(--[\w-]+|#[0-9a-f]{3,6})\s+on\s+\((--[\w-]+)\s+(\.\d+)\s+over\s+([\w-]+)\)\s*=\s*(\d+\.\d+)/giu)) {
    const foreground = parseCssColor(foregroundName)?.rgb || opaque(foregroundName);
    const tint = tokens.get(tintName);
    const background = opaque(surface);
    if (!foreground || !tint || !background) continue;
    compare(`${foregroundName} on (${tintName} ${alpha} over ${surface})`,
      contrastRatio(foreground, compositeOver({ rgb: tint.rgb, alpha: Number(alpha) }, background)), value);
  }

  // 4) "X on Y = N" — 불투명 면 위 전경
  for (const [, foregroundName, backgroundName, value] of
    table.matchAll(/(--[\w-]+|#[0-9a-f]{3,6})\s+on\s+(--[\w-]+|#[0-9a-f]{3,6})(?:\s+#[0-9a-f]{3,6})?\s*=\s*(\d+\.\d+)/giu)) {
    const foreground = parseCssColor(foregroundName)?.rgb || opaque(foregroundName);
    const background = parseCssColor(backgroundName)?.rgb || opaque(backgroundName);
    if (!foreground || !background) continue;
    compare(`${foregroundName} on ${backgroundName}`, contrastRatio(foreground, background), value);
  }

  // 5) 헤어라인의 범위 표기 (min~max)
  for (const [, lineName, low, high] of table.matchAll(/(--line[\w-]*)\s+(\d+\.\d+)~(\d+\.\d+)/gu)) {
    const hairline = tokens.get(lineName);
    if (!hairline) continue;
    const ratios = surfaceNames
      .map((surface) => opaque(surface))
      .filter(Boolean)
      .map((background) => contrastRatio(compositeOver(hairline, background), background));
    compare(`${lineName} min`, Math.min(...ratios), low);
    compare(`${lineName} max`, Math.max(...ratios), high);
  }

  check(compared >= 60, `system.css contrast table: only ${compared} values were re-computed — the parser lost the table`);

  // 6) 전수 검산 — :root의 모든 색 토큰이 표에 등장해야 한다 (DESIGN.md §3.1).
  for (const name of tokens.keys()) {
    check(table.includes(name.slice(2)),
      `system.css contrast table: ${name} is defined but never appears in the table — every color token needs its contrast recorded (DESIGN.md §3.1)`);
  }

  // 7) .btn-danger의 normal·hover는 CSS 선언에서 직접 재계산한다 (R4-M-10).
  //    표의 숫자가 아니라 **규칙이 실제로 쓰는 토큰**을 본다 — 값이 맞아도 규칙이 다른
  //    토큰을 쓰면 화면은 미달이다. :disabled는 WCAG 1.4.3 비활성 예외라 하한을 걸지 않는다.
  const dangerForeground = /\.btn-danger\s*\{[^}]*color:\s*var\((--[\w-]+)\)/u.exec(css);
  const dangerBase = /\.btn-danger\s*\{[^}]*background:\s*var\((--[\w-]+)\)/u.exec(css);
  const dangerHover = /\.btn-danger:hover\s*\{[^}]*background:\s*var\((--[\w-]+)\)/u.exec(css);
  check(Boolean(dangerForeground && dangerBase && dangerHover),
    'system.css: .btn-danger normal/hover declarations could not be read — the danger contrast check is inert');
  if (dangerForeground && dangerBase && dangerHover) {
    const foreground = opaque(dangerForeground[1]);
    for (const [state, rule] of [['normal', dangerBase], ['hover', dangerHover]]) {
      const background = opaque(rule[1]);
      check(Boolean(foreground && background),
        `system.css: .btn-danger ${state} uses a non-opaque surface (${rule[1]}) — an alpha fill makes contrast depend on the parent (R4-M-10)`);
      if (!foreground || !background) continue;
      const ratio = contrastRatio(foreground, background);
      check(ratio >= 4.5,
        `system.css: .btn-danger ${state} is ${computed(ratio)}:1 (${dangerForeground[1]} on ${rule[1]}) — 14px semibold needs 4.5:1`);
    }
  }
  check(/\.btn:disabled[^{]*\{[^}]*opacity:/u.test(css),
    'system.css: .btn disabled state must be opacity-based (WCAG 1.4.3 exempts inactive controls from the contrast floor)');
}

function validateLandingGating() {
  // 사이클 #3 게이팅 잠금 (plan.md D7 철회) — 미로그인 랜딩은 "개인 웹사이트"여야 한다.
  // 사이클5에서 계약이 한 단계 더 좁아졌다: 로그인해도 본문은 학습을 말하지 않고,
  // 학습·사용량 진입은 드로어 템플릿에만 있다 (plan.md §1-1 / §3.3).
  //
  // 이 검사가 **못 보는 것**: 런타임에 조립돼 삽입되는 링크·문구, 그리고 Worker가 같은
  // 규칙을 강제하는지. 정적으로 볼 수 있는 것은 문서에 무엇이 적혀 있는가까지다.
  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const homeJs = readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8');
  const templatePattern = /<template data-(?:study|owner|behavior-owner)>[^]*?<\/template>/gu;
  const gatedTemplates = homeHtml.match(templatePattern) || [];
  const staticMarkup = homeHtml.replace(templatePattern, '');
  const templateMarkup = gatedTemplates.join('\n');

  // 로그인-후 진입 경로 목록을 손으로 적지 않는다 — 템플릿 자신에서 도출한다.
  // 드로어에 항목을 추가하면 그 경로가 자동으로 "정적 마크업 금지" 대상이 된다.
  // '/admin/'만 예외로 더한다: 템플릿에는 없지만(진입은 로그인 후 타이틀 링크가 만든다)
  // 미로그인 문서에 노출돼선 안 되는 경로다.
  const templateTargets = [...new Set(
    [...templateMarkup.matchAll(/href="(\/[\w./-]*\/)(?:[?#][^"]*)?"/gu)].map(([, href]) => href),
  )];
  check(templateTargets.length >= 3,
    `index.html: only ${templateTargets.length} gated entry paths were derived from <template data-study> — this check is inert`);

  // 1) 미로그인 상태로 렌더되는 정적 마크업에 로그인-후 진입 경로가 있으면 실패.
  for (const appPath of [...new Set([...templateTargets, '/admin/'])]) {
    check(!new RegExp(`(?:href|src|action)=["']${appPath.replaceAll('/', '\\/')}`, 'u').test(staticMarkup),
      `index.html: logged-out static markup must not link to gated path ${appPath}`);
  }
  // 2) 학습을 드러내는 문구도 정적 마크업에 남으면 안 된다 (메타/OG 포함 전체 소스 기준).
  for (const keyword of STUDY_KEYWORDS) {
    check(!staticMarkup.includes(keyword),
      `index.html: logged-out static markup must not contain study keyword "${keyword}"`);
  }
  // 3) 복원 계약 — 로그인 시 주입될 템플릿 안에 두 학습 앱과 사용량 링크가 있어야 한다.
  check(gatedTemplates.some((block) => block.startsWith('<template data-study>')),
    'index.html: <template data-study> blocks are missing');
  check(templateMarkup.includes('href="/WordMaster/"'), 'index.html: study templates must restore the /WordMaster/ link on login');
  check(templateMarkup.includes('href="/smstudy/"'), 'index.html: study templates must restore the /smstudy/ link on login');
  // 사용량은 소유자 개인 데이터다 — 항목은 소유자 전용 템플릿에만 있어야 한다 (review WP1 M-5).
  const ownerTemplate = /<template data-owner>[^]*?<\/template>/u.exec(homeHtml)?.[0] ?? '';
  const studyOnlyMarkup = gatedTemplates.filter((block) => block.startsWith('<template data-study>')).join('\n');
  check(ownerTemplate.includes('href="/usage/"'),
    'index.html: the usage entry must live inside <template data-owner> — it is owner-only data (review WP1 M-5)');
  check(!studyOnlyMarkup.includes('href="/usage/"'),
    'index.html: the usage entry must not sit in <template data-study> — that template mounts for every logged-in account');
  const configuredOwners = /(?:^|\n)OWNER_USERNAME\s*=\s*"([^"]*)"/u
    .exec(readFileSync(path.join(ROOT, 'worker/wrangler.toml'), 'utf8'))?.[1]
    ?.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean) || [];
  const renderedOwnerLiteral = /const OWNER_USERNAMES = \[([^\]]*)\];/u.exec(homeJs)?.[1] || '';
  const renderedOwners = [...renderedOwnerLiteral.matchAll(/'([^']+)'/gu)]
    .map((match) => match[1].trim().toLowerCase()).filter(Boolean);
  check(configuredOwners.length === 1 && configuredOwners[0] === 'hvsdcm'
    && JSON.stringify(renderedOwners) === JSON.stringify(configuredOwners),
  'owner boundary: Worker and landing UI must expose owner controls to the sole human owner only');
  const behaviorOwnerTemplate = /<template data-behavior-owner>[^]*?<\/template>/u.exec(homeHtml)?.[0] ?? '';
  check(behaviorOwnerTemplate.includes('href="/behavior-lab/#paper"'),
    'index.html: the owner landing template must link directly to the Behavior Lab paper tab');
  check(!ownerTemplate.includes('href="/behavior-lab/'),
    'index.html: Behavior Lab must not enter the broader owner template that also mounts for claude-test');
  check(homeJs.includes("const BEHAVIOR_OWNER_USERNAME = 'hvsdcm';")
    && homeJs.includes("normalize('NFKC').trim().toLowerCase() === BEHAVIOR_OWNER_USERNAME")
    && /if \(!isBehaviorOwner\(username\)[^]*?return;/u.test(homeJs)
    && homeJs.includes('mountBehaviorOwnerEntry(savedUsername)'),
  'home.js: the Behavior Lab landing entry must mount only for the exact human owner');
  // 4) 주입 루틴 존재 — 템플릿만 있고 주입 코드가 사라지면 로그인 화면이 빈다.
  check(homeJs.includes('mountDrawerTemplates'), 'home.js: mountDrawerTemplates is missing — drawer templates would never render');

  // 5) 드로어가 여는 페이지는 전부 자기 로그인 게이트를 지나야 한다. 대상 목록도 템플릿의
  //    링크에서 도출하므로, 드로어에 항목을 추가하면 그 페이지가 자동으로 검사를 받는다.
  for (const target of templateTargets) {
    const entry = path.join(ROOT, target.slice(1), 'index.html');
    check(existsSync(entry), `index.html: the drawer links to ${target} but ${target}index.html does not exist`);
    if (!existsSync(entry)) continue;
    check(Boolean(loginGateOf(entry, readFileSync(entry, 'utf8'))),
      `${target}index.html: it is opened from the login-gated drawer but no script gates it — an anonymous visitor could read it (plan.md §3.3)`);
  }
}

function validateBehaviorLab() {
  const files = [
    'behavior-lab/index.html',
    'behavior-lab/assets/css/app.css',
    'behavior-lab/assets/js/core.js',
    'behavior-lab/assets/js/app.js',
    'worker/src/behavior-lab.js',
  ];
  for (const file of files) check(existsSync(path.join(ROOT, file)), `${file}: Behavior Lab artifact is missing`);
  if (files.some((file) => !existsSync(path.join(ROOT, file)))) return;

  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const pageHtml = readFileSync(path.join(ROOT, 'behavior-lab/index.html'), 'utf8');
  const appSource = readFileSync(path.join(ROOT, 'behavior-lab/assets/js/app.js'), 'utf8');
  const coreSource = readFileSync(path.join(ROOT, 'behavior-lab/assets/js/core.js'), 'utf8');
  const workerSource = readFileSync(path.join(ROOT, 'worker/src/behavior-lab.js'), 'utf8');
  const routerSource = readFileSync(path.join(ROOT, 'worker/src/router.js'), 'utf8');
  const expectedPaths = [
    '/api/v2/mix/market/tickers',
    '/api/v2/mix/market/ticker',
    '/api/v2/mix/market/candles',
    '/api/v2/mix/market/long-short',
    '/api/v2/mix/market/taker-buy-sell',
    '/api/v2/mix/market/history-fund-rate',
    '/api/v2/mix/market/open-interest',
    '/api/v2/mix/market/contracts',
  ];
  const declaredBlock = /BITGET_PUBLIC_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(workerSource)?.[1] ?? '';
  const declaredPaths = [...declaredBlock.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  const requestedPaths = [...workerSource.matchAll(/publicGet\('([^']+)'/gu)].map((match) => match[1]);
  check(declaredPaths.join('\n') === expectedPaths.join('\n'),
    `worker/src/behavior-lab.js: public path allowlist must be the exact accepted eight paths, found [${declaredPaths.join(', ')}]`);
  check(requestedPaths.length === 8 && [...requestedPaths].sort().join('\n') === [...expectedPaths].sort().join('\n'),
    'worker/src/behavior-lab.js: one dashboard load must construct every accepted path exactly once');
  check(workerSource.includes("BITGET_PUBLIC_HOST = 'api.bitget.com'")
    && workerSource.includes("method: 'GET'") && workerSource.includes("redirect: 'manual'"),
  'worker/src/behavior-lab.js: upstream must stay https api.bitget.com GET with Workerd-compatible manual redirect refusal');
  check(/BEHAVIOR_LAB_SYMBOLS = Object\.freeze\(\['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'\]\)/u.test(workerSource)
    && /BEHAVIOR_LAB_PERIODS = Object\.freeze\(\['5m', '15m', '1h', '4h'\]\)/u.test(workerSource),
  'worker/src/behavior-lab.js: symbol and period enums must remain fixed');
  check(workerSource.includes('joinedTimes.length < 20') && workerSource.includes('unmatchedLong > 2')
    && workerSource.includes('unmatchedTaker > 2'),
  'worker/src/behavior-lab.js: long-short and taker rows must use exact timestamp joins with bounded unmatched edges');
  check(workerSource.includes('REQUEST_TIMEOUT_MS') && workerSource.includes('MAX_RESPONSE_BYTES')
    && workerSource.includes('TOTAL_DEADLINE_MS') && workerSource.includes('MAX_ACTIVE_DASHBOARD_LOADS')
    && workerSource.includes('MAX_BEHAVIOR_QUEUE_DEPTH') && workerSource.includes('CACHE_TTL_MS')
    && workerSource.includes('CACHE_LIMIT') && workerSource.includes('clock() + CACHE_TTL_MS'),
  'worker/src/behavior-lab.js: total/fetch timeout, admission, behavior queue, response, completion TTL, and cache cardinality must stay bounded');
  check(!/authorization|api[-_ ]?key|passphrase|signature/iu.test(workerSource),
    'worker/src/behavior-lab.js: credential vocabulary is forbidden on the public market boundary');
  check(!/\/api\/v\d+\/(?:mix\/)?(?:account|order|position|trade|private)(?:\/|['"`])/iu.test(workerSource),
    'worker/src/behavior-lab.js: account, private, position, trading, and order paths are forbidden');
  check(!/fixture|\bdemo\b/iu.test(workerSource),
    'worker/src/behavior-lab.js: upstream failure must not fall back to fixture/demo data');
  check(routerSource.includes("method === 'GET' && path === '/api/behavior-lab/dashboard'")
    && (routerSource.match(/\/api\/behavior-lab\/dashboard/gu) || []).length === 1,
  'worker/src/router.js: exactly one Behavior Lab dashboard route must exist');

  check((appSource.match(/\/api\/behavior-lab\/dashboard/gu) || []).length === 1,
    'behavior-lab app: the browser must fetch only the single Worker dashboard route');
  check(!appSource.includes('api.bitget.com'),
    'behavior-lab app: browser-direct Bitget requests are forbidden');
  check(!/scheduler|notification|health/iu.test(appSource),
    'behavior-lab app: local scheduler, notification, and health surfaces must stay out of the public page');
  check(!/<form\b|type=["']submit["']|\baction=/iu.test(pageHtml)
    && /id="copyDraft"[^>]*type="button"/u.test(pageHtml)
    && pageHtml.includes('제출 기능은 존재하지 않습니다.'),
  'behavior-lab page: the manual draft must remain text/copy-only with no submit surface');
  check(coreSource.includes('runWalkForwardBacktest') && coreSource.includes('createManualDraft')
    && coreSource.includes('BACKTEST_FEE_BPS_PER_SIDE = 6')
    && coreSource.includes('BACKTEST_SLIPPAGE_BPS_PER_SIDE = 4'),
  'behavior-lab core: chronological backtest and cost-inclusive manual draft semantics are incomplete');
  check(coreSource.includes('evaluateSnapshotQuality') && coreSource.includes('componentMaxAges')
    && coreSource.includes('createFreshManualDraft') && appSource.includes('setInterval(refreshLiveClock, 1_000)')
    && /function createDraft\(\)[\s\S]*createFreshManualDraft/u.test(appSource),
  'behavior-lab app: component/period live-clock freshness and action-time draft gating must stay fail-closed');
  check(/<template data-behavior-owner>[^]*?href="\/behavior-lab\/#paper"[^]*?<\/template>/u.test(homeHtml),
    'index.html: private Behavior Lab must have an exact-owner landing entry to the paper tab');
  check(pageHtml.includes('content="noindex, nofollow, noarchive"')
    && /id="labShell"[^>]*\bhidden\b/u.test(pageHtml)
    && appSource.includes("localStorage.getItem('hvsdcm.token')")
    && appSource.includes('authorization: `Bearer ${ownerToken()}`')
    && appSource.includes('/api/behavior-lab/paper'),
  'behavior-lab: owner gate, bearer reads, noindex, and paper tab contract are incomplete');
  check(!pageHtml.includes('id="paperReport"') && !pageHtml.includes('id="paperAdaptive"')
    && appSource.includes('PAPER_REFRESH_MS = 5_000') && appSource.includes('renderEquityChart')
    && appSource.includes("['starting', 'active'].includes(payload.experiment.status)")
    && appSource.includes('curve.length <= 64') && appSource.includes("setAttribute('role', 'img')")
    && routerSource.includes("value.engine_version !== 'realtime-paper-v2'")
    && routerSource.includes('MAX_BEHAVIOR_ADAPTIVE_CHALLENGERS = 8')
    && routerSource.includes('MAX_BEHAVIOR_ADAPTIVE_AUDIT_LOGS = 20')
    && routerSource.includes("stream.credential_used !== false")
    && routerSource.includes("'$.adaptive.audit.sequence'"),
  'behavior-lab: active-only A/B/C UI and backward-compatible bounded adaptive Worker contract are incomplete');

  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const architecture = readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  check(readme.includes('/behavior-lab/'), 'README.md: Behavior Lab is missing from the application list');
  check(architecture.includes('GET /api/behavior-lab/dashboard'),
    'docs/ARCHITECTURE.md: the public Behavior Lab API boundary is missing');
}

validateJavaScriptSyntax();
validateHtmlAssets();
validateUiContracts();
validateLandingGating();
validateStudyExposure();
validateLabelledBy();
validateContrastTable();
validateDesignHeadingSequence();
validateDesignTokens();
validateBrandName();
validateEmojiSystem();
validateSmStudyEmoji();
validateWordMasterEmoji();
validateEmojiCrossMaps();
validateOgImageLock();
validateGlobalsAndOrder();
validateMigrations();
validateGichulBackend();
validateGichulFrontend();
validateBehaviorLab();
validateWordMasterData();
// M-6 — 스크린샷 대신 남긴 정적 스냅샷. 존재와 "파일 단독으로 열림"을 계약으로 건다.
// 스냅샷이 조용히 사라지거나 외부 자산에 의존하게 되면 시각 확인 근거가 없어진다.
function validateDocSnapshots() {
  // ---- R2-M-1. 스냅샷이 낡으면 실패해야 한다 ----
  // 이전 검사는 파일 존재·인라인 표식·figure 수·다이어그램 제목만 봤다. 그래서 스냅샷 본문의
  // 키워드를 '낡은공유성'으로 바꾼 변형이 13204 checks로 통과했다. 이제 scripts/snapshot.mjs가
  // **현재 커밋의 소스로 스냅샷을 다시 만들어** 커밋된 파일과 그대로 대조한다.
  // 데이터·렌더러·CSS 중 무엇이 바뀌든 `node scripts/snapshot.mjs`를 다시 돌리기 전에는 실패한다.
  const regenerated = buildSnapshots();
  for (const [file, html] of Object.entries(regenerated)) {
    const absolute = path.join(ROOT, file);
    if (!existsSync(absolute)) continue;
    const committed = readFileSync(absolute, 'utf8');
    if (committed === html) {
      check(true, `${file}: snapshot matches the current sources`);
      continue;
    }
    const at = [...html].findIndex((character, index) => committed[index] !== character);
    check(false, `${file}: snapshot is stale — it does not match what scripts/snapshot.mjs produces from the current sources`
      + ` (first difference at offset ${at}: expected "${html.slice(at, at + 60).replace(/\n/gu, '\n')}",`
      + ` found "${committed.slice(at, at + 60).replace(/\n/gu, '\n')}") — run: node scripts/snapshot.mjs`);
  }

  // ---- R4-M-1. 화면 커버리지 ----
  // 완료 조건(plan.md §4)은 4개 화면 **전부**의 스냅샷을 요구했는데, 이전 게이트는
  // diagrams/concept 두 파일만 확인해 화면 두 개가 통째로 없어도 통과했다.
  // 화면 목록을 손으로 적으면 화면이 늘어도 게이트는 모른다 — 게시되는 **진입 HTML**에서
  // 도출해 생성기의 화면→스냅샷 표와 대조한다.
  //
  // 이 검사가 **못 보는 것**: 스냅샷이 그 화면의 "대표 상태"를 담고 있는지(예: 로그인
  // 상태인지, 표에 행이 있는지). 각 스냅샷의 주석 상자가 반영한 상태를 사람이 읽도록 적는다.
  // 그리고 뷰포트별(320/768/1280) 기하는 레이아웃 엔진이 필요해 여기서 재지 못한다.
  const published = publishedHtml().map(relative);
  const screens = published.filter((file) => file === 'index.html' || file.endsWith('/index.html'));
  check(screens.length >= 4, `snapshot coverage: only ${screens.length} entry screens were derived — this check is inert`);
  for (const screen of screens) {
    const snapshot = SNAPSHOT_BY_SCREEN[screen];
    check(Boolean(snapshot),
      `${screen}: no snapshot is declared for this screen — add it to SNAPSHOT_BY_SCREEN in scripts/snapshot.mjs (docs/plan.md §4)`);
    if (!snapshot) continue;
    check(Object.prototype.hasOwnProperty.call(regenerated, snapshot),
      `${snapshot}: scripts/snapshot.mjs no longer produces the snapshot for ${screen}`);
    check(existsSync(path.join(ROOT, snapshot)),
      `${snapshot}: the snapshot for ${screen} is missing — run: node scripts/snapshot.mjs`);
  }

  // ---- B-1. 스냅샷은 공개 배포면 밖에 있어야 한다 ----
  for (const file of Object.values(SNAPSHOT_FILES)) {
    check(!published.includes(file),
      `${file}: the snapshot is on the published surface — it renders study content with no login gate (plan.md §3)`);
  }

  // 아래는 재생성 대조가 깨졌을 때에도 남는 구조 계약이다 (생성기 자체가 잘못될 수 있다).
  for (const file of Object.keys(regenerated)) {
    const absolute = path.join(ROOT, file);
    check(existsSync(absolute), `${file}: visual snapshot is missing — regenerate it (docs/plan.md §4)`);
    if (!existsSync(absolute)) continue;
    const source = readFileSync(absolute, 'utf8');
    check(!/<link\b[^>]*rel=["']stylesheet/iu.test(source) && !/<script\b[^>]*\bsrc=/iu.test(source),
      `${file}: snapshot must inline every stylesheet and carry no scripts so the file opens standalone`);
    check(source.includes('assets/css/system.css (inlined)'),
      `${file}: snapshot must inline /assets/css/system.css`);
  }
  const figuresIn = (file) => (readFileSync(path.join(ROOT, file), 'utf8').match(/<figure class="sm-diagram\b/gu) || []).length;
  const captionsIn = (file) => (readFileSync(path.join(ROOT, file), 'utf8').match(/<figcaption\b/gu) || []).length;
  for (const file of [SNAPSHOT_FILES.DIAGRAMS, SNAPSHOT_BY_SCREEN['smstudy/index.html']]) {
    // 한 figure에 figcaption은 하나뿐이어야 한다 (M-3 회귀 잠금 — 얼린 DOM에서도 확인한다).
    check(figuresIn(file) > 0, `${file}: no rendered diagram found — the frozen DOM lost its figures`);
    check(captionsIn(file) === figuresIn(file),
      `${file}: expected one <figcaption> per <figure>, found ${captionsIn(file)} for ${figuresIn(file)} figures`);
  }
  const diagrams = readFileSync(path.join(ROOT, SNAPSHOT_FILES.DIAGRAMS), 'utf8');
  const notebookData = evaluateBrowserData('_learning/smstudy/notebook-data.js', 'SMSTUDY_NOTEBOOK');
  for (const [id, notebook] of Object.entries(notebookData?.NOTEBOOKS || {})) {
    for (const diagram of notebook.diagrams || []) {
      check(diagrams.includes(`${id} — ${diagram.title} (${diagram.kind}`),
        `${SNAPSHOT_FILES.DIAGRAMS}: missing heading for ${id} — ${diagram.title} (${diagram.kind}) — regenerate the snapshot`);
    }
  }
}

validateSmStudyData();
validateRenderedCopy();
validateDocSnapshots();

if (failures.length > 0) {
  console.error(`Validation failed (${failures.length}/${checks})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validation passed (${checks} checks)`);
}
