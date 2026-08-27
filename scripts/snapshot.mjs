// docs/_snapshots/*.html 생성기.
//
// 왜 생성기인가 (review 라운드 2, R2-M-1)
//   손으로 얼린 스냅샷은 낡아도 게이트가 모른다. 실제로 concept-sample.html의 키워드를
//   '낡은공유성'으로 바꾼 변형이 13204 checks로 통과했다. 그래서 스냅샷을 **소스에서
//   재생성 가능한 산출물**로 바꾼다. scripts/validate.mjs가 같은 함수로 다시 만들어
//   커밋된 파일과 바이트 단위로 대조하므로, 데이터·렌더러·CSS 중 무엇이 바뀌든
//   스냅샷을 다시 만들기 전에는 게이트가 실패한다.
//
// 왜 밑줄 디렉터리인가 (review 라운드 4, R4-B-1)
//   저장소 루트가 곧 GitHub Pages 배포 루트다. docs/snapshots/*.html은 로그인 검사 없이
//   개념 본문·표·회상 문제를 렌더하는 **공개 페이지**였고, 미로그인 학습 내용 비노출
//   계약을 정면으로 깼다. Jekyll(.nojekyll 없음)은 경로 조각이 '_'로 시작하면 출력하지
//   않으므로 docs/_snapshots로 옮긴다. 이 전제가 무너지는 순간(=.nojekyll이 생기는 순간)
//   validate.mjs의 publishedHtml()이 이 파일들을 검사 대상으로 끌어와 게이트가 실패한다.
//
// 사용법:  node scripts/snapshot.mjs   (파일을 덮어쓴다)

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createAppSandbox, evaluateBrowserData, evaluateDiagramRenderer,
  ICON_SOURCE, NOTEBOOK_SOURCE, readSource, renderUsageDashboard, renderWordMasterHome,
} from './render-sandbox.mjs';

const ROOT = process.cwd();

export const SNAPSHOT_DIR = 'docs/_snapshots';

// 화면(게시되는 진입 HTML) → 스냅샷 파일. 완료 조건 "4개 화면 전부"(plan.md §4)의
// 근거이고, validate.mjs가 게시 진입 HTML 목록과 이 표를 대조한다 (R4-M-1).
export const SNAPSHOT_BY_SCREEN = {
  'index.html': `${SNAPSHOT_DIR}/landing.html`,
  'WordMaster/index.html': `${SNAPSHOT_DIR}/wordmaster.html`,
  'smstudy/index.html': `${SNAPSHOT_DIR}/concept-sample.html`,
  'admin/index.html': `${SNAPSHOT_DIR}/admin.html`,
  'usage/index.html': `${SNAPSHOT_DIR}/usage.html`,
};

export const SNAPSHOT_FILES = {
  ...SNAPSHOT_BY_SCREEN,
  DIAGRAMS: `${SNAPSHOT_DIR}/diagrams.html`,
};

// 개념 화면 스냅샷이 담는 중단원. 바꾸면 파일도 함께 다시 만들어야 한다.
const CONCEPT_SAMPLE_ID = 'III-01';

