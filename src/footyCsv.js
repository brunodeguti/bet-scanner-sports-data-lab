import { parseCsv } from './importer.js';

const fields = ['goals', 'yellow', 'red', 'corners', 'shots', 'onTarget'];
const sourceFields = {
  goals:'goal_count', yellow:'yellow_cards', red:'red_cards',
  corners:'corner_count', shots:'shots', onTarget:'shots_on_target'
};

function numberOrNull(value) {
  if (value == null || String(value).trim() === '' || /^(N\/A|null|-)$/i.test(String(value).trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function normalizeName(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }

function leagueSeason(filename) {
  const match = /^(.+)-(matches|teams2|teams|players)-(\d{4})-to-(\d{4})-stats\.csv$/i.exec(filename);
  if (!match) throw new Error('Selecione um CSV FootyStats de matches, teams, teams2 ou players com temporada no nome.');
  return { league:match[1].toLowerCase(), kind:match[2].toLowerCase(), season:`${match[3]}/${match[4]}` };
}

export function importFootyCsv(db, filename, csv) {
  const { league, season, kind } = leagueSeason(filename);
  const rows = parseCsv(csv);
  if (kind !== 'matches') return importSeasonRecords(db, { league, season, kind, rows });
  const required = ['timestamp', 'status', 'home_team_name', 'away_team_name', 'home_team_goal_count', 'away_team_goal_count'];
  if (required.some((key) => !(key in rows[0]))) throw new Error('CSV de partidas FootyStats incompleto: faltam colunas obrigatórias.');
  const columns = Object.keys(rows[0]);
  const insert = db.prepare(`INSERT INTO footy_matches(league, season, kickoff, home_team, away_team, stats)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(league, season, kickoff, home_team, away_team)
    DO UPDATE SET stats=excluded.stats`);
  let imported = 0, skipped = 0;
  db.exec('BEGIN');
  try {
    for (const [index, row] of rows.entries()) {
      if (String(row.status).toLowerCase() !== 'complete') { skipped++; continue; }
      const kickoff = Number(row.timestamp);
      const home = normalizeName(row.home_team_name), away = normalizeName(row.away_team_name);
      if (!Number.isSafeInteger(kickoff) || kickoff < 1 || !home || !away || home === away ||
          numberOrNull(row.home_team_goal_count) == null || numberOrNull(row.away_team_goal_count) == null) {
        throw new Error(`Linha ${index + 2}: data, equipes ou placar inválidos.`);
      }
      const stats = {};
      for (const side of ['home', 'away']) {
        stats[side] = Object.fromEntries(fields.map((field) => [field, numberOrNull(row[`${side}_team_${sourceFields[field]}`])]));
        stats[side].firstHalfGoals = numberOrNull(row[`${side}_team_goal_count_half_time`]);
        stats[side].firstHalfCards = numberOrNull(row[`${side}_team_first_half_cards`]);
        stats[side].secondHalfCards = numberOrNull(row[`${side}_team_second_half_cards`]);
      }
      insert.run(league, season, kickoff, home, away, JSON.stringify(stats));
      imported++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const coverage = {};
  for (const field of [...fields, 'firstHalfGoals', 'firstHalfCards', 'secondHalfCards']) {
    coverage[field] = 0;
    for (const row of rows.filter((item) => item.status.toLowerCase() === 'complete')) {
      const column = field === 'firstHalfGoals' ? 'goal_count_half_time'
        : field === 'firstHalfCards' ? 'first_half_cards' : field === 'secondHalfCards' ? 'second_half_cards' : sourceFields[field];
      for (const side of ['home', 'away']) if (numberOrNull(row[`${side}_team_${column}`]) != null) coverage[field]++;
    }
  }
  return { league, season, kind, imported, skipped, teams:listFootyTeams(db, league, season).length, columns, coverage };
}

function importSeasonRecords(db, { league, season, kind, rows }) {
  const nameColumn = kind === 'players' ? 'full_name' : 'team_name';
  if (![nameColumn, 'season'].every((key) => key in rows[0])) throw new Error(`CSV ${kind} incompleto: faltam ${nameColumn} ou season.`);
  const insert = db.prepare(`INSERT INTO footy_csv_records(league, season, kind, record_key, record_data)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(league, season, kind, record_key)
    DO UPDATE SET record_data=excluded.record_data`);
  let imported = 0;
  db.exec('BEGIN');
  try {
    for (const [index, row] of rows.entries()) {
      const name = normalizeName(row[nameColumn]);
      if (!name || String(row.season).trim() !== season) throw new Error(`Linha ${index + 2}: nome ou temporada incompatível com o arquivo.`);
      const key = kind === 'players' ? `${name}|${normalizeName(row['current club'])}|${normalizeName(row.birthday_gmt)}` : name;
      insert.run(league, season, kind, key, JSON.stringify(row));
      imported++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { league, season, kind, imported, columns:Object.keys(rows[0]), note:'Dados agregados da temporada; não usados para calcular últimos 5/10 jogos.' };
}

export function listFootyCsvDatasets(db) {
  return db.prepare(`SELECT league, season, kind, COUNT(*) AS records FROM footy_csv_records
    GROUP BY league, season, kind ORDER BY season DESC, league, kind`).all();
}

export function listFootySeasons(db) {
  return db.prepare(`SELECT league, season, COUNT(*) AS matches, MAX(kickoff) AS latest
    FROM footy_matches GROUP BY league, season ORDER BY latest DESC`).all();
}

export function listFootyTeams(db, league, season) {
  return db.prepare(`SELECT team FROM (
    SELECT home_team AS team FROM footy_matches WHERE league=? AND season=?
    UNION SELECT away_team AS team FROM footy_matches WHERE league=? AND season=?
  ) ORDER BY team`).all(league, season, league, season).map((row) => row.team);
}

function average(games, select) {
  const values = games.map(select).filter((value) => value != null);
  return values.length ? { average:Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100, observed:values.length } : { average:null, observed:0 };
}

function summarize(games, name) {
  const sample = { matches:games.length, from:games.at(-1)?.kickoff ?? null, to:games[0]?.kickoff ?? null };
  sample.games = games.map((game) => {
    const home = game.home_team === name;
    return { kickoff:game.kickoff, venue:home ? 'home' : 'away', opponent:home ? game.away_team : game.home_team,
      for:game.stats[home ? 'home' : 'away'], against:game.stats[home ? 'away' : 'home'] };
  });
  for (const field of fields) {
    sample[field] = average(games, (game) => {
      const stats = game.stats;
      const side = game.home_team === name ? 'home' : 'away';
      return stats[side][field];
    });
    sample[`${field}Against`] = average(games, (game) => {
      const side = game.home_team === name ? 'away' : 'home';
      return game.stats[side][field];
    });
  }
  sample.totalGoals = average(games, (game) => game.stats.home.goals + game.stats.away.goals);
  sample.totalCorners = average(games, (game) => {
    const { home, away } = game.stats;
    return home.corners == null || away.corners == null ? null : home.corners + away.corners;
  });
  sample.totalCards = average(games, (game) => {
    const { home, away } = game.stats;
    return [home.yellow, home.red, away.yellow, away.red].every((v) => v != null)
      ? home.yellow + home.red + away.yellow + away.red : null;
  });
  sample.firstHalfGoals = average(games, (game) => {
    const { home, away } = game.stats;
    return home.firstHalfGoals == null || away.firstHalfGoals == null ? null : home.firstHalfGoals + away.firstHalfGoals;
  });
  for (const half of ['firstHalf', 'secondHalf']) {
    sample[`${half}GoalsFor`] = average(games, (game) => {
      const side = game.home_team === name ? 'home' : 'away';
      const stats = game.stats[side];
      return stats.firstHalfGoals == null ? null : half === 'firstHalf' ? stats.firstHalfGoals : stats.goals - stats.firstHalfGoals;
    });
    sample[`${half}GoalsAgainst`] = average(games, (game) => {
      const side = game.home_team === name ? 'away' : 'home';
      const stats = game.stats[side];
      return stats.firstHalfGoals == null ? null : half === 'firstHalf' ? stats.firstHalfGoals : stats.goals - stats.firstHalfGoals;
    });
    sample[`${half}Cards`] = average(games, (game) => {
      const side = game.home_team === name ? 'home' : 'away';
      return game.stats[side][`${half}Cards`];
    });
  }
  return sample;
}

export function footyTeamWindows(db, { league, season, team, before }) {
  if (!league || !season || !team) throw new Error('Selecione campeonato, temporada e equipe.');
  const cutoff = before ? Date.parse(before) / 1000 : Date.now() / 1000;
  if (!Number.isFinite(cutoff)) throw new Error('Data de corte inválida.');
  const rows = db.prepare(`SELECT * FROM footy_matches WHERE league=? AND season=?
    AND (home_team=? OR away_team=?) AND kickoff < ? ORDER BY kickoff DESC`).all(league, season, team, team, cutoff)
    .map((row) => ({ ...row, stats:JSON.parse(row.stats) }));
  if (!rows.length) throw new Error('Nenhuma partida concluída encontrada para esta equipe antes da data selecionada.');
  const venues = { overall:rows, home:rows.filter((row) => row.home_team === team), away:rows.filter((row) => row.away_team === team) };
  return { league, season, team, windows:Object.fromEntries([5, 10].map((size) =>
    [size, Object.fromEntries(Object.entries(venues).map(([venue, games]) => [venue, summarize(games.slice(0, size), team)]))])),
    lastMatch:rows[0].kickoff };
}
