import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDatabase } from '../src/db.js';
import { importFootyCsv } from '../src/footyCsv.js';
import { addBetLeg, attachOdds, createBetSlip, evaluateBetSlip, getBetSlip, settleSelection, validateSelection } from '../src/betBuilder.js';
import { createApp } from '../src/app.js';
import { clearOddsPapiMarketCache } from '../src/oddsPapi.js';

const filename = 'test-league-matches-2018-to-2019-stats.csv';
const base = Date.parse('2019-04-01T12:00:00Z') / 1000;
const head = 'timestamp,status,home_team_name,away_team_name,home_team_goal_count,away_team_goal_count,home_team_goal_count_half_time,away_team_goal_count_half_time,home_team_corner_count,away_team_corner_count,home_team_yellow_cards,away_team_yellow_cards,home_team_red_cards,away_team_red_cards,home_team_shots,away_team_shots,home_team_shots_on_target,away_team_shots_on_target';
const matches = [head];
for (let i = 0; i < 12; i++) {
  matches.push(`${base + i * 86400},complete,A,Other${i},2,0,1,0,5,3,2,1,0,0,10,6,4,2`);
  matches.push(`${base + i * 86400 + 3600},complete,Host${i},B,1,0,1,0,5,3,2,1,0,0,10,6,4,2`);
}

function setup() {
  const db = openDatabase();
  importFootyCsv(db, filename, matches.join('\n'));
  const slip = createBetSlip(db, { league:'test-league', season:'2018/2019', home:'A', away:'B', kickoff:'2019-04-14T12:00:00Z', fixtureId:'fixture-123' });
  return { db, slip };
}

test('linha asiática e over inteiro ou .25 liquidam green, push e meios resultados', () => {
  const row = { stats:{ home:{ goals:2, corners:2 }, away:{ goals:0, corners:3 } } };
  const asian = (line) => validateSelection({market:'asian_handicap', subject:'home', line});
  const over = (line) => validateSelection({market:'total', metric:'goals', subject:'match', pick:'over', line});
  assert.equal(settleSelection(row, asian(-1.5)).result, 'green');
  assert.equal(settleSelection(row, asian(-2)).result, 'push');
  assert.equal(settleSelection(row, asian(-2.25)).result, 'half_red');
  assert.equal(settleSelection(row, asian(-1.75)).result, 'half_green');
  assert.equal(settleSelection(row, over(2)).result, 'push');
  assert.equal(settleSelection(row, over(1.75)).result, 'half_green');
  assert.equal(settleSelection(row, over(2.25)).result, 'half_red');
  assert.equal(settleSelection(row, over(2.5)).result, 'red');
  assert.equal(settleSelection(row, validateSelection({market:'european_handicap', line:-2, pick:'draw'})).result, 'green');
});

test('20 partidas observadas dão frequência por perna, casa/fora e correlação', () => {
  const { db, slip } = setup();
  try {
    addBetLeg(db, slip.id, {market:'total', metric:'corners', subject:'match', pick:'over', line:7.5});
    addBetLeg(db, slip.id, {market:'total', metric:'corners', subject:'home', pick:'over', line:4.5});
    const analysis = evaluateBetSlip(db, slip.id);
    assert.equal(analysis.legs[0].evidence.home.last5.counts.observed, 5);
    assert.equal(analysis.legs[0].evidence.away.last10.counts.observed, 10);
    assert.equal(analysis.legs[0].pooled.observed, 20);
    assert.equal(analysis.legs[0].probability.green, 1);
    assert.equal(analysis.legs[0].fairOdds, null);
    assert.equal(analysis.legs[0].strength, 'frequencia_alta');
    assert.equal(analysis.correlations.length, 1);
    assert.match(analysis.correlations[0].reason, /mesma estatística/);
    assert.equal(getBetSlip(db, slip.id).legs.length, 2);
  } finally { db.close(); }
});

test('dados faltantes, props e temporada antiga não produzem probabilidade ou EV', () => {
  const { db, slip } = setup();
  try {
    addBetLeg(db, slip.id, {market:'total', metric:'firstHalfCards', subject:'match', pick:'under', line:2.5});
    addBetLeg(db, slip.id, {market:'custom', label:'Jogador X: 2 chutes no gol'});
    const analysis = evaluateBetSlip(db, slip.id);
    assert.equal(analysis.legs[0].pooled.observed, 0);
    assert.equal(analysis.legs[0].probability, null);
    assert.equal(analysis.legs[1].reason, 'Mercado sem dados por partida no CSV.');
    db.prepare('UPDATE bet_slips SET kickoff=? WHERE id=?').run('2026-09-23T12:00:00Z', slip.id);
    addBetLeg(db, slip.id, {market:'total', metric:'corners', subject:'match', pick:'over', line:7.5});
    const stale = evaluateBetSlip(db, slip.id).legs[2];
    assert.equal(stale.probability, null);
    assert.match(stale.reason, /Dados antigos/);
  } finally { db.close(); }
});

