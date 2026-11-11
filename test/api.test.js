import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { clearOddsPapiMarketCache } from '../src/oddsPapi.js';

async function withServer(run, appOptions = {}) {
  const db = openDatabase(':memory:');
  const server = createApp({ db, simulationOnly:false, enforceFreshness:false, ...appOptions }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db }); }
  finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
}

const rows = [
  { sport:'Futebol', league:'Teste', event:'A x B', starts_at:'2026-10-01T20:00:00-03:00', market_key:'total', market_name:'Total', outcome:'Over', bookmaker:'Casa A', odds:2.12, estimated_probability:0.52, captured_at:'2026-09-21T10:00:00-03:00' },
  { sport:'Futebol', league:'Teste', event:'A x B', starts_at:'2026-10-01T20:00:00-03:00', market_key:'total', market_name:'Total', outcome:'Under', bookmaker:'Casa B', odds:2.05, estimated_probability:0.48, captured_at:'2026-09-21T10:00:00-03:00' }
];

test('health, importação, duplicata, scanner e histórico funcionam juntos', async () => withServer(async ({ base }) => {
  let response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');

  response = await fetch(`${base}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /v1\.13\.1/);
  assert.equal((html.match(/class="panel provider-card"/g) ?? []).length, 3);
  response = await fetch(`${base}/matching.js`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /bestNamedMatch/);

  response = await fetch(`${base}/api/import/json`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ rows }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).inserted, 2);

  response = await fetch(`${base}/api/import/json`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ rows }) });
  assert.equal((await response.json()).duplicates, 2);

  const markets = await (await fetch(`${base}/api/markets?type=surebet&sort=roi`)).json();
  assert.equal(markets.length, 1);
  assert.equal(markets[0].surebet.isSurebet, true);

  response = await fetch(`${base}/api/analyze/surebet/preview`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ marketId:markets[0].id, totalStake:100 }) });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/analyze/surebet/preview`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ marketId:markets[0].id, totalStake:15 }) });
  const preview = await response.json();
  assert.equal(response.status, 200);
  assert.equal(preview.totalStake, 15);

  response = await fetch(`${base}/api/analyze/surebet`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ marketId:markets[0].id, totalStake:20 }) });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).roundedMinProfit > 0);

  response = await fetch(`${base}/api/analyze/ev`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ marketId:markets[0].id, quoteId:markets[0].quotes[0].id }) });
  assert.equal(response.status, 200);

  const history = await (await fetch(`${base}/api/history`)).json();
  assert.equal(history.length, 2);
  assert.ok(history.every((item) => item.status === 'open' && item.stake > 0));
}));

test('CSV, configurações e respostas de erro funcionam', async () => withServer(async ({ base }) => {
  const csv = 'sport,event,starts_at,market_key,outcome,bookmaker,odds,captured_at\nFutebol,C x D,2026-10-02T20:00:00-03:00,h2h,C,Casa,2.2,2026-09-21T10:00:00-03:00';
  let response = await fetch(`${base}/api/import/csv`, { method:'POST', headers:{'content-type':'text/csv'}, body:csv });
  assert.equal(response.status, 201);

  response = await fetch(`${base}/api/settings`, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({ bankroll:1500, fixed_stake:30, kelly_fraction:0.2, max_exposure_pct:1.5, min_ev_pct:3 }) });
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.equal(settings.bankroll, 1500);
  assert.equal(settings.surebet_stake, 30);
  assert.equal(settings.ev_fixed_stake, 30);
  assert.equal(settings.risk.maxStake, 22.5);

  response = await fetch(`${base}/api/import/json`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ rows:[{ odds:1 }] }) });
  assert.equal(response.status, 400);
  assert.ok((await response.json()).details.length > 0);
}));