// ---- 사용량 화면 fixture ----------------------------------------------------
// 사용량 본문은 Worker가 돌려주는 수집 결과라 저장소에 원본이 없다. 그래서 계약
// (docs/plan.md §3.2)이 정한 모양의 표본을 여기에 둔다. 기준 시각도 고정값이다 —
// 상대 시간을 렌더하므로 now가 흐르면 스냅샷이 매번 달라져 대조가 무의미해진다.
//
// 표본은 계약의 갈래를 전부 한 번씩 지난다: Codex의 primary/secondary와 모르는
// 키(monthly), 게이지 세 구간, 모델별로 창을 담는 Claude payload(used_percentage),
// 그리고 Main Codex·Codex 서브에이전트·WebGPT 실행자·Claude 오케스트레이터를
// 같은 작업 계층에 둔 실제 하네스 payload.
const USAGE_NOW = Date.parse('2026-08-27T12:00:00Z');
const USAGE_FIXTURE = {
  snapshots: [{
    source: 'codex',
    captured_at: '2026-08-27T11:48:00Z',
    payload: {
      model: 'gpt-5.6-sol',
      plan_type: 'pro',
      rate_limits: {
        primary: { used_percent: 41.5, resets_at: '2026-08-27T15:10:00Z', window_minutes: 300 },
        secondary: { used_percent: 78.2, resets_at: '2026-08-31T09:00:00Z', window_minutes: 10_080 },
        monthly: { used_percent: 96.1 },
      },
    },
  }, {
    source: 'claude',
    captured_at: '2026-08-27T11:52:00Z',
    payload: {
      models: {
        'claude-opus-5': {
          captured_at: '2026-08-27T11:52:00Z',
          rate_limits: {
            five_hour: { used_percentage: 33.4, resets_at: '2026-08-27T14:00:00Z' },
            seven_day: { used_percentage: 57.9, resets_at: '2026-09-01T00:00:00Z' },
          },
        },
      },
    },
  }],
  tasks: [
    {
      version: 1,
      id: 'jimunhanjang-project',
      name: '프로젝트 지문한장 (08-27)',
      phase: 'done',
      progress: 100,
      status: 'complete',
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
      category_key: 'jimunhanjang-project',
      category: '지문한장 프로젝트',
      current: '배포 완료',
      done: '제품 E2E와 독립 검토 통과',
      next: '완료 기록 보존',
      deadline: '20:20 KST',
      created_at: '2026-08-27T08:40:00Z',
      updated_at: '2026-08-27T11:50:00Z',
      actors: [{
        id: 'jimunhanjang:main', parent_id: '', name: 'Main Codex', kind: 'codex',
        model: 'gpt-5.6-sol', reasoning: 'xhigh', role: '제품 개선 총괄', status: 'done',
        assignment: '배포와 최종 판정 완료',
      }],
      artifacts: ['제품 E2E 기준 고정'],
    },
    {
      version: 1,
      id: 'pipeline-hardening',
      name: 'Pipeline 개선 프로토콜 (08-27)',
      phase: 'review',
      progress: 82,
      status: 'active',
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
      category_key: 'pipeline-protocol',
      category: '자체 pipeline 개선 프로토콜',
      current: '독립 gate 검토',
      done: 'WIP와 실패 복구 규칙 고정',
      next: '하네스 회귀 확인',
      deadline: '20:15 KST',
      created_at: '2026-08-27T08:50:00Z',
      updated_at: '2026-08-27T11:52:00Z',
      actors: [{
        id: 'pipeline-hardening:main', parent_id: '', name: 'Main Codex', kind: 'codex',
        model: 'gpt-5.6-sol', reasoning: 'xhigh', role: '프로토콜 소유자', status: 'reviewing',
        assignment: '결정적 gate와 최종 판정',
      }],
      artifacts: ['control npm test'],
    },
    {
    version: 1,
    id: 'usage-harness-visualization',
    name: '사용량 하네스 시각화 (08-27)',
    phase: 'review',
    progress: 86,
    status: 'active',
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    category_key: 'pipeline-visualization',
    category: '파이프라인 시각화',
    current: '독립 검토와 반응형 확인',
    done: 'Worker 연결 · 렌더 구현 · 결정적 gate',
    next: '라이브 배포',
    deadline: '20:10 KST',
    created_at: '2026-08-27T09:00:00Z',
    updated_at: '2026-08-27T11:54:00Z',
    modules: [
      { id: 'verification', name: '검증 단계', progress: 80, status: 'reviewing', owner: '독립 검토' },
      { id: 'css', name: 'CSS 구현', progress: 88, status: 'working', owner: 'Main Codex' },
      { id: 'quota', name: '한도 수집', progress: 72, status: 'working', owner: 'Main Codex' },
    ],
    actors: [
      {
        id: 'usage-harness:main', parent_id: '', name: 'Main Codex', kind: 'codex',
        model: 'gpt-5.6-sol', reasoning: 'xhigh', role: '기획 · 통합 · 최종 판정', status: 'reviewing',
        assignment: '전체 계약과 최종 판정', progress: 86,
      },
      {
        id: 'usage-harness:writer', parent_id: 'usage-harness:main', name: '구현 컨텍스트', kind: 'codex',
        model: 'gpt-5.6-sol', reasoning: 'xhigh', role: '구현자', status: 'done', assignment: 'Worker와 사용량 화면 구현', progress: 100,
      },
      {
        id: 'usage-harness:reviewer', parent_id: 'usage-harness:main', name: '독립 검토', kind: 'codex',
        model: 'gpt-5.6-sol', reasoning: 'xhigh', role: '검토자', status: 'reviewing', assignment: 'diff와 실제 artifact 반증', progress: 80,
      },
      {
        id: 'usage-harness:webgpt', parent_id: 'usage-harness:main', name: 'WebGPT 실행자', kind: 'webgpt',
        model: 'WebGPT PRO', role: '보조 실행', status: 'waiting', assignment: '경계가 명확한 저위험 작업 대기', progress: 37,
      },
      {
        id: 'usage-harness:claude', parent_id: 'usage-harness:main', name: 'Fable 5 오케스트레이터', kind: 'claude',
        model: 'claude-fable-5', reasoning: 'high', role: '기획 · 총괄', status: 'working',
        assignment: 'Claude 한도 복원 통합', progress: 62,
      },
    ],
    // WP-A1의 이벤트 로그. 셋 중 이 세션에만 넣는다 — 단계 소요시간과 세션 한도 소모가
    // 붙은 화면과, 구세션처럼 그 두 줄이 없는 화면을 한 파일에서 나란히 보기 위해서다.
    events: [
      { ts: '2026-08-27T09:00:00Z', kind: 'phase-change', phase: 'plan', model: 'gpt-5.6-sol', reasoning: 'xhigh', usage_codex: 18.4, usage_claude: 21.0 },
      { ts: '2026-08-27T09:35:00Z', kind: 'phase-change', phase: 'work', model: 'gpt-5.6-sol', reasoning: 'xhigh', usage_codex: 24.9, usage_claude: 25.6 },
      { ts: '2026-08-27T10:20:00Z', kind: 'report', phase: 'work', actor_id: 'usage-harness:writer', percent: 100, usage_codex: 31.2, usage_claude: 28.1 },
      { ts: '2026-08-27T11:05:00Z', kind: 'phase-change', phase: 'review', model: 'claude-opus-5', reasoning: 'high', usage_codex: 38.6, usage_claude: 30.4 },
      { ts: '2026-08-27T11:40:00Z', kind: 'report', phase: 'review', actor_id: 'usage-harness:reviewer', percent: 80, usage_codex: 41.5, usage_claude: 33.4 },
    ],
    artifacts: ['npm test', 'HARNESS E2E: PASS', 'PC · 태블릿 · 모바일 캡처'],
    },
  ],
};

