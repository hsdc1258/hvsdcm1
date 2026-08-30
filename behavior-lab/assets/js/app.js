(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = /^(?:127\.0\.0\.1|localhost)$/u.test(location.hostname) ? location.origin : DEFAULT_API_URL;
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const PERIODS = ['5m', '15m', '1h', '4h'];
  const core = window.BehaviorLabCore;
  const state = { symbol: 'BTCUSDT', period: '5m', dashboard: null, request: 0, controller: null, draft: null };

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
    marketChange: document.getElementById('marketChange'),
    marketHigh: document.getElementById('marketHigh'),
    marketLeverage: document.getElementById('marketLeverage'),
    marketLow: document.getElementById('marketLow'),
    marketPrice: document.getElementById('marketPrice'),
    marketSymbol: document.getElementById('marketSymbol'),
    outSampleMetrics: document.getElementById('outSampleMetrics'),
    periodChoices: document.getElementById('periodChoices'),
    priceLine: document.getElementById('priceLine'),
    retryDashboard: document.getElementById('retryDashboard'),
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

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function validPayload(payload, symbol, period) {
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
      && Array.isArray(signal.evidence) && Array.isArray(signal.counterSignals));
  }

  function formatPrice(value) {
    if (!finite(value)) return '—';
    return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: value < 10 ? 4 : value < 1_000 ? 2 : 0 }).format(value);
  }

  function formatCompact(value) {
    return finite(value) ? new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
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

  function clearDerived() {
    state.draft = null;
    elements.backtestEmpty.hidden = false;
    elements.backtestResult.hidden = true;
    elements.draftPlaceholder.hidden = false;
    elements.draftErrors.hidden = true;
    elements.draftResult.hidden = true;
    elements.draftText.value = '';
    elements.copyDraft.textContent = '텍스트 복사';
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
        headers: { accept: 'application/json' },
        signal: state.controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (requestId !== state.request) return;
      if (!response.ok) throw new Error(payload.error || '공개 데이터를 불러오지 못했습니다.');
      if (!validPayload(payload, state.symbol, state.period)) throw new Error('검증되지 않은 응답을 표시하지 않았습니다.');
      state.dashboard = payload;
      renderDashboard(payload);
      setStatus('live', 'LIVE · 8개 공개 GET 검증');
    } catch (error) {
      if (error.name === 'AbortError' || requestId !== state.request) return;
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
    const ready = Boolean(state.dashboard
      && state.dashboard.signal.direction !== 'stand-aside'
      && finite(state.dashboard.snapshot.maxLeverage)
      && riskInputs.every((input) => input.value.trim()));
    elements.createDraft.disabled = !ready;
    elements.draftBlocked.hidden = ready;
  }

  function createDraft() {
    if (!state.dashboard) return;
    const before = identity();
    const result = core.createManualDraft({
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
    });
    if (before !== identity()) return;
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
  riskInputs.forEach((input) => input.addEventListener('input', () => {
    state.draft = null;
    elements.draftPlaceholder.hidden = false;
    elements.draftErrors.hidden = true;
    elements.draftResult.hidden = true;
    updateDraftAvailability();
  }));

  void loadDashboard();
})();