test('OddsPapi só calcula EV para fixture, linha, período, resultado e cotação atual compatíveis', () => {
  const { db, slip } = setup();
  try {
    // Quatro resultados contrários deixam uma distribuição com ganhos e perdas observados.
    for (const team of ['A', 'B']) {
      const games = db.prepare(`SELECT * FROM footy_matches WHERE ${team === 'A' ? 'home_team' : 'away_team'}=? ORDER BY kickoff DESC LIMIT 2`).all(team);
      for (const game of games) {
        const stats = JSON.parse(game.stats);
        stats.home.corners = 3;
        stats.away.corners = 3;
        db.prepare('UPDATE footy_matches SET stats=? WHERE league=? AND season=? AND kickoff=? AND home_team=? AND away_team=?')
          .run(JSON.stringify(stats), game.league, game.season, game.kickoff, game.home_team, game.away_team);
      }
    }
    addBetLeg(db, slip.id, {market:'total', metric:'corners', subject:'match', pick:'over', line:7.5,
      quoteRef:{bookmaker:'betano.bet.br',marketId:700,outcomeId:701,line:'7.5/over'}});
    const analysis = evaluateBetSlip(db, slip.id);
    const now = Date.parse('2019-04-14T11:00:00Z');
    const offer = {outcomeId:701,outcome:'Over',line:'7.5/over',price:1.8,active:true,changedAt:'2019-04-14T10:45:00Z'};
    const market = {id:700,name:'Corners Over Under',period:'fulltime',playerProp:false,handicap:null,active:true,offers:[offer]};
    const summary = {event:'A x B',startsAt:slip.kickoff,books:[{slug:'betano.bet.br',name:'Betano',active:true,markets:[market]}]};
    assert.equal(analysis.legs[0].fairOdds, 1.25);
    assert.equal(attachOdds(analysis, summary, now).legs[0].evPct, 44);
    assert.equal(attachOdds(analysis, { ...summary, event:'B x A' }, now).legs[0].evPct, null);
    assert.equal(attachOdds(analysis, { ...summary, books:[{ ...summary.books[0], markets:[{...market, name:'Total Goals'}]}] }, now).legs[0].evPct, null);
    assert.equal(attachOdds(analysis, summary, now + 2 * 3600000).legs[0].evPct, null);
  } finally { db.close(); }
});

test('HTTP cadastra bilhete/seleção e analisa CSV real sem exibir EV histórico', async () => {
  const directory = process.env.FOOTY_SAMPLE_DIRECTORY;
  if (!directory) return;
  const db = openDatabase();
  const name = 'england-premier-league-matches-2018-to-2019-stats.csv';
  importFootyCsv(db, name, fs.readFileSync(`${directory}/${name}`, 'utf8'));
  const server = createApp({ db }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path, body) => fetch(`${url}${path}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }).then((res) => res.json());
    const slip = await post('/api/bet-slips', {league:'england-premier-league',season:'2018/2019',home:'Manchester United',away:'Leicester City',kickoff:'2026-09-23T15:00:00Z'});
    const leg = await post(`/api/bet-slips/${slip.id}/legs`, {market:'total',metric:'shots',subject:'home',pick:'over',line:7.5});
    assert.ok(leg.id);
    const analysis = await (await fetch(`${url}/api/bet-slips/${slip.id}/analyze`)).json();
    assert.equal(analysis.legs.length, 1);
    assert.equal(analysis.legs[0].probability, null);
    assert.equal(analysis.legs[0].evPct, null);
    assert.ok(analysis.legs[0].evidence.home.last10.counts.observed > 0);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});

test('rota OddsPapi vincula cotação ao bilhete e recusa fixture com times divergentes', async () => {
  const { db, slip } = setup();
  const oldKey = process.env.ODDSPAPI_API_KEY;
  process.env.ODDSPAPI_API_KEY = 'chave-de-teste';
  clearOddsPapiMarketCache();
  const fakeFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/markets')) return { ok:true, json:async () => ([{
      marketId:700, marketName:'Corners Over Under', sportId:10, period:'fulltime',
      outcomes:[{outcomeId:701,outcomeName:'Over'}, {outcomeId:702,outcomeName:'Under'}]
    }]) };
    return { ok:true, json:async () => ({ fixtureId:'fixture-123',participant1Name:'A',participant2Name:'B',startTime:slip.kickoff,
      bookmakerOdds:{'betano.bet.br':{markets:{'700':{outcomes:{
        '701':{players:{'0':{price:1.8,bookmakerOutcomeId:'7.5/over',changedAt:'2019-04-14T10:45:00Z'}}}
      }}}}} }) };
  };
  const server = createApp({ db, fetchImpl:fakeFetch, oddsPapiCacheFile:null }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${url}/api/bet-slips/${slip.id}/quotes`);
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.books[0].markets[0].offers[0].line, '7.5/over');
    db.prepare('UPDATE bet_slips SET home_team=? WHERE id=?').run('Outro time', slip.id);
    const rejected = await fetch(`${url}/api/bet-slips/${slip.id}/quotes`);
    assert.equal(rejected.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve)); db.close();
    if (oldKey == null) delete process.env.ODDSPAPI_API_KEY;
    else process.env.ODDSPAPI_API_KEY = oldKey;
    clearOddsPapiMarketCache();
  }
});