// 화면마다 얹히는 CSS가 다르다. 여기를 한 벌로 두면 WordMaster 스냅샷이 smstudy의
// 스타일로 조판돼 실제와 다른 화면을 보여 준다(실측으로 확인: .wm-layout 규칙이 없어
// 320px에서 366px로 넘쳤다).
const SMSTUDY_CSS = ['assets/css/system.css', 'smstudy/assets/css/style.css'];
const WORDMASTER_CSS = ['assets/css/system.css', 'WordMaster/assets/css/style.css'];

const SNAPSHOT_CSS = `/* ---- 스냅샷 전용 (원본 CSS 아님) ---- */
body { background: var(--bg); color: var(--text); margin: 0; padding: 32px 24px 64px; }
.snap-wrap { max-width: 900px; margin: 0 auto; container-type: inline-size; }
.snap-note { border: 1px solid var(--line); border-radius: var(--radius-m, 12px); padding: 16px 18px; margin-bottom: 32px; color: var(--text-2); font-size: 14px; line-height: 1.7; }
.snap-note code { color: var(--text); }
.snap-item { padding: 28px 0; border-top: 1px solid var(--line); }
.snap-item:first-of-type { border-top: 0; }
.snap-head { font-size: 15px; font-weight: 600; color: var(--text-2); margin: 0 0 14px; letter-spacing: normal; }`;

