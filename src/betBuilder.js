const METRICS = new Set(['goals', 'firstHalfGoals', 'secondHalfGoals', 'corners', 'yellow', 'red', 'cardsTotal', 'shots', 'onTarget', 'firstHalfCards', 'secondHalfCards']);
const MARKETS = new Set(['total', 'result', 'double_chance', 'btts', 'asian_handicap', 'european_handicap', 'custom']);

function fail(message) { throw new Error(message); }
function cleanName(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }
function eventKey(row) { return `${row.league}|${row.season}|${row.kickoff}|${row.home_team}|${row.away_team}`; }
const decimals = (value) => Math.round(value * 10000) / 10000;

export function validateSelection(raw) {
  const market = String(raw?.market ?? '');
  if (!MARKETS.has(market)) fail('Mercado da seleção inválido.');
  const result = { market, label:cleanName(raw?.label).slice(0, 160), quoteRef:null };
  if (market === 'custom') {
    if (!result.label) fail('Informe o nome da seleção sem estatísticas por partida.');
    return result;
  }
  if (market === 'total') {
    result.metric = String(raw.metric ?? '');
    result.subject = String(raw.subject ?? '');
    result.pick = String(raw.pick ?? '');
    if (!METRICS.has(result.metric) || !['home', 'away', 'match'].includes(result.subject) || !['over', 'under'].includes(result.pick)) fail('Métrica, equipe ou lado over/under inválido.');
    result.line = Number(raw.line);
    if (raw.line === '' || raw.line == null || !Number.isFinite(result.line) || result.line < 0 || result.line > 100 || Math.abs(result.line * 4 - Math.round(result.line * 4)) > 1e-8) fail('Linha deve estar entre 0 e 100, em passos de 0,25.');
  } else if (market === 'asian_handicap' || market === 'european_handicap') {
    result.line = Number(raw.line);
    result.subject = market === 'asian_handicap' ? String(raw.subject ?? '') : 'home';
    result.pick = market === 'asian_handicap' ? result.subject : String(raw.pick ?? '');
    if (raw.line === '' || raw.line == null || !Number.isFinite(result.line) || Math.abs(result.line) > 20 ||
        Math.abs(result.line * (market === 'asian_handicap' ? 4 : 1) - Math.round(result.line * (market === 'asian_handicap' ? 4 : 1))) > 1e-8 ||
        !(market === 'asian_handicap' ? ['home', 'away'].includes(result.subject) : ['home', 'draw', 'away'].includes(result.pick))) fail('Handicap, time ou resultado inválido.');
  } else {
    result.pick = String(raw.pick ?? '');
    const allowed = market === 'result' ? ['home', 'draw', 'away'] : market === 'double_chance' ? ['1x', 'x2', '12'] : ['yes', 'no'];
    if (!allowed.includes(result.pick)) fail('Resultado escolhido inválido.');
  }
  if (raw.quoteRef != null) {
    const ref = raw.quoteRef;
    if (!/^[\w.-]{1,100}$/.test(String(ref.bookmaker ?? '')) || !Number.isSafeInteger(Number(ref.marketId)) || Number(ref.marketId) < 1 || !Number.isSafeInteger(Number(ref.outcomeId)) || Number(ref.outcomeId) < 1) fail('Identificador da cotação OddsPapi inválido.');
    result.quoteRef = {
      bookmaker:String(ref.bookmaker), marketId:Number(ref.marketId), outcomeId:Number(ref.outcomeId),
      line:String(ref.line ?? '').slice(0, 80), playerName:String(ref.playerName ?? '').slice(0, 100)
    };
  }
  return result;
}

