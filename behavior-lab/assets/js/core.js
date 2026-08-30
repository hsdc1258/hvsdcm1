(() => {
  'use strict';

  const BACKTEST_FEE_BPS_PER_SIDE = 6;
  const BACKTEST_SLIPPAGE_BPS_PER_SIDE = 4;
  const BACKTEST_SIDE_COST_RATE = (BACKTEST_FEE_BPS_PER_SIDE + BACKTEST_SLIPPAGE_BPS_PER_SIDE) / 10_000;
  const RISK_ROUND_TRIP_COST_RATE = 2 * (BACKTEST_FEE_BPS_PER_SIDE + BACKTEST_SLIPPAGE_BPS_PER_SIDE) / 10_000;
  const INITIAL_EQUITY = 10_000;

  function average(candles, endExclusive, length, field) {
    const start = Math.max(0, endExclusive - length);
    const sample = candles.slice(start, endExclusive);
    return sample.reduce((sum, candle) => sum + candle[field], 0) / Math.max(1, sample.length);
  }

  function calculateNetReturn(entry, exit, direction) {
    return direction * (exit / entry - 1) - 2 * BACKTEST_SIDE_COST_RATE;
  }

  function simulate(candles, holdingBars, startIndex, endIndex) {
    const trades = [];
    for (let signalIndex = Math.max(36, startIndex - 1); signalIndex < endIndex - holdingBars - 1;) {
      const fast = average(candles, signalIndex + 1, 9, 'close');
      const slow = average(candles, signalIndex + 1, 30, 'close');
      const volumeNow = average(candles, signalIndex + 1, 6, 'volume');
      const volumeBase = average(candles, signalIndex + 1, 24, 'volume');
      const direction = fast > slow * 1.0015 ? 1 : fast < slow * 0.9985 ? -1 : 0;
      if (direction === 0 || volumeNow < volumeBase * 0.82) {
        signalIndex += 1;
        continue;
      }
      const entryIndex = signalIndex + 1;
      const exitIndex = Math.min(entryIndex + holdingBars, endIndex - 1);
      if (entryIndex < startIndex || exitIndex >= endIndex) {
        signalIndex += 1;
        continue;
      }
      const entryPrice = candles[entryIndex]?.open;
      const exitPrice = candles[exitIndex]?.close;
      if (!entryPrice || !exitPrice) break;
      trades.push({
        entryIndex,
        exitIndex,
        direction,
        entryPrice,
        exitPrice,
        netReturn: calculateNetReturn(entryPrice, exitPrice, direction),
      });
      signalIndex = exitIndex + 1;
    }
    return trades;
  }

  function calculateTradeMetrics(candles, trades) {
    let equity = INITIAL_EQUITY;
    let peak = equity;
    let maxDrawdown = 0;
    let wins = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    for (const trade of trades) {
      const baseEquity = equity;
      for (let index = trade.entryIndex; index <= trade.exitIndex; index += 1) {
        const candle = candles[index];
        if (!candle) continue;
        const favorablePrice = trade.direction === 1 ? candle.high : candle.low;
        const adversePrice = trade.direction === 1 ? candle.low : candle.high;
        const exitCost = index === trade.exitIndex ? BACKTEST_SIDE_COST_RATE : 0;
        const favorableReturn = trade.direction * (favorablePrice / trade.entryPrice - 1)
          - BACKTEST_SIDE_COST_RATE - exitCost;
        const adverseReturn = trade.direction * (adversePrice / trade.entryPrice - 1)
          - BACKTEST_SIDE_COST_RATE - exitCost;
        const favorableEquity = Math.max(0, baseEquity * (1 + favorableReturn));
        const adverseEquity = Math.max(0, baseEquity * (1 + adverseReturn));
        peak = Math.max(peak, favorableEquity);
        maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - adverseEquity) / peak : 0);
      }
      equity = Math.max(0, baseEquity * (1 + trade.netReturn));
      const realizedPnl = equity - baseEquity;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
      if (realizedPnl > 0) {
        wins += 1;
        grossProfit += realizedPnl;
      } else if (realizedPnl < 0) grossLoss += Math.abs(realizedPnl);
    }
    const profitFactor = trades.length === 0 || (grossProfit === 0 && grossLoss === 0)
      ? { kind: 'undefined' }
      : grossLoss === 0 ? { kind: 'infinite' } : { kind: 'finite', value: grossProfit / grossLoss };
    return {
      tradeCount: trades.length,
      winRate: trades.length ? wins / trades.length : 0,
      expectancy: trades.length ? trades.reduce((sum, trade) => sum + trade.netReturn, 0) / trades.length : 0,
      maxDrawdown,
      profitFactor,
      netReturn: equity / INITIAL_EQUITY - 1,
    };
  }

  function chooseHoldingBars(candles, endIndex) {
    const ranked = [4, 8, 12].map((holdingBars) => {
      const trades = simulate(candles, holdingBars, 36, endIndex);
      return {
        holdingBars,
        trainingTradeCount: trades.length,
        score: calculateTradeMetrics(candles, trades).expectancy,
      };
    }).sort((left, right) => right.score - left.score || left.holdingBars - right.holdingBars);
    return ranked[0] || { holdingBars: 8, trainingTradeCount: 0 };
  }

  function runWalkForwardBacktest(candles) {
    if (!Array.isArray(candles) || candles.length < 120) {
      throw new Error('워크포워드 검증에는 최소 120개 캔들이 필요합니다.');
    }
    const chronological = [...candles].sort((left, right) => left.ts - right.ts);
    if (chronological.some((candle, index) => index > 0 && candle.ts <= chronological[index - 1].ts)) {
      throw new Error('캔들 시각은 중복 없이 증가해야 합니다.');
    }
    const splitIndex = Math.floor(chronological.length * 0.6);
    const initial = chooseHoldingBars(chronological, splitIndex);
    const inSampleTrades = simulate(chronological, initial.holdingBars, 36, splitIndex);
    const windowSize = Math.ceil((chronological.length - splitIndex) / 4);
    const outOfSampleTrades = [];
    const windows = [];
    for (let windowIndex = 0; windowIndex < 4; windowIndex += 1) {
      const start = splitIndex + windowIndex * windowSize;
      const end = Math.min(chronological.length, start + windowSize);
      if (start >= end) continue;
      const selected = chooseHoldingBars(chronological, start);
      const testTrades = simulate(chronological, selected.holdingBars, start, end);
      outOfSampleTrades.push(...testTrades);
      windows.push({
        index: windowIndex + 1,
        trainingStartTs: chronological[36].ts,
        trainingEndTs: chronological[start - 1].ts,
        testStartTs: chronological[start].ts,
        testEndTs: chronological[end - 1].ts,
        holdingBars: selected.holdingBars,
        trainingTradeCount: selected.trainingTradeCount,
        testTradeCount: testTrades.length,
      });
    }
    return {
      assumptions: {
        feeBps: BACKTEST_FEE_BPS_PER_SIDE,
        slippageBps: BACKTEST_SLIPPAGE_BPS_PER_SIDE,
        initialHoldingBars: initial.holdingBars,
        initialEquity: INITIAL_EQUITY,
        drawdownModel: '보수적 OHLC intrabar mark-to-market',
      },
      splitAt: chronological[splitIndex].ts,
      inSample: calculateTradeMetrics(chronological, inSampleTrades),
      outOfSample: calculateTradeMetrics(chronological, outOfSampleTrades),
      walkForwardWindows: windows.length,
      windows,
      chronology: '가격·거래량 crowd-proxy만 사용. 신호는 해당 봉 종가까지, 진입은 다음 봉 시가. 각 검증 창의 보유 기간은 그 창 시작 전 데이터로만 선택.',
    };
  }

  function positive(value) {
    return Number.isFinite(value) && value > 0;
  }

  function createManualDraft(input, context) {
    const identity = {
      symbol: context.symbol,
      period: context.period,
      snapshotUpdatedAt: context.snapshotUpdatedAt,
      direction: context.direction,
    };
    const errors = [];
    if (!positive(input.seed)) errors.push('운용 기준 자금을 입력하세요.');
    if (!positive(input.maxLossPct) || input.maxLossPct > 10) errors.push('1회 최대 손실은 0% 초과 10% 이하로 입력하세요.');
    if (!Number.isFinite(input.leverageCap) || input.leverageCap < 1 || input.leverageCap > 20) {
      errors.push('레버리지 상한은 1~20배로 입력하세요.');
    }
    if (!positive(input.stopDistancePct) || input.stopDistancePct > 25) errors.push('손절 거리는 0% 초과 25% 이하로 입력하세요.');
    if (!positive(context.entry)) errors.push('유효한 기준 가격이 필요합니다.');
    if (!positive(context.marketMaxLeverage)) errors.push('1배 이상인 검증된 시장 레버리지 상한이 필요합니다.');
    if (!positive(context.snapshotUpdatedAt)) errors.push('유효한 데이터 시각이 필요합니다.');
    if (context.direction === 'stand-aside') errors.push('관망 신호에서는 초안을 만들지 않습니다.');
    if (errors.length) return { valid: false, errors, identity };

    const stopRate = input.stopDistancePct / 100;
    const riskBudget = input.seed * input.maxLossPct / 100;
    const effectiveLeverageCap = Math.min(input.leverageCap, context.marketMaxLeverage);
    const riskBoundNotional = riskBudget / (stopRate + RISK_ROUND_TRIP_COST_RATE);
    const leverageBoundNotional = input.seed * effectiveLeverageCap;
    const notional = Math.min(riskBoundNotional, leverageBoundNotional);
    const modeledLoss = notional * (stopRate + RISK_ROUND_TRIP_COST_RATE);
    const rawQuantityReference = notional / context.entry;
    const sign = context.direction === 'long' ? 1 : -1;
    const stop = context.entry * (1 - sign * stopRate);
    const target1 = context.entry * (1 + sign * stopRate);
    const target2 = context.entry * (1 + sign * stopRate * 2);
    const values = [riskBudget, effectiveLeverageCap, notional, modeledLoss, rawQuantityReference, stop, target1, target2];
    if (values.some((value) => !positive(value))) {
      return { valid: false, errors: ['계산 결과가 유효 범위를 벗어났습니다. 입력값을 낮추세요.'], identity };
    }
    if (modeledLoss > riskBudget + 1e-9) {
      return { valid: false, errors: ['보수적 총손실이 지정한 위험 예산을 초과합니다.'], identity };
    }
    const text = [
      '[수동 주문 참고 초안 — 전송/제출 기능 없음]',
      `심볼/주기: ${context.symbol} / ${context.period}`,
      `데이터 시각: ${new Date(context.snapshotUpdatedAt).toISOString()}`,
      `방향: ${context.direction === 'long' ? 'LONG 후보' : 'SHORT 후보'}`,
      `진입 시나리오: ${context.entry.toFixed(4)} 부근에서 조건을 사람이 재확인`,
      `무효화/손절: ${stop.toFixed(4)} (${input.stopDistancePct.toFixed(2)}%)`,
      `목표 1R: ${target1.toFixed(4)} / 목표 2R: ${target2.toFixed(4)}`,
      `위험 예산: ${riskBudget.toFixed(2)} USDT (${input.maxLossPct.toFixed(2)}%)`,
      `비용 가정: 왕복 ${(RISK_ROUND_TRIP_COST_RATE * 10_000).toFixed(0)}bps (fee+slippage)`,
      `보수적 총손실: ${modeledLoss.toFixed(2)} USDT 이하`,
      `명목 금액: ${notional.toFixed(2)} USDT / 적용 레버리지 상한: ${effectiveLeverageCap.toFixed(1)}x`,
      `원시 수량 참고: ${rawQuantityReference.toFixed(8)} (정밀도·최소수량 미검증, 주문 입력 금지)`,
      '무효화 조건: 손절 가격 도달 또는 근거 신호 반전 시 폐기',
      '실행 경계: 거래소 화면에서 사용자가 직접 검토·입력해야 합니다.',
    ].join('\n');
    return {
      valid: true,
      errors: [],
      riskBudget,
      notional,
      rawQuantityReference,
      modeledLoss,
      costRate: RISK_ROUND_TRIP_COST_RATE,
      effectiveLeverageCap,
      identity,
      text,
    };
  }

  window.BehaviorLabCore = Object.freeze({
    BACKTEST_FEE_BPS_PER_SIDE,
    BACKTEST_SLIPPAGE_BPS_PER_SIDE,
    RISK_ROUND_TRIP_COST_RATE,
    calculateNetReturn,
    createManualDraft,
    runWalkForwardBacktest,
  });
})();
