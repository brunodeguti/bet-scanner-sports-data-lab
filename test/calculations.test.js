import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEV, calculateSurebet, consensusNoVig, noVigProbabilities } from '../src/calculations.js';

test('remove a margem de um mercado simétrico', () => {
  const result = noVigProbabilities({ Over: 1.91, Under: 1.91 });
  assert.equal(result.probabilities.Over, 0.5);
  assert.equal(result.probabilities.Under, 0.5);
  assert.ok(result.margin > 0);
});

test('detecta surebet de 2 resultados e distribui todos os centavos', () => {
  const result = calculateSurebet([
    { outcome: 'Over', bookmaker: 'A', odds: 2.12 },
    { outcome: 'Under', bookmaker: 'B', odds: 2.05 }
  ], 100);
  assert.equal(result.isSurebet, true);
  assert.equal(result.allocation.reduce((sum, item) => sum + item.stake, 0), 100);
  assert.ok(result.roundedMinProfit > 0);
});

test('seleciona a melhor odd por resultado e detecta ausência de arbitragem', () => {
  const result = calculateSurebet([
    { outcome: 'Casa', bookmaker: 'A', odds: 1.8 },
    { outcome: 'Casa', bookmaker: 'B', odds: 1.9 },
    { outcome: 'Fora', bookmaker: 'A', odds: 1.8 }
  ], 75.55);
  assert.equal(result.isSurebet, false);
  assert.equal(result.allocation.find((item) => item.outcome === 'Casa').odds, 1.9);
  assert.equal(result.allocation.reduce((sum, item) => sum + item.stake, 0), 75.55);
});

test('detecta surebet de 3 resultados incluindo empate', () => {
  const result = calculateSurebet([
    { outcome: 'Casa', bookmaker: 'A', odds: 3.4 },
    { outcome: 'Empate', bookmaker: 'B', odds: 3.6 },
    { outcome: 'Fora', bookmaker: 'C', odds: 2.5 }
  ], 200);
  assert.equal(result.isSurebet, true);
  assert.equal(result.outcomes, 3);
  assert.ok(result.roundedMinProfit > 0);
});

test('rejeita mercado incompleto e odds inválidas', () => {
  assert.throws(() => calculateSurebet([{ outcome: 'Casa', odds: 2 }], 100), /duas cotações/);
  assert.throws(() => calculateSurebet([{ outcome: 'Casa', odds: 1 }, { outcome: 'Fora', odds: 2 }], 100), /inválida/);
});

test('calcula EV, edge, odd justa e limita Kelly pela exposição', () => {
  const result = calculateEV({ odds: 2.1, fairProbability: 0.55, bankroll: 1000, fixedStake: 50, kellyFraction: 0.25, maxExposurePct: 2 });
  assert.ok(Math.abs(result.evPct - 15.5) < 1e-9);
  assert.ok(Math.abs(result.fairOdds - (1 / 0.55)) < 1e-9);
  assert.equal(result.suggestedStake, 20);
  assert.ok(result.alerts.some((alert) => alert.includes('teto')));
});

test('stake é zero em EV negativo', () => {
  const result = calculateEV({ odds: 1.8, fairProbability: 0.5, bankroll: 1000, fixedStake: 20 });
  assert.equal(result.suggestedStake, 0);
  assert.ok(result.alerts.some((alert) => alert.includes('não entrar')));
});

test('consenso usa somente casas de referência com mercado completo', () => {
  const result = consensusNoVig([
    { outcome: 'Over', bookmaker: 'Ref', odds: 1.9, is_reference: 1, captured_at: '2026-01-01' },
    { outcome: 'Under', bookmaker: 'Ref', odds: 1.9, is_reference: 1, captured_at: '2026-01-01' },
    { outcome: 'Over', bookmaker: 'Incompleta', odds: 2.2, is_reference: 1, captured_at: '2026-01-01' }
  ], ['Over', 'Under']);
  assert.deepEqual(result.sources, ['Ref']);
  assert.equal(result.probabilities.Over, 0.5);
});