export function createBetSlip(db, raw) {
  const league = cleanName(raw?.league), season = cleanName(raw?.season);
  const home = cleanName(raw?.home), away = cleanName(raw?.away);
  const kickoff = new Date(raw?.kickoff);
  const fixtureId = cleanName(raw?.fixtureId);
  if (!league || !season || !home || !away || home === away || !Number.isFinite(kickoff.getTime())) fail('Informe campeonato, temporada, duas equipes distintas e data do jogo.');
  if (fixtureId && !/^[\w-]{1,100}$/.test(fixtureId)) fail('ID da partida OddsPapi inválido.');
  const teams = db.prepare(`SELECT team FROM (
    SELECT home_team AS team FROM footy_matches WHERE league=? AND season=?
    UNION SELECT away_team AS team FROM footy_matches WHERE league=? AND season=?
  )`).all(league, season, league, season).map((row) => row.team);
  if (!teams.includes(home) || !teams.includes(away)) fail('Um dos times não consta no CSV de partidas desta temporada.');
  const created = db.prepare(`INSERT INTO bet_slips(league, season, home_team, away_team, kickoff, fixture_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(league, season, home, away, kickoff.toISOString(), fixtureId || null);
  return getBetSlip(db, Number(created.lastInsertRowid));
}

export function getBetSlip(db, id) {
  const row = db.prepare('SELECT * FROM bet_slips WHERE id=?').get(id);
  if (!row) fail('Criar Aposta não encontrada.');
  return { ...row, legs:db.prepare('SELECT id, selection FROM bet_legs WHERE slip_id=? ORDER BY id').all(id)
    .map((item) => ({ id:item.id, ...JSON.parse(item.selection) })) };
}

export function listBetSlips(db) {
  return db.prepare('SELECT id FROM bet_slips ORDER BY id DESC LIMIT 50').all().map((row) => getBetSlip(db, row.id));
}

export function addBetLeg(db, slipId, raw) {
  getBetSlip(db, slipId);
  const selection = validateSelection(raw);
  const count = db.prepare('SELECT COUNT(*) AS n FROM bet_legs WHERE slip_id=?').get(slipId).n;
  if (count >= 20) fail('Limite de 20 seleções por Criar Aposta.');
  const id = Number(db.prepare('INSERT INTO bet_legs(slip_id, selection) VALUES (?, ?)').run(slipId, JSON.stringify(selection)).lastInsertRowid);
  return { id, ...selection };
}

export function deleteBetLeg(db, slipId, legId) {
  const row = db.prepare('DELETE FROM bet_legs WHERE id=? AND slip_id=?').run(legId, slipId);
  if (!row.changes) fail('Seleção não encontrada nesta Criar Aposta.');
}

function measure(row, leg) {
  const h = row.stats.home, a = row.stats.away;
  if (leg.market === 'custom') return null;
  if (leg.market === 'btts') return h.goals == null || a.goals == null ? null : Number(h.goals > 0 && a.goals > 0);
  if (['result', 'double_chance', 'asian_handicap', 'european_handicap'].includes(leg.market)) {
    return h.goals == null || a.goals == null ? null : { home:h.goals, away:a.goals };
  }
  const field = leg.metric;
  const calc = (stats) => {
    if (field === 'firstHalfGoals') return stats.firstHalfGoals;
    if (field === 'secondHalfGoals') return stats.firstHalfGoals == null || stats.goals == null ? null : stats.goals - stats.firstHalfGoals;
    if (field === 'cardsTotal') return stats.yellow == null || stats.red == null ? null : stats.yellow + stats.red;
    return stats[field] ?? null;
  };
  const home = calc(h), away = calc(a);
  if (leg.subject === 'home') return home;
  if (leg.subject === 'away') return away;
  return home == null || away == null ? null : home + away;
}

function threshold(value, line, pick) {
  if (value == null) return null;
  const sign = pick === 'over' ? value - line : line - value;
  return sign > 1e-8 ? 1 : sign < -1e-8 ? -1 : 0;
}

function settleQuarter(value, line, pick) {
  // Uma linha .25/.75 divide a stake igualmente entre as duas linhas inteiras/semiponto adjacentes.
  const quarter = Math.abs(line * 2 - Math.round(line * 2)) > 1e-8;
  const parts = quarter ? [threshold(value, line - 0.25, pick), threshold(value, line + 0.25, pick)] : [threshold(value, line, pick)];
  if (parts.some((part) => part == null)) return null;
  const score = parts.reduce((sum, part) => sum + part, 0) / parts.length;
  return score === 1 ? 'green' : score === 0.5 ? 'half_green' : score === 0 ? 'push' : score === -0.5 ? 'half_red' : 'red';
}

export function settleSelection(row, leg) {
  const value = measure(row, leg);
  if (value == null) return { value:null, result:'missing' };
  if (leg.market === 'total') return { value, result:settleQuarter(value, leg.line, leg.pick) };
  if (leg.market === 'btts') return { value, result:Boolean(value) === (leg.pick === 'yes') ? 'green' : 'red' };
  if (leg.market === 'asian_handicap') {
    const margin = leg.subject === 'home' ? value.home - value.away : value.away - value.home;
    return { value:margin, result:settleQuarter(margin, -leg.line, 'over') };
  }
  const margin = value.home - value.away + (leg.market === 'european_handicap' ? leg.line : 0);
  const winner = margin > 0 ? 'home' : margin < 0 ? 'away' : 'draw';
  if (leg.market === 'double_chance') {
    return { value:margin, result:(leg.pick === '1x' ? winner !== 'away' : leg.pick === 'x2' ? winner !== 'home' : winner !== 'draw') ? 'green' : 'red' };
  }
  return { value:margin, result:winner === leg.pick ? 'green' : 'red' };
}

function recent(db, slip, team, venue) {
  const clause = venue === 'home' ? 'home_team=?' : venue === 'away' ? 'away_team=?' : '(home_team=? OR away_team=?)';
  const args = venue === 'overall' ? [team, team] : [team];
  return db.prepare(`SELECT * FROM footy_matches WHERE league=? AND season=? AND ${clause} AND kickoff < ?
    ORDER BY kickoff DESC LIMIT 12`).all(slip.league, slip.season, ...args, Date.parse(slip.kickoff) / 1000)
    .map((row) => ({ ...row, stats:JSON.parse(row.stats) }));
}

function countResults(items) {
  const counts = { green:0, half_green:0, push:0, half_red:0, red:0, missing:0 };
  for (const item of items) counts[item.result]++;
  return { ...counts, observed:items.length - counts.missing, total:items.length };
}

function sample(rows, leg, limit) {
  const games = rows.slice(0, limit).map((row) => ({
    key:eventKey(row), kickoff:row.kickoff, home:row.home_team, away:row.away_team,
    ...settleSelection(row, leg)
  }));
  return { counts:countResults(games), games };
}

function strongestClass(counts) {
  if (counts.observed < 10) return 'sem_base';
  const winShare = (counts.green + counts.half_green * 0.5) / counts.observed;
  return winShare >= 0.75 ? 'frequencia_alta' : winShare < 0.6 ? 'frequencia_baixa' : 'intermediaria';
}

export function evaluateBetSlip(db, id) {
  const slip = getBetSlip(db, id);
  const venue = {
    home:recent(db, slip, slip.home_team, 'home'), away:recent(db, slip, slip.away_team, 'away')
  };
  const general = {
    home:recent(db, slip, slip.home_team, 'overall'), away:recent(db, slip, slip.away_team, 'overall')
  };
  const legs = slip.legs.map((leg) => {
    const evidence = Object.fromEntries(['home', 'away'].map((side) => [side, {
      last5:sample(venue[side], leg, 5), last10:sample(venue[side], leg, 10),
      general5:sample(general[side], leg, 5), general10:sample(general[side], leg, 10)
    }]));
    const used = [evidence.home.last10, evidence.away.last10];
    const seen = new Set(), pooled = [];
    for (const set of used) for (const game of set.games) if (!seen.has(game.key)) { pooled.push(game); seen.add(game.key); }
    const counts = countResults(pooled);
    const ageBySide = Object.fromEntries(['home', 'away'].map((side) => [side, venue[side][0]
      ? Math.floor((Date.parse(slip.kickoff) / 1000 - venue[side][0].kickoff) / 86400) : null]));
    const ageDays = ageBySide.home != null && ageBySide.away != null ? Math.max(ageBySide.home, ageBySide.away) : null;
    const enough = used.every((set) => set.counts.observed >= 10) && counts.observed >= 20 &&
      Object.values(ageBySide).every((age) => age != null && age >= 0 && age <= 90);
    const reason = leg.market === 'custom' ? 'Mercado sem dados por partida no CSV.'
      : ageDays != null && ageDays > 90 ? `Dados antigos: partida mais recente há ${ageDays} dias do jogo.`
      : !enough ? 'Exige 10 jogos observados do mandante em casa e 10 do visitante fora, até 90 dias antes do jogo.' : null;
    const probability = enough ? Object.fromEntries(['green', 'half_green', 'push', 'half_red', 'red']
      .map((result) => [result, decimals(counts[result] / counts.observed)])) : null;
    const netWins = probability ? probability.green + probability.half_green / 2 : 0;
    const netLosses = probability ? probability.red + probability.half_red / 2 : 0;
    const fairOdds = netWins > 0 && netLosses > 0 ? decimals(1 + netLosses / netWins) : null;
    return { ...leg, evidence, pooled:counts, probability,
      fairOdds, fairOddsReason:probability && fairOdds == null ? 'A amostra teve somente ganhos ou somente perdas; odd justa e EV não são estimados.' : null,
      strength:enough ? strongestClass(counts) : 'sem_base', reason, ageDays, quote:null, evPct:null };
  });
  return { ...slip, legs, correlations:correlations(legs) };
}

function correlations(legs) {
  const results = [];
  const goalMarkets = new Set(['result', 'double_chance', 'btts', 'asian_handicap', 'european_handicap']);
  for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
    const a = legs[i], b = legs[j];
    let reason = null;
    if (a.market === 'total' && b.market === 'total') {
      if (a.metric === b.metric && (a.subject === b.subject || a.subject === 'match' || b.subject === 'match')) reason = 'As linhas usam a mesma estatística ou uma parte do total.';
      if (['shots', 'onTarget'].includes(a.metric) && ['shots', 'onTarget'].includes(b.metric) && a.metric !== b.metric && a.subject === b.subject) reason = 'Chutes no gol são parte das finalizações.';
    }
    if ((goalMarkets.has(a.market) || (a.market === 'total' && /goals/i.test(a.metric))) &&
        (goalMarkets.has(b.market) || (b.market === 'total' && /goals/i.test(b.metric)))) reason = 'As seleções dependem dos mesmos gols.';
    if (reason) results.push({ firstId:a.id, secondId:b.id, reason });
  }
  return results;
}

function fold(value) { return cleanName(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase(); }

export function oddsFixtureMatches(slip, summary) {
  const [home, away] = String(summary.event ?? '').split(' x ');
  return fold(slip.home_team) === fold(home) && fold(slip.away_team) === fold(away) &&
    Math.abs(Date.parse(slip.kickoff) - Date.parse(summary.startsAt)) < 2 * 3600000;
}

function quoteLine(offer, market) {
  const match = /^([+-]?\d+(?:\.\d+)?)(?:\/|$)/.exec(String(offer.line ?? ''));
  return match ? Number(match[1]) : market.handicap != null && Number.isFinite(Number(market.handicap)) ? Number(market.handicap) : null;
}

function compatibleQuote(leg, market, offer) {
  const name = market.name.toLowerCase(), outcome = String(offer.outcome).trim().toLowerCase();
  const period = String(market.period).toLowerCase();
  if (market.playerProp || offer.playerName) return false;
  const first = /firsthalf|first half|1st half|p1/.test(period);
  const full = /fulltime|full time|regular|p0/.test(period);
  if (!first && !full) return false;
  const acceptable = leg.pick === 'home' ? ['1', 'home'] : leg.pick === 'away' ? ['2', 'away']
    : leg.pick === 'draw' ? ['x', 'draw'] : [leg.pick];
  const outcomeMatches = acceptable.includes(outcome);
  if (!outcomeMatches) return false;
  if (leg.market === 'total') {
    const halfMetric = /firstHalf|secondHalf/.test(leg.metric);
    if (halfMetric !== first || (leg.metric.startsWith('secondHalf'))) return false;
    const patterns = {
      goals:/\bgoals?\b/, corners:/\bcorners?\b/, yellow:/yellow cards?/, red:/red cards?/, cardsTotal:/\bcards?\b|bookings?/,
      shots:/\bshots?\b|attempts?/, onTarget:/shots? on target|on target shots?/, firstHalfGoals:/\bgoals?\b/,
      firstHalfCards:/\bcards?\b|bookings?/
    };
    if (!patterns[leg.metric]?.test(name)) return false;
    if (leg.metric === 'shots' && /on target|off target|player/.test(name)) return false;
    if (leg.metric === 'cardsTotal' && /yellow|red/.test(name)) return false;
    if (leg.metric === 'goals' && /corner|player/.test(name)) return false;
    const teamMark = /team 1|team 2|home team|away team/.exec(name)?.[0];
    if (leg.subject === 'match' && teamMark) return false;
    if (leg.subject !== 'match') {
      if (!teamMark) return false;
      if (leg.subject === 'home' && !['team 1', 'home team'].includes(teamMark)) return false;
      if (leg.subject === 'away' && !['team 2', 'away team'].includes(teamMark)) return false;
    }
    return quoteLine(offer, market) === leg.line;
  }
  if (!full) return false;
  if (leg.market === 'result') return /^(full time result|1x2|match result)$/i.test(market.name);
  if (leg.market === 'double_chance') return /double chance/i.test(name);
  if (leg.market === 'btts') return /both teams to score/i.test(name);
  if (leg.market === 'asian_handicap') return /asian handicap/i.test(name) && quoteLine(offer, market) === leg.line;
  if (leg.market === 'european_handicap') return /european handicap/i.test(name) && quoteLine(offer, market) === leg.line;
  return false;
}

export function attachOdds(analysis, summary, now = Date.now()) {
  if (!oddsFixtureMatches(analysis, summary)) return { ...analysis, oddsWarning:'A partida OddsPapi não corresponde com segurança aos times e horário selecionados.' };
  return { ...analysis, oddsWarning:null, legs:analysis.legs.map((leg) => {
    if (!leg.quoteRef) return leg;
    const book = summary.books.find((item) => item.slug === leg.quoteRef.bookmaker && item.active);
    const market = book?.markets.find((item) => item.id === leg.quoteRef.marketId && item.active);
    const offer = market?.offers.find((item) => item.outcomeId === leg.quoteRef.outcomeId &&
      String(item.line ?? '') === leg.quoteRef.line && String(item.playerName ?? '') === leg.quoteRef.playerName && item.active);
    if (!offer) return { ...leg, quoteStatus:'Cotação não encontrada ou suspensa.' };
    if (!compatibleQuote(leg, market, offer)) return { ...leg, quoteStatus:'Mercado, período, seleção ou linha não corresponde aos dados analisados.' };
    const updated = Date.parse(offer.changedAt);
    if (!Number.isFinite(updated) || updated > now + 60000 || now - updated > 60 * 60000) return { ...leg, quoteStatus:'Horário da cotação indisponível ou anterior a 60 minutos.' };
    const quote = { bookmaker:book.name, price:offer.price, changedAt:offer.changedAt, market:market.name, outcome:offer.outcome };
    if (!leg.probability) return { ...leg, quote, quoteStatus:leg.reason };
    if (leg.fairOdds == null) return { ...leg, quote, quoteStatus:'A amostra não contém ganhos e perdas suficientes para estimar odd justa e EV.' };
    const p = leg.probability;
    const ev = (p.green + p.half_green / 2) * (offer.price - 1) - (p.red + p.half_red / 2);
    return { ...leg, quote, quoteStatus:null, evPct:decimals(ev * 100) };
  }) };
}
