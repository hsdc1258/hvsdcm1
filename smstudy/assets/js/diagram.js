(() => {
  'use strict';

  // 개념 다이어그램 렌더러 (plan.md §4.3, kice-analysis.md 부록 D).
  //
  // 조판 원칙 — 사이클3 후속 재설계
  // - **레이아웃은 브라우저가 한다.** 좌표를 손으로 계산해 SVG <text>를 찍으면 글자 길이가
  //   조금만 달라져도 도형·선·글자가 겹치고, 균등 배치된 상자와 화살표는 SmartArt로 보인다.
  //   그래서 관계가 곧 기하학인 두 형식(venn·scale)만 SVG를 남기고, 나머지 다섯 형식은
  //   HTML+CSS 조판(그리드·플렉스·일반 흐름)으로 낸다. 줄바꿈을 브라우저가 하므로
  //   겹침이 원리적으로 발생하지 않는다.
  // - 남긴 SVG에도 **문장을 넣지 않는다.** venn은 원 안에 한 글자짜리 번호만 두고,
  //   scale은 빔·받침·접시만 그린다. 라벨과 항목은 SVG 밖 CSS 조판으로 뺀다.
  // - 레퍼런스는 docs/DESIGN.md §1의 **문제집·참고서 조판**이다. 상자와 화살표 범벅이 아니라
  //   표, 들여쓰기 위계, 얇은 구분선, 여백으로 관계를 말한다.
  // - 색 리터럴을 쓰지 않는다. 색은 style.css의 클래스와 currentColor만 정한다.
  // - 글자 수 상한은 더 이상 좌표가 아니라 **가독성**이 정한다 (아래 게이트 주석 참고).
  //   scripts/validate.mjs의 DIAGRAM_TEXT_LIMITS와 같은 값이어야 한다:
  //     label 14자 / items 28자 / center 14자 / title 20자 / why 40자
  // - 좁은 화면 분기는 venn·scale의 장식 SVG를 숨기는 컨테이너 쿼리 하나뿐이다.
  //   나머지 형식은 CSS 조판이 이미 반응형이라 폴백 목록이 필요 없다.

  const ICON_SET = (window.SM_ICONS && window.SM_ICONS.ICONS) || {};
  const esc = (window.HvsStudyUtils && window.HvsStudyUtils.escapeHtml)
    || ((value) => String(value).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  // 순서가 의미를 갖는 형식은 <ol>로 낸다. matrix2x2·venn의 번호는 순서가 아니라
  // 도형과 라벨을 짝짓는 열쇠지만, 번호를 화면에 내므로 같은 <ol>을 쓴다.
  const NUMBERED_KINDS = new Set(['flow', 'timeline', 'pyramid', 'matrix2x2', 'venn']);

  function renderIcon(key, className = 'sm-icon') {
    const body = ICON_SET[key];
    if (!body) return '';
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  // 노드 하나의 제목 줄. 번호는 동그라미 뱃지가 아니라 그냥 숫자다 (DESIGN.md §4 장식 상한).
  function nodeHead(node, index, numbered) {
    const number = numbered ? `<span class="sm-d-n">${index + 1}</span>` : '';
    return `<p class="sm-d-head">${number}${renderIcon(node.icon)}<strong>${esc(node.label)}</strong></p>`;
  }

  function nodeItems(node) {
    const list = node.items || [];
    if (!list.length) return '';
    return `<ul class="sm-d-items">${list.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
  }

  // 모든 형식이 공유하는 노드 컨테이너. data-node는 게이트가 "출력 노드 수 = 데이터 노드 수"를
  // 세는 표지이자 CSS 선택자다.
  function nodeCell(node, index, numbered, className = '') {
    return `<li class="sm-d-node${className ? ` ${className}` : ''}" data-node>`
      + `${nodeHead(node, index, numbered)}${nodeItems(node)}</li>`;
  }

  function nodeList(kind, nodes, listClass, cellClass) {
    const numbered = NUMBERED_KINDS.has(kind);
    const tag = numbered ? 'ol' : 'ul';
    const cells = nodes.map((node, index) => nodeCell(node, index, numbered, cellClass)).join('');
    return `<${tag} class="${listClass}">${cells}</${tag}>`;
  }

  function art(viewBox, body) {
    return `<div class="sm-d-art">`
      + `<svg class="sm-d-svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${body}</svg>`
      + `</div>`;
  }

  // ---- kind별 레이아웃 -------------------------------------------------------

  // 판별 순서를 세로 단계로 조판한다. 왼쪽이 판정 기준, 오른쪽이 그 결과다.
  // 화살표를 그리지 않고 얇은 세로 규칙선과 들여쓰기로 흐름을 보인다.
  function layoutFlow(diagram) {
    return nodeList('flow', diagram.nodes, 'sm-d-flow');
  }

  // 대립하는 두 극. 저울의 기울기가 곧 의미라서 SVG를 남기되, 빔·받침·접시만 그린다.
  // 접시 위 항목은 SVG 밖 두 열로 빼서 접시 아래에 나란히 놓는다.
  // 두 접시의 중심을 viewBox의 25%·75%에 두어, 폭이 얼마든 아래 두 열의 중심과 맞는다.
  function layoutScale(diagram) {
    const beam = [
      `<path d="M160 44H800" class="sm-d-beam"/>`,
      `<path d="M480 44L532 112H428Z" class="sm-d-fulcrum"/>`,
      `<path d="M392 116H568" class="sm-d-beam"/>`,
      `<path d="M240 44V80" class="sm-d-rule"/>`,
      `<path d="M720 44V80" class="sm-d-rule"/>`,
      `<path d="M160 80Q240 124 320 80" class="sm-d-pan"/>`,
      `<path d="M640 80Q720 124 800 80" class="sm-d-pan"/>`,
    ].join('');
    return art('0 0 960 130', beam)
      + nodeList('scale', diagram.nodes.slice(0, 2), 'sm-d-pans');
  }

  // 두 기준이 교차해 만드는 네 칸. nodes 순서는 좌상·우상·좌하·우하다(부록 D).
  // 축 이름은 데이터에 없으므로 라벨을 붙이지 않는다. 교차는 칸 사이 실선이 말한다.
  function layoutMatrix2x2(diagram) {
    return nodeList('matrix2x2', diagram.nodes.slice(0, 4), 'sm-d-quads');
  }

  // 원의 교집합이 곧 의미이므로 원은 SVG로 그린다. 원 안에는 한 글자짜리 번호만 두고
  // (계약 상한 14자짜리 라벨은 3원 벤의 배타 영역에 들어가지 않는다) 이름과 세부는 아래 범례로 뺀다.
  // 번호 자리는 각 원의 배타 영역 중심이라 어떤 데이터에서도 선·다른 원과 겹치지 않는다.
  function layoutVenn(diagram) {
    const nodes = diagram.nodes.slice(0, 3);
    const three = nodes.length >= 3;
    const circles = three
      ? [[185, 135], [295, 135], [240, 225]]
      : [[180, 150], [300, 150]];
    const radius = three ? 95 : 105;
    const marks = three
      ? [[135, 108], [345, 108], [240, 282]]
      : [[135, 150], [345, 150]];
    const shapes = circles
      .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="${radius}" class="sm-d-venn"/>`)
      .join('');
    const digits = nodes
      .map((node, index) => `<text x="${marks[index][0]}" y="${marks[index][1]}" class="sm-d-mark" text-anchor="middle" dominant-baseline="central">${index + 1}</text>`)
      .join('');
    return art(three ? '0 0 480 340' : '0 0 480 300', shapes + digits)
      + nodeList('venn', nodes, 'sm-d-legend');
  }

  // 시간 축 위의 단계. 위아래 교대 배치(겹침의 주원인)를 없애고 그리드 열로 편다.
  // grid-auto-flow가 열을 만들므로 단계 수를 마크업이 알 필요가 없다.
  function layoutTimeline(diagram) {
    return nodeList('timeline', diagram.nodes, 'sm-d-timeline');
  }

  // 위가 좁고 아래가 넓은 층. 폭이 줄어드는 가로 막대를 CSS가 그리고, 글자는 일반 흐름으로
  // 막대 안에 들어간다. 사다리꼴 안에 글자를 맞춰 넣는 계산이 사라진다.
  function layoutPyramid(diagram) {
    return nodeList('pyramid', diagram.nodes, 'sm-d-pyramid');
  }

  // 중심 개념 하나에서 대등한 갈래가 뻗는 지도. 바퀴살 자체는 정보를 주지 않으므로
  // 중심을 제목 줄로 올리고 갈래는 카드 그리드로 편다.
  function layoutRadial(diagram) {
    const center = diagram.center || diagram.title;
    return `<p class="sm-d-center">${renderIcon('target')}<strong>${esc(center)}</strong></p>`
      + nodeList('radial', diagram.nodes, 'sm-d-cards');
  }

  const LAYOUTS = {
    flow: layoutFlow,
    scale: layoutScale,
    matrix2x2: layoutMatrix2x2,
    venn: layoutVenn,
    timeline: layoutTimeline,
    pyramid: layoutPyramid,
    radial: layoutRadial,
  };

  // ---- 설명문 ---------------------------------------------------------------

  function labelsOf(diagram) {
    return diagram.nodes.map((node) => node.label);
  }

  // 조사 선택 — 데이터의 라벨을 문장에 넣을 때 받침 유무로 이/가, 과/와, 을/를을 고른다.
  // 이 처리가 없으면 '반문화이', '공공 부조과' 같은 문장이 캡션에 그대로 나간다.
  function hasFinalConsonant(word) {
    const text = String(word).trim();
    const code = text.charCodeAt(text.length - 1);
    if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return false;
    return (code - 0xac00) % 28 !== 0;
  }

  function withParticle(word, afterConsonant, afterVowel) {
    return `${word}${hasFinalConsonant(word) ? afterConsonant : afterVowel}`;
  }

  // 둘이면 '과/와'로, 셋 이상이면 쉼표로 잇는다 ('A과 B과 C'는 한국어 문장이 아니다).
  function joinWith(words) {
    if (words.length <= 1) return words[0] || '';
    if (words.length === 2) return `${withParticle(words[0], '과', '와')} ${words[1]}`;
    return words.join(', ');
  }

  function narrative(diagram) {
    const labels = labelsOf(diagram);
    const first = labels[0];
    const last = labels[labels.length - 1];
    switch (diagram.kind) {
      case 'flow':
        return `${first}부터 ${last}까지 ${labels.length}단계를 위에서 아래로 차례로 판정한다.`;
      case 'scale':
        return `${withParticle(joinWith(labels), '이', '가')} 하나의 축에서 정반대에 놓인다.`;
      case 'matrix2x2':
        return `두 기준이 교차해 ${labels.join(', ')}의 네 칸이 만들어진다.`;
      case 'venn':
        return `${withParticle(joinWith(labels), '이', '가')} 서로 겹칠 수 있다는 점을 원의 교집합으로 보인다.`;
      case 'timeline':
        return `${first}에서 ${last}까지 ${labels.length}단계가 시간 순서로 이어진다.`;
      case 'pyramid':
        return `위의 ${first}에서 아래의 ${last}까지 ${labels.length}층으로 쌓인 구조다.`;
      case 'radial':
        return `${withParticle(diagram.center || diagram.title, '을', '를')} ${labels.length}갈래로 나눠 우열 없이 나란히 놓는다.`;
      default:
        return `${labels.join(', ')}의 관계를 보인다.`;
    }
  }

  // why는 '…때문' 또는 '…하므로/…라서' 두 어형으로 들어온다. 앞의 것만 조사를 붙여
  // 뒤 문장과 이어지게 만든다 (데이터를 고치지 않고 렌더러에서 흡수한다).
  function reason(why) {
    const clause = /때문$/u.test(why) ? `${why}에` : why;
    return `${clause} 이 형식으로 그렸다.`;
  }

  // ---- 공개 API -------------------------------------------------------------

  const KIND_LABELS = {
    flow: '판별 순서도',
    scale: '대립 저울',
    matrix2x2: '2×2 교차표',
    venn: '벤 다이어그램',
    timeline: '단계 타임라인',
    pyramid: '포함 위계',
    radial: '갈래 지도',
  };

  function renderDiagram(diagram) {
    const layout = LAYOUTS[diagram.kind];
    if (!layout || !Array.isArray(diagram.nodes) || diagram.nodes.length === 0) return '';
    // figure 하나에 figcaption은 하나만 올 수 있고 첫째 또는 마지막 자식이어야 한다
    // (HTML 콘텐츠 모델, review 3c M-3). 제목 줄은 일반 div로 내리고, 요구된 서술형 설명을
    // 유일한 figcaption으로 남겨 figure의 접근 가능한 이름이 그 문장이 되게 한다.
    return `
      <figure class="sm-diagram sm-diagram--${esc(diagram.kind)}">
        <div class="sm-diagram-head">
          <strong>${esc(diagram.title)}</strong>
          <span class="badge">${esc(KIND_LABELS[diagram.kind] || diagram.kind)}</span>
        </div>
        ${layout(diagram)}
        <figcaption class="sm-diagram-note">${esc(diagram.title)} — ${esc(narrative(diagram))} ${esc(reason(diagram.why))}</figcaption>
      </figure>`;
  }

  window.SMSTUDY_DIAGRAM = Object.freeze({
    ICONS: ICON_SET,
    KINDS: Object.freeze(Object.keys(LAYOUTS)),
    renderIcon,
    renderDiagram,
  });
})();
