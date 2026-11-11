import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOddsPapiFixture, collectOddsPapi, fetchOddsPapiFixtures, normalizeOddsPapiMarkets, normalizeOddsPapiTournaments, summarizeOddsPapiFixture, transformOddsPapi } from '../src/oddsPapi.js';

const fixture = {
  fixtureId:'id123', participant1Name:'Time A', participant2Name:'Time B',
  startTime:'2026-09-22T22:00:00Z', categorySlug:'brazil', tournamentName:'Serie A', hasOdds:true
};
const payload = { bookmakerOdds:{
  'betano.bet.br':{bookmakerName:'Betano BR',updatedAt:'2026-09-21T18:00:00Z',markets:{'101':{outcomes:{
    '101':{players:{'0':{price:'2.10'}}}, '102':{players:{'0':{price:'3.20'}}}, '103':{players:{'0':{price:'3.50'}}}
  }}}},
  pinnacle:{bookmakerName:'Pinnacle',updatedAt:'2026-09-21T18:00:00Z',markets:{'101':{outcomes:{
    '101':{players:{'0':{price:2.05}}}, '102':{players:{'0':{price:3.25}}}, '103':{players:{'0':{price:3.60}}}
  }}}}
}};

test('transforma somente 1X2 e marca Pinnacle como referência', () => {
  const result = transformOddsPapi([{fixture,payload}], {bookmakers:['betano.bet.br','pinnacle','superbet.bet.br']});
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows[1].outcome, 'Empate');
  assert.equal(result.rows.filter((row) => row.is_reference).length, 3);
  assert.deepEqual(result.bookmakersMissing, ['superbet.bet.br']);
  assert.equal(result.rows.every((row) => row.market_key === 'oddspapi_h2h'), true);
  assert.deepEqual(result.fixtureCoverage, [{fixtureId:'id123',completeBookmakers:2,rows:6}]);
});

test('normaliza catálogo de futebol e classifica mercados desejados', () => {
  const markets = normalizeOddsPapiMarkets([
    {marketId:101,marketName:'Full Time Result',sportId:10,period:'fulltime',marketType:'1x2',outcomes:[{outcomeId:101,outcomeName:'1'}]},
    {marketId:501,marketName:'Player Shots on Target',sportId:10,period:'fulltime',marketType:'totals',playerProp:true,outcomes:[{outcomeId:502,outcomeName:'Over'}]},
    {marketId:601,marketName:'First Half Corners',sportId:10,period:'firsthalf',marketType:'totals',outcomes:[]},
    {marketId:999,marketName:'Basketball Points',sportId:4,period:'fulltime',marketType:'totals',outcomes:[]}
  ]);
  assert.equal(markets.length, 3);
  assert.equal(markets.find((item) => item.id === 501).category, 'Chutes no gol');
  assert.equal(markets.find((item) => item.id === 501).playerProp, true);
  assert.equal(markets.find((item) => item.id === 601).category, 'Escanteios');
});

test('resume mercados reais por casa incluindo props e linhas', () => {
  const catalog = normalizeOddsPapiMarkets([
    {marketId:501,marketName:'Player Shots on Target',sportId:10,period:'fulltime',marketType:'totals',playerProp:true,outcomes:[{outcomeId:502,outcomeName:'Over'}]}
  ]);
  const summary = summarizeOddsPapiFixture({
    fixtureId:'id123',participant1Name:'Time A',participant2Name:'Time B',tournamentName:'Serie A',
    bookmakerOdds:{'superbet.bet.br':{bookmakerName:'Superbet BR',markets:{'501':{marketActive:true,outcomes:{'502':{players:{'77':{playerName:'Atacante A',price:1.85,bookmakerOutcomeId:'1.5/over',mainLine:true}}}}}}}}
  }, catalog, {bookmakers:['superbet.bet.br']});
  assert.equal(summary.event, 'Time A x Time B');
  assert.equal(summary.marketCount, 1);
  assert.equal(summary.books[0].markets[0].name, 'Player Shots on Target');
  assert.equal(summary.books[0].markets[0].offers[0].playerName, 'Atacante A');
  assert.equal(summary.books[0].markets[0].offers[0].line, '1.5/over');
});

test('encontra +EV somente na mesma linha com referência Pinnacle completa', () => {
  const catalog = normalizeOddsPapiMarkets([
    {marketId:700,marketName:'Corners Over Under',sportId:10,period:'fulltime',marketType:'totals',outcomes:[
      {outcomeId:701,outcomeName:'Over'},{outcomeId:702,outcomeName:'Under'}
    ]}
  ]);
  const market = (over, under) => ({outcomes:{
    '701':{players:{'0':{price:over,bookmakerOutcomeId:'9.5/over',mainLine:true}}},
    '702':{players:{'0':{price:under,bookmakerOutcomeId:'9.5/under',mainLine:true}}}
  }});
  const summary = summarizeOddsPapiFixture({
    fixtureId:'corners-1',participant1Name:'Time A',participant2Name:'Time B',
    bookmakerOdds:{
      pinnacle:{markets:{'700':market(1.90, 1.90)}},
      'betano.bet.br':{markets:{'700':market(2.20, 1.70)}}
    }
  }, catalog);
  const result = analyzeOddsPapiFixture(summary, {minEvPct:2});
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].outcome, 'Over');
  assert.equal(result.opportunities[0].line, '9.5');
  assert.equal(result.opportunities[0].bookmaker, 'betano.bet.br');
  assert.ok(result.opportunities[0].evPct > 9);
});