// 문서 스냅샷(원본 HTML을 그대로 얼리는 쪽)은 페이지 자신의 레이아웃을 건드리면 안 되므로
// 주석 상자 하나만 얹는다.
const DOCUMENT_SNAPSHOT_CSS = `/* ---- 스냅샷 전용 (원본 CSS 아님) ---- */
.snap-note { position: relative; z-index: 300; margin: 0; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--surface); color: var(--text-2); font-size: 14px; line-height: 1.7; }
.snap-note code { color: var(--text); }`;

// 생성물이므로 줄 끝 공백을 남기지 않는다 (git diff --check).
function normalize(html) {
  return `${html.split('\n').map((line) => line.replace(/[ \t]+$/u, '')).join('\n').replace(/\n+$/u, '')}\n`;
}

function inlineStyles(files) {
  return files
    .map((file) => `<style>/* ${file} (inlined) */\n${readSource(file).trimEnd()}\n</style>`)
    .join('\n');
}

function page(title, note, items, styles = SMSTUDY_CSS) {
  return normalize(`<!doctype html>
<html lang="ko" data-snapshot="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
${inlineStyles(styles)}
<style>
${SNAPSHOT_CSS}
</style>
</head>
<body>
<div class="snap-wrap">
<div class="snap-note">${note}</div>
${items.join('\n')}
</div>
</body>
</html>`);
}

const GENERATED_NOTE = '<br><strong>기준</strong> — 이 파일은 <code>node scripts/snapshot.mjs</code>가 만든 생성물이다. 손으로 고치지 않는다.'
  + ' <code>npm run validate</code>가 같은 생성기를 다시 돌려 이 파일과 대조하므로, 데이터·렌더러·CSS를 바꾸면 반드시 다시 만들어야 한다.'
  + ' 이 디렉터리는 밑줄로 시작하므로 GitHub Pages(Jekyll)가 게시하지 않는다 — 학습 내용이 들어 있어도 공개면에 오르지 않는다.';

function section(heading, body) {
  return `<section class="snap-item"><h2 class="snap-head">${heading}</h2>${body}</section>`;
}

