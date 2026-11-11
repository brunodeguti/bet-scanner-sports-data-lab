const EPSILON = 1e-12;

export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function assertDecimalOdds(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds <= 1) {
    throw new Error(`Odd decimal inválida: ${value}. Use um número maior que 1.`);
  }
  return odds;
}

export function impliedProbability(odds) {
  return 1 / assertDecimalOdds(odds);
}

export function noVigProbabilities(outcomeOdds) {
  if (!outcomeOdds || typeof outcomeOdds !== 'object') {
    throw new Error('Odds de referência são obrigatórias.');
  }
  const entries = Object.entries(outcomeOdds);
  if (![2, 3].includes(entries.length)) {
    throw new Error('O mercado de referência precisa ter 2 ou 3 resultados.');
  }
  const implied = entries.map(([outcome, odds]) => [outcome, impliedProbability(odds)]);
  const overround = implied.reduce((sum, [, probability]) => sum + probability, 0);
  return {
    overround,
    margin: overround - 1,
    probabilities: Object.fromEntries(
      implied.map(([outcome, probability]) => [outcome, probability / overround])
    )
  };
}

function allocateMoney(totalStake, weightedSelections) {
  const totalCents = Math.round(Number(totalStake) * 100);
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new Error('A stake total precisa ser maior que zero.');
  }

  const raw = weightedSelections.map((selection) => {
    const rawCents = totalCents * selection.weight;
    const baseCents = Math.floor(rawCents);
    return { ...selection, rawCents, baseCents, fraction: rawCents - baseCents };
  });
  let remainder = totalCents - raw.reduce((sum, item) => sum + item.baseCents, 0);
  const allocationOrder = [...raw].sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < remainder; i += 1) allocationOrder[i % allocationOrder.length].baseCents += 1;
  return raw.map((item) => ({ ...item, stake: item.baseCents / 100 }));
}

export function calculateSurebet(quotes, totalStake) {
  if (!Array.isArray(quotes) || quotes.length < 2) {
    throw new Error('Informe ao menos duas cotações.');
  }

  const bestByOutcome = new Map();
  for (const quote of quotes) {
    const outcome = String(quote.outcome ?? '').trim();
    if (!outcome) throw new Error('Toda cotação precisa de um resultado.');
    const odds = assertDecimalOdds(quote.odds);
    const current = bestByOutcome.get(outcome);
    if (!current || odds > current.odds) bestByOutcome.set(outcome, { ...quote, outcome, odds });
  }

  if (![2, 3].includes(bestByOutcome.size)) {
    throw new Error('Surebet aceita mercados completos de 2 ou 3 resultados.');
  }

  const selections = [...bestByOutcome.values()];
  const inverseSum = selections.reduce((sum, item) => sum + 1 / item.odds, 0);
  const isSurebet = inverseSum < 1 - EPSILON;
  const allocation = allocateMoney(
    totalStake,
    selections.map((item) => ({ ...item, weight: (1 / item.odds) / inverseSum }))
  ).map((item) => {
    const grossReturn = round2(item.stake * item.odds);
    return {
      outcome: item.outcome,
      bookmaker: item.bookmaker,
      odds: item.odds,
      stake: item.stake,
      grossReturn,
      netProfit: round2(grossReturn - Number(totalStake))
    };
  });

  const netProfits = allocation.map((item) => item.netProfit);
  const theoreticalReturn = Number(totalStake) / inverseSum;
  const theoreticalProfit = theoreticalReturn - Number(totalStake);

  return {
    isSurebet,
    totalStake: round2(totalStake),
    outcomes: allocation.length,
    inverseSum,
    impliedTotalPct: inverseSum * 100,
    theoreticalReturn: round2(theoreticalReturn),
    theoreticalProfit: round2(theoreticalProfit),
    theoreticalRoiPct: (theoreticalProfit / Number(totalStake)) * 100,
    roundedMinProfit: Math.min(...netProfits),
    roundedMaxProfit: Math.max(...netProfits),
    roundedRoiPct: (Math.min(...netProfits) / Number(totalStake)) * 100,
    allocation
  };
}