test('filtra fixtures pelo país escolhido e conta requisições', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/fixtures?')) return {ok:true,json:async()=>[fixture,{...fixture,fixtureId:'id999',categorySlug:'england'}]};
    return {ok:true,json:async()=>payload};
  };
  const result = await collectOddsPapi({key:'teste',from:'2026-09-21',to:'2026-09-23',country:'brazil',fetchImpl});
  assert.equal(result.fixturesSelected, 1);
  assert.equal(result.requestsUsed, 2);
  assert.equal(result.results[0].fixture.fixtureId, 'id123');
  assert.equal(result.fixtures.length, 1);
  assert.equal(result.fixtures[0].status, 'consulted');
});

test('mantém todos os jogos do calendário mesmo sem consultar odds de todos', async () => {
  const fixtures = [
    fixture,
    {...fixture, fixtureId:'id-sem-odds', participant1Name:'Sem Odds', hasOdds:false},
    {...fixture, fixtureId:'id-limite', participant1Name:'Além do Limite'}
  ];
  const fetchImpl = async (url) => url.includes('/fixtures?')
    ? {ok:true,status:200,json:async()=>fixtures}
    : {ok:true,status:200,json:async()=>payload};
  const result = await collectOddsPapi({key:'teste',from:'2026-09-22',to:'2026-09-22',tournamentId:71,maxFixtures:1,fetchImpl});
  assert.equal(result.fixturesFound, 3);
  assert.deepEqual(result.fixtures.map((item) => item.status), ['consulted', 'no_odds', 'not_queried_limit']);
});

test('recusa período maior que 10 dias antes de consultar', async () => {
  await assert.rejects(collectOddsPapi({key:'x',from:'2026-09-01',to:'2026-09-20',fetchImpl:async()=>{}}), /período/);
});

test('aceita pesquisa de um único dia e trata a data final como inclusiva', async () => {
  let requestedUrl;
  const sameBrazilDay = {...fixture, fixtureId:'same-day', startTime:'2026-09-23T02:30:00Z'};
  const nextBrazilDay = {...fixture, fixtureId:'next-day', startTime:'2026-09-23T03:30:00Z'};
  const result = await fetchOddsPapiFixtures({
    key:'teste', from:'2026-09-22', to:'2026-09-22', tournamentId:71,
    fetchImpl:async (url) => {
      requestedUrl = new URL(url);
      return {ok:true,status:200,json:async()=>[sameBrazilDay, nextBrazilDay]};
    }
  });
  assert.equal(requestedUrl.searchParams.get('from'), '2026-09-22');
  assert.equal(requestedUrl.searchParams.get('to'), '2026-09-23');
  assert.deepEqual(result.map((item) => item.fixtureId), ['same-day']);
});

test('lista todos os campeonatos ou filtra pelo país escolhido', () => {
  const payload = [
    {tournamentId:71,tournamentName:'Serie A',categorySlug:'brazil',categoryName:'Brazil',futureFixtures:8},
    {tournamentId:72,tournamentName:'Serie B',categorySlug:'brazil',categoryName:'Brazil',upcomingFixtures:2},
    {tournamentId:8,tournamentName:'LaLiga',categorySlug:'spain',categoryName:'Spain',futureFixtures:10}
  ];
  assert.deepEqual(normalizeOddsPapiTournaments(payload).map((item) => item.id), [8, 71, 72]);
  const result = normalizeOddsPapiTournaments(payload, {country:'brazil'});
  assert.deepEqual(result.map((item) => item.id), [71, 72]);
  assert.equal(result[0].fixtures, 8);
});

test('continua os outros jogos quando uma fixture da OddsPapi falha', async () => {
  const broken = {...fixture, fixtureId:'id-error', participant1Name:'Falha FC'};
  const fetchImpl = async (url) => {
    if (url.includes('/fixtures?')) return {ok:true,status:200,json:async()=>[broken, fixture]};
    if (url.includes('id-error')) return {ok:false,status:429,json:async()=>({error:{message:'Limite temporário'}})};
    return {ok:true,status:200,json:async()=>payload};
  };
  const result = await collectOddsPapi({key:'teste',from:'2026-09-21',to:'2026-09-23',tournamentId:71,fetchImpl});
  assert.equal(result.results.length, 1);
  assert.equal(result.fixtureErrors.length, 1);
  assert.match(result.fixtureErrors[0].error, /Limite temporário/);
});
