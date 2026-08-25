(() => {
  'use strict';

  // 개념 다이어그램 렌더러 (plan.md §4.3, kice-analysis.md 부록 D).
  //
  // 계약
  // - kind 하나당 layout* 함수 하나. 게이트(scripts/validate.mjs)가 이 파일의 함수 이름에서
  //   허용 kind 집합을 정규식으로 자동 도출하므로, 이름 규칙(layout + PascalCase kind)을 지킨다.
  // - SVG 속성에 색 리터럴을 쓰지 않는다. 색은 style.css의 클래스와 currentColor만 정한다.
  // - 좌표는 라벨 길이 상한(label 7자, items 14자, center 6자 — 부록 D 실측)을 전제로 계산한다.
  //   글자 폭은 textWidth()로 근사하고, 상자 폭은 항상 그 근사값보다 넉넉하게 잡는다.
  // - 좁은 화면 전환은 hidden 속성이 아니라 CSS 미디어쿼리가 한다(.sm-diagram-list).

  const ICON_SET = (window.SM_ICONS && window.SM_ICONS.ICONS) || {};
  const esc = (window.HvsStudyUtils && window.HvsStudyUtils.escapeHtml)
    || ((value) => String(value).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  const CANVAS_WIDTH = 760;
  // 순서가 의미를 갖는 형식은 폴백 목록도 번호가 붙은 <ol>로 낸다.
  const ORDERED_KINDS = new Set(['flow', 'timeline', 'pyramid']);

  function round(value, digits = 2) {
    return Number(value.toFixed(digits));
  }

  // 한글은 전각, 라틴/숫자는 반각으로 근사한다. 정확한 측정이 아니라 상한 계산용이다.
  function textWidth(value, fontSize) {
    let units = 0;
    for (const char of String(value)) {
      if (char === ' ') units += 0.32;
      else if (/[ᄀ-ᇿ㄰-㆏가-힯　-〿＀-￯]/u.test(char)) units += 1;
      else units += 0.56;
    }
    return units * fontSize;
  }

  function svgText(x, y, value, fontSize, className, anchor) {
    const anchorAttribute = anchor ? ` text-anchor="${anchor}"` : '';
    return `<text x="${round(x)}" y="${round(y)}" font-size="${fontSize}" class="${className}"${anchorAttribute}>${esc(value)}</text>`;
  }

  // 아이콘은 24x24 좌표계이므로 원하는 크기로 축소해 (x, y) 좌상단에 배치한다.
  function svgIcon(key, x, y, size) {
    const body = ICON_SET[key];
    if (!body) return '';
    return `<g class="sm-d-icon" transform="translate(${round(x)} ${round(y)}) scale(${round(size / 24, 4)})">${body}</g>`;
  }

  function canvas(height, body) {
    return `<div class="sm-diagram-canvas">`
      + `<svg class="sm-d-svg" viewBox="0 0 ${CANVAS_WIDTH} ${round(height)}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${body}</svg>`
      + `</div>`;
  }

  // ---- kind별 레이아웃 -------------------------------------------------------

  // 판정 단계를 위에서 아래로 쌓는다. 왼쪽은 판정 기준, 오른쪽은 그 결과 칩이다.
  function layoutFlow(diagram) {
    const nodes = diagram.nodes;
    const boxHeight = 92;
    const gap = 30;
    const top = 6;
    const height = top + nodes.length * boxHeight + (nodes.length - 1) * gap + 8;
    const parts = [];

    nodes.forEach((node, index) => {
      const y = top + index * (boxHeight + gap);
      const middle = y + boxHeight / 2;
      parts.push(`<rect x="6" y="${y}" width="748" height="${boxHeight}" rx="18" class="sm-d-box"/>`);
      parts.push(`<circle cx="42" cy="${middle}" r="17" class="sm-d-badge"/>`);
      parts.push(svgText(42, middle + 5, String(index + 1), 14, 'sm-d-num', 'middle'));
      parts.push(svgIcon(node.icon, 76, middle - 11, 22));
      parts.push(svgText(108, middle + 6, node.label, 16, 'sm-d-label'));

      const items = node.items || [];
      const chipHeight = 28;
      const chipTop = items.length > 1 ? y + 14 : y + (boxHeight - chipHeight) / 2;
      items.forEach((item, itemIndex) => {
        const chipY = chipTop + itemIndex * (chipHeight + 4);
        const chipWidth = Math.min(textWidth(item, 12.5) + 28, 500);
        parts.push(`<rect x="248" y="${round(chipY)}" width="${round(chipWidth)}" height="${chipHeight}" rx="14" class="sm-d-chip"/>`);
        parts.push(svgText(262, chipY + 19, item, 12.5, 'sm-d-item'));
      });

      if (index < nodes.length - 1) {
        const from = y + boxHeight + 5;
        const to = y + boxHeight + gap - 6;
        parts.push(`<path d="M42 ${round(from)}V${round(to)}" class="sm-d-connector"/>`);
        parts.push(`<path d="M35 ${round(to - 7)}l7 7 7-7" class="sm-d-arrow"/>`);
      }
    });

    return canvas(height, parts.join(''));
  }

  // 대립하는 두 극을 저울 양쪽에 올린다. 축은 하나이고 양쪽은 그 축의 반대편이다.
  function layoutScale(diagram) {
    const [left, right] = diagram.nodes;
    const maxItems = Math.max(...diagram.nodes.map((node) => (node.items || []).length), 1);
    const panTop = 132;
    const panHeight = 58 + maxItems * 24;
    const height = panTop + panHeight + 16;
    const parts = [
      `<path d="M60 96H700" class="sm-d-beam"/>`,
      `<path d="M380 92L412 142H348Z" class="sm-d-fulcrum"/>`,
      `<path d="M187 96V${panTop}" class="sm-d-connector"/>`,
      `<path d="M573 96V${panTop}" class="sm-d-connector"/>`,
      svgText(380, 178, 'vs', 13, 'sm-d-mute', 'middle'),
    ];

    [[left, 30], [right, 415]].forEach(([node, x]) => {
      parts.push(`<rect x="${x}" y="${panTop}" width="315" height="${panHeight}" rx="18" class="sm-d-box"/>`);
      parts.push(svgIcon(node.icon, x + 22, panTop + 20, 22));
      parts.push(svgText(x + 54, panTop + 38, node.label, 16, 'sm-d-label'));
      (node.items || []).forEach((item, index) => {
        const y = panTop + 66 + index * 24;
        parts.push(`<circle cx="${x + 28}" cy="${round(y - 4)}" r="3" class="sm-d-dot"/>`);
        parts.push(svgText(x + 40, y, item, 12, 'sm-d-item'));
      });
    });

    return canvas(height, parts.join(''));
  }

  // 두 기준이 교차해 만드는 네 칸. nodes 순서는 좌상·우상·좌하·우하다(부록 D).
  function layoutMatrix2x2(diagram) {
    const cellWidth = 364;
    const cellHeight = 190;
    const origins = [[8, 8], [388, 8], [8, 214], [388, 214]];
    const height = 412;
    const parts = [
      `<path d="M380 8V404" class="sm-d-guide"/>`,
      `<path d="M8 206H752" class="sm-d-guide"/>`,
    ];

    diagram.nodes.slice(0, 4).forEach((node, index) => {
      const [x, y] = origins[index];
      parts.push(`<rect x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" rx="16" class="sm-d-box"/>`);
      parts.push(svgIcon(node.icon, x + 20, y + 22, 20));
      parts.push(svgText(x + 50, y + 38, node.label, 15, 'sm-d-label'));
      parts.push(svgText(x + cellWidth - 18, y + 32, String(index + 1), 12, 'sm-d-mute', 'end'));
      (node.items || []).forEach((item, itemIndex) => {
        const itemY = y + 80 + itemIndex * 26;
        parts.push(`<circle cx="${x + 26}" cy="${round(itemY - 4)}" r="3" class="sm-d-dot"/>`);
        parts.push(svgText(x + 38, itemY, item, 12, 'sm-d-item'));
      });
    });

    return canvas(height, parts.join(''));
  }

  // 원이 겹치는 그림이 곧 개념이다. 원 안에는 이름만 두고 세부는 아래 범례로 뺀다
  // — 3원 벤의 배타 영역은 14자 항목을 넣을 만큼 넓지 않다.
  function layoutVenn(diagram) {
    const nodes = diagram.nodes.slice(0, 3);
    const three = nodes.length >= 3;
    const circles = three
      ? [{ cx: 300, cy: 190, r: 140 }, { cx: 460, cy: 190, r: 140 }, { cx: 380, cy: 330, r: 140 }]
      : [{ cx: 295, cy: 200, r: 145 }, { cx: 465, cy: 200, r: 145 }];
    const labelSpots = three
      ? [{ x: 225, y: 150 }, { x: 535, y: 150 }, { x: 380, y: 415 }]
      : [{ x: 215, y: 196 }, { x: 545, y: 196 }];
    const legendTop = three ? 500 : 380;
    const columnStart = three ? 20 : 30;
    const columnGap = three ? 245 : 370;
    const maxItems = Math.max(...nodes.map((node) => (node.items || []).length), 1);
    const height = legendTop + 30 + maxItems * 22 + 18;

    const parts = [];
    circles.forEach((circle, index) => {
      parts.push(`<circle cx="${circle.cx}" cy="${circle.cy}" r="${circle.r}" class="sm-d-venn sm-d-venn-${index + 1}"/>`);
    });
    parts.push(svgText(380, three ? 262 : 206, '겹침', 12, 'sm-d-mute', 'middle'));
    nodes.forEach((node, index) => {
      parts.push(svgText(labelSpots[index].x, labelSpots[index].y, node.label, 15, 'sm-d-label', 'middle'));
    });

    nodes.forEach((node, index) => {
      const x = columnStart + index * columnGap;
      parts.push(`<circle cx="${x + 8}" cy="${legendTop + 8}" r="7" class="sm-d-venn sm-d-venn-${index + 1}"/>`);
      parts.push(svgText(x + 24, legendTop + 13, node.label, 13.5, 'sm-d-label'));
      (node.items || []).forEach((item, itemIndex) => {
        parts.push(svgText(x + 24, legendTop + 36 + itemIndex * 22, item, 11.5, 'sm-d-item'));
      });
    });

    return canvas(height, parts.join(''));
  }

  // 시간 축 위의 단계. 4단계 이상이면 위·아래로 번갈아 놓아 라벨이 서로 닿지 않게 한다.
  function layoutTimeline(diagram) {
    const nodes = diagram.nodes;
    const count = nodes.length;
    const span = 620;
    const stepX = count > 1 ? span / (count - 1) : 0;
    const alternate = count >= 4;
    const maxItems = Math.max(...nodes.map((node) => (node.items || []).length), 1);
    const axisY = alternate ? 158 : 70;
    const height = alternate ? 300 : 118 + maxItems * 22 + 24;

    const parts = [
      `<path d="M34 ${axisY}H716" class="sm-d-axis"/>`,
      `<path d="M710 ${axisY - 6}l8 6-8 6" class="sm-d-arrow"/>`,
    ];

    nodes.forEach((node, index) => {
      const x = 70 + index * stepX;
      const above = alternate && index % 2 === 0;
      parts.push(`<circle cx="${round(x)}" cy="${axisY}" r="15" class="sm-d-badge"/>`);
      parts.push(svgText(x, axisY + 5, String(index + 1), 13, 'sm-d-num', 'middle'));

      if (alternate) {
        const labelY = above ? 92 : axisY + 44;
        parts.push(`<path d="M${round(x)} ${above ? 100 : axisY + 16}V${above ? axisY - 16 : 190}" class="sm-d-connector"/>`);
        parts.push(svgText(x, labelY, node.label, 14, 'sm-d-label', 'middle'));
        (node.items || []).forEach((item, itemIndex) => {
          parts.push(svgText(x, labelY + 22 + itemIndex * 20, item, 11.5, 'sm-d-item', 'middle'));
        });
      } else {
        parts.push(`<path d="M${round(x)} ${axisY + 16}V96" class="sm-d-connector"/>`);
        parts.push(svgText(x, 118, node.label, 15, 'sm-d-label', 'middle'));
        (node.items || []).forEach((item, itemIndex) => {
          parts.push(svgText(x, 144 + itemIndex * 22, item, 12, 'sm-d-item', 'middle'));
        });
      }
    });

    return canvas(height, parts.join(''));
  }

  // 위가 좁고 아래가 넓은 층. 위 층이 아래 층에 포함된다는 뜻을 도형이 직접 말한다.
  function layoutPyramid(diagram) {
    const nodes = diagram.nodes;
    const layerHeight = 96;
    const top = 20;
    const centerX = 380;
    const halfTop = 92;
    const halfBottom = 320;
    const total = nodes.length * layerHeight;
    const halfAt = (y) => halfTop + (halfBottom - halfTop) * ((y - top) / total);
    const height = top + total + 22;
    const parts = [];

    nodes.forEach((node, index) => {
      const y0 = top + index * layerHeight;
      const y1 = y0 + layerHeight;
      const h0 = halfAt(y0);
      const h1 = halfAt(y1);
      const points = [
        `${round(centerX - h0)},${round(y0)}`,
        `${round(centerX + h0)},${round(y0)}`,
        `${round(centerX + h1)},${round(y1)}`,
        `${round(centerX - h1)},${round(y1)}`,
      ].join(' ');
      parts.push(`<polygon points="${points}" class="sm-d-box sm-d-layer-${index + 1}"/>`);

      const labelWidth = textWidth(node.label, 15);
      parts.push(svgIcon(node.icon, centerX - labelWidth / 2 - 26, y0 + 22, 18));
      parts.push(svgText(centerX + 11, y0 + 36, node.label, 15, 'sm-d-label', 'middle'));
      (node.items || []).forEach((item, itemIndex) => {
        parts.push(svgText(centerX, y0 + 60 + itemIndex * 20, item, 11.5, 'sm-d-item', 'middle'));
      });
      parts.push(svgText(centerX - halfBottom - 14, y0 + 40, String(index + 1), 12, 'sm-d-mute', 'end'));
    });

    return canvas(height, parts.join(''));
  }

  // 중심 개념 하나에서 대등한 갈래가 뻗는 지도. 5갈래를 72도 간격으로 고정 배치한다.
  function layoutRadial(diagram) {
    const nodes = diagram.nodes.slice(0, 5);
    const centerX = 380;
    const centerY = 280;
    const centerR = 66;
    const radius = 200;
    const cardWidth = 204;
    const cardHeight = 80;
    const height = 522;
    const lines = [];
    const cards = [];

    nodes.forEach((node, index) => {
      const angle = (-90 + (360 / nodes.length) * index) * (Math.PI / 180);
      const px = centerX + radius * Math.cos(angle);
      const py = centerY + radius * Math.sin(angle);
      const x = px - cardWidth / 2;
      const y = py - cardHeight / 2;
      lines.push(`<path d="M${round(centerX + centerR * Math.cos(angle))} ${round(centerY + centerR * Math.sin(angle))}L${round(px)} ${round(py)}" class="sm-d-connector"/>`);
      cards.push(`<rect x="${round(x)}" y="${round(y)}" width="${cardWidth}" height="${cardHeight}" rx="16" class="sm-d-box"/>`);
      cards.push(svgIcon(node.icon, x + 20, y + 16, 20));
      cards.push(svgText(x + 50, y + 32, node.label, 15, 'sm-d-label'));
      (node.items || []).forEach((item, itemIndex) => {
        cards.push(svgText(x + 20, y + 56 + itemIndex * 18, item, 11, 'sm-d-item'));
      });
    });

    // 중심 라벨은 최대 14자까지 올 수 있으므로 원 지름(132)에 맞춰 두 줄로 접는다.
    const centerLines = wrapCenter(diagram.center || diagram.title, 7);
    const centerParts = [`<circle cx="${centerX}" cy="${centerY}" r="${centerR}" class="sm-d-center-circle"/>`];
    centerLines.forEach((line, index) => {
      const baseline = centerY + 6 - (centerLines.length - 1) * 10 + index * 20;
      centerParts.push(svgText(centerX, baseline, line, 15, 'sm-d-center', 'middle'));
    });

    return canvas(height, lines.join('') + centerParts.join('') + cards.join(''));
  }

  function wrapCenter(value, perLine) {
    const words = String(value).split(' ').filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
      if (!current) current = word;
      else if (current.length + 1 + word.length <= perLine) current += ` ${word}`;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    if (lines.length === 0) return [String(value)];
    if (lines.length <= 2) return lines;
    return [lines[0], lines.slice(1).join(' ')];
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

  function narrative(diagram) {
    const labels = labelsOf(diagram);
    const first = labels[0];
    const last = labels[labels.length - 1];
    switch (diagram.kind) {
      case 'flow':
        return `${first}부터 ${last}까지 ${labels.length}단계를 위에서 아래로 차례로 판정한다.`;
      case 'scale':
        return `${labels.join('과 ')}이 하나의 축에서 정반대에 놓인다.`;
      case 'matrix2x2':
        return `두 기준이 교차해 ${labels.join(', ')}의 네 칸이 만들어진다.`;
      case 'venn':
        return `${labels.join('과 ')}이 서로 겹칠 수 있다는 점을 원의 교집합으로 보인다.`;
      case 'timeline':
        return `${first}에서 ${last}까지 ${labels.length}단계가 시간 순서로 이어진다.`;
      case 'pyramid':
        return `${first}이 ${last}에 포함되는 ${labels.length}층 위계다.`;
      case 'radial':
        return `${diagram.center || diagram.title}을 중심으로 ${labels.length}갈래가 대등하게 뻗는다.`;
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
    radial: '방사형 지도',
  };

  function renderIcon(key, className = 'sm-icon') {
    const body = ICON_SET[key];
    if (!body) return '';
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  function fallbackList(diagram) {
    const tag = ORDERED_KINDS.has(diagram.kind) ? 'ol' : 'ul';
    const center = diagram.center
      ? `<li class="sm-diagram-node is-center"><p class="sm-diagram-node-head">${renderIcon('target', 'sm-icon')}<strong>${esc(diagram.center)}</strong></p></li>`
      : '';
    const items = diagram.nodes.map((node) => {
      const detail = (node.items || []).length
        ? `<ul class="sm-diagram-node-items">${node.items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
        : '';
      return `<li class="sm-diagram-node"><p class="sm-diagram-node-head">${renderIcon(node.icon, 'sm-icon')}<strong>${esc(node.label)}</strong></p>${detail}</li>`;
    }).join('');
    return `<${tag} class="sm-diagram-list">${diagram.center ? center : ''}${items}</${tag}>`;
  }

  function renderDiagram(diagram) {
    const layout = LAYOUTS[diagram.kind];
    if (!layout || !Array.isArray(diagram.nodes) || diagram.nodes.length === 0) return '';
    return `
      <figure class="sm-diagram sm-diagram--${esc(diagram.kind)}">
        <figcaption class="sm-diagram-head">
          <strong>${esc(diagram.title)}</strong>
          <span class="badge">${esc(KIND_LABELS[diagram.kind] || diagram.kind)}</span>
        </figcaption>
        ${layout(diagram)}
        ${fallbackList(diagram)}
        <figcaption class="sm-diagram-note">${esc(narrative(diagram))} ${esc(reason(diagram.why))}</figcaption>
      </figure>`;
  }

  window.SMSTUDY_DIAGRAM = Object.freeze({
    ICONS: ICON_SET,
    KINDS: Object.freeze(Object.keys(LAYOUTS)),
    renderIcon,
    renderDiagram,
  });
})();
