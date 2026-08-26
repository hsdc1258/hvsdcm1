// docs/snapshots/*.html 생성기.
//
// 왜 생성기인가 (review 라운드 2, R2-M-1)
//   손으로 얼린 스냅샷은 낡아도 게이트가 모른다. 실제로 concept-sample.html의 키워드를
//   '낡은공유성'으로 바꾼 변형이 13204 checks로 통과했다. 그래서 스냅샷을 **소스에서
//   재생성 가능한 산출물**로 바꾼다. scripts/validate.mjs가 같은 함수로 다시 만들어
//   커밋된 파일과 바이트 단위로 대조하므로, 데이터·렌더러·CSS 중 무엇이 바뀌든
//   스냅샷을 다시 만들기 전에는 게이트가 실패한다.
//
// 사용법:  node scripts/snapshot.mjs   (파일을 덮어쓴다)

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createAppSandbox, evaluateBrowserData, evaluateDiagramRenderer,
  ICON_SOURCE, NOTEBOOK_SOURCE, readSource,
} from './render-sandbox.mjs';

const ROOT = process.cwd();

export const SNAPSHOT_FILES = {
  DIAGRAMS: 'docs/snapshots/diagrams.html',
  CONCEPT: 'docs/snapshots/concept-sample.html',
};

// 개념 화면 스냅샷이 담는 중단원. 바꾸면 파일도 함께 다시 만들어야 한다.
const CONCEPT_SAMPLE_ID = 'III-01';

const INLINED_CSS = ['assets/css/system.css', 'smstudy/assets/css/style.css'];

const SNAPSHOT_CSS = `/* ---- 스냅샷 전용 (원본 CSS 아님) ---- */
body { background: var(--bg); color: var(--text); margin: 0; padding: 32px 24px 64px; }
.snap-wrap { max-width: 900px; margin: 0 auto; container-type: inline-size; }
.snap-note { border: 1px solid var(--line); border-radius: var(--radius-m, 12px); padding: 16px 18px; margin-bottom: 32px; color: var(--text-2); font-size: 14px; line-height: 1.7; }
.snap-note code { color: var(--text); }
.snap-item { padding: 28px 0; border-top: 1px solid var(--line); }
.snap-item:first-of-type { border-top: 0; }
.snap-head { font-size: 15px; font-weight: 600; color: var(--text-2); margin: 0 0 14px; letter-spacing: normal; }`;

// 생성물이므로 줄 끝 공백을 남기지 않는다 (git diff --check).
function normalize(html) {
  return `${html.split('\n').map((line) => line.replace(/[ \t]+$/u, '')).join('\n').replace(/\n+$/u, '')}\n`;
}

function page(title, note, items) {
  const styles = INLINED_CSS
    .map((file) => `<style>/* ${file} (inlined) */\n${readSource(file).trimEnd()}\n</style>`)
    .join('\n');
  return normalize(`<!doctype html>
<html lang="ko" data-snapshot="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${styles}
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
  + ' <code>npm run validate</code>가 같은 생성기를 다시 돌려 이 파일과 대조하므로, 데이터·렌더러·CSS를 바꾸면 반드시 다시 만들어야 한다.';

function section(heading, body) {
  return `<section class="snap-item"><h2 class="snap-head">${heading}</h2>${body}</section>`;
}

// 형식 이름(‘판별 순서도’ 등)은 렌더러가 낸 badge에서 뽑는다 — 게이트가 목록을 따로 갖지 않는다.
function kindLabelOf(markup) {
  return /<span class="badge">([^<]*)<\/span>/u.exec(markup)?.[1] || '';
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
        `${id} — ${diagram.title} (${diagram.kind} · ${kindLabelOf(markup)})`,
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
    [SNAPSHOT_FILES.CONCEPT]: page(
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
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts/snapshot.mjs')) {
  for (const [file, html] of Object.entries(buildSnapshots())) {
    writeFileSync(path.join(ROOT, file), html, 'utf8');
    console.log(`wrote ${file} (${html.length} bytes)`);
  }
}