export function calculateEV({ odds, fairProbability, bankroll, fixedStake, kellyFraction = 0.25, maxExposurePct = 2, stakeMode = 'kelly' }) {
  const decimalOdds = assertDecimalOdds(odds);
  const probability = Number(fairProbability);
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new Error('A probabilidade justa precisa estar entre 0 e 1.');
  }
  const bank = Number(bankroll);
  if (!Number.isFinite(bank) || bank <= 0) throw new Error('A banca precisa ser maior que zero.');
  const fraction = Number(kellyFraction);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('Kelly fracionado precisa estar entre 0 e 1.');
  const exposure = Number(maxExposurePct);
  if (!Number.isFinite(exposure) || exposure <= 0 || exposure > 100) throw new Error('Exposição máxima precisa estar entre 0 e 100%.');

  const marketProbability = 1 / decimalOdds;
  const expectedValue = probability * decimalOdds - 1;
  const edge = probability - marketProbability;
  const fullKelly = Math.max(0, expectedValue / (decimalOdds - 1));
  const maxStake = bank * (exposure / 100);
  const rawKellyStake = bank * fullKelly * fraction;
  const fixed = Number(fixedStake);
  if (!['kelly', 'fixed'].includes(stakeMode)) throw new Error('Modo de stake +EV inválido.');
  if (stakeMode === 'fixed' && (!Number.isFinite(fixed) || fixed <= 0)) {
    throw new Error('A stake fixa precisa ser maior que zero.');
  }
  const suggestedStake = expectedValue > 0
    ? Math.min(stakeMode === 'fixed' ? fixed : rawKellyStake, maxStake)
    : 0;

  const alerts = [];
  if (expectedValue <= 0) alerts.push('Sem valor esperado positivo: não entrar.');
  if (suggestedStake >= maxStake - EPSILON && expectedValue > 0) alerts.push('Stake limitada pelo teto de exposição.');
  if (edge > 0.15) alerts.push('Edge muito alto: revise a probabilidade estimada e a origem dos dados.');

  return {
    odds: decimalOdds,
    fairProbability: probability,
    fairProbabilityPct: probability * 100,
    marketProbability,
    marketProbabilityPct: marketProbability * 100,
    fairOdds: 1 / probability,
    edge,
    edgePct: edge * 100,
    expectedValue,
    evPct: expectedValue * 100,
    fullKellyPct: fullKelly * 100,
    appliedKellyPct: fullKelly * fraction * 100,
    stakeMode,
    requestedStake: round2(stakeMode === 'fixed' ? fixed : rawKellyStake),
    suggestedStake: round2(suggestedStake),
    stakeWasCapped: expectedValue > 0 && suggestedStake >= maxStake - EPSILON && (stakeMode === 'fixed' ? fixed : rawKellyStake) > maxStake + EPSILON,
    expectedProfitAtSuggestedStake: round2(suggestedStake * expectedValue),
    maxStake: round2(maxStake),
    alerts
  };
}

export function consensusNoVig(quotes, outcomes) {
  const expected = [...new Set(outcomes)];
  const byBookmaker = new Map();
  for (const quote of quotes.filter((item) => item.is_reference)) {
    if (!byBookmaker.has(quote.bookmaker)) byBookmaker.set(quote.bookmaker, new Map());
    const map = byBookmaker.get(quote.bookmaker);
    const current = map.get(quote.outcome);
    if (!current || String(quote.captured_at) >= String(current.captured_at)) map.set(quote.outcome, quote);
  }

  const models = [];
  for (const [bookmaker, outcomeMap] of byBookmaker) {
    if (!expected.every((outcome) => outcomeMap.has(outcome))) continue;
    const input = Object.fromEntries(expected.map((outcome) => [outcome, outcomeMap.get(outcome).odds]));
    models.push({ bookmaker, ...noVigProbabilities(input) });
  }
  if (!models.length) return { probabilities: {}, sources: [] };

  const probabilities = Object.fromEntries(expected.map((outcome) => [
    outcome,
    models.reduce((sum, model) => sum + model.probabilities[outcome], 0) / models.length
  ]));
  return { probabilities, sources: models.map((model) => model.bookmaker), models };
}