test('importa odds brasileiras da OddsPapi sem expor a chave', async () => {
  const oldKey = process.env.ODDSPAPI_API_KEY;
  process.env.ODDSPAPI_API_KEY = 'segredo-papi';
  const fixture = {fixtureId:'id123',participant1Name:'A',participant2Name:'B',startTime:'2026-09-22T22:00:00Z',categorySlug:'brazil',tournamentName:'Serie A',hasOdds:true};
  const fetchImpl = async (url) => {
    assert.equal(url.includes('segredo-papi'), true);
    if (url.includes('/fixtures?')) return {ok:true,json:async()=>[fixture]};
    return {ok:true,json:async()=>({bookmakerOdds:{'betano.bet.br':{bookmakerName:'Betano BR',markets:{'101':{updatedAt:'2026-09-22T20:00:00Z',outcomes:{
      '101':{players:{'0':{price:2.1}}},'102':{players:{'0':{price:3.2}}},'103':{players:{'0':{price:3.5}}}
    }}}}}})};
  };
  try {
    await withServer(async ({base}) => {
      let response = await fetch(`${base}/api/providers/oddspapi/status`);
      const status = await response.json();
      assert.equal(status.configured, true);
      assert.equal(JSON.stringify(status).includes('segredo-papi'), false);
      response = await fetch(`${base}/api/providers/oddspapi/import`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        from:'2026-09-21',to:'2026-09-23',bookmakers:'betano.bet.br',maxFixtures:10
      })});
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.inserted, 3);
      assert.deepEqual(body.bookmakersFound, ['betano.bet.br']);
      assert.equal(body.fixtures.length, 1);
      assert.equal(body.fixtures[0].status, 'updated');
      assert.equal(body.marketIds.length, 1);
      assert.equal(body.fixtures[0].marketId, body.marketIds[0]);
      response = await fetch(`${base}/api/providers/oddspapi/import`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        from:'2026-09-21',to:'2026-09-23',bookmakers:'betano.bet.br',maxFixtures:10
      })});
      const repeated = await response.json();
      assert.equal(repeated.inserted, 0);
      assert.equal(repeated.fixtures[0].status, 'already_saved');
      const markets = await (await fetch(`${base}/api/markets`)).json();
      assert.equal(markets[0].source, 'oddspapi');
    }, {fetchImpl});
  } finally {
    if (oldKey === undefined) delete process.env.ODDSPAPI_API_KEY;
    else process.env.ODDSPAPI_API_KEY = oldKey;
  }
});

test('consulta comparação FootyStats sem expor a chave', async () => {
  const oldKey = process.env.FOOTYSTATS_API_KEY;
  process.env.FOOTYSTATS_API_KEY = 'segredo-footy';
  const fetchImpl = async (url) => {
    assert.equal(url.includes('segredo-footy'), true);
    const teamId = Number(new URL(url).searchParams.get('team_id'));
    return {ok:true,status:200,json:async()=>({success:true,metadata:{request_remaining:'99'},data:[{
      id:teamId,name:teamId === 1 ? 'Casa' : 'Fora',full_name:teamId === 1 ? 'Casa FC' : 'Fora FC',last_x_match_num:5,
      stats:{seasonMatchesPlayed_overall:5,seasonPPG_overall:2,seasonScoredAVG_overall:1.6,seasonConcededAVG_overall:0.8}
    }]})};
  };
  try {
    await withServer(async ({base}) => {
      let response = await fetch(`${base}/api/providers/footystats/status`);
      const status = await response.json();
      assert.equal(status.configured, true);
      assert.equal(JSON.stringify(status).includes('segredo-footy'), false);
      response = await fetch(`${base}/api/providers/footystats/compare?homeTeamId=1&awayTeamId=2`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.home.name, 'Casa FC');
      assert.equal(body.away.name, 'Fora FC');
      assert.equal(JSON.stringify(body).includes('segredo-footy'), false);
    }, {fetchImpl});
  } finally {
    if (oldKey === undefined) delete process.env.FOOTYSTATS_API_KEY;
    else process.env.FOOTYSTATS_API_KEY = oldKey;
  }
});

