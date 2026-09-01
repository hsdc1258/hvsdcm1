(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = /^(?:127\.0\.0\.1|localhost)$/u.test(location.hostname) ? location.origin : DEFAULT_API_URL;
  const PAPER_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const PAPER_REFRESH_MS = 30_000;
  const LIVE_REFRESH_MS = 60_000;
  const PAPER_REQUEST_TIMEOUT_MS = 4_000;
  const PAPER_STALE_MS = 2 * 60_000;
  const state = {
    ownerVerified: false, experiment: null, paperLoading: false, paperRequestId: 0, paperController: null,
    stopSubmitting: false, stopRequested: false, activeTab: 'paper', liveReport: null,
    liveLoading: false, liveRequestId: 0, liveController: null, refreshTimer: null,
  };

  const elements = {
    experimentArms: document.getElementById('experimentArms'),
    experimentAverageReturn: document.getElementById('experimentAverageReturn'),
    experimentDeadline: document.getElementById('experimentDeadline'),
    experimentFeed: document.getElementById('experimentFeed'),
    experimentLeaderName: document.getElementById('experimentLeaderName'),
    experimentLeaderPnl: document.getElementById('experimentLeaderPnl'),
    experimentLeaderReturn: document.getElementById('experimentLeaderReturn'),
    experimentLastPacket: document.getElementById('experimentLastPacket'),
    experimentLeaderboard: document.getElementById('experimentLeaderboard'),
    experimentOpenPositions: document.getElementById('experimentOpenPositions'),
    experimentStarted: document.getElementById('experimentStarted'),
    experimentStatus: document.getElementById('experimentStatus'),
    experimentTotalTrades: document.getElementById('experimentTotalTrades'),
    labShell: document.getElementById('labShell'),
    liveTab: document.getElementById('liveTab'),
    liveTabPanel: document.getElementById('liveTabPanel'),
    liveTradingStatus: document.getElementById('liveTradingStatus'),
    liveTradingError: document.getElementById('liveTradingError'),
    liveTradingErrorText: document.getElementById('liveTradingErrorText'),
    liveTradingEmpty: document.getElementById('liveTradingEmpty'),
    liveTradingReport: document.getElementById('liveTradingReport'),
    liveTradingSummary: document.getElementById('liveTradingSummary'),
    liveModelGrid: document.getElementById('liveModelGrid'),
    liveWarnings: document.getElementById('liveWarnings'),
    ownerGate: document.getElementById('ownerGate'),
    ownerGateMessage: document.getElementById('ownerGateMessage'),
    ownerGateTitle: document.getElementById('ownerGateTitle'),
    ownerLoginLink: document.getElementById('ownerLoginLink'),
    paperEmpty: document.getElementById('paperEmpty'),
    paperError: document.getElementById('paperError'),
    paperErrorText: document.getElementById('paperErrorText'),
    paperExperiment: document.getElementById('paperExperiment'),
    paperStatus: document.getElementById('paperStatus'),
    paperTab: document.getElementById('paperTab'),
    paperTabPanel: document.getElementById('paperTabPanel'),
    refreshPaper: document.getElementById('refreshPaper'),
    refreshLiveTrading: document.getElementById('refreshLiveTrading'),
    retryOwnerGate: document.getElementById('retryOwnerGate'),
    stopPaper: document.getElementById('stopPaper'),
  };


  class OwnerAccessError extends Error {
    constructor(status) {
      super('owner access required');
      this.status = status;
    }
  }

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function ownerToken() { return localStorage.getItem('hvsdcm.token') || ''; }


  function formatUsdt(value, signed = false) {
    if (!finite(value)) return '—';
    const prefix = signed && value > 0 ? '+' : '';
    return `${prefix}${new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)} USDT`;
  }

  function formatPercent(value, signed = false) {
    if (!finite(value)) return '—';
    return `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  }

  function formatKoreanTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '아직 없음';
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(value));
  }


  function createText(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }


  function showOwnerGate(status = 0) {
    state.paperRequestId += 1;
    state.paperController?.abort();
    state.paperController = null;
    state.paperLoading = false;
    state.ownerVerified = false;
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    state.experiment = null;
    state.stopSubmitting = false;
    state.stopRequested = false;
    state.liveRequestId += 1;
    state.liveController?.abort();
    state.liveController = null;
    state.liveLoading = false;
    state.liveReport = null;
    elements.paperExperiment.hidden = true;
    elements.paperExperiment.dataset.freshness = 'stale';
    elements.paperExperiment.setAttribute('aria-busy', 'false');
    elements.paperEmpty.hidden = true;
    elements.paperError.hidden = true;
    elements.refreshPaper.disabled = false;
    elements.stopPaper.hidden = true;
    elements.stopPaper.disabled = false;
    elements.stopPaper.textContent = '6개 실험 중단';
    elements.liveTradingReport.hidden = true;
    elements.liveTradingEmpty.hidden = true;
    elements.liveTradingError.hidden = true;
    elements.labShell.hidden = true;
    elements.ownerGate.hidden = false;
    elements.retryOwnerGate.hidden = status === 401 || status === 404;
    elements.ownerLoginLink.hidden = status !== 401 && status !== 404;
    if (status === 401) {
      elements.ownerGateTitle.textContent = '로그인이 필요합니다';
      elements.ownerGateMessage.textContent = 'Behavior Lab은 소유자 계정으로 로그인한 뒤에만 열립니다.';
      elements.ownerLoginLink.textContent = '홈에서 로그인';
    } else if (status === 404) {
      elements.ownerGateTitle.textContent = '페이지를 찾을 수 없습니다';
      elements.ownerGateMessage.textContent = '현재 계정에는 이 도구의 접근 권한이 없습니다.';
      elements.ownerLoginLink.textContent = '홈으로';
      elements.ownerLoginLink.href = '/';
    } else {
      elements.ownerGateTitle.textContent = '접근 확인에 실패했습니다';
      elements.ownerGateMessage.textContent = '네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
    }
  }

  function unlockOwnerShell() {
    state.ownerVerified = true;
    elements.ownerGate.hidden = true;
    elements.labShell.hidden = false;
  }

  function switchTab(tab, { refresh = true } = {}) {
    const next = ['paper', 'live'].includes(tab) ? tab : 'paper';
    state.activeTab = next;
    const paperActive = next === 'paper';
    const liveActive = next === 'live';
    elements.paperTab.classList.toggle('is-active', paperActive);
    elements.paperTab.setAttribute('aria-selected', String(paperActive));
    elements.liveTab.classList.toggle('is-active', liveActive);
    elements.liveTab.setAttribute('aria-selected', String(liveActive));
    elements.paperTabPanel.hidden = !paperActive;
    elements.liveTabPanel.hidden = !liveActive;
    document.body.classList.add('is-paper-view');
    history.replaceState(null, '', `#${next}`);
    if (refresh && state.ownerVerified && document.visibilityState !== 'hidden') {
      if (liveActive) void loadLiveTrading();
      else void loadPaper();
    }
    scheduleRefresh();
  }

  function scheduleRefresh(delay) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    if (!state.ownerVerified || document.visibilityState === 'hidden') return;
    const interval = state.activeTab === 'live' ? LIVE_REFRESH_MS : PAPER_REFRESH_MS;
    state.refreshTimer = window.setTimeout(async () => {
      if (document.visibilityState === 'hidden') return;
      if (state.activeTab === 'live') await loadLiveTrading();
      else await loadPaper();
      scheduleRefresh();
    }, delay ?? interval);
  }

  function paperStatus(status) {
    const labels = {
      starting: 'STARTING · 첫 주기 준비',
      active: 'ACTIVE · 모의투자 진행 중',
      halted: 'HALTED · 위험 한도 정지',
      complete: 'COMPLETE · 세션 종료',
      error: 'ERROR · 실행 오류',
      stale: 'STALE · 이전 보고',
    };
    elements.paperStatus.className = `live-status ${status === 'active' || status === 'complete' ? 'is-live' : status === 'starting' ? 'is-loading' : 'is-error'}`;
    elements.paperStatus.querySelector('span').textContent = labels[status] || '상태 미확인';
  }

  function experimentDisplayStatus(experiment, now = Date.now()) {
    if (!['starting', 'active'].includes(experiment.status)) return experiment.status;
    const candidates = [experiment.generated_at, experiment.shared_feed?.last_packet_at,
      ...experiment.arms.map((arm) => arm.last_cycle_at)].map(Date.parse).filter(Number.isFinite);
    const latest = candidates.length ? Math.max(...candidates) : NaN;
    return Number.isFinite(latest) && now - latest <= PAPER_STALE_MS ? experiment.status : 'stale';
  }

  function paperValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'number') return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 }).format(value);
    const text = String(value);
    return Number.isFinite(Date.parse(text)) && /(?:at|time|date)$/iu.test(text) ? formatKoreanTime(text) : text;
  }

  function detailCell(label, value) {
    const row = document.createElement('div');
    row.append(createText('span', '', label), createText('b', '', paperValue(value)));
    return row;
  }

  function validExperimentReport(experiment) {
    const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
    const validCurve = (curve, chainSequence, equity) => Array.isArray(curve) && curve.length <= 64
      && curve.every((point, index) => Number.isInteger(point.sequence) && point.sequence > 0
        && point.sequence <= chainSequence && Number.isFinite(Date.parse(point.at))
        && finite(point.equity) && finite(point.net_pnl) && Math.abs(point.net_pnl - (point.equity - 100)) <= 1e-6
        && (index === 0 || (point.sequence > curve[index - 1].sequence
          && Date.parse(point.at) > Date.parse(curve[index - 1].at))))
      && (!curve.length || (curve.at(-1).sequence === chainSequence && Math.abs(curve.at(-1).equity - equity) <= 1e-6));
    const profiles = {
      'abc-paper-experiment-v1': { experimentId: 'abc-paper-20260831', armIds: ['A', 'B', 'C'],
        strategyIds: ['abc-trend-momentum-v1', 'abc-breakout-volatility-v1', 'abc-mean-reversion-crowd-fade-v1'] },
      'multi-paper-experiment-v3': { experimentId: 'multi-paper-binance-20260901-v1', armIds: ['A', 'B', 'C', 'D', 'E', 'F'],
        strategyIds: ['multi-trend-persistence-v3', 'multi-breakout-confirmation-v3', 'multi-range-reversion-v3',
          'multi-ofi-continuation-v3', 'multi-overreaction-fade-v3', 'multi-consensus-conservative-v3'] },
    };
    const profile = profiles[experiment?.schema];
    const started = Date.parse(experiment?.started_at);
    const deadline = Date.parse(experiment?.deadline_at);
    const v3 = experiment?.schema === 'multi-paper-experiment-v3';
    const continuous = v3 && experiment?.run_mode === 'until-stopped';
    const stopped = experiment?.stopped_at === null ? null : Date.parse(experiment?.stopped_at);
    const validTiming = continuous
      ? experiment.deadline_at === null && (stopped === null || Number.isFinite(stopped))
      : Number.isFinite(deadline) && deadline - started === 24 * 60 * 60_000;
    return Boolean(experiment && profile && experiment.experiment_id === profile.experimentId && experiment.simulation === true
      && experiment.public_data_only === true && Number.isFinite(started) && validTiming
      && ['starting', 'active', 'complete', 'error'].includes(experiment.status)
      && experiment.shared_feed?.provider === 'binance-usdm-public'
      && Number.isInteger(experiment.shared_feed?.sequence) && experiment.shared_feed.sequence > 0
      && hash(experiment.shared_feed.hash) && experiment.shared_feed.credential_used === false
      && JSON.stringify(experiment.shared_feed.symbols) === JSON.stringify(PAPER_SYMBOLS)
      && JSON.stringify(experiment.shared_feed.channels) === JSON.stringify(['ticker', 'books5', 'trade', 'candle1m'])
      && experiment.assumptions?.seed_equity_per_arm === 100 && experiment.assumptions.max_positions_per_arm === 1
      && experiment.assumptions.strategy_mutation === false && Array.isArray(experiment.leaderboard)
      && experiment.leaderboard.length === profile.armIds.length && Array.isArray(experiment.arms)
      && experiment.arms.length === profile.armIds.length
      && (!v3 || (hash(experiment.strategy_set_hash) && experiment.assumptions.modeled_round_trip_cost_bps === 20
        && experiment.assumptions.risk_pct === 1.5 && experiment.assumptions.leverage_cap === 3
        && (!continuous || (experiment.assumptions.entry_cutoff_at === null
          && experiment.assumptions.terminal_close === 'owner-stop'))))
      && experiment.arms.every((arm, index) => arm.arm_id === profile.armIds[index]
        && arm.strategy?.id === profile.strategyIds[index]
        && hash(arm.strategy.definition_hash) && Number.isInteger(arm.chain?.sequence) && arm.chain.sequence > 0
        && hash(arm.chain.hash) && finite(arm.equity) && finite(arm.net_pnl) && finite(arm.return_pct)
        && finite(arm.max_drawdown_pct) && finite(arm.fees) && finite(arm.slippage_cost)
        && Number.isInteger(arm.trade_count) && Array.isArray(arm.recent_trades) && arm.recent_trades.length <= 25
        && Array.isArray(arm.recent_decisions) && arm.recent_decisions.length <= 20
        && Array.isArray(arm.recent_logs) && arm.recent_logs.length <= 30
        && (!v3 || (arm.strategy.policy && arm.risk && arm.risk.risk_pct === 1.5 && arm.risk.leverage_cap === 3
          && Array.isArray(arm.strategy.policy.allowed_regimes) && Array.isArray(arm.strategy.policy.required_features)))
        && validCurve(arm.equity_curve || [], arm.chain.sequence, arm.equity))
      && Array.isArray(experiment.limitations));
  }

  function renderExperimentList(items, emptyText, renderer) {
    const list = document.createElement('ol');
    list.className = 'paper-logs abc-list';
    list.replaceChildren(...(items.length ? items.map(renderer) : [createText('li', '', emptyText)]));
    return list;
  }

  function renderEquityChart(arm) {
    const figure = document.createElement('figure');
    figure.className = 'abc-equity-chart';
    const curve = arm.equity_curve || [];
    const titleId = `abc-chart-title-${arm.arm_id}`;
    const descriptionId = `abc-chart-description-${arm.arm_id}`;
    const title = createText('figcaption', '', `${arm.arm_id} 자산 곡선`);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 640 220');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-labelledby', `${titleId} ${descriptionId}`);
    svg.dataset.pointCount = String(curve.length);
    const svgTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    svgTitle.id = titleId;
    svgTitle.textContent = `${arm.arm_id} 자산 곡선`;
    const description = document.createElementNS('http://www.w3.org/2000/svg', 'desc');
    description.id = descriptionId;
    description.textContent = curve.length
      ? `${curve.length}개 지점, 시작 ${formatUsdt(curve[0].equity)}, 현재 ${formatUsdt(curve.at(-1).equity)}`
      : '새 엔진 보고가 도착하면 자산 곡선을 표시합니다.';
    svg.append(svgTitle, description);
    for (const y of [20, 110, 200]) {
      const grid = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      grid.setAttribute('x1', '16'); grid.setAttribute('x2', '624'); grid.setAttribute('y1', String(y)); grid.setAttribute('y2', String(y));
      grid.setAttribute('class', 'abc-chart-grid');
      svg.append(grid);
    }
    const values = curve.map((point) => point.equity);
    const low = Math.min(100, ...values);
    const high = Math.max(100, ...values);
    const span = Math.max(high - low, .01);
    const firstAt = curve.length ? Date.parse(curve[0].at) : 0;
    const duration = curve.length > 1 ? Date.parse(curve.at(-1).at) - firstAt : 0;
    const pointText = curve.map((point) => {
      const x = duration > 0 ? 16 + (Date.parse(point.at) - firstAt) / duration * 608 : 320;
      const y = 200 - (point.equity - low) / span * 180;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    if (pointText) {
      const baseline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const baselineY = 200 - (100 - low) / span * 180;
      baseline.setAttribute('x1', '16'); baseline.setAttribute('x2', '624');
      baseline.setAttribute('y1', String(baselineY)); baseline.setAttribute('y2', String(baselineY));
      baseline.setAttribute('class', 'abc-chart-baseline');
      const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polyline.setAttribute('points', pointText);
      polyline.setAttribute('class', arm.net_pnl < 0 ? 'is-negative' : 'is-positive');
      svg.append(baseline, polyline);
    }
    const range = createText('p', 'abc-chart-range', curve.length
      ? `${formatKoreanTime(curve[0].at)} → ${formatKoreanTime(curve.at(-1).at)} · 저점 ${formatUsdt(low)} · 고점 ${formatUsdt(high)}`
      : '곡선 데이터 대기 중');
    figure.append(title, svg, range);
    return figure;
  }

  function strategyPresentation(strategyId, fallback) {
    const presentations = {
      'multi-trend-persistence-v3': ['추세 지속', '힘이 이어지는 방향을 따라가요.'],
      'multi-breakout-confirmation-v3': ['돌파 확인', '가격이 범위를 벗어난 뒤 확인하고 따라가요.'],
      'multi-range-reversion-v3': ['구간 회귀', '과하게 움직인 가격이 범위로 돌아오는 흐름을 봐요.'],
      'multi-ofi-continuation-v3': ['체결 흐름', '매수와 매도 체결의 쏠림이 이어지는지 봐요.'],
      'multi-overreaction-fade-v3': ['과민 반응 역추세', '군중의 과한 반응이 되돌아오는 구간을 찾아요.'],
      'multi-consensus-conservative-v3': ['보수적 합의', '여러 신호가 같은 방향일 때만 움직여요.'],
    };
    return presentations[strategyId] || [fallback || strategyId, '고정된 규칙으로 공개 시장 데이터를 관찰해요.'];
  }

  function signedClass(value) {
    return value > 0 ? 'is-positive' : value < 0 ? 'is-negative' : 'is-neutral';
  }

  function newestFirst(items, timestampKey, sequenceKey) {
    return items.map((item, index) => ({ item, index })).sort((left, right) => {
      const leftSequence = Number(left.item[sequenceKey]);
      const rightSequence = Number(right.item[sequenceKey]);
      if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) {
        return rightSequence - leftSequence;
      }
      const leftTime = Date.parse(left.item[timestampKey]);
      const rightTime = Date.parse(right.item[timestampKey]);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return right.index - left.index;
    }).map(({ item }) => item);
  }

  function renderExperimentArm(arm, expanded = false) {
    const card = document.createElement('article');
    card.className = 'panel abc-arm-card';
    card.dataset.armId = arm.arm_id;
    card.dataset.outcome = signedClass(arm.net_pnl);
    const [strategyName, strategyDescription] = strategyPresentation(arm.strategy.id, arm.strategy.label);
    const heading = document.createElement('div');
    heading.className = 'abc-arm-heading';
    heading.append(
      createText('span', 'abc-arm-id', arm.arm_id),
      createText('div', '', ''),
      createText('span', `abc-position-state ${arm.open_position ? 'is-open' : ''}`,
        arm.open_position ? `${String(arm.open_position.direction).toUpperCase()} 포지션` : arm.status === 'halted' ? '위험 한도 정지' : '포지션 대기'),
    );
    heading.children[1].append(createText('h3', '', strategyName), createText('p', 'abc-strategy-description', strategyDescription),
      createText('small', 'abc-strategy-id', arm.strategy.id));
    const result = document.createElement('div');
    result.className = 'abc-arm-result';
    const returnValue = createText('strong', signedClass(arm.return_pct), formatPercent(arm.return_pct, true));
    result.append(createText('span', '', '현재 수익률'), returnValue,
      createText('small', '', `순손익 ${formatUsdt(arm.net_pnl, true)} · 자산 ${formatUsdt(arm.equity)}`));
    const metrics = document.createElement('div');
    metrics.className = 'abc-arm-metrics';
    metrics.append(
      detailCell('최대 낙폭', formatPercent(arm.max_drawdown_pct)),
      detailCell('전체 비용', formatUsdt(arm.fees + arm.slippage_cost)),
      detailCell('거래 결과', `${arm.trade_count}회 · ${arm.win_count}승 ${arm.loss_count}패`),
      detailCell('현재 상태', arm.open_position ? '포지션 보유' : arm.status === 'halted' ? '정지' : '관찰 중'),
    );
    const chart = renderEquityChart(arm);
    const details = document.createElement('details');
    details.className = 'abc-arm-details';
    details.dataset.armId = arm.arm_id;
    details.open = expanded;
    details.append(createText('summary', '', '전략 상세와 최신 기록 보기'));
    if (expanded) {
    const detailsBody = document.createElement('div');
    detailsBody.className = 'abc-arm-details-body';
    const policy = document.createElement('section');
    policy.className = 'abc-arm-section';
    policy.append(createText('h4', '', '진입 정책 / 위험'));
    const policyGrid = document.createElement('div');
    policyGrid.className = 'paper-kv';
    if (!arm.strategy.policy || !arm.risk) policyGrid.append(detailCell('프로필', 'v1 고정 정책'));
    else policyGrid.append(
      detailCell('스타일', arm.strategy.policy.style),
      detailCell('허용 체제', arm.strategy.policy.allowed_regimes.join(', ')),
      detailCell('필수 feature', arm.strategy.policy.required_features.join(', ') || '합의 기반'),
      detailCell('합의 / 지속', `${arm.strategy.policy.minimum_feature_agreement}개 / ${arm.strategy.policy.min_persistence_seconds}초`),
      detailCell('진입 score', `≥ ${arm.strategy.policy.entry_threshold}`),
      detailCell('최대 spread', `${arm.strategy.policy.max_spread_bps} bps`),
      detailCell('목표 / net R:R', `≥ ${arm.strategy.policy.min_target_bps} bps / ${arm.strategy.policy.min_net_reward_risk}`),
      detailCell('쿨다운 / 반대 확인', `${arm.strategy.policy.cooldown_minutes}분 / ${arm.strategy.policy.opposite_confirmations}회`),
      detailCell('회당 위험 / 레버리지', `${arm.risk.risk_pct}% / ${arm.risk.leverage_cap}×`),
      detailCell('낙폭 정지 / 최대 보유', `${arm.risk.drawdown_halt_pct}% / ${arm.risk.max_hold_minutes}분`),
    );
    policy.append(policyGrid);
    const position = document.createElement('section');
    position.className = 'abc-arm-section';
    position.append(createText('h4', '', '현재 포지션'));
    const positionGrid = document.createElement('div');
    positionGrid.className = 'paper-kv';
    if (!arm.open_position) positionGrid.append(detailCell('상태', '열린 포지션 없음'));
    else positionGrid.append(...Object.entries(arm.open_position).slice(0, 12).map(([key, value]) => detailCell(key, value)));
    position.append(positionGrid);
    const trades = document.createElement('section');
    trades.className = 'abc-arm-section';
    trades.append(createText('h4', '', '최근 거래 · 최신순'));
    trades.append(renderExperimentList(newestFirst(arm.recent_trades, 'closed_at', 'sequence'), '아직 종료 거래가 없습니다.', (trade) => {
      const row = document.createElement('li');
      row.append(createText('time', '', `${formatKoreanTime(trade.opened_at)} → ${formatKoreanTime(trade.closed_at)}`),
        createText('span', '', `${trade.symbol} · ${trade.direction} · ${formatUsdt(trade.net_pnl, true)}`),
        createText('small', '', `${trade.reason} · 비용 ${formatUsdt(trade.fees + trade.slippage_cost)}`));
      return row;
    }));
    const decisions = document.createElement('section');
    decisions.className = 'abc-arm-section';
    decisions.append(createText('h4', '', '최근 판단 · 최신순'));
    decisions.append(renderExperimentList(newestFirst(arm.recent_decisions, 'observed_at', 'feed_sequence'), '아직 판단이 없습니다.', (decision) => {
      const row = document.createElement('li');
      row.append(createText('time', '', formatKoreanTime(decision.observed_at)),
        createText('span', '', `${decision.symbol} · ${decision.direction} · score ${paperValue(decision.score)}${decision.regime ? ` · ${decision.regime}` : ''}`),
        createText('small', '', decision.gate_reasons
          ? `합의 ${decision.feature_agreement} · spread ${decision.spread_bps} bps · 목표 ${decision.target_distance_bps} bps · net R:R ${decision.net_reward_risk} · ${decision.gate_reasons.join(', ') || 'all gates passed'}`
          : `feed #${decision.feed_sequence} · ${String(decision.feed_hash).slice(0, 12)}… · ${decision.reason || 'entry candidate'}`));
      return row;
    }));
    const logs = document.createElement('section');
    logs.className = 'abc-arm-section';
    logs.append(createText('h4', '', '최근 로그 · 최신순'));
    logs.append(renderExperimentList(newestFirst(arm.recent_logs, 'at', 'sequence'), '아직 로그가 없습니다.', (log) => {
      const row = document.createElement('li');
      row.append(createText('time', '', formatKoreanTime(log.at)), createText('span', '', log.message),
        createText('small', '', `#${log.sequence} · ${log.type}`));
      return row;
    }));
    const chain = createText('p', 'abc-chain', `arm chain #${arm.chain.sequence} · ${arm.chain.hash.slice(0, 16)}… · ${arm.strategy.definition_hash.slice(0, 12)}…`);
    detailsBody.append(policy, position, trades, decisions, logs, chain);
    details.append(detailsBody);
    }
    card.append(heading, result, chart, metrics, details);
    return card;
  }

  function patchRenderedNode(current, next) {
    if (current.nodeType !== next.nodeType
      || (current.nodeType === Node.ELEMENT_NODE && current.nodeName !== next.nodeName)) {
      current.replaceWith(next.cloneNode(true));
      return;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    if (current.nodeType !== Node.ELEMENT_NODE) return;
    for (const name of current.getAttributeNames()) {
      if (current.tagName === 'DETAILS' && name === 'open') continue;
      if (!next.hasAttribute(name)) current.removeAttribute(name);
    }
    for (const name of next.getAttributeNames()) {
      const value = next.getAttribute(name);
      if (current.getAttribute(name) !== value) current.setAttribute(name, value);
    }
    const desired = [...next.childNodes];
    for (let index = 0; index < desired.length; index += 1) {
      const existing = current.childNodes[index];
      if (!existing) current.append(desired[index].cloneNode(true));
      else patchRenderedNode(existing, desired[index]);
    }
    while (current.childNodes.length > desired.length) current.lastChild.remove();
  }

  function patchRenderedChildren(container, desired) {
    for (let index = 0; index < desired.length; index += 1) {
      const current = container.children[index];
      if (!current) container.append(desired[index]);
      else patchRenderedNode(current, desired[index]);
    }
    while (container.children.length > desired.length) container.lastElementChild.remove();
  }

  function syncStopButton(experiment) {
    const canStop = experiment?.schema === 'multi-paper-experiment-v3'
      && experiment.run_mode === 'until-stopped' && ['starting', 'active'].includes(experiment.status);
    elements.stopPaper.hidden = !canStop;
    elements.stopPaper.disabled = !canStop || state.stopSubmitting || state.stopRequested;
    elements.stopPaper.textContent = state.stopSubmitting ? '중단 요청 전송 중'
      : state.stopRequested ? '중단 요청됨' : '6개 실험 중단';
  }

  function renderExperiment(experiment) {
    const retained = Boolean(state.experiment && !elements.paperExperiment.hidden
      && elements.experimentArms.children.length === experiment.arms.length);
    const expandedArmIds = new Set([...(elements.experimentArms.querySelectorAll?.('details[open][data-arm-id]') || [])]
      .map((details) => details.dataset.armId));
    state.experiment = experiment;
    const displayStatus = experimentDisplayStatus(experiment);
    paperStatus(displayStatus);
    const labels = { starting: 'STARTING · 준비', active: 'ACTIVE · 동시 진행', stale: 'STALE · 마지막 반영 끊김' };
    elements.experimentStatus.className = `adaptive-stream ${displayStatus === 'active' ? 'is-live' : 'is-connecting'}`;
    elements.experimentStatus.textContent = labels[displayStatus];
    elements.experimentStarted.textContent = formatKoreanTime(experiment.started_at);
    elements.experimentDeadline.textContent = experiment.run_mode === 'until-stopped'
      ? '중단 버튼을 누를 때까지' : formatKoreanTime(experiment.deadline_at);
    elements.experimentFeed.textContent = `BINANCE USDⓈ-M · #${experiment.shared_feed.sequence} · ${experiment.shared_feed.hash.slice(0, 16)}…`;
    elements.experimentLastPacket.textContent = formatKoreanTime(experiment.shared_feed.last_packet_at);
    const overviewCopy = elements.paperExperiment.querySelector('[data-experiment-copy]');
    if (overviewCopy) overviewCopy.textContent = `같은 공개 시장 데이터와 비용 기준으로 ${experiment.arms.length}개 전략을 공정하게 비교해요.`;
    const leader = experiment.leaderboard.find((entry) => entry.rank === 1) || experiment.leaderboard[0];
    const leaderArm = experiment.arms.find((arm) => arm.arm_id === leader.arm_id);
    const [leaderName] = strategyPresentation(leaderArm.strategy.id, leaderArm.strategy.label);
    const averageReturn = experiment.arms.reduce((sum, arm) => sum + arm.return_pct, 0) / experiment.arms.length;
    const openPositions = experiment.arms.filter((arm) => arm.open_position).length;
    const totalTrades = experiment.arms.reduce((sum, arm) => sum + arm.trade_count, 0);
    elements.experimentLeaderName.textContent = `${leader.arm_id} · ${leaderName}`;
    elements.experimentLeaderReturn.textContent = formatPercent(leader.return_pct, true);
    elements.experimentLeaderReturn.className = signedClass(leader.return_pct);
    elements.experimentLeaderPnl.textContent = `순손익 ${formatUsdt(leader.net_pnl, true)} · 자산 ${formatUsdt(leader.equity)}`;
    elements.experimentAverageReturn.textContent = formatPercent(averageReturn, true);
    elements.experimentAverageReturn.className = signedClass(averageReturn);
    elements.experimentOpenPositions.textContent = `${openPositions} / ${experiment.arms.length}`;
    elements.experimentTotalTrades.textContent = `${totalTrades}회`;
    const leaderboard = experiment.leaderboard.map((entry) => {
      const arm = experiment.arms.find((item) => item.arm_id === entry.arm_id);
      const [name] = strategyPresentation(arm.strategy.id, arm.strategy.label);
      const row = document.createElement('li');
      row.className = 'paper-ranking-item';
      const identity = document.createElement('div');
      identity.append(createText('b', '', `${entry.arm_id} · ${name}`), createText('span', '', `자산 ${formatUsdt(entry.equity)} · 낙폭 ${formatPercent(entry.max_drawdown_pct)}`));
      const resultBlock = document.createElement('div');
      resultBlock.append(createText('strong', signedClass(entry.return_pct), formatPercent(entry.return_pct, true)),
        createText('small', '', formatUsdt(entry.net_pnl, true)));
      row.append(createText('span', 'paper-rank-number', String(entry.rank)), identity, resultBlock);
      return row;
    });
    const arms = experiment.arms.map((arm) => renderExperimentArm(arm, expandedArmIds.has(arm.arm_id)));
    if (retained) {
      patchRenderedChildren(elements.experimentLeaderboard, leaderboard);
      patchRenderedChildren(elements.experimentArms, arms);
    } else {
      elements.experimentLeaderboard.replaceChildren(...leaderboard);
      elements.experimentArms.replaceChildren(...arms);
    }
    syncStopButton(experiment);
    elements.paperExperiment.hidden = false;
    elements.paperExperiment.setAttribute('aria-busy', 'false');
    return displayStatus;
  }

  function markPaperRefreshError(error, timedOut = false) {
    const fallback = timedOut ? '모의투자 보고 요청 시간이 초과되었습니다.' : '모의투자 보고를 불러오지 못했습니다.';
    const message = timedOut ? fallback : error?.message || fallback;
    const retained = Boolean(state.experiment && !elements.paperExperiment.hidden);
    elements.paperErrorText.textContent = retained
      ? `${message} 업데이트하지 못했습니다. 이전 보고를 표시합니다.`
      : message;
    elements.paperError.hidden = false;
    if (retained) {
      elements.paperExperiment.dataset.freshness = 'stale';
      paperStatus('stale');
    }
  }

  async function loadPaper({ verifyOwner = false, force = false } = {}) {
    if (state.paperLoading && !force) return;
    if (force) state.paperController?.abort();
    const requestId = ++state.paperRequestId;
    const controller = new AbortController();
    state.paperController = controller;
    state.paperLoading = true;
    elements.paperExperiment.setAttribute('aria-busy', 'true');
    let timedOut = false;
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('모의투자 보고 요청 시간이 초과되었습니다.'));
      }, PAPER_REQUEST_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([fetch(`${API_URL}/api/behavior-lab/paper`, {
        method: 'GET', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/json', authorization: `Bearer ${ownerToken()}` }, signal: controller.signal,
      }), timeout]);
      const payload = await Promise.race([response.json().catch(() => ({})), timeout]);
      if (requestId !== state.paperRequestId) return;
      if (response.status === 401 || response.status === 404) throw new OwnerAccessError(response.status);
      if (!response.ok) throw new Error(payload.error || '모의투자 보고를 불러오지 못했습니다.');
      if (verifyOwner) unlockOwnerShell();
      const activeExperiment = payload.experiment && ['starting', 'active'].includes(payload.experiment.status)
        ? payload.experiment : null;
      if (!activeExperiment) {
        state.experiment = null;
        state.stopRequested = false;
        paperStatus('starting');
        elements.paperExperiment.hidden = true;
        elements.experimentArms.replaceChildren();
        elements.experimentLeaderboard.replaceChildren();
        elements.paperEmpty.hidden = false;
        elements.paperError.hidden = true;
        elements.stopPaper.hidden = true;
        return;
      }
      if (!validExperimentReport(activeExperiment)) throw new Error('검증되지 않은 모의실험 보고는 표시하지 않았습니다.');
      state.stopRequested = payload.control?.experiment_id === activeExperiment.experiment_id
        && payload.control.stop_requested === true;
      const displayStatus = renderExperiment(activeExperiment);
      elements.paperExperiment.dataset.freshness = displayStatus === 'stale' ? 'stale' : 'fresh';
      if (displayStatus === 'stale') {
        elements.paperErrorText.textContent = '마지막 모의투자 보고가 2분 넘게 갱신되지 않았습니다. 러너 상태를 확인하고 이전 보고만 표시합니다.';
        elements.paperError.hidden = false;
      } else elements.paperError.hidden = true;
      elements.paperEmpty.hidden = true;
    } catch (error) {
      if (requestId !== state.paperRequestId) return;
      if (error instanceof OwnerAccessError) {
        if (verifyOwner) throw error;
        showOwnerGate(error.status);
        return;
      }
      if (verifyOwner) throw error;
      markPaperRefreshError(error, timedOut);
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === state.paperRequestId) {
        state.paperLoading = false;
        state.paperController = null;
        elements.paperExperiment.setAttribute('aria-busy', 'false');
        elements.refreshPaper.disabled = false;
      }
    }
  }

  function validLiveTradingReport(report) {
    const expected = [
      ['beast', '야수의 심장', ['BTCUSDT', 'SOLUSDT'], 25],
      ['ddokdogi', '똑도기', ['ETHUSDT', 'XRPUSDT'], 6],
    ];
    return Boolean(report && report.schema === 'dual-live-v1'
      && report.experiment_id === 'dual-live-20260901-v1' && report.live_trading === true
      && Number.isFinite(Date.parse(report.generated_at)) && Number.isInteger(report.sequence) && report.sequence >= 0
      && ['blocked', 'armed', 'active', 'degraded', 'error'].includes(report.status)
      && report.exchange?.name === 'Binance' && report.exchange.product === 'USD-M-FUTURES'
      && report.exchange.api === 'fapi-v1'
      && JSON.stringify(report.allocation) === JSON.stringify({ per_model_usdt: 3, total_usdt: 6,
        mode: 'isolated-margin-hard-cap' })
      && Array.isArray(report.models) && report.models.length === 2
      && report.models.every((model, index) => model.id === expected[index][0] && model.name === expected[index][1]
        && JSON.stringify(model.symbols) === JSON.stringify(expected[index][2]) && model.allocation_usdt === 3
        && model.leverage_cap === expected[index][3]
        && ['blocked', 'watching', 'open', 'degraded', 'error'].includes(model.status)
        && Number.isInteger(model.trade_count) && Number.isInteger(model.win_count) && Number.isInteger(model.loss_count)
        && finite(model.realized_pnl) && Array.isArray(model.recent_decisions) && model.recent_decisions.length <= 30
        && Array.isArray(model.recent_logs) && model.recent_logs.length <= 40
        && (!model.open_order || (model.symbols.includes(model.open_order.symbol)
          && model.open_order.estimated_margin_usdt > 0 && model.open_order.estimated_margin_usdt <= 3.00000001)))
      && Array.isArray(report.warnings) && /^[a-f0-9]{64}$/u.test(report.fingerprint));
  }

  function liveTradingStatus(status, stale = false) {
    const labels = { blocked: 'BLOCKED · API 키 필요', armed: 'ARMED · 조건 감시 중', active: 'LIVE · 실포지션 추적',
      degraded: 'DEGRADED · 재시도 중', error: 'ERROR · 실행 중단' };
    const effective = stale ? 'stale' : status;
    elements.liveTradingStatus.className = `live-status ${['armed', 'active'].includes(effective) ? 'is-live'
      : effective === 'blocked' ? 'is-loading' : 'is-error'}`;
    elements.liveTradingStatus.querySelector('span').textContent = stale ? 'STALE · 이전 실투 보고' : labels[status] || '상태 미확인';
  }

  function liveModelCard(model) {
    const card = document.createElement('article');
    card.className = `panel live-model-card is-${model.id}`;
    const header = document.createElement('div'); header.className = 'live-model-head';
    const name = document.createElement('div');
    name.append(createText('p', 'section-index', model.id === 'beast' ? 'MODEL 01 · AGGRESSIVE' : 'MODEL 02 · CONSERVATIVE'),
      createText('h2', '', model.name), createText('p', 'section-copy', model.style));
    header.append(name, createText('span', `live-model-state is-${model.status}`,
      model.status === 'open' ? '실포지션 보유' : model.status === 'watching' ? '조건 감시' : model.status === 'blocked' ? '시작 차단' : '상태 점검'));
    const allocation = document.createElement('div'); allocation.className = 'live-model-allocation';
    allocation.append(detailCell('격리 배정', `${model.allocation_usdt} USDT`), detailCell('레버리지 상한', `${model.leverage_cap}×`),
      detailCell('누적 거래', `${model.trade_count}회`), detailCell('실현 손익', formatUsdt(model.realized_pnl, true)));
    const status = createText('p', 'live-model-message', model.status_message);
    const position = document.createElement('section'); position.className = 'live-position-card';
    position.append(createText('h3', '', '현재 실포지션'));
    const positionGrid = document.createElement('div'); positionGrid.className = 'paper-kv';
    if (!model.open_order) positionGrid.append(detailCell('상태', '열린 실포지션 없음'), detailCell('관찰 심볼', model.symbols.join(' · ')));
    else positionGrid.append(detailCell('방향', `${model.open_order.symbol} · ${model.open_order.direction.toUpperCase()}`),
      detailCell('수량', model.open_order.quantity), detailCell('체결가', model.open_order.average_price || '확인 중'),
      detailCell('격리 증거금', `${model.open_order.estimated_margin_usdt.toFixed(4)} USDT`),
      detailCell('손절', model.open_order.stop_price), detailCell('익절', model.open_order.target_price));
    position.append(positionGrid);
    const details = document.createElement('details'); details.className = 'live-model-details';
    details.append(createText('summary', '', '최신 판단과 실행 로그 보기'));
    const body = document.createElement('div'); body.className = 'abc-arm-details-body';
    const decisions = document.createElement('section'); decisions.className = 'abc-arm-section';
    decisions.append(createText('h4', '', '최근 판단 · 최신순'));
    decisions.append(renderExperimentList(newestFirst(model.recent_decisions, 'at', 'sequence'), '아직 판단이 없습니다.', (decision) => {
      const row = document.createElement('li');
      const probability = decision.estimated_win_probability === null ? '추정 불가'
        : `추정 ${(decision.estimated_win_probability * 100).toFixed(1)}%`;
      row.append(createText('time', '', formatKoreanTime(decision.at)),
        createText('span', '', `${decision.symbol} · ${decision.direction} · ${probability}`),
        createText('small', '', `score ${decision.score} · spread ${decision.spread_bps} bps · net R:R ${decision.net_reward_risk} · ${decision.reasons.join(', ')}`));
      return row;
    }));
    const logs = document.createElement('section'); logs.className = 'abc-arm-section';
    logs.append(createText('h4', '', '실행 로그 · 최신순'));
    logs.append(renderExperimentList(newestFirst(model.recent_logs, 'at', 'sequence'), '아직 로그가 없습니다.', (log) => {
      const row = document.createElement('li');
      row.append(createText('time', '', formatKoreanTime(log.at)), createText('span', '', log.message),
        createText('small', '', `#${log.sequence} · ${log.level}`));
      return row;
    }));
    body.append(decisions, logs); details.append(body);
    card.append(header, allocation, status, position, details); return card;
  }

  function renderLiveTrading(report, receivedAt) {
    state.liveReport = report;
    const age = Date.now() - Math.max(Date.parse(report.generated_at), Date.parse(receivedAt));
    const stale = Number.isFinite(age) && age > PAPER_STALE_MS;
    liveTradingStatus(report.status, stale);
    elements.liveTradingSummary.textContent = report.status_message;
    patchRenderedChildren(elements.liveModelGrid, report.models.map(liveModelCard));
    elements.liveWarnings.replaceChildren(...report.warnings.map((warning) => createText('p', '', warning)));
    elements.liveTradingReport.dataset.freshness = stale ? 'stale' : 'fresh';
    elements.liveTradingReport.hidden = false; elements.liveTradingEmpty.hidden = true;
    elements.liveTradingReport.setAttribute('aria-busy', 'false');
    if (stale) {
      elements.liveTradingErrorText.textContent = '실투 보고가 2분 넘게 갱신되지 않았습니다. 이전 보고만 표시합니다.';
      elements.liveTradingError.hidden = false;
    } else elements.liveTradingError.hidden = true;
  }

  async function loadLiveTrading({ force = false } = {}) {
    if (state.liveLoading && !force) return;
    if (force) state.liveController?.abort();
    const requestId = ++state.liveRequestId; const controller = new AbortController();
    state.liveController = controller; state.liveLoading = true;
    elements.liveTradingReport.setAttribute('aria-busy', 'true'); elements.refreshLiveTrading.disabled = true;
    const timeoutId = window.setTimeout(() => controller.abort(), PAPER_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/api/behavior-lab/live`, { method: 'GET', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/json', authorization: `Bearer ${ownerToken()}` }, signal: controller.signal });
      const payload = await response.json().catch(() => ({})); if (requestId !== state.liveRequestId) return;
      if (response.status === 401 || response.status === 404) throw new OwnerAccessError(response.status);
      if (!response.ok) throw new Error(payload.error || '실투 보고를 불러오지 못했습니다.');
      if (!payload.report) {
        state.liveReport = null; liveTradingStatus('blocked'); elements.liveTradingReport.hidden = true;
        elements.liveTradingEmpty.hidden = false; elements.liveTradingError.hidden = true; return;
      }
      if (payload.report.exchange?.name !== 'Binance') {
        state.liveReport = null; liveTradingStatus('blocked'); elements.liveTradingReport.hidden = true;
        elements.liveTradingEmpty.hidden = false; elements.liveTradingError.hidden = true; return;
      }
      if (!validLiveTradingReport(payload.report)) throw new Error('검증되지 않은 실투 보고는 표시하지 않았습니다.');
      renderLiveTrading(payload.report, payload.received_at);
    } catch (error) {
      if (requestId !== state.liveRequestId) return;
      if (error instanceof OwnerAccessError) { showOwnerGate(error.status); return; }
      const retained = Boolean(state.liveReport && !elements.liveTradingReport.hidden);
      elements.liveTradingErrorText.textContent = retained
        ? `${error?.message || '실투 보고를 갱신하지 못했습니다.'} 이전 보고를 표시합니다.`
        : error?.message || '실투 보고를 불러오지 못했습니다.';
      elements.liveTradingError.hidden = false;
      if (retained) liveTradingStatus(state.liveReport.status, true);
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === state.liveRequestId) {
        state.liveLoading = false; state.liveController = null; elements.refreshLiveTrading.disabled = false;
        elements.liveTradingReport.setAttribute('aria-busy', 'false');
      }
    }
  }

  async function requestPaperStop() {
    const experiment = state.experiment;
    if (state.stopSubmitting || state.stopRequested || experiment?.schema !== 'multi-paper-experiment-v3'
      || experiment.run_mode !== 'until-stopped' || !['starting', 'active'].includes(experiment.status)) return;
    state.stopSubmitting = true;
    syncStopButton(experiment);
    try {
      const response = await fetch(`${API_URL}/api/behavior-lab/paper/stop`, {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json',
          authorization: `Bearer ${ownerToken()}` },
        body: JSON.stringify({ experiment_id: experiment.experiment_id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 404) {
        showOwnerGate(response.status);
        return;
      }
      if (!response.ok || payload.stop_requested !== true) {
        throw new Error(payload.error || '모의실험 중단 요청을 저장하지 못했습니다.');
      }
      state.stopRequested = true;
      elements.paperError.hidden = true;
    } catch (error) {
      elements.paperErrorText.textContent = error?.message || '모의실험 중단 요청을 저장하지 못했습니다.';
      elements.paperError.hidden = false;
    } finally {
      state.stopSubmitting = false;
      if (state.ownerVerified) syncStopButton(state.experiment);
    }
  }

  async function bootstrap() {
    if (!ownerToken()) {
      showOwnerGate(401);
      return;
    }
    elements.retryOwnerGate.hidden = true;
    elements.ownerLoginLink.hidden = true;
    elements.ownerGateTitle.textContent = '접근 권한 확인 중';
    elements.ownerGateMessage.textContent = '소유자 전용 보고 API로 세션을 확인하고 있습니다.';
    try {
      await loadPaper({ verifyOwner: true, force: true });
      switchTab(location.hash === '#live' ? 'live' : 'paper', { refresh: false });
    } catch (error) {
      showOwnerGate(error instanceof OwnerAccessError ? error.status : 0);
    }
  }

  elements.paperTab.addEventListener('click', () => switchTab('paper'));
  elements.liveTab.addEventListener('click', () => switchTab('live'));
  elements.refreshPaper.addEventListener('click', () => void loadPaper({ force: true }));
  elements.refreshLiveTrading.addEventListener('click', () => void loadLiveTrading({ force: true }));
  elements.stopPaper.addEventListener('click', () => void requestPaperStop());
  elements.retryOwnerGate.addEventListener('click', () => void bootstrap());
  elements.experimentArms.addEventListener('toggle', (event) => {
    const details = event.target;
    if (details?.tagName !== 'DETAILS' || !details.open || details.querySelector('.abc-arm-details-body')) return;
    const arm = state.experiment?.arms?.find((item) => item.arm_id === details.dataset.armId);
    const body = arm ? renderExperimentArm(arm, true).querySelector('.abc-arm-details-body') : null;
    if (body) details.append(body);
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
      return;
    }
    if (state.ownerVerified) {
      if (state.activeTab === 'live') void loadLiveTrading({ force: true });
      else void loadPaper({ force: true });
      scheduleRefresh();
    }
  });
  void bootstrap();
})();
