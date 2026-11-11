import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, validateImportRows } from '../src/importer.js';

const valid = {
  sport: 'Futebol', event: 'A x B', starts_at: '2026-10-01T20:00:00-03:00', market_key: 'h2h',
  outcome: 'A', bookmaker: 'Casa', odds: 2.1, captured_at: '2026-09-21T10:00:00-03:00'
};

test('faz parse de CSV com vírgula entre aspas', () => {
  const rows = parseCsv('sport,event,starts_at,market_key,outcome,bookmaker,odds\nFutebol,"A, FC x B",2026-10-01,h2h,A,Casa,2.1');
  assert.equal(rows[0].event, 'A, FC x B');
});

test('aceita delimitador ponto e vírgula', () => {
  const rows = parseCsv('sport;event;starts_at;market_key;outcome;bookmaker;odds\nFutebol;A x B;2026-10-01;h2h;A;Casa;2.1');
  assert.equal(rows[0].odds, '2.1');
});

test('normaliza linha válida', () => {
  const [row] = validateImportRows([valid]);
  assert.equal(row.odds, 2.1);
  assert.match(row.starts_at, /^2026-10-01T23:00:00/);
});

test('agrega erros de validação', () => {
  assert.throws(() => validateImportRows([{ ...valid, odds: 1, bookmaker: '' }]), (error) => {
    assert.equal(error.details.length, 2);
    return true;
  });
});