test('lista catálogo OddsPapi e inspeciona todos os mercados de uma partida sem expor a chave', async () => {
  const oldKey = process.env.ODDSPAPI_API_KEY;
  process.env.ODDSPAPI_API_KEY = 'segredo-catalogo';
  clearOddsPapiMarketCache();
  let marketCalls = 0;
  const fetchImpl = async (url) => {
    assert.equal(url.includes('segredo-catalogo'), true);
    if (url.includes('/markets?')) {
      marketCalls += 1;
      return {ok:true,status:200,json:async()=>[
        {marketId:101,marketName:'Full Time Result',sportId:10,period:'fulltime',marketType:'1x2',outcomes:[{outcomeId:101,outcomeName:'1'}]},
        {marketId:501,marketName:'Player Shots on Target',sportId:10,period:'fulltime',marketType:'totals',playerProp:true,outcomes:[{outcomeId:502,outcomeName:'Over'}]}
      ]};
    }
    if (url.includes('/odds?')) return {ok:true,status:200,json:async()=>({
      fixtureId:'id123',participant1Name:'A',participant2Name:'B',tournamentName:'Serie A',
      bookmakerOdds:{'superbet.bet.br':{bookmakerName:'Superbet BR',markets:{'501':{outcomes:{'502':{players:{'9':{playerName:'Jogador A',price:1.9,bookmakerOutcomeId:'0.5/over'}}}}}}}}
    })};
    throw new Error(`URL inesperada: ${url}`);
  };
  try {
    await withServer(async ({base}) => {
      let response = await fetch(`${base}/api/providers/oddspapi/markets`);
      assert.equal(response.status, 200);
      let body = await response.json();
      assert.equal(body.total, 2);
      assert.equal(body.playerProps, 1);
      assert.equal(JSON.stringify(body).includes('segredo-catalogo'), false);

      response = await fetch(`${base}/api/providers/oddspapi/fixtures/id123/markets?bookmakers=superbet.bet.br`);
      assert.equal(response.status, 200);
      body = await response.json();
      assert.equal(body.marketCount, 1);
      assert.equal(body.books[0].markets[0].offers[0].playerName, 'Jogador A');
      assert.equal(JSON.stringify(body).includes('segredo-catalogo'), false);
      assert.equal(marketCalls, 1);
    }, {fetchImpl, oddsPapiCacheFile:null});
  } finally {
    clearOddsPapiMarketCache();
    if (oldKey === undefined) delete process.env.ODDSPAPI_API_KEY;
    else process.env.ODDSPAPI_API_KEY = oldKey;
  }
});

