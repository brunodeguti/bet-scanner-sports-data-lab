import test from 'node:test';
import assert from 'node:assert/strict';
import { bestNamedMatch, nameScore, normalizedName, resolveLeagueForEvent, seasonIncludesDate, seasonYears } from '../public/matching.js';

test('reconhece abreviações e nomes holandeses usados entre os provedores', () => {
  assert.ok(nameScore('GVVV Veenendaal', ['GVVV']) >= 88);
  assert.ok(nameScore('SV Dvs 33 Ermelo', ["DVS '33 Ermelo"]) >= 88);
  assert.equal(normalizedName('KNVB Beker'), normalizedName('KNVB Cup'));
});

test('interpreta temporadas simples, compactas e com barra sem misturar ano histórico', () => {
  assert.deepEqual(seasonYears('2024/25'), [2024, 2025]);
  assert.deepEqual(seasonYears('20252026'), [2025, 2026]);
  assert.deepEqual(seasonYears('2026'), [2026]);
  assert.equal(seasonIncludesDate('2024/25', '2026-10-10T12:00:00Z'), false);
  assert.equal(seasonIncludesDate('2025/26', '2026-02-10T12:00:00Z'), true);
});

test('bloqueia pareamento automático com temporada histórica e identifica temporada atual sem acesso', () => {
  const historicalOnly = [
    {seasonId:1,name:'Premier League',fullName:'England Premier League',year:'2024/25',accessible:true}
  ];
  const historical = resolveLeagueForEvent('Premier League', '2026-10-10T12:00:00Z', historicalOnly);
  assert.equal(historical.status, 'historical');
  assert.equal(historical.league.seasonId, 1);

  const withCurrentLocked = [...historicalOnly,
    {seasonId:2,name:'Premier League',fullName:'England Premier League',year:'2026/27',accessible:false}
  ];
  const locked = resolveLeagueForEvent('Premier League', '2026-10-10T12:00:00Z', withCurrentLocked);
  assert.equal(locked.status, 'locked');
  assert.equal(locked.league.seasonId, 2);

  withCurrentLocked[1].accessible = true;
  assert.equal(resolveLeagueForEvent('Premier League', '2026-10-10T12:00:00Z', withCurrentLocked).status, 'ok');
});

test('só marca pareamento como seguro quando há pontuação e distância suficientes', () => {
  const teams = [
    {id:1,names:['GVVV']},
    {id:2,names:['VVV Venlo']},
    {id:3,names:["DVS '33 Ermelo"]}
  ];
  const result = bestNamedMatch('GVVV Veenendaal', teams, (team) => team.names);
  assert.equal(result.item.id, 1);
  assert.equal(result.confident, true);
});
