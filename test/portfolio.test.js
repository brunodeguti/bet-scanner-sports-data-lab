import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { openDatabase, importRows } from '../src/db.js';
import { validateImportRows } from '../src/importer.js';
import { assertMarketIntegrity } from '../src/marketIntegrity.js';
import { transformOddsPapi, fetchOddsPapiOdds } from '../src/oddsPapi.js';
import { fetchFootyStatsLastX } from '../src/footyStats.js';
import { importFootyCsv, footyTeamWindows } from '../src/footyCsv.js';

async function withApp(run) {
  const db = openDatabase();
  const server = createApp({ db }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, db); }
  finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
}
const baseRows = ['A', 'B'].map((outcome) => ({ sport:'Futebol', event:'A x B',
  starts_at:'2020-01-02T12:00:00Z', captured_at:'2020-01-01T12:00:00Z',
  market_key:'1x2', bookmaker:'Fonte fictícia', outcome, odds:3, is_demo:true }));
const post = (base, path, body) => fetch(`${base}${path}`, { method:'POST',
  headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });

test('portfolio bloqueia provedores e cotações mesmo com chaves no ambiente', async () => {
  const old = process.env.ODDSPAPI_API_KEY;
  process.env.ODDSPAPI_API_KEY = 'test-only-not-a-real-key';
  try { await withApp(async (base) => {
    assert.equal((await (await fetch(`${base}/api/providers/oddspapi/status`)).json()).configured, false);
    for (const route of ['/api/providers/oddspapi/markets', '/api/providers/footystats/leagues', '/api/bet-slips/1/quotes']) {
      assert.equal((await fetch(base + route)).status, 403);
    }
    assert.equal((await post(base, '/api/providers/oddspapi/import', {})).status, 403);
    assert.equal((await (await fetch(`${base}/api/health`)).json()).externalProviders, false);
  }); } finally { if (old === undefined) delete process.env.ODDSPAPI_API_KEY; else process.env.ODDSPAPI_API_KEY = old; }
});

test('portfolio exige dados fictícios e preserva o fluxo de simulação e histórico', async () => withApp(async (base) => {
  const demo = JSON.parse(fs.readFileSync(new URL('../examples/demo-odds.json', import.meta.url)));
  const real = { rows:demo.rows.map((row) => ({ ...row, is_demo:false })) };
  assert.equal((await post(base, '/api/import/json', real)).status, 400);
  const imported = await post(base, '/api/import/json', demo);
  assert.equal(imported.status, 201);
  const markets = await (await fetch(`${base}/api/markets`)).json();
  assert.equal(markets.length, 3);
  assert.ok(markets.every((market) => market.is_demo));
  assert.equal((await post(base, '/api/analyze/surebet', {marketId:markets[0].id})).status, 200);
  assert.equal((await (await fetch(`${base}/api/history`)).json()).length, 1);
}));

test('1X2 incompleto não aparece como surebet nem pode ser registrado', async () => withApp(async (base) => {
  assert.equal((await post(base, '/api/import/json', {rows:baseRows})).status, 201);
  const [market] = await (await fetch(`${base}/api/markets`)).json();
  assert.equal(market.surebet, null);
  assert.deepEqual(market.ev, []);
  for (const route of ['/api/analyze/surebet', '/api/analyze/surebet/preview']) {
    assert.equal((await post(base, route, {marketId:market.id})).status, 400);
  }
  assert.deepEqual(await (await fetch(`${base}/api/history`)).json(), []);
}));

test('odds reais vencidas e partidas passadas são rejeitadas pelos endpoints', async () => withApp(async (base, db) => {
  importRows(db, validateImportRows(baseRows.map((row) => ({...row, is_demo:false,
    market_key:'total', outcome:row.outcome === 'A' ? 'Over' : 'Under', starts_at:'2099-01-01T12:00:00Z'}))));
  const [market] = await (await fetch(`${base}/api/markets`)).json();
  assert.match(market.surebetError, /vencida/);
  assert.deepEqual(market.ev, []);
  assert.equal((await post(base, '/api/analyze/surebet', {marketId:market.id})).status, 400);
  assert.equal((await post(base, '/api/analyze/ev', {marketId:market.id,quoteId:market.quotes[0].id})).status, 400);
  const model = {...market, starts_at:'2020-01-02T12:00:00Z'};
  assert.throws(() => assertMarketIntegrity(model), /Partida iniciada/);
}));

function providerPayload() {
  return {updatedAt:'2026-09-21T12:00:00Z',bookmakerOdds:{synthetic:{markets:{101:{outcomes:{
    101:{players:{0:{price:3}}},102:{players:{0:{price:3}}},103:{players:{0:{price:3}}}
  }}}}}};
}
const fixture = {startTime:'2026-09-22T12:00:00Z',participant1Name:'A',participant2Name:'B'};
test('adaptador descarta casa, mercado e oferta suspensos e não inventa horário', () => {
  for (const suspend of [
    (p) => { p.bookmakerOdds.synthetic.suspended=true; },
    (p) => { p.bookmakerOdds.synthetic.markets[101].marketActive=false; },
    (p) => { p.bookmakerOdds.synthetic.markets[101].outcomes[101].players[0].active=false; },
    (p) => { delete p.updatedAt; }
  ]) {
    const payload=providerPayload(); suspend(payload);
    assert.equal(transformOddsPapi([{fixture,payload}]).rows.length, 0);
  }
});

test('adaptadores recebem sinal de cancelamento com prazo definido', async () => {
  const fakeFetch = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return {ok:true,json:async()=>({})};
  };
  await fetchOddsPapiOdds({key:'fake',fixtureId:'fixture-1',fetchImpl:fakeFetch});
  await fetchFootyStatsLastX({key:'fake',teamId:1,fetchImpl:fakeFetch});
});

test('CSV sintético reproduz 5/10 por local, ausentes e corte histórico', () => {
  const db=openDatabase();
  try {
    const name='demo-sports-matches-2026-to-2027-stats.csv';
    const csv=fs.readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
    assert.equal(importFootyCsv(db,name,csv).imported,40);
    importFootyCsv(db,name,csv);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM footy_matches').get().n,40);
    const data=footyTeamWindows(db,{league:'demo-sports',season:'2026/2027',team:'Azul FC',before:'2026-11-01T00:00:00Z'});
    assert.equal(data.windows[10].home.matches,10);
    assert.equal(data.windows[10].away.matches,10);
    assert.ok(data.windows[10].away.shots.observed < 10);
  } finally {db.close();}
});

test('requisições de outra origem não alteram a simulação', async () => withApp(async (base) => {
  const response=await fetch(`${base}/api/import/json`,{method:'POST',headers:{'content-type':'application/json',origin:'https://example.invalid'},body:JSON.stringify({rows:baseRows})});
  assert.equal(response.status,403);
}));