test('descobre campeonatos OddsPapi e campeonatos/times FootyStats', async () => {
  const oldPapi = process.env.ODDSPAPI_API_KEY;
  const oldFooty = process.env.FOOTYSTATS_API_KEY;
  process.env.ODDSPAPI_API_KEY = 'papi-lista';
  process.env.FOOTYSTATS_API_KEY = 'footy-lista';
  const fetchImpl = async (url) => {
    if (url.includes('api.oddspapi.io') && url.includes('/tournaments?')) return {ok:true,status:200,json:async()=>[
      {tournamentId:71,tournamentName:'Serie A',categorySlug:'brazil',categoryName:'Brazil',futureFixtures:10},
      {tournamentId:8,tournamentName:'LaLiga',categorySlug:'spain',categoryName:'Spain'}
    ]};
    if (url.includes('/league-list?')) {
      const chosenOnly = new URL(url).searchParams.get('chosen_leagues_only') === 'true';
      return {ok:true,status:200,json:async()=>({success:true,data:chosenOnly ? [
        {name:'Brazil Serie A',country:'Brazil',league_name:'Serie A',season:[{id:900,year:2026}]}
      ] : [
        {name:'Brazil Serie A',country:'Brazil',league_name:'Serie A',season:[{id:900,year:2026}]},
        {name:'Brazil Acreano',country:'Brazil',league_name:'Acreano',season:[{id:901,year:2026}]}
      ]})};
    }
    if (url.includes('/league-teams?')) return {ok:true,status:200,json:async()=>({success:true,data:[
      {id:612,name:'CR Flamengo',cleanName:'Flamengo'},{id:711,name:'Santos FC',cleanName:'Santos'}
    ]})};
    throw new Error(`URL inesperada: ${url}`);
  };
  try {
    await withServer(async ({base}) => {
      let response = await fetch(`${base}/api/providers/oddspapi/tournaments?country=brazil`);
      assert.equal(response.status, 200);
      const oddsDirectory = await response.json();
      assert.deepEqual(oddsDirectory.tournaments.map((item) => item.id), [71]);
      assert.deepEqual(oddsDirectory.countries.map((item) => item.slug), ['brazil', 'spain']);
      response = await fetch(`${base}/api/providers/footystats/leagues`);
      assert.equal(response.status, 200);
      const footyDirectory = await response.json();
      assert.equal(footyDirectory.leagues.find((item) => item.seasonId === 900).accessible, true);
      assert.equal(footyDirectory.leagues.find((item) => item.seasonId === 901).accessible, false);
      assert.equal(footyDirectory.accessibleLeagues, 1);
      assert.deepEqual(footyDirectory.countries, ['Brazil']);
      response = await fetch(`${base}/api/providers/footystats/leagues/900/teams`);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).teams.map((item) => item.id), [612, 711]);
      response = await fetch(`${base}/api/providers/footystats/leagues/901/teams`);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /não está liberado/);
    }, {fetchImpl});
  } finally {
    if (oldPapi === undefined) delete process.env.ODDSPAPI_API_KEY; else process.env.ODDSPAPI_API_KEY = oldPapi;
    if (oldFooty === undefined) delete process.env.FOOTYSTATS_API_KEY; else process.env.FOOTYSTATS_API_KEY = oldFooty;
  }
});

test('liquida histórico, atualiza a banca e corrige resultado sem duplicar saldo', async () => withServer(async ({base}) => {
  await fetch(`${base}/api/import/json`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ rows }) });
  const [market] = await (await fetch(`${base}/api/markets`)).json();
  let response = await fetch(`${base}/api/analyze/surebet`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({marketId:market.id,totalStake:20})
  });
  const registered = await response.json();
  assert.equal(response.status, 200);

  response = await fetch(`${base}/api/history/${registered.historyId}/settle`, {
    method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({status:'win'})
  });
  const win = await response.json();
  assert.equal(response.status, 200);
  assert.equal(win.bankroll, 1000 + registered.roundedMinProfit);

  response = await fetch(`${base}/api/history/${registered.historyId}/settle`, {
    method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({status:'loss'})
  });
  const corrected = await response.json();
  assert.equal(corrected.bankroll, 980);
  const [history] = await (await fetch(`${base}/api/history`)).json();
  assert.equal(history.status, 'loss');
  assert.equal(history.settled_profit, -20);

  const [updatedMarket] = await (await fetch(`${base}/api/markets`)).json();
  const eligible = updatedMarket.ev.find((item) => item.minimumMet);
  response = await fetch(`${base}/api/analyze/ev`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({marketId:updatedMarket.id,quoteId:eligible.quoteId})
  });
  const ev = await response.json();
  response = await fetch(`${base}/api/history/${ev.historyId}/settle`, {
    method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({status:'win'})
  });
  const evWin = await response.json();
  assert.equal(evWin.bankroll, 980 + ev.winProfit);
  response = await fetch(`${base}/api/history/${ev.historyId}/settle`, {
    method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({status:'push'})
  });
  assert.equal((await response.json()).bankroll, 980);
}));
