(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = /^(?:127\.0\.0\.1|localhost)$/u.test(location.hostname) ? location.origin : DEFAULT_API_URL;
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const PERIODS = ['5m', '15m', '1h', '4h'];
  const PAPER_REFRESH_MS = 5_000;
  const PAPER_REQUEST_TIMEOUT_MS = 4_000;
  const core = window.BehaviorLabCore;
  const state = {
    symbol: 'BTCUSDT', period: '5m', dashboard: null, request: 0, controller: null, draft: null, freshness: null,
    ownerVerified: false, paper: null, experiment: null, paperLoading: false, paperRequestId: 0, paperController: null, activeTab: 'market',
  };

  const elements = {
    adaptiveAudit: document.getElementById('adaptiveAudit'),
    adaptiveAuditRef: document.getElementById('adaptiveAuditRef'),
    adaptiveCadence: document.getElementById('adaptiveCadence'),
    adaptiveChallengersBody: document.getElementById('adaptiveChallengersBody'),
    adaptiveChampion: document.getElementById('adaptiveChampion'),
    adaptiveLastPacket: document.getElementById('adaptiveLastPacket'),
    adaptivePromotion: document.getElementById('adaptivePromotion'),
    adaptivePromotionReasons: document.getElementById('adaptivePromotionReasons'),
    adaptiveStream: document.getElementById('adaptiveStream'),
    adaptiveUpgraded: document.getElementById('adaptiveUpgraded'),
    backtestChronology: document.getElementById('backtestChronology'),
    backtestEmpty: document.getElementById('backtestEmpty'),
    backtestResult: document.getElementById('backtestResult'),
    confidenceValue: document.getElementById('confidenceValue'),
    copyDraft: document.getElementById('copyDraft'),
    counterList: document.getElementById('counterList'),
    counterTitle: document.getElementById('counterTitle'),
    createDraft: document.getElementById('createDraft'),
    crowdLabel: document.getElementById('crowdLabel'),
    dashboard: document.getElementById('dashboard'),
    dashboardError: document.getElementById('dashboardError'),
    dashboardErrorText: document.getElementById('dashboardErrorText'),
    draftBlocked: document.getElementById('draftBlocked'),
    draftErrors: document.getElementById('draftErrors'),
    draftPlaceholder: document.getElementById('draftPlaceholder'),
    draftResult: document.getElementById('draftResult'),
    draftText: document.getElementById('draftText'),
    freshnessText: document.getElementById('freshnessText'),
    fundingValue: document.getElementById('fundingValue'),
    experimentArms: document.getElementById('experimentArms'),
    experimentDeadline: document.getElementById('experimentDeadline'),
    experimentFeed: document.getElementById('experimentFeed'),
    experimentLastPacket: document.getElementById('experimentLastPacket'),
    experimentLeaderboard: document.getElementById('experimentLeaderboard'),
    experimentStarted: document.getElementById('experimentStarted'),
    experimentStatus: document.getElementById('experimentStatus'),
    inSampleMetrics: document.getElementById('inSampleMetrics'),
    interestValue: document.getElementById('interestValue'),
    liveStatus: document.getElementById('liveStatus'),
    longRatioBar: document.getElementById('longRatioBar'),
    longShortValue: document.getElementById('longShortValue'),
    labShell: document.getElementById('labShell'),
    marketChange: document.getElementById('marketChange'),
    marketHigh: document.getElementById('marketHigh'),
    marketLeverage: document.getElementById('marketLeverage'),
    marketLow: document.getElementById('marketLow'),
    marketPrice: document.getElementById('marketPrice'),
    marketSymbol: document.getElementById('marketSymbol'),
    outSampleMetrics: document.getElementById('outSampleMetrics'),
    periodChoices: document.getElementById('periodChoices'),
    marketTab: document.getElementById('marketTab'),
    marketTabPanel: document.getElementById('marketTabPanel'),
    ownerGate: document.getElementById('ownerGate'),
    ownerGateMessage: document.getElementById('ownerGateMessage'),
    ownerGateTitle: document.getElementById('ownerGateTitle'),
    ownerLoginLink: document.getElementById('ownerLoginLink'),
    paperCash: document.getElementById('paperCash'),
    paperCostDetail: document.getElementById('paperCostDetail'),
    paperCosts: document.getElementById('paperCosts'),
    paperDeadline: document.getElementById('paperDeadline'),
    paperDrawdown: document.getElementById('paperDrawdown'),
    paperEmpty: document.getElementById('paperEmpty'),
    paperEquity: document.getElementById('paperEquity'),
    paperError: document.getElementById('paperError'),
    paperErrorText: document.getElementById('paperErrorText'),
    paperExperiment: document.getElementById('paperExperiment'),
    paperLastCycle: document.getElementById('paperLastCycle'),
    paperLimitations: document.getElementById('paperLimitations'),
    paperLogs: document.getElementById('paperLogs'),
    paperNetPnl: document.getElementById('paperNetPnl'),
    paperAdaptive: document.getElementById('paperAdaptive'),
    paperPosition: document.getElementById('paperPosition'),
    paperRecord: document.getElementById('paperRecord'),
    paperReport: document.getElementById('paperReport'),
    paperReturn: document.getElementById('paperReturn'),
    paperSequence: document.getElementById('paperSequence'),
    paperStatus: document.getElementById('paperStatus'),
    paperTab: document.getElementById('paperTab'),
    paperTabPanel: document.getElementById('paperTabPanel'),
    paperTrades: document.getElementById('paperTrades'),
    paperTradesBody: document.getElementById('paperTradesBody'),
    paperUnrealized: document.getElementById('paperUnrealized'),
    priceLine: document.getElementById('priceLine'),
    refreshPaper: document.getElementById('refreshPaper'),
    retryDashboard: document.getElementById('retryDashboard'),
    retryOwnerGate: document.getElementById('retryOwnerGate'),
    riskLeverage: document.getElementById('riskLeverage'),
    riskLoss: document.getElementById('riskLoss'),
    riskSeed: document.getElementById('riskSeed'),
    riskStop: document.getElementById('riskStop'),
    runBacktest: document.getElementById('runBacktest'),
    scoreValue: document.getElementById('scoreValue'),
    signalArrow: document.getElementById('signalArrow'),
    signalContext: document.getElementById('signalContext'),
    signalDirection: document.getElementById('signalDirection'),
    signalEntry: document.getElementById('signalEntry'),
    signalInvalidation: document.getElementById('signalInvalidation'),
    signalPanel: document.getElementById('signalPanel'),
    signalTarget: document.getElementById('signalTarget'),
    supportList: document.getElementById('supportList'),
    supportTitle: document.getElementById('supportTitle'),
    symbolChoices: document.getElementById('symbolChoices'),
    takerLabel: document.getElementById('takerLabel'),
    takerRatioBar: document.getElementById('takerRatioBar'),
    takerValue: document.getElementById('takerValue'),
    tickerGrid: document.getElementById('tickerGrid'),
    windowList: document.getElementById('windowList'),
  };

  const riskInputs = [elements.riskSeed, elements.riskLoss, elements.riskLeverage, elements.riskStop];

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

  function validPayload(payload, symbol, period, now = Date.now()) {
    if (!payload || payload.source !== 'live' || payload.quality !== 'live') return false;
    const { snapshot, signal } = payload;
    if (!snapshot || snapshot.source !== 'live' || snapshot.quality !== 'live'
      || snapshot.symbol !== symbol || snapshot.period !== period || !SYMBOLS.includes(symbol) || !PERIODS.includes(period)) return false;
    if (!finite(payload.generatedAt) || payload.generatedAt > Date.now() + 60_000 || Date.now() - payload.generatedAt > 5 * 60_000) return false;
    if (!Array.isArray(snapshot.tickers) || snapshot.tickers.length !== SYMBOLS.length
      || !Array.isArray(snapshot.candles) || snapshot.candles.length < 120
      || !Array.isArray(snapshot.behaviorSeries) || snapshot.behaviorSeries.length < 20) return false;
    if (!snapshot.tickers.every((ticker) => SYMBOLS.includes(ticker.symbol) && finite(ticker.last) && ticker.last > 0)) return false;
    if (!snapshot.candles.every((candle) => ['ts', 'open', 'high', 'low', 'close', 'volume'].every((key) => finite(candle[key])))) return false;
    if (!snapshot.behaviorSeries.every((point) => ['ts', 'longRatio', 'shortRatio', 'buyVolume', 'sellVolume'].every((key) => finite(point[key])))) return false;
    return Boolean(signal && ['long', 'short', 'stand-aside'].includes(signal.direction)
      && Array.isArray(signal.evidence) && Array.isArray(signal.counterSignals)
      && core.evaluateSnapshotQuality(snapshot, now).isLive);
  }

  function formatPrice(value) {
    if (!finite(value)) return '—';
    return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: value < 10 ? 4 : value < 1_000 ? 2 : 0 }).format(value);
  }

  function formatCompact(value) {
    return finite(value) ? new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
  }

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

  function formatAge(ms) {
    if (!finite(ms)) return '시각 미확인';
    if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1_000))}초 전 검증`;
    return `${Math.round(ms / 60_000)}분 전 검증`;
  }

  function setStatus(kind, message) {
    elements.liveStatus.className = `live-status is-${kind}`;
    elements.liveStatus.querySelector('span').textContent = message;
  }

  function setActiveChoices() {
    for (const button of elements.symbolChoices.querySelectorAll('[data-symbol]')) {
      button.classList.toggle('is-active', button.dataset.symbol === state.symbol);
      button.setAttribute('aria-pressed', String(button.dataset.symbol === state.symbol));
    }
    for (const button of elements.periodChoices.querySelectorAll('[data-period]')) {
      button.classList.toggle('is-active', button.dataset.period === state.period);
      button.setAttribute('aria-pressed', String(button.dataset.period === state.period));
    }
  }

  function clearDraft() {
    state.draft = null;
    elements.draftPlaceholder.hidden = false;
    elements.draftErrors.hidden = true;
    elements.draftResult.hidden = true;
    elements.draftText.value = '';
    elements.copyDraft.textContent = '텍스트 복사';
  }

  function clearDerived() {
    clearDraft();
    elements.backtestEmpty.hidden = false;
    elements.backtestResult.hidden = true;
  }

  function identity() {
    const data = state.dashboard;
    return data ? `${data.snapshot.symbol}|${data.snapshot.period}|${data.snapshot.updatedAt}|${data.signal.direction}` : '';
  }

  function createText(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function renderTickers(snapshot) {
    const fragment = document.createDocumentFragment();
    for (const ticker of snapshot.tickers) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ticker-card${ticker.symbol === state.symbol ? ' is-selected' : ''}`;
      button.dataset.selectSymbol = ticker.symbol;
      button.setAttribute('aria-pressed', String(ticker.symbol === state.symbol));
      const title = createText('span', 'ticker-name', ticker.symbol.replace('USDT', ''));
      title.append(createText('small', '', 'USDT PERP'));
      const price = createText('strong', '', formatPrice(ticker.last));
      price.append(createText('small', '', `Vol ${formatCompact(ticker.quoteVolume)}`));
      const change = createText('span', ticker.change24h >= 0 ? 'is-positive' : 'is-negative', `${ticker.change24h >= 0 ? '+' : ''}${ticker.change24h.toFixed(2)}%`);
      button.append(title, price, change);
      fragment.append(button);
    }
    elements.tickerGrid.replaceChildren(fragment);
  }

  function renderChart(candles) {
    const sample = candles.slice(-90);
    const minimum = Math.min(...sample.map((item) => item.low));
    const maximum = Math.max(...sample.map((item) => item.high));
    const points = sample.map((item, index) => {
      const x = 20 + index / Math.max(1, sample.length - 1) * 860;
      const y = 20 + (maximum - item.close) / Math.max(0.00001, maximum - minimum) * 260;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    elements.priceLine.setAttribute('points', points);
  }

  function renderEvidence(target, items, emptyText) {
    const fragment = document.createDocumentFragment();
    if (!items.length) fragment.append(createText('p', 'evidence-empty', emptyText));
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'evidence-row';
      const body = document.createElement('div');
      body.append(createText('b', '', item.label), createText('span', '', item.detail));
      row.append(body, createText('em', '', `${item.impact > 0 ? '+' : ''}${item.impact.toFixed(1)}`));
      fragment.append(row);
    }
    target.replaceChildren(fragment);
  }

  function refreshLiveClock() {
    if (!state.dashboard) return false;
    const freshness = core.evaluateSnapshotQuality(state.dashboard.snapshot, Date.now());
    state.freshness = freshness;
    elements.freshnessText.textContent = formatAge(freshness.freshnessMs);
    elements.dashboard.dataset.quality = freshness.quality;
    if (!freshness.isLive) {
      clearDraft();
      elements.createDraft.disabled = true;
      elements.draftBlocked.hidden = false;
      elements.dashboardErrorText.textContent = '필수 component가 최신 상태가 아닙니다. 새 대시보드를 다시 불러오세요.';
      elements.dashboardError.hidden = false;
      setStatus('error', freshness.quality === 'stale' ? 'STALE · 새로고침 필요' : '데이터 검증 실패');
      return false;
    }
    elements.dashboardError.hidden = true;
    setStatus('live', 'LIVE · 8개 공개 GET 검증');
    return true;
  }

  function renderDashboard(payload) {
    const { snapshot, signal } = payload;
    clearDerived();
    renderTickers(snapshot);
    renderChart(snapshot.candles);
    elements.freshnessText.textContent = formatAge(snapshot.freshnessMs);
    elements.marketSymbol.textContent = snapshot.symbol.replace('USDT', '');
    elements.marketPrice.textContent = formatPrice(snapshot.ticker.last);
    elements.marketChange.textContent = `${snapshot.ticker.change24h >= 0 ? '+' : ''}${snapshot.ticker.change24h.toFixed(2)}%`;
    elements.marketChange.className = snapshot.ticker.change24h >= 0 ? 'is-positive' : 'is-negative';
    elements.marketLow.textContent = formatPrice(snapshot.ticker.low24h);
    elements.marketHigh.textContent = formatPrice(snapshot.ticker.high24h);
    const behavior = snapshot.behaviorSeries.at(-1);
    const longPercent = behavior.longRatio * 100;
    const buyPercent = behavior.buyVolume / (behavior.buyVolume + behavior.sellVolume) * 100;
    elements.longShortValue.textContent = `${behavior.longRatio.toFixed(2)} / ${behavior.shortRatio.toFixed(2)}`;
    elements.crowdLabel.textContent = signal.crowdState;
    elements.longRatioBar.style.width = `${Math.max(0, Math.min(100, longPercent))}%`;
    elements.takerValue.textContent = `${buyPercent.toFixed(1)}% BUY`;
    elements.takerLabel.textContent = buyPercent >= 50 ? '매수 우위' : '매도 우위';
    elements.takerRatioBar.style.width = `${Math.max(0, Math.min(100, buyPercent))}%`;
    elements.fundingValue.textContent = `${(snapshot.fundingRate * 100).toFixed(4)}%`;
    elements.interestValue.textContent = formatCompact(snapshot.openInterest);
    elements.signalPanel.className = `panel signal-panel is-${signal.direction === 'stand-aside' ? 'aside' : signal.direction}`;
    elements.signalArrow.textContent = signal.direction === 'long' ? '↗' : signal.direction === 'short' ? '↘' : '—';
    elements.signalDirection.textContent = signal.directionLabel;
    elements.signalContext.textContent = `${signal.regime} · ${signal.crowdState}`;
    elements.confidenceValue.textContent = `${signal.confidence} / 100`;
    elements.scoreValue.textContent = `SCORE ${signal.score > 0 ? '+' : ''}${signal.score}`;
    elements.signalEntry.textContent = formatPrice(snapshot.ticker.last);
    elements.signalInvalidation.textContent = formatPrice(signal.invalidationPrice);
    elements.signalTarget.textContent = formatPrice(signal.targetPrice);
    elements.supportTitle.textContent = signal.direction === 'long' ? '롱 지지 근거' : signal.direction === 'short' ? '숏 지지 근거' : '상방 요인';
    elements.counterTitle.textContent = signal.direction === 'long' ? '롱 반대 신호' : signal.direction === 'short' ? '숏 반대 신호' : '하방 요인';
    renderEvidence(elements.supportList, signal.evidence, '뚜렷한 지지 근거가 없습니다.');
    renderEvidence(elements.counterList, signal.counterSignals, '현재 감지된 강한 반대 신호가 없습니다.');
    elements.marketLeverage.textContent = `시장 ${snapshot.maxLeverage}x`;
    elements.dashboard.setAttribute('aria-busy', 'false');
    updateDraftAvailability();
  }

  async function loadDashboard() {
    const requestId = state.request + 1;
    state.request = requestId;
    state.controller?.abort();
    state.controller = new AbortController();
    state.dashboard = null;
    state.freshness = null;
    setActiveChoices();
    clearDerived();
    elements.dashboard.setAttribute('aria-busy', 'true');
    elements.dashboardError.hidden = true;
    setStatus('loading', '공개 데이터 확인 중');
    try {
      const response = await fetch(`${API_URL}/api/behavior-lab/dashboard?symbol=${encodeURIComponent(state.symbol)}&period=${encodeURIComponent(state.period)}`, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'application/json', authorization: `Bearer ${ownerToken()}` },
        signal: state.controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (requestId !== state.request) return;
      if (response.status === 401 || response.status === 404) throw new OwnerAccessError(response.status);
      if (!response.ok) throw new Error(payload.error || '공개 데이터를 불러오지 못했습니다.');
      if (!validPayload(payload, state.symbol, state.period)) throw new Error('검증되지 않은 응답을 표시하지 않았습니다.');
      state.dashboard = payload;
      renderDashboard(payload);
    } catch (error) {
      if (error.name === 'AbortError' || requestId !== state.request) return;
      if (error instanceof OwnerAccessError) {
        showOwnerGate(error.status);
        return;
      }
      elements.dashboard.setAttribute('aria-busy', 'false');
      elements.dashboardErrorText.textContent = error.message || '공개 데이터를 불러오지 못했습니다.';
      elements.dashboardError.hidden = false;
      setStatus('error', '데이터 검증 실패');
      updateDraftAvailability();
    }
  }

  function metricRows(target, metrics) {
    const profitFactor = metrics.profitFactor.kind === 'finite'
      ? metrics.profitFactor.value.toFixed(2)
      : metrics.profitFactor.kind === 'infinite' ? '∞ (손실 없음)' : '— (거래 없음)';
    const rows = [
      ['거래 수', String(metrics.tradeCount)],
      ['승률', `${(metrics.winRate * 100).toFixed(1)}%`],
      ['기대값/회', `${(metrics.expectancy * 100).toFixed(2)}%`],
      ['최대 낙폭', `${(metrics.maxDrawdown * 100).toFixed(2)}%`],
      ['Profit factor', profitFactor],
      ['순수익률', `${metrics.netReturn >= 0 ? '+' : ''}${(metrics.netReturn * 100).toFixed(2)}%`],
    ];
    target.replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement('div');
      row.append(createText('span', '', label), createText('b', '', value));
      return row;
    }));
  }

  function runBacktest() {
    if (!state.dashboard) return;
    const before = identity();
    try {
      const result = core.runWalkForwardBacktest(state.dashboard.snapshot.candles);
      if (before !== identity()) return;
      elements.backtestChronology.textContent = result.chronology;
      metricRows(elements.inSampleMetrics, result.inSample);
      metricRows(elements.outSampleMetrics, result.outOfSample);
      const windows = result.windows.map((window) => {
        const row = document.createElement('div');
        row.append(
          createText('b', '', `W${window.index}`),
          createText('span', '', `학습 ${new Date(window.trainingStartTs).toLocaleDateString('ko-KR')}–${new Date(window.trainingEndTs).toLocaleDateString('ko-KR')} · ${window.trainingTradeCount}회`),
          createText('span', '', `검증 ${new Date(window.testStartTs).toLocaleDateString('ko-KR')}–${new Date(window.testEndTs).toLocaleDateString('ko-KR')} · ${window.testTradeCount}회`),
          createText('em', '', `보유 ${window.holdingBars}봉`),
        );
        return row;
      });
      elements.windowList.replaceChildren(...windows);
      elements.backtestEmpty.hidden = true;
      elements.backtestResult.hidden = false;
    } catch (error) {
      elements.backtestEmpty.querySelector('p').textContent = error.message || '백테스트를 실행하지 못했습니다.';
    }
  }

  function updateDraftAvailability() {
    const live = state.dashboard ? refreshLiveClock() : false;
    const ready = Boolean(live
      && state.dashboard.signal.direction !== 'stand-aside'
      && finite(state.dashboard.snapshot.maxLeverage)
      && riskInputs.every((input) => input.value.trim()));
    elements.createDraft.disabled = !ready;
    elements.draftBlocked.hidden = ready;
  }

  function createDraft() {
    if (!state.dashboard) return;
    const before = identity();
    const result = core.createFreshManualDraft({
      seed: Number(elements.riskSeed.value),
      maxLossPct: Number(elements.riskLoss.value),
      leverageCap: Number(elements.riskLeverage.value),
      stopDistancePct: Number(elements.riskStop.value),
    }, {
      symbol: state.dashboard.snapshot.symbol,
      period: state.dashboard.snapshot.period,
      snapshotUpdatedAt: state.dashboard.snapshot.updatedAt,
      entry: state.dashboard.snapshot.ticker.last,
      direction: state.dashboard.signal.direction,
      marketMaxLeverage: state.dashboard.snapshot.maxLeverage,
    }, state.dashboard.snapshot, Date.now());
    if (before !== identity()) return;
    if (!result.freshness?.isLive) {
      refreshLiveClock();
      return;
    }
    state.draft = result;
    elements.draftPlaceholder.hidden = true;
    elements.draftErrors.hidden = result.valid;
    elements.draftResult.hidden = !result.valid;
    if (!result.valid) {
      elements.draftErrors.replaceChildren(createText('b', '', '초안 생성 차단'), ...result.errors.map((message) => createText('p', '', `· ${message}`)));
      return;
    }
    elements.draftText.value = result.text;
    elements.copyDraft.textContent = '텍스트 복사';
  }

  async function copyDraft() {
    if (!state.draft?.valid || elements.draftText.value !== state.draft.text) return;
    if (!refreshLiveClock()) return;
    try {
      await navigator.clipboard.writeText(state.draft.text);
    } catch {
      elements.draftText.focus();
      elements.draftText.select();
      document.execCommand('copy');
      elements.draftText.setSelectionRange(0, 0);
    }
    elements.copyDraft.textContent = '복사 완료';
  }

  function showOwnerGate(status = 0) {
    state.paperRequestId += 1;
    state.paperController?.abort();
    state.paperController = null;
    state.paperLoading = false;
    state.ownerVerified = false;
    state.paper = null;
    state.experiment = null;
    elements.paperReport.hidden = true;
    elements.paperExperiment.hidden = true;
    elements.paperReport.dataset.freshness = 'stale';
    elements.paperReport.setAttribute('aria-busy', 'false');
    elements.paperAdaptive.hidden = true;
    elements.paperEmpty.hidden = true;
    elements.paperError.hidden = true;
    elements.refreshPaper.disabled = false;
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

  function switchTab(tab) {
    const next = tab === 'paper' ? 'paper' : 'market';
    state.activeTab = next;
    const paperActive = next === 'paper';
    elements.marketTab.classList.toggle('is-active', !paperActive);
    elements.marketTab.setAttribute('aria-selected', String(!paperActive));
    elements.paperTab.classList.toggle('is-active', paperActive);
    elements.paperTab.setAttribute('aria-selected', String(paperActive));
    elements.marketTabPanel.hidden = paperActive;
    elements.paperTabPanel.hidden = !paperActive;
    history.replaceState(null, '', paperActive ? '#paper' : '#market');
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

  function renderPaperPosition(position) {
    if (!position) {
      elements.paperPosition.replaceChildren(detailCell('상태', '열린 포지션 없음'));
      return;
    }
    const labels = {
      symbol: '심볼', direction: '방향', side: '방향', entry_price: '진입가', mark_price: '현재가',
      current_price: '현재가', quantity: '수량', notional: '명목가치', leverage: '레버리지',
      stop_price: '손절가', target_price: '목표가', opened_at: '진입 시각', bars_held: '보유 봉',
      unrealized_pnl: '미실현 손익',
    };
    const rows = Object.entries(position).slice(0, 16).map(([key, value]) => detailCell(labels[key] || key, value));
    elements.paperPosition.replaceChildren(...rows);
  }

  function tradeField(trade, ...keys) {
    for (const key of keys) if (trade[key] !== undefined && trade[key] !== null) return trade[key];
    return null;
  }

  function renderPaperTrades(trades) {
    if (!trades.length) {
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.textContent = '아직 종료된 거래가 없습니다.';
      const row = document.createElement('tr');
      row.append(cell);
      elements.paperTradesBody.replaceChildren(row);
      return;
    }
    const rows = trades.map((trade) => {
      const row = document.createElement('tr');
      const entry = tradeField(trade, 'entry_price', 'entry');
      const exit = tradeField(trade, 'exit_price', 'exit');
      const values = [
        tradeField(trade, 'symbol') || '—',
        tradeField(trade, 'direction', 'side') || '—',
        `${paperValue(entry)} → ${paperValue(exit)}`,
        formatUsdt(tradeField(trade, 'net_pnl', 'pnl'), true),
        tradeField(trade, 'exit_reason', 'reason') || '—',
      ];
      row.replaceChildren(...values.map((value) => createText('td', '', value)));
      return row;
    });
    elements.paperTradesBody.replaceChildren(...rows);
  }

  function renderPaperLogs(logs) {
    const rows = logs.length ? logs.map((log) => {
      const row = document.createElement('li');
      const at = log.at ?? log.timestamp ?? log.generated_at ?? '';
      const message = log.message ?? log.event ?? log.type ?? JSON.stringify(log);
      if (at) row.append(createText('time', '', formatKoreanTime(at)));
      row.append(createText('span', '', String(message || '기록')));
      return row;
    }) : [createText('li', '', '아직 로그가 없습니다.')];
    elements.paperLogs.replaceChildren(...rows);
  }

  function validExperimentReport(experiment) {
    const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
    const armIds = ['A', 'B', 'C'];
    const strategyIds = ['abc-trend-momentum-v1', 'abc-breakout-volatility-v1', 'abc-mean-reversion-crowd-fade-v1'];
    const started = Date.parse(experiment?.started_at);
    const deadline = Date.parse(experiment?.deadline_at);
    return Boolean(experiment && experiment.schema === 'abc-paper-experiment-v1'
      && experiment.experiment_id === 'abc-paper-20260831' && experiment.simulation === true
      && experiment.public_data_only === true && Number.isFinite(started) && deadline - started === 24 * 60 * 60_000
      && ['starting', 'active', 'complete', 'error'].includes(experiment.status)
      && Number.isInteger(experiment.shared_feed?.sequence) && experiment.shared_feed.sequence > 0
      && hash(experiment.shared_feed.hash) && experiment.shared_feed.credential_used === false
      && JSON.stringify(experiment.shared_feed.symbols) === JSON.stringify(SYMBOLS)
      && JSON.stringify(experiment.shared_feed.channels) === JSON.stringify(['ticker', 'books5', 'trade', 'candle1m'])
      && experiment.assumptions?.seed_equity_per_arm === 100 && experiment.assumptions.max_positions_per_arm === 1
      && experiment.assumptions.strategy_mutation === false && Array.isArray(experiment.leaderboard)
      && experiment.leaderboard.length === 3 && Array.isArray(experiment.arms) && experiment.arms.length === 3
      && experiment.arms.every((arm, index) => arm.arm_id === armIds[index] && arm.strategy?.id === strategyIds[index]
        && hash(arm.strategy.definition_hash) && Number.isInteger(arm.chain?.sequence) && arm.chain.sequence > 0
        && hash(arm.chain.hash) && finite(arm.equity) && finite(arm.net_pnl) && finite(arm.return_pct)
        && finite(arm.max_drawdown_pct) && finite(arm.fees) && finite(arm.slippage_cost)
        && Number.isInteger(arm.trade_count) && Array.isArray(arm.recent_trades) && arm.recent_trades.length <= 25
        && Array.isArray(arm.recent_decisions) && arm.recent_decisions.length <= 20
        && Array.isArray(arm.recent_logs) && arm.recent_logs.length <= 30)
      && Array.isArray(experiment.limitations));
  }

  function renderExperimentList(items, emptyText, renderer) {
    const list = document.createElement('ol');
    list.className = 'paper-logs abc-list';
    list.replaceChildren(...(items.length ? items.map(renderer) : [createText('li', '', emptyText)]));
    return list;
  }

  function renderExperimentArm(arm) {
    const card = document.createElement('article');
    card.className = 'panel abc-arm-card';
    const heading = document.createElement('div');
    heading.className = 'abc-arm-heading';
    heading.append(
      createText('span', 'abc-arm-id', arm.arm_id),
      createText('div', '', ''),
    );
    heading.lastElementChild.append(createText('p', 'section-index', arm.strategy.label), createText('h3', '', arm.strategy.id));
    const metrics = document.createElement('div');
    metrics.className = 'abc-arm-metrics';
    metrics.append(
      detailCell('자산', formatUsdt(arm.equity)), detailCell('순손익', formatUsdt(arm.net_pnl, true)),
      detailCell('수익률', formatPercent(arm.return_pct, true)), detailCell('최대 낙폭', formatPercent(arm.max_drawdown_pct)),
      detailCell('비용', `${formatUsdt(arm.fees + arm.slippage_cost)} · 수수료 ${formatUsdt(arm.fees)}`),
      detailCell('거래', `${arm.trade_count}회 · ${arm.win_count}승 ${arm.loss_count}패`),
    );
    const position = document.createElement('section');
    position.className = 'abc-arm-section';
    position.append(createText('h4', '', '현재 포지션'));
    const positionGrid = document.createElement('div');
    positionGrid.className = 'paper-kv';
    if (!arm.open_position) positionGrid.append(detailCell('상태', '열린 포지션 없음'));
    else positionGrid.append(...Object.entries(arm.open_position).slice(0, 12).map(([key, value]) => detailCell(key, value)));
    position.append(positionGrid);
    const decisions = document.createElement('section');
    decisions.className = 'abc-arm-section';
    decisions.append(createText('h4', '', '최근 판단'));
    decisions.append(renderExperimentList(arm.recent_decisions, '아직 판단이 없습니다.', (decision) => {
      const row = document.createElement('li');
      row.append(createText('time', '', formatKoreanTime(decision.observed_at)),
        createText('span', '', `${decision.symbol} · ${decision.direction} · score ${paperValue(decision.score)}`),
        createText('small', '', `feed #${decision.feed_sequence} · ${String(decision.feed_hash).slice(0, 12)}… · ${decision.reason || 'entry candidate'}`));
      return row;
    }));
    const logs = document.createElement('section');
    logs.className = 'abc-arm-section';
    logs.append(createText('h4', '', '최근 로그'));
    logs.append(renderExperimentList(arm.recent_logs, '아직 로그가 없습니다.', (log) => {
      const row = document.createElement('li');
      row.append(createText('time', '', formatKoreanTime(log.at)), createText('span', '', log.message),
        createText('small', '', `#${log.sequence} · ${log.type}`));
      return row;
    }));
    const chain = createText('p', 'abc-chain', `arm chain #${arm.chain.sequence} · ${arm.chain.hash.slice(0, 16)}… · ${arm.strategy.definition_hash.slice(0, 12)}…`);
    card.append(heading, metrics, position, decisions, logs, chain);
    return card;
  }

  function renderExperiment(experiment) {
    state.experiment = experiment;
    const labels = { starting: 'STARTING · 준비', active: 'ACTIVE · 동시 진행', complete: 'COMPLETE · 24h 종료', error: 'ERROR · 확인 필요' };
    elements.experimentStatus.className = `adaptive-stream ${experiment.status === 'active' || experiment.status === 'complete' ? 'is-live' : experiment.status === 'starting' ? 'is-connecting' : 'is-error'}`;
    elements.experimentStatus.textContent = labels[experiment.status];
    elements.experimentStarted.textContent = formatKoreanTime(experiment.started_at);
    elements.experimentDeadline.textContent = formatKoreanTime(experiment.deadline_at);
    elements.experimentFeed.textContent = `#${experiment.shared_feed.sequence} · ${experiment.shared_feed.hash.slice(0, 16)}…`;
    elements.experimentLastPacket.textContent = formatKoreanTime(experiment.shared_feed.last_packet_at);
    elements.experimentLeaderboard.replaceChildren(...experiment.leaderboard.map((entry) => {
      const arm = experiment.arms.find((item) => item.arm_id === entry.arm_id);
      const row = document.createElement('tr');
      row.replaceChildren(createText('td', '', String(entry.rank)), createText('td', '', `${entry.arm_id} · ${arm.strategy.label}`),
        createText('td', '', formatUsdt(entry.equity)), createText('td', '', `${formatUsdt(entry.net_pnl, true)} / ${formatPercent(entry.return_pct, true)}`),
        createText('td', '', formatPercent(entry.max_drawdown_pct)));
      return row;
    }));
    elements.experimentArms.replaceChildren(...experiment.arms.map(renderExperimentArm));
    elements.paperExperiment.hidden = false;
    elements.paperExperiment.setAttribute('aria-busy', 'false');
  }

  function validAdaptiveReport(adaptive) {
    const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
    const strategy = (value, metrics = false) => Boolean(value
      && /^[a-z0-9][a-z0-9-]{2,63}$/u.test(value.id) && Number.isInteger(value.version) && value.version > 0
      && hash(value.hash) && (!metrics || (Number.isInteger(value.trade_count) && value.trade_count >= 0
        && finite(value.expectancy) && finite(value.max_drawdown_pct) && finite(value.cost_bps))));
    const exactCadence = adaptive?.cadence?.regime === '5m' && adaptive.cadence.candidate === 'completed-1m'
      && adaptive.cadence.risk === 'ticker-event' && adaptive.cadence.microstructure === '1s/3s-persistence'
      && adaptive.cadence.weight_checkpoint === '15m' && adaptive.cadence.challenger_checkpoint === '24h-minimum';
    const recent = adaptive?.audit?.recent;
    return Boolean(adaptive && adaptive.engine_version === 'realtime-paper-v2' && adaptive.strategy_schema === 1
      && exactCadence && Number.isFinite(Date.parse(adaptive.upgraded_at))
      && ['connecting', 'live', 'stale', 'stopped', 'error'].includes(adaptive.stream?.status)
      && (adaptive.stream.last_packet_at === null || Number.isFinite(Date.parse(adaptive.stream.last_packet_at)))
      && Number.isInteger(adaptive.stream.reconnect_count) && adaptive.stream.reconnect_count >= 0
      && adaptive.stream.credential_used === false && strategy(adaptive.champion)
      && Array.isArray(adaptive.challengers) && adaptive.challengers.length <= 8
      && adaptive.challengers.every((entry) => strategy(entry, true))
      && ['collecting', 'held', 'promoted', 'rolled-back'].includes(adaptive.promotion?.status)
      && Array.isArray(adaptive.promotion.reasons) && adaptive.promotion.reasons.length <= 12
      && Number.isInteger(adaptive.audit?.sequence) && adaptive.audit.sequence >= 0
      && (adaptive.audit.sequence === 0 ? adaptive.audit.hash === 'GENESIS' : hash(adaptive.audit.hash))
      && Array.isArray(recent) && recent.length <= 20
      && recent.every((entry) => Number.isInteger(entry.sequence) && entry.sequence > 0
        && Number.isFinite(Date.parse(entry.at)) && typeof entry.kind === 'string'
        && typeof entry.message === 'string' && hash(entry.hash)));
  }

  function renderAdaptiveReport(adaptive) {
    if (!adaptive) {
      elements.paperAdaptive.hidden = true;
      return;
    }
    const streamLabels = {
      connecting: 'CONNECTING · 공개 스트림 연결 중', live: 'LIVE · ticker 위험 평가 중',
      stale: 'STALE · 신규 진입 차단', stopped: 'STOPPED · 스트림 종료', error: 'ERROR · 스트림 오류',
    };
    elements.adaptiveStream.className = `adaptive-stream is-${adaptive.stream.status}`;
    elements.adaptiveStream.textContent = streamLabels[adaptive.stream.status];
    elements.adaptiveCadence.textContent = '5분 체제 · 완성 1분 후보 · ticker 위험 · 1초/3초 지속';
    elements.adaptiveUpgraded.textContent = formatKoreanTime(adaptive.upgraded_at);
    elements.adaptiveAuditRef.textContent = `#${adaptive.audit.sequence} · ${adaptive.audit.hash.slice(0, 12)}…`;
    elements.adaptiveLastPacket.textContent = adaptive.stream.last_packet_at
      ? `${formatKoreanTime(adaptive.stream.last_packet_at)} · 재연결 ${adaptive.stream.reconnect_count}회`
      : `아직 없음 · 재연결 ${adaptive.stream.reconnect_count}회`;
    elements.adaptiveChampion.replaceChildren(
      detailCell('전략', adaptive.champion.id),
      detailCell('버전', `v${adaptive.champion.version}`),
      detailCell('정의 hash', `${adaptive.champion.hash.slice(0, 16)}…`),
    );

    const promotionLabels = { collecting: '증거 수집 중', held: '현 챔피언 유지', promoted: '도전자 승격', 'rolled-back': '승격 롤백' };
    const route = adaptive.promotion.from && adaptive.promotion.to
      ? `${adaptive.promotion.from} → ${adaptive.promotion.to}` : '변경 없음';
    elements.adaptivePromotion.replaceChildren(
      detailCell('결정', promotionLabels[adaptive.promotion.status]),
      detailCell('최근 checkpoint', adaptive.promotion.last_checkpoint_at),
      detailCell('전환', route),
    );
    elements.adaptivePromotionReasons.replaceChildren(...adaptive.promotion.reasons.map((reason) => createText('li', '', reason)));

    const challengerRows = adaptive.challengers.length ? adaptive.challengers.map((challenger) => {
      const row = document.createElement('tr');
      row.replaceChildren(
        createText('td', '', `${challenger.id} · v${challenger.version}`),
        createText('td', '', `${challenger.trade_count}회`),
        createText('td', '', formatUsdt(challenger.expectancy, true)),
        createText('td', '', formatPercent(challenger.max_drawdown_pct)),
        createText('td', '', `${paperValue(challenger.cost_bps)} bps`),
      );
      return row;
    }) : [(() => {
      const row = document.createElement('tr');
      const cell = createText('td', '', '등록된 shadow challenger가 없습니다.');
      cell.colSpan = 5;
      row.append(cell);
      return row;
    })()];
    elements.adaptiveChallengersBody.replaceChildren(...challengerRows);

    const auditRows = adaptive.audit.recent.length ? adaptive.audit.recent.map((entry) => {
      const row = document.createElement('li');
      row.append(
        createText('time', '', formatKoreanTime(entry.at)),
        createText('span', '', entry.message),
        createText('small', '', `#${entry.sequence} · ${entry.kind} · ${entry.hash.slice(0, 12)}…`),
      );
      return row;
    }) : [createText('li', '', '아직 감사 로그가 없습니다.')];
    elements.adaptiveAudit.replaceChildren(...auditRows);
    elements.paperAdaptive.hidden = false;
  }

  function validPaperReport(report) {
    return Boolean(report && report.session_id === 'paper-20260831-100usd'
      && report.simulation === true && report.deadline_at === '2026-08-30T23:00:00.000Z'
      && ['starting', 'active', 'halted', 'complete', 'error'].includes(report.status)
      && finite(report.equity) && finite(report.net_pnl) && finite(report.return_pct)
      && Array.isArray(report.recent_trades) && report.recent_trades.length <= 25
      && Array.isArray(report.recent_logs) && report.recent_logs.length <= 50
      && Array.isArray(report.limitations)
      && (report.adaptive === undefined || validAdaptiveReport(report.adaptive)));
  }

  function renderPaper(report) {
    state.paper = report;
    elements.paperReport.dataset.freshness = 'fresh';
    elements.paperError.hidden = true;
    paperStatus(report.status);
    elements.paperDeadline.textContent = formatKoreanTime(report.deadline_at);
    elements.paperLastCycle.textContent = formatKoreanTime(report.last_cycle_at);
    elements.paperSequence.textContent = String(report.sequence);
    elements.paperEquity.textContent = formatUsdt(report.equity);
    elements.paperNetPnl.textContent = formatUsdt(report.net_pnl, true);
    elements.paperNetPnl.className = report.net_pnl > 0 ? 'is-positive' : report.net_pnl < 0 ? 'is-negative' : '';
    elements.paperReturn.textContent = formatPercent(report.return_pct, true);
    elements.paperDrawdown.textContent = formatPercent(report.max_drawdown_pct);
    elements.paperCosts.textContent = formatUsdt(report.fees + report.slippage_cost);
    elements.paperCostDetail.textContent = `수수료 ${formatUsdt(report.fees)} · 슬리피지 ${formatUsdt(report.slippage_cost)}`;
    elements.paperTrades.textContent = `${report.trade_count}회`;
    elements.paperRecord.textContent = `${report.win_count}승 · ${report.loss_count}패`;
    elements.paperCash.textContent = formatUsdt(report.cash);
    elements.paperUnrealized.textContent = `미실현 ${formatUsdt(report.unrealized_pnl, true)} · 실현 ${formatUsdt(report.realized_pnl, true)}`;
    renderPaperPosition(report.open_position);
    renderPaperTrades(report.recent_trades);
    renderPaperLogs(report.recent_logs);
    renderAdaptiveReport(report.adaptive);
    elements.paperLimitations.replaceChildren(...report.limitations.map((item) => createText('li', '', item)));
    elements.paperEmpty.hidden = true;
    elements.paperReport.hidden = false;
    elements.paperReport.setAttribute('aria-busy', 'false');
  }

  function markPaperRefreshError(error, timedOut = false) {
    const fallback = timedOut ? '모의투자 보고 요청 시간이 초과되었습니다.' : '모의투자 보고를 불러오지 못했습니다.';
    const message = timedOut ? fallback : error?.message || fallback;
    const retained = Boolean((state.paper && !elements.paperReport.hidden) || (state.experiment && !elements.paperExperiment.hidden));
    elements.paperErrorText.textContent = retained
      ? `${message} 업데이트하지 못했습니다. 이전 보고를 표시합니다.`
      : message;
    elements.paperError.hidden = false;
    if (retained) {
      elements.paperReport.dataset.freshness = 'stale';
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
    elements.paperReport.setAttribute('aria-busy', 'true');
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
      if (!payload.report && !payload.experiment) {
        state.paper = null; state.experiment = null;
        paperStatus('starting');
        elements.paperReport.hidden = true;
        elements.paperExperiment.hidden = true;
        elements.paperAdaptive.hidden = true;
        elements.paperEmpty.hidden = false;
        elements.paperError.hidden = true;
        return;
      }
      if (payload.report) {
        if (!validPaperReport(payload.report)) throw new Error('검증되지 않은 모의투자 보고는 표시하지 않았습니다.');
        renderPaper(payload.report);
      } else { state.paper = null; elements.paperReport.hidden = true; elements.paperAdaptive.hidden = true; }
      if (payload.experiment) {
        if (!validExperimentReport(payload.experiment)) throw new Error('검증되지 않은 A/B/C 모의실험 보고는 표시하지 않았습니다.');
        renderExperiment(payload.experiment);
      } else { state.experiment = null; elements.paperExperiment.hidden = true; }
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
        elements.paperReport.setAttribute('aria-busy', 'false');
        elements.paperExperiment.setAttribute('aria-busy', 'false');
        elements.refreshPaper.disabled = false;
      }
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
      switchTab(location.hash === '#paper' ? 'paper' : 'market');
      void loadDashboard();
    } catch (error) {
      showOwnerGate(error instanceof OwnerAccessError ? error.status : 0);
    }
  }

  elements.symbolChoices.addEventListener('click', (event) => {
    const button = event.target.closest('[data-symbol]');
    if (!button || !SYMBOLS.includes(button.dataset.symbol) || button.dataset.symbol === state.symbol) return;
    state.symbol = button.dataset.symbol;
    void loadDashboard();
  });
  elements.periodChoices.addEventListener('click', (event) => {
    const button = event.target.closest('[data-period]');
    if (!button || !PERIODS.includes(button.dataset.period) || button.dataset.period === state.period) return;
    state.period = button.dataset.period;
    void loadDashboard();
  });
  elements.tickerGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-select-symbol]');
    if (!button || !SYMBOLS.includes(button.dataset.selectSymbol) || button.dataset.selectSymbol === state.symbol) return;
    state.symbol = button.dataset.selectSymbol;
    void loadDashboard();
  });
  elements.retryDashboard.addEventListener('click', () => void loadDashboard());
  elements.runBacktest.addEventListener('click', runBacktest);
  elements.createDraft.addEventListener('click', createDraft);
  elements.copyDraft.addEventListener('click', () => void copyDraft());
  elements.marketTab.addEventListener('click', () => switchTab('market'));
  elements.paperTab.addEventListener('click', () => switchTab('paper'));
  elements.refreshPaper.addEventListener('click', () => void loadPaper({ force: true }));
  elements.retryOwnerGate.addEventListener('click', () => void bootstrap());
  riskInputs.forEach((input) => input.addEventListener('input', () => {
    clearDraft();
    updateDraftAvailability();
  }));

  window.setInterval(refreshLiveClock, 1_000);
  window.setInterval(() => {
    if (state.ownerVerified) void loadPaper();
  }, PAPER_REFRESH_MS);
  void bootstrap();
})();
