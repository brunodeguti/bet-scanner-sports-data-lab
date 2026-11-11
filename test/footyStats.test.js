import test from 'node:test';
import assert from 'node:assert/strict';
import { clearFootyStatsCache, compareFootyStatsTeams, getFootyStatsLeagues, normalizeFootyStatsLastX, normalizeFootyStatsLeagues, normalizeFootyStatsLeagueTeams } from '../src/footyStats.js';

function team(teamId, name, withPremium = false) {
  return {
    id:teamId, name, full_name:`${name} FC`, country:'Brasil', season:'2026', competition_id:71,
    last_x_match_num:5,
    stats:{
      seasonMatchesPlayed_overall:5, seasonMatchesPlayed_home:3, seasonMatchesPlayed_away:2,
      seasonWinsNum_overall:4, seasonWinsNum_home:3, seasonWinsNum_away:1,
      seasonDrawsNum_overall:1, seasonDrawsNum_home:0, seasonDrawsNum_away:1,
      seasonLossesNum_overall:0, seasonLossesNum_home:0, seasonLossesNum_away:0,
      seasonPPG_overall:2.6, seasonPPG_home:3, seasonPPG_away:2,
      seasonScoredAVG_overall:2, seasonScoredAVG_home:2.33, seasonScoredAVG_away:1.5,
      seasonConcededAVG_overall:0.8, seasonConcededAVG_home:0.67, seasonConcededAVG_away:1,
      seasonAVG_overall:2.8, seasonAVG_home:3, seasonAVG_away:2.5,
      seasonBTTSPercentage_overall:40, seasonBTTSPercentage_home:33, seasonBTTSPercentage_away:50,
      seasonOver25Percentage_overall:60, seasonOver25Percentage_home:67, seasonOver25Percentage_away:50,
      scoredAVGHT_overall:0.8, concededAVGHT_overall:0.2, AVGHT_overall:1,
      seasonOver05PercentageHT_overall:60,
      scored_2hg_avg_overall:1.2, conceded_2hg_avg_overall:0.6, AVG_2hg_overall:1.8,
      shotsAVG_overall:14.2, shotsOnTargetAVG_overall:5.4,
      ...(withPremium ? {
        cornersAVG_overall:6.2, cornersAgainstAVG_overall:3.8, corners_total_avg_overall:10,
        cards_for_avg_overall:2.4, cards_total_avg_overall:4.7
      } : { cornersAVG_overall:-1, cardsAVG_overall:-1 })
    }
  };
}

function payload(teamId, name, withPremium = false) {
  const five = team(teamId, name, withPremium);
  const ten = structuredClone(five);
  ten.last_x_match_num = 10;
  ten.stats.seasonMatchesPlayed_overall = 10;
  return { success:true, metadata:{request_limit:'1800', request_remaining:'1798'}, data:[five, ten] };
}

test('normaliza últimos 5/10, casa/fora e tempos sem inventar dados bloqueados', () => {
  const result = normalizeFootyStatsLastX(payload(612, 'Flamengo'), 612);
  assert.equal(result.name, 'Flamengo FC');
  assert.deepEqual(result.availableWindows, [5, 10]);
  assert.equal(result.windows['5'].venues.home.ppg, 3);
  assert.equal(result.windows['5'].venues.overall.firstHalf.goalsTotal, 1);
  assert.equal(result.windows['5'].venues.overall.secondHalf.goalsTotal, 1.8);
  assert.equal(result.availability.shots, true);
  assert.equal(result.availability.corners, false);
  assert.equal(result.availability.cards, false);
});

test('aceita nomes novos de cartões/escanteios e ignora sentinela negativa', () => {
  const premium = normalizeFootyStatsLastX(payload(612, 'Flamengo', true), 612);
  const overall = premium.windows['5'].venues.overall;
  assert.equal(overall.corners.total, 10);
  assert.equal(overall.cards.team, 2.4);
  assert.equal(overall.cards.total, 4.7);
  assert.equal(premium.availability.cards, true);
});

test('compara dois times, preserva quota e usa cache', async () => {
  clearFootyStatsCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const teamId = Number(new URL(url).searchParams.get('team_id'));
    return { ok:true, status:200, json:async () => payload(teamId, teamId === 612 ? 'Flamengo' : 'Santos') };
  };
  const first = await compareFootyStatsTeams({ key:'segredo', homeTeamId:612, awayTeamId:711, fetchImpl });
  assert.equal(first.home.shortName, 'Flamengo');
  assert.equal(first.away.shortName, 'Santos');
  assert.equal(first.unavailable.corners, true);
  assert.equal(first.quota.remaining, 1798);
  assert.equal(calls, 2);
  const second = await compareFootyStatsTeams({ key:'segredo', homeTeamId:612, awayTeamId:711, fetchImpl });
  assert.deepEqual(second.cached, {home:true, away:true});
  assert.equal(calls, 2);
});

test('recusa ID inválido antes de chamar a FootyStats', async () => {
  clearFootyStatsCache();
  await assert.rejects(
    compareFootyStatsTeams({ key:'segredo', homeTeamId:'abc', awayTeamId:2, fetchImpl:async () => assert.fail('não deveria consultar') }),
    /ID FootyStats/
  );
});

test('converte campeonatos na temporada mais recente e lista IDs dos times', () => {
  const leagues = normalizeFootyStatsLeagues({data:[
    {name:'Brazil Serie A',country:'Brazil',league_name:'Serie A',season:[{id:100,year:2025},{id:200,year:2026}]},
    {name:'England Premier League',country:'England',league_name:'Premier League',season:[{id:300,year:20252026}]}
  ]});
  assert.equal(leagues.find((item) => item.name === 'Serie A').seasonId, 200);
  const teams = normalizeFootyStatsLeagueTeams({data:[
    {id:612,name:'CR Flamengo',cleanName:'Flamengo',full_name:'CR Flamengo',alt_names:['Fla'],alt_name1:'Mengão'},
    {id:711,name:'Santos FC',cleanName:'Santos'}
  ]});
  assert.deepEqual(teams.map((item) => item.id), [612, 711]);
  assert.equal(teams[0].aliases.includes('Fla'), true);
  assert.equal(teams[0].aliases.includes('Mengão'), true);
});

test('cruza catálogo completo com as ligas liberadas na conta', async () => {
  clearFootyStatsCache();
  const fetchImpl = async (url) => {
    const chosen = new URL(url).searchParams.get('chosen_leagues_only') === 'true';
    return {ok:true,status:200,json:async()=>({success:true,data:chosen ? [
      {name:'Brazil Serie A',country:'Brazil',league_name:'Serie A',season:[{id:200,year:2026}]}
    ] : [
      {name:'Brazil Serie A',country:'Brazil',league_name:'Serie A',season:[{id:200,year:2026}]},
      {name:'Brazil Acreano',country:'Brazil',league_name:'Acreano',season:[{id:201,year:2026}]}
    ]})};
  };
  const result = await getFootyStatsLeagues({key:'teste',fetchImpl});
  assert.equal(result.catalogLeagues, 2);
  assert.equal(result.accessibleLeagues, 1);
  assert.equal(result.leagues.find((item) => item.seasonId === 200).accessible, true);
  assert.equal(result.leagues.find((item) => item.seasonId === 201).accessible, false);
});
