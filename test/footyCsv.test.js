import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDatabase } from '../src/db.js';
import { importFootyCsv, footyTeamWindows, listFootyCsvDatasets, listFootySeasons, listFootyTeams } from '../src/footyCsv.js';
import { createApp } from '../src/app.js';

const filename = 'england-premier-league-matches-2018-to-2019-stats.csv';
const header = 'timestamp,status,home_team_name,away_team_name,home_team_goal_count,away_team_goal_count,home_team_corner_count,away_team_corner_count,home_team_yellow_cards,away_team_yellow_cards,home_team_red_cards,away_team_red_cards,home_team_shots,away_team_shots,home_team_shots_on_target,away_team_shots_on_target';
const csv = [header,
  '1000,complete,A,B,2,1,5,3,2,1,0,0,10,8,4,2',
  '2000,complete,C,A,0,3,2,4,1,3,0,1,6,12,1,5',
  '3000,complete,A,C,1,1,N/A,7,0,1,0,0,9,10,3,4',
  '4000,incomplete,A,B,9,9,9,9,9,9,9,9,9,9,9,9'].join('\n');

test('importação preserva jogos e recortes por local com ausentes e data de corte', () => {
  const db = openDatabase();
  try {
    const first = importFootyCsv(db, filename, csv);
    assert.deepEqual([first.imported, first.skipped, first.teams], [3, 1, 3]);
    importFootyCsv(db, filename, csv);
    assert.equal(listFootySeasons(db)[0].matches, 3);
    assert.deepEqual(listFootyTeams(db, first.league, first.season), ['A', 'B', 'C']);
    const team = footyTeamWindows(db, { ...first, team:'A', before:new Date(3500 * 1000).toISOString() });
    assert.equal(team.windows[5].overall.matches, 3);
    assert.equal(team.windows[5].home.matches, 2);
    assert.equal(team.windows[5].away.matches, 1);
    assert.equal(team.windows[5].home.corners.average, 5);
    assert.equal(team.windows[5].home.corners.observed, 1);
    assert.equal(team.windows[5].overall.goals.average, 2);
    assert.equal(team.windows[10].overall.matches, 3);
    const early = footyTeamWindows(db, { ...first, team:'A', before:new Date(2500 * 1000).toISOString() });
    assert.equal(early.windows[5].overall.matches, 2);
    assert.equal(early.windows[5].overall.goals.average, 2.5);
  } finally { db.close(); }
});

test('arquivo incorreto e linha inválida não importam parcialmente', () => {
  const db = openDatabase();
  try {
    assert.throws(() => importFootyCsv(db, 'teams.csv', csv), /CSV FootyStats/);
    assert.throws(() => importFootyCsv(db, filename, csv + '\n5000,complete,A,A,1,0,,,,,,,,,,'), /Linha/);
    assert.equal(listFootySeasons(db).length, 0);
  } finally { db.close(); }
});

test('amostra real da FootyStats soma jogos por temporada sem duplicar', () => {
  const path = process.env.FOOTY_SAMPLE_PATH;
  if (!path) return;
  const db = openDatabase();
  try {
    const summary = importFootyCsv(db, filename, fs.readFileSync(path, 'utf8'));
    assert.equal(summary.imported, 380);
    assert.equal(listFootySeasons(db)[0].matches, 380);
    assert.equal(footyTeamWindows(db, { ...summary, team:'Manchester United' }).windows[10].overall.matches, 10);
  } finally { db.close(); }
});

test('rotas HTTP importam CSV e comparam times sem chave de API', async () => {
  const db = openDatabase();
  const server = createApp({ db }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const imported = await fetch(`${base}/api/footy-csv/import?filename=${filename}`, {
      method:'POST', headers:{ 'content-type':'text/csv' }, body:csv
    });
    assert.equal(imported.status, 201);
    assert.equal((await imported.json()).imported, 3);
    const result = await (await fetch(`${base}/api/footy-csv/compare?league=england-premier-league&season=2018%2F2019&home=A&away=C`)).json();
    assert.equal(result.home.windows['5'].home.matches, 2);
    assert.equal(result.away.windows['5'].away.matches, 1);
    assert.equal(result.source, 'FootyStats CSV');
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});

test('quatro CSVs reais: partidas alimentam recortes e agregados ficam separados', () => {
  const directory = process.env.FOOTY_SAMPLE_DIRECTORY;
  if (!directory) return;
  const db = openDatabase();
  try {
    const kinds = ['matches', 'teams', 'teams2', 'players'];
    const expected = [380, 20, 20, 572];
    for (const [i, kind] of kinds.entries()) {
      const name = `england-premier-league-${kind}-2018-to-2019-stats.csv`;
      const content = fs.readFileSync(`${directory}/${name}`, 'utf8');
      const result = importFootyCsv(db, name, content);
      assert.equal(result.imported, expected[i], kind);
      assert.ok(result.columns.length >= (kind === 'matches' ? 66 : 200));
      importFootyCsv(db, name, content);
    }
    assert.equal(listFootySeasons(db)[0].matches, 380);
    assert.deepEqual(listFootyCsvDatasets(db).map((entry) => entry.records).sort((a, b) => a - b), [20, 20, 572]);
  } finally { db.close(); }
});