// ---- 원본 HTML 문서를 그대로 얼리는 스냅샷 ---------------------------------
// 랜딩·admin은 마크업 자체가 화면이다. 렌더러를 통과시키는 대신 문서를 손대지 않고
// (1) 외부 CSS·스크립트 참조를 인라인 스타일로 바꾸고, (2) 스크립트가 하는 일 중 화면
// 상태에 해당하는 것만 정적으로 반영한다. 무엇을 반영했는지는 각 파일의 주석 상자에 적는다.
function documentSnapshot(file, { note, mutate }) {
  const source = readSource(file);
  // 외부 호스트의 스타일시트(Pretendard CDN)는 인라인할 수 없다 — 링크째 걷어내고
  // 시스템 폰트 폴백으로 둔다. 조판 검증 대상은 --font-sans의 첫 순위(시스템 서체)다.
  const hrefs = [...source.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gu)]
    .map(([, href]) => href)
    .filter((href) => !/^https?:/iu.test(href))
    .map((href) => href.replace(/[?#].*$/u, '').replace(/^\//u, ''));
  let html = source
    .replace(/\n?\s*<link\b[^>]*rel="stylesheet"[^>]*>/gu, '')
    .replace(/\n?\s*<script\b[^>]*>\s*<\/script>/gu, '');
  html = html.replace('</head>', `${inlineStyles(hrefs)}\n<style>\n${DOCUMENT_SNAPSHOT_CSS}\n</style>\n</head>`);
  html = html.replace('<html lang="ko">', '<html lang="ko" data-snapshot="1">');
  html = mutate(html);
  html = html.replace(/<body([^>]*)>/u, `<body$1>\n  <div class="snap-note">${note}</div>`);
  return normalize(html);
}

// home.js의 paintEmoji()와 같은 매핑으로 슬롯을 채운다 — 스냅샷이 매핑 배선까지 보여준다.
function paintEmoji(html) {
  const map = evaluateBrowserData('assets/js/site-emoji.js', 'SITE_EMOJI') || {};
  return html.replace(/(<[^>]*\sdata-emoji="([^"]+)"[^>]*>)(<\/span>)/gu,
    (whole, open, key, close) => `${open}${map[key] || ''}${close}`);
}

export function buildSnapshots() {
  const notebooks = evaluateBrowserData(NOTEBOOK_SOURCE, 'SMSTUDY_NOTEBOOK').NOTEBOOKS;
  const renderer = evaluateDiagramRenderer(evaluateBrowserData(ICON_SOURCE, 'SM_ICONS').ICONS);

  const diagramItems = [];
  let diagramCount = 0;
  for (const [id, notebook] of Object.entries(notebooks)) {
    for (const diagram of notebook.diagrams || []) {
      const markup = renderer.renderDiagram(diagram);
      diagramCount += 1;
      diagramItems.push(section(
        `${id} — ${diagram.title} (${diagram.kind})`,
        `<div class="sm-diagrams">${markup}</div>`,
      ));
    }
  }

  const sandbox = createAppSandbox();
  const conceptMarkup = sandbox.renderConcept(CONCEPT_SAMPLE_ID);
  const subunitTitle = evaluateBrowserData('smstudy/assets/js/data.js', 'SMSTUDY_DATA')
    .UNITS.flatMap((unit) => unit.subs).find((sub) => sub.id === CONCEPT_SAMPLE_ID).title;

  return {
    [SNAPSHOT_FILES.DIAGRAMS]: page(
      `개념 다이어그램 스냅샷 — ${Object.keys(notebooks).length}단원 ${diagramCount}개`,
      '<strong>무엇인가</strong> — <code>smstudy/assets/js/diagram.js</code>가 실제로 낸 마크업을 그대로 얼린 정적 스냅샷이다.'
      + ` ${Object.keys(notebooks).length}개 중단원의 다이어그램 ${diagramCount}개를 <code>단원ID — title (kind)</code> 소제목과 함께 모두 담았다.`
      + ' CSS 두 개(<code>/assets/css/system.css</code>, <code>/smstudy/assets/css/style.css</code>)를 인라인했으므로 이 파일만 열면 된다.'
      + '\n  <br><strong>왜 있나</strong> — 이 환경에서 스크린샷을 찍을 수 없어(브라우저 pane 뷰포트 0px) DESIGN.md §6의 시각 확인을 대신한다.'
      + '\n  스크린샷의 완전한 대체는 아니지만, 조판·겹침·잘림을 사람이 눈으로 볼 수 있는 산출물이다.'
      + `\n  ${GENERATED_NOTE}`,
      diagramItems,
    ),
    [SNAPSHOT_BY_SCREEN['smstudy/index.html']]: page(
      `개념 화면 스냅샷 — ${CONCEPT_SAMPLE_ID} ${subunitTitle}`,
      `<strong>무엇인가</strong> — <code>smstudy/assets/js/app.js</code>의 <code>renderConcept('${CONCEPT_SAMPLE_ID}')</code>가 <code>#app</code>에 쓰는 마크업 전체다.`
      + '\n  히어로·구조도·기출 분석·비교표·문제 푸는 순서·개념 설명·회상 점검·학습 설계까지 화면 전체가 들어 있다.'
      + '\n  CSS 두 개(<code>/assets/css/system.css</code>, <code>/smstudy/assets/css/style.css</code>)를 인라인했으므로 이 파일만 열면 된다.'
      + '\n  <br><strong>주의</strong> — 정적 사본이라 버튼·아코디언은 동작하지 않는다(회상 점검의 <code>&lt;details&gt;</code>는 열린다).'
      + '\n  기출 이미지는 저장소 상대 경로를 참조하므로 저장소 안에서 열어야 보인다.'
      + `\n  ${GENERATED_NOTE}`,
      [section(
        `${CONCEPT_SAMPLE_ID} — ${subunitTitle} (개념 화면 #app 전체)`,
        `<div class="app-main">${conceptMarkup}</div>`,
      )],
    ),
    [SNAPSHOT_BY_SCREEN['WordMaster/index.html']]: page(
      'WordMaster 화면 스냅샷 — 시험 설정(첫 화면)',
      '<strong>무엇인가</strong> — <code>WordMaster/assets/js/app.js</code>가 로드 직후 <code>#app</code>에 쓰는 첫 화면(시험 설정) 마크업 전체다.'
      + '\n  출제 범위·학습 현황·오답 다루기 그룹과 행 안의 값 컨트롤(<code>.field-input-inline</code>)이 들어 있다.'
      + '\n  <br><strong>주의</strong> — 학습 기록이 비어 있는 새 브라우저 상태다(localStorage 없음). 정적 사본이라 버튼은 동작하지 않는다.'
      + `\n  ${GENERATED_NOTE}`,
      [section('WordMaster — 시험 설정 (#app 전체)', `<div class="app-main">${renderWordMasterHome()}</div>`)],
      WORDMASTER_CSS,
    ),
    [SNAPSHOT_BY_SCREEN['index.html']]: documentSnapshot('index.html', {
      note: '<strong>무엇인가</strong> — 랜딩(<code>/index.html</code>) 문서를 그대로 얼린 스냅샷이다. 링크된 CSS를 인라인하고 스크립트를 걷어냈다.'
        + '\n  <br><strong>정적으로 반영한 상태</strong> — <code>home.js</code>가 로그인 시 하는 일 세 가지: 드로어 안 <code>&lt;template data-study&gt;</code> 주입,'
        + ' <code>body/#account/#drawer</code>에 <code>logged</code> 부여, <code>data-emoji</code> 슬롯을 <code>site-emoji.js</code> 매핑으로 채우기.'
        + ' 즉 <strong>소유자 계정으로 로그인한 화면</strong>이다(사용량 항목은 소유자에게만 주입된다).'
        + '\n  <br><strong>여기서 확인할 것</strong> — 로그인 상태인데도 본문에 학습 요소가 하나도 없어야 한다(plan.md §1-1).'
        + ' 학습·사용량 진입은 드로어에만 있고, 드로어는 닫힌 상태(화면 밖)라 이 사본에서는 보이지 않는다.'
        + '\n  <br><strong>주의</strong> — 등장 애니메이션(<code>.reveal</code>)은 <code>html.js</code>가 없어 처음부터 보인 상태로 조판된다.'
        + `\n  ${GENERATED_NOTE}`,
      mutate: (html) => paintEmoji(html
        // 소유자로 로그인한 상태를 얼린다 — data-owner 그룹(사용량)까지 주입된다.
        .replace(/<template data-(?:study|owner)>([^]*?)<\/template>/gu, '$1')
        .replace('<body>', '<body class="logged">')
        .replace('<aside id="drawer" class="drawer"', '<aside id="drawer" class="drawer logged"')
        .replace('<div id="account" class="account hero-actions">', '<div id="account" class="account hero-actions logged">')),
    }),
    [SNAPSHOT_BY_SCREEN['admin/index.html']]: documentSnapshot('admin/index.html', {
      note: '<strong>무엇인가</strong> — 관리자(<code>/admin/index.html</code>) 문서를 그대로 얼린 스냅샷이다. 링크된 CSS를 인라인하고 스크립트를 걷어냈다.'
        + '\n  <br><strong>정적으로 반영한 상태</strong> — 인증 후 화면을 보기 위해 <code>#login</code>을 감추고 <code>#panel</code>의 <code>hidden</code>을 풀었으며,'
        + ' 사이드바의 <strong>개요</strong> 항목에 <code>aria-current</code>를 얹었다(활성 필). 즉 <strong>개요 뷰</strong> 하나만 보이는 상태다.'
        + ' 사이드바 최상단에는 흰 헤어라인 로고 엠블럼(<code>.sidebar-emblem</code>)이 있고, 그 아래 각 항목은 아이콘 없이 <strong>텍스트 전용 행</strong>이다(DESIGN.md §8/v5 — 이모지 슬롯 폐지).'
        + '\n  <br><strong>여기서 확인할 것</strong> — 뷰가 하나만 렌더된다(나머지 <code>.ad-view</code>는 <code>hidden</code>).'
        + ' 사이드바가 대문자 소제목으로 묶여 있고, 엠블럼이 로고와 같은 사각형 3개 기하를 그대로 쓰는지.'
        + '\n  <br><strong>주의</strong> — 요약 스트립과 표의 행은 Worker API가 채우므로 이 사본에서는 비어 있다. 검증 대상은 셸·사이드바·툴바·표 머리의 조판이다.'
        + `\n  ${GENERATED_NOTE}`,
      mutate: (html) => html
        .replace('<section id="login" class="ad-login">', '<section id="login" class="ad-login hidden">')
        .replace('<section id="panel" class="ad-panel hidden">', '<section id="panel" class="ad-panel">')
        .replace(/(<button class="sidebar-item" type="button" data-view="overview"[^>]*?)>/u, '$1 aria-current="page">'),
    }),
    [SNAPSHOT_BY_SCREEN['usage/index.html']]: documentSnapshot('usage/index.html', {
      note: '<strong>무엇인가</strong> — 사용량(<code>/usage/index.html</code>) 문서를 얼린 스냅샷이다. 링크된 CSS를 인라인하고 스크립트를 걷어냈다.'
        + '\n  <br><strong>정적으로 반영한 상태</strong> — 본문은 <code>usage.js</code>의 <code>buildDashboard()</code>를 <strong>실제로 실행</strong>해 얻은 마크업이다.'
        + ' 입력은 <code>scripts/snapshot.mjs</code>의 고정 표본(<code>USAGE_FIXTURE</code>)이고 기준 시각도 고정이라, 상대 시간이 흐르지 않는다.'
        + '\n  <br><strong>여기서 확인할 것</strong> — 진행 중/완료/전체 조직도 탭의 수치가 각각 2/1/3이고, 진행 중 병렬 task 중 선택된 한 panel만 보이는지,'
        + ' 선택된 세션의 조직도가 사용자 입력 → 총괄 → 구상/작업/검토/완료 <strong>네 단계 전부</strong>로 뻗고 그 아래 실제 actor가 갈라지는지,'
        + ' 지나간 단계는 완료·앞으로 올 단계는 대기로 <strong>상태만</strong> 다른지, 노드·연결선·글자가 어디서도 겹치지 않는지,'
        + ' 오른쪽 Codex · Claude 한도 rail, 게이지의 세 색 구간, 모르는 버킷 키(<code>monthly</code>)가 모두 실제 renderer 산출물에 있는지.'
        + '\n  <br><strong>주의</strong> — 미로그인 접근은 <code>usage.js</code>가 랜딩으로 되돌린다. 이 사본은 로그인한 방문자가 보는 화면이다.'
        + ' 조직도는 실제 화면에서 <strong>휠 확대 · 끌어 이동</strong>하는 캔버스이고, 열리는 순간 트리 전체가 들어오도록 배율이 맞춰진다.'
        + ' 이 정적 사본은 스크립트가 없어 그 맞춤이 돌지 않으므로, 스냅샷 전용 규칙으로 캔버스 높이를 풀고 가로 스크롤을 허용했다 —'
        + ' 조직도 안을 옆으로 밀어 보면 실제 화면에서 끌어 이동했을 때와 같은 것이 보인다.'
        + `\n  ${GENERATED_NOTE}`,
      mutate: (html) => html
        // 확대·이동은 JS가 하는 일이다. 정적 사본에서 뷰포트를 그대로 두면 트리의
        // 왼쪽 위 모서리만 보여 시각 확인(DESIGN.md §10)에 쓸 수 없다.
        .replace('</head>', '<style>\n/* ---- 스냅샷 전용 (원본 CSS 아님) ---- */\n.h-org-viewport { height: auto; overflow: auto; }\n</style>\n</head>')
        .replace(
          '<div id="usageBody" class="us-body"></div>',
          `<div id="usageBody" class="us-body">${renderUsageDashboard(USAGE_FIXTURE, USAGE_NOW)}</div>`,
        ),
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts/snapshot.mjs')) {
  for (const [file, html] of Object.entries(buildSnapshots())) {
    writeFileSync(path.join(ROOT, file), html, 'utf8');
    console.log(`wrote ${file} (${html.length} bytes)`);
  }
}
