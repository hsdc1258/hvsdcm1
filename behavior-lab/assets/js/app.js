(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = /^(?:127\.0\.0\.1|localhost)$/u.test(location.hostname) ? location.origin : DEFAULT_API_URL;
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const PERIODS = ['5m', '15m', '1h', '4h'];
  const core = window.BehaviorLabCore;
  const token = localStorage.getItem('hvsdcm.token') || '';
  const state = {
    symbol: 'BTCUSDT', period: '5m', dashboard: null, request: 0, controller: null, draft: null, freshness: null,
    ownerVerified: false, paper: null, activeTab: 'market',
  };

  const elements = {
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
    paperLastCycle: document.getElementById('paperLastCycle'),
    paperLimitations: document.getElementById('paperLimitations'),
    paperLogs: document.getElementById('paperLogs'),
    paperNetPnl: document.getElementById('paperNetPnl'),
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
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
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
    state.ownerVerified = false;
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

  function validPaperReport(report) {
    return Boolean(report && report.session_id === 'paper-20260831-100usd'
      && report.simulation === true && report.deadline_at === '2026-08-30T23:00:00.000Z'
      && ['starting', 'active', 'halted', 'complete', 'error'].includes(report.status)
      && finite(report.equity) && finite(report.net_pnl) && finite(report.return_pct)
      && Array.isArray(report.recent_trades) && report.recent_trades.length <= 25
      && Array.isArray(report.recent_logs) && report.recent_logs.length <= 50
      && Array.isArray(report.limitations));
  }

  function renderPaper(report) {
    state.paper = report;
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
    elements.paperLimitations.replaceChildren(...report.limitations.map((item) => createText('li', '', item)));
    elements.paperEmpty.hidden = true;
    elements.paperReport.hidden = false;
    elements.paperReport.setAttribute('aria-busy', 'false');
  }

  async function loadPaper({ verifyOwner = false } = {}) {
    elements.paperError.hidden = true;
    elements.paperReport.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`${API_URL}/api/behavior-lab/paper`, {
        method: 'GET', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 404) throw new OwnerAccessError(response.status);
      if (!response.ok) throw new Error(payload.error || '모의투자 보고를 불러오지 못했습니다.');
      if (verifyOwner) unlockOwnerShell();
      if (!payload.report) {
        state.paper = null;
        paperStatus('starting');
        elements.paperReport.hidden = true;
        elements.paperEmpty.hidden = false;
        return;
      }
      if (!validPaperReport(payload.report)) throw new Error('검증되지 않은 모의투자 보고는 표시하지 않았습니다.');
      renderPaper(payload.report);
    } catch (error) {
      if (error instanceof OwnerAccessError || verifyOwner) throw error;
      elements.paperErrorText.textContent = error.message || '모의투자 보고를 불러오지 못했습니다.';
      elements.paperError.hidden = false;
      elements.paperReport.setAttribute('aria-busy', 'false');
    }
  }

  async function bootstrap() {
    if (!token) {
      showOwnerGate(401);
      return;
    }
    elements.retryOwnerGate.hidden = true;
    elements.ownerLoginLink.hidden = true;
    elements.ownerGateTitle.textContent = '접근 권한 확인 중';
    elements.ownerGateMessage.textContent = '소유자 전용 보고 API로 세션을 확인하고 있습니다.';
    try {
      await loadPaper({ verifyOwner: true });
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
  elements.refreshPaper.addEventListener('click', () => void loadPaper());
  elements.retryOwnerGate.addEventListener('click', () => void bootstrap());
  riskInputs.forEach((input) => input.addEventListener('input', () => {
    clearDraft();
    updateDraftAvailability();
  }));

  window.setInterval(refreshLiveClock, 1_000);
  window.setInterval(() => {
    if (state.ownerVerified) void loadPaper();
  }, 30_000);
  void bootstrap();
})();
