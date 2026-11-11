import express from 'express';
import { assertMarketIntegrity } from './marketIntegrity.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateEV, calculateSurebet, consensusNoVig, round2 } from './calculations.js';
import { getMarket, importRows, listMarkets, saveHistory } from './db.js';
import { parseCsv, validateImportRows } from './importer.js';
import { analyzeOddsPapiFixture, collectOddsPapi, fetchOddsPapiOdds, getOddsPapiMarkets, getOddsPapiTournaments, ODDS_PAPI_DEFAULT_BOOKMAKERS, summarizeOddsPapiFixture, transformOddsPapi } from './oddsPapi.js';
import { compareFootyStatsTeams, getFootyStatsLeagues, getFootyStatsLeagueTeams, getFootyStatsTeam } from './footyStats.js';
import { importFootyCsv, listFootyCsvDatasets, listFootySeasons, listFootyTeams, footyTeamWindows } from './footyCsv.js';
import { addBetLeg, attachOdds, createBetSlip, deleteBetLeg, evaluateBetSlip, getBetSlip, listBetSlips, oddsFixtureMatches } from './betBuilder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const oddsPapiMarketsCacheFile = path.join(__dirname, '..', 'data', 'oddspapi-markets-cache.json');

function readSettings(db) {
  return db.prepare(`SELECT bankroll, fixed_stake, surebet_stake, ev_stake_mode, ev_fixed_stake,
    kelly_fraction, max_exposure_pct, min_ev_pct FROM settings WHERE id=1`).get();
}

function riskSummary(settings) {
  const maxStake = round2(Number(settings.bankroll) * Number(settings.max_exposure_pct) / 100);
  const effectiveSurebetStake = round2(Math.min(Number(settings.surebet_stake), maxStake));
  const effectiveEvFixedStake = round2(Math.min(Number(settings.ev_fixed_stake), maxStake));
  const warnings = [];
  if (Number(settings.surebet_stake) > maxStake) warnings.push(`Stake da surebet limitada de R$ ${Number(settings.surebet_stake).toFixed(2)} para R$ ${maxStake.toFixed(2)} pela exposição máxima.`);
  if (settings.ev_stake_mode === 'fixed' && Number(settings.ev_fixed_stake) > maxStake) warnings.push(`Stake fixa +EV limitada de R$ ${Number(settings.ev_fixed_stake).toFixed(2)} para R$ ${maxStake.toFixed(2)} pela exposição máxima.`);
  return { maxStake, effectiveSurebetStake, effectiveEvFixedStake, warnings };
}

function settingsResponse(settings) {
  return { ...settings, risk:riskSummary(settings) };
}

function marketAnalysis(market, settings, enforceFreshness = true) {
  const risk = riskSummary(settings);
  const outcomes = [...new Set(market.quotes.map((quote) => quote.outcome))];
  let surebet = null;
  let surebetError = null;
  try { assertMarketIntegrity(market, { enforceFreshness }); surebet = calculateSurebet(market.quotes, risk.effectiveSurebetStake); }
  catch (error) { surebetError = error.message; }
  const consensus = surebetError ? { probabilities:{}, sources:[] } : consensusNoVig(market.quotes, outcomes);
  const ev = (surebetError ? [] : market.quotes).map((quote) => {
    const manual = quote.estimated_probability;
    const probability = manual ?? consensus.probabilities[quote.outcome];
    if (!probability) return null;
    return {
      quoteId: quote.id,
      outcome: quote.outcome,
      bookmaker: quote.bookmaker,
      probabilitySource: manual ? 'manual' : `no-vig: ${consensus.sources.join(', ')}`,
      ...calculateEV({
        odds: quote.odds,
        fairProbability: probability,
        bankroll: settings.bankroll,
        fixedStake: settings.ev_fixed_stake,
        kellyFraction: settings.kelly_fraction,
        maxExposurePct: settings.max_exposure_pct,
        stakeMode: settings.ev_stake_mode
      }),
      minimumMet:false
    };
  }).filter(Boolean).sort((a, b) => b.evPct - a.evPct);
  for (const item of ev) item.minimumMet = item.evPct >= settings.min_ev_pct && item.suggestedStake > 0;
  return { ...market, outcomes, surebet, surebetError, ev, referenceSources: consensus.sources, risk };
}

function parseHistoryPayload(value) {
  try { return JSON.parse(value); }
  catch { return {}; }
}

function historyStake(kind, payload) {
  if (kind === 'surebet') return round2(payload.totalStake ?? payload.allocation?.reduce((sum, item) => sum + Number(item.stake || 0), 0) ?? 0);
  return round2(payload.suggestedStake ?? 0);
}

function settlementProfit(kind, payload, status) {
  const stake = historyStake(kind, payload);
  if (['push', 'cancelled', 'open'].includes(status)) return 0;
  if (status === 'loss') return round2(-stake);
  if (kind === 'surebet') return round2(payload.roundedMinProfit ?? 0);
  return round2(stake * (Number(payload.odds) - 1));
}

function historyRow(row) {
  const payload = parseHistoryPayload(row.payload);
  return { ...row, payload, stake:historyStake(row.kind, payload) };
}

export function createApp({ db, fetchImpl = fetch, oddsPapiCacheFile = oddsPapiMarketsCacheFile, simulationOnly = true, enforceFreshness = true }) {
  const app = express();
  app.disable('x-powered-by');
  // Production entry point never enables provider requests. Injected transports
  // are allowed only for deterministic adapter tests (no environment switch).
  const offline = fetchImpl === fetch;
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error:'Origem não permitida.' });
    }
    if (offline && (req.path.startsWith('/providers/') || /^\/bet-slips\/[^/]+\/quotes$/.test(req.path))) {
      if (req.path.endsWith('/status')) return res.json({ configured:false, offline:true, automaticBetting:false });
      return res.status(403).json({ error:'Consultas externas estão desativadas nesta demonstração offline.' });
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));
  app.use('/api/import/csv', express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: '2mb' }));
  app.use('/api/footy-csv/import', express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: '12mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: 'sqlite', mode:'portfolio', externalProviders:!offline, simulationOnly }));

  app.post('/api/footy-csv/import', (req, res, next) => {
    try { res.status(201).json(importFootyCsv(db, String(req.query.filename ?? ''), req.body)); }
    catch (error) { next(error); }
  });
  app.get('/api/footy-csv/seasons', (_req, res) => res.json(listFootySeasons(db)));
  app.get('/api/footy-csv/datasets', (_req, res) => res.json(listFootyCsvDatasets(db)));
  app.get('/api/footy-csv/teams', (req, res, next) => {
    try { res.json(listFootyTeams(db, String(req.query.league ?? ''), String(req.query.season ?? ''))); }
    catch (error) { next(error); }
  });
  app.get('/api/footy-csv/compare', (req, res, next) => {
    try {
      const args = { league:String(req.query.league ?? ''), season:String(req.query.season ?? ''), before:String(req.query.before ?? '') };
      res.json({ home:footyTeamWindows(db, { ...args, team:String(req.query.home ?? '') }),
        away:footyTeamWindows(db, { ...args, team:String(req.query.away ?? '') }), source:'FootyStats CSV' });
    } catch (error) { next(error); }
  });

  app.get('/api/bet-slips', (_req, res) => res.json(listBetSlips(db)));
  app.post('/api/bet-slips', (req, res, next) => {
    try { res.status(201).json(createBetSlip(db, req.body)); }
    catch (error) { next(error); }
  });
  app.get('/api/bet-slips/:id', (req, res, next) => {
    try { res.json(getBetSlip(db, Number(req.params.id))); }
    catch (error) { next(error); }
  });
  app.delete('/api/bet-slips/:id', (req, res, next) => {
    try {
      const changes = db.prepare('DELETE FROM bet_slips WHERE id=?').run(Number(req.params.id)).changes;
      if (!changes) throw new Error('Criar Aposta não encontrada.');
      res.json({ deleted:true });
    } catch (error) { next(error); }
  });
  app.post('/api/bet-slips/:id/legs', (req, res, next) => {
    try { res.status(201).json(addBetLeg(db, Number(req.params.id), req.body)); }
    catch (error) { next(error); }
  });
  app.delete('/api/bet-slips/:id/legs/:legId', (req, res, next) => {
    try { deleteBetLeg(db, Number(req.params.id), Number(req.params.legId)); res.json({ deleted:true }); }
    catch (error) { next(error); }
  });

  async function oddsForSlip(slip, bookmakers) {
    const catalog = await getOddsPapiMarkets({ key:process.env.ODDSPAPI_API_KEY, cacheFile:oddsPapiCacheFile, fetchImpl });
    const payload = await fetchOddsPapiOdds({ key:process.env.ODDSPAPI_API_KEY, fixtureId:slip.fixture_id,
      bookmakers, verbosity:3, fetchImpl });
    const summary = summarizeOddsPapiFixture(payload, catalog.markets, { bookmakers });
    const stored = db.prepare('SELECT * FROM oddspapi_fixtures WHERE fixture_id=?').get(slip.fixture_id);
    if (stored) {
      if (!summary.startsAt) summary.startsAt = stored.starts_at;
      if (summary.event === 'Casa x Visitante') summary.event = `${stored.home_team} x ${stored.away_team}`;
    }
    return summary;
  }

  app.get('/api/bet-slips/:id/quotes', async (req, res, next) => {
    try {
      const slip = getBetSlip(db, Number(req.params.id));
      if (!slip.fixture_id) throw new Error('Informe a fixture ID da OddsPapi ao cadastrar esta Criar Aposta.');
      const summary = await oddsForSlip(slip, String(req.query.bookmakers ?? ODDS_PAPI_DEFAULT_BOOKMAKERS.join(',')));
      if (!oddsFixtureMatches(slip, summary)) throw new Error('Os times ou horário da OddsPapi não correspondem à Criar Aposta.');
      res.json(summary);
    } catch (error) { next(error); }
  });

  app.get('/api/bet-slips/:id/analyze', async (req, res, next) => {
    try {
      const analysis = evaluateBetSlip(db, Number(req.params.id));
      if (offline || !analysis.fixture_id || !analysis.legs.some((leg) => leg.quoteRef)) return res.json(analysis);
      try {
        const summary = await oddsForSlip(analysis, String(req.query.bookmakers ?? ODDS_PAPI_DEFAULT_BOOKMAKERS.join(',')));
        res.json(attachOdds(analysis, summary));
      } catch (error) { res.json({ ...analysis, oddsWarning:`OddsPapi: ${error.message}` }); }
    } catch (error) { next(error); }
  });

  app.get('/api/providers/oddspapi/status', (_req, res) => res.json({
    configured: Boolean(process.env.ODDSPAPI_API_KEY),
    provider: 'OddsPapi', automaticBetting: false,
    defaultBookmakers: ODDS_PAPI_DEFAULT_BOOKMAKERS
  }));

  app.get('/api/providers/footystats/status', (_req, res) => res.json({
    configured:Boolean(process.env.FOOTYSTATS_API_KEY),
    provider:'FootyStats', automaticBetting:false,
    cacheMinutes:10,
    supportedWindows:[5, 6, 10]
  }));

  app.get('/api/providers/oddspapi/tournaments', async (req, res, next) => {
    try {
      res.json(await getOddsPapiTournaments({
        key:process.env.ODDSPAPI_API_KEY,
        country:req.query.country ?? '',
        force:req.query.refresh === 'true',
        fetchImpl
      }));
    } catch (error) { next(error); }
  });

  app.get('/api/providers/oddspapi/markets', async (req, res, next) => {
    try {
      res.json(await getOddsPapiMarkets({
        key:process.env.ODDSPAPI_API_KEY,
        force:req.query.refresh === 'true',
        cacheFile:oddsPapiCacheFile,
        fetchImpl
      }));
    } catch (error) { next(error); }
  });

  app.get('/api/providers/oddspapi/fixtures/:fixtureId/markets', async (req, res, next) => {
    try {
      const bookmakers = String(req.query.bookmakers ?? ODDS_PAPI_DEFAULT_BOOKMAKERS.join(','));
      const catalog = await getOddsPapiMarkets({
        key:process.env.ODDSPAPI_API_KEY,
        cacheFile:oddsPapiCacheFile,
        fetchImpl
      });
      const payload = await fetchOddsPapiOdds({
        key:process.env.ODDSPAPI_API_KEY,
        fixtureId:req.params.fixtureId,
        bookmakers,
        verbosity:3,
        fetchImpl
      });
      res.json(summarizeOddsPapiFixture(payload, catalog.markets, { bookmakers }));
    } catch (error) { next(error); }
  });

  app.get('/api/providers/footystats/leagues', async (req, res, next) => {
    try {
      res.json(await getFootyStatsLeagues({ key:process.env.FOOTYSTATS_API_KEY, force:req.query.refresh === 'true', fetchImpl }));
    } catch (error) { next(error); }
  });

  app.get('/api/providers/footystats/leagues/:seasonId/teams', async (req, res, next) => {
    try {
      const directory = await getFootyStatsLeagues({ key:process.env.FOOTYSTATS_API_KEY, fetchImpl });
      const selected = directory.leagues.find((league) => league.seasonId === Number(req.params.seasonId));
      if (!selected) throw new Error('Temporada não encontrada no catálogo atual da FootyStats. Recarregue os campeonatos.');
      if (!selected.accessible) {
        throw new Error('Este campeonato aparece no catálogo, mas não está liberado nas ligas escolhidas da sua conta FootyStats. Libere-o nas configurações da FootyStats e aguarde até 1 hora pelo cache do provedor.');
      }
      res.json(await getFootyStatsLeagueTeams({
        key:process.env.FOOTYSTATS_API_KEY,
        seasonId:req.params.seasonId,
        force:req.query.refresh === 'true',
        fetchImpl
      }));
    } catch (error) { next(error); }
  });

  app.get('/api/providers/footystats/team/:teamId', async (req, res, next) => {
    try {
      res.json(await getFootyStatsTeam({
        key:process.env.FOOTYSTATS_API_KEY,
        teamId:req.params.teamId,
        fetchImpl
      }));
    } catch (error) { next(error); }
  });

  app.get('/api/providers/footystats/compare', async (req, res, next) => {
    try {
      res.json(await compareFootyStatsTeams({
        key:process.env.FOOTYSTATS_API_KEY,
        homeTeamId:req.query.homeTeamId,
        awayTeamId:req.query.awayTeamId,
        fetchImpl
      }));
    } catch (error) { next(error); }
  });

  app.post('/api/providers/oddspapi/import', async (req, res, next) => {
    try {
      const bookmakers = String(req.body.bookmakers ?? ODDS_PAPI_DEFAULT_BOOKMAKERS.join(','))
        .split(',').map((item) => item.trim()).filter(Boolean);
      const collected = await collectOddsPapi({
        key:process.env.ODDSPAPI_API_KEY, from:req.body.from, to:req.body.to,
        tournamentId:req.body.tournamentId, country:req.body.country,
        maxFixtures:req.body.maxFixtures ?? 10, fetchImpl
      });
      const saveFixture = db.prepare(`INSERT INTO oddspapi_fixtures(fixture_id, home_team, away_team, starts_at, tournament)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(fixture_id) DO UPDATE SET
        home_team=excluded.home_team, away_team=excluded.away_team, starts_at=excluded.starts_at,
        tournament=excluded.tournament, seen_at=CURRENT_TIMESTAMP`);
      for (const fixture of collected.fixtures) if (fixture.fixtureId && fixture.startsAt) {
        saveFixture.run(String(fixture.fixtureId), fixture.home, fixture.away, fixture.startsAt, fixture.tournament);
      }
      const catalog = await getOddsPapiMarkets({
        key:process.env.ODDSPAPI_API_KEY, cacheFile:oddsPapiCacheFile, fetchImpl
      });
      const settings = readSettings(db);
      const analyses = collected.results.map(({ fixture, payload }) => {
        const analysis = analyzeOddsPapiFixture(summarizeOddsPapiFixture(payload, catalog.markets, { bookmakers }), {
          bankroll:settings.bankroll,
          maxExposurePct:settings.max_exposure_pct,
          kellyFraction:settings.kelly_fraction,
          fixedStake:settings.ev_fixed_stake,
          stakeMode:settings.ev_stake_mode,
          minEvPct:settings.min_ev_pct
        });
        return {
          ...analysis,
          fixtureId:analysis.fixtureId ?? fixture?.fixtureId ?? null,
          event:`${fixture?.participant1Name ?? analysis.event.split(' x ')[0]} x ${fixture?.participant2Name ?? analysis.event.split(' x ')[1]}`,
          startsAt:fixture?.startTime ?? analysis.startsAt,
          tournament:fixture?.tournamentName ?? analysis.tournament
        };
      });
      const transformed = transformOddsPapi(collected.results, { bookmakers });
      const coverage = new Map(transformed.fixtureCoverage.map((item) => [String(item.fixtureId), item]));
      const fixtures = collected.fixtures.map((fixture) => {
        const item = coverage.get(String(fixture.fixtureId));
        return fixture.status === 'consulted'
          ? { ...fixture, status:item?.rows ? 'imported' : 'no_complete_1x2', completeBookmakers:item?.completeBookmakers ?? 0 }
          : fixture;
      });
      if (!transformed.rows.length) return res.json({
        inserted:0, duplicates:0, received:0,
        fixturesFound:collected.fixturesFound, fixturesSelected:collected.fixturesSelected,
        requestsUsed:collected.requestsUsed, bookmakersFound:transformed.bookmakersFound,
        bookmakersMissing:transformed.bookmakersMissing, skipped:transformed.skipped,
        fixtures, fixtureErrors:collected.fixtureErrors, analyses,
        warning:'Nenhuma odd 1X2 completa das casas selecionadas foi encontrada. Confira o período, campeonato e cobertura do seu plano.'
      });
      const rows = validateImportRows(transformed.rows);
      const imported = importRows(db, rows);
      const marketByEvent = new Map(imported.marketResults.map((item) => [`${item.event}\u0000${item.startsAt}`, item]));
      const classifiedFixtures = fixtures.map((fixture) => {
        if (fixture.status !== 'imported') return fixture;
        const normalizedStart = fixture.startsAt ? new Date(fixture.startsAt).toISOString() : '';
        const market = marketByEvent.get(`${fixture.home} x ${fixture.away}\u0000${normalizedStart}`);
        return {
          ...fixture,
          status:market ? (market.inserted ? 'updated' : 'already_saved') : 'imported',
          marketId:market?.marketId ?? null
        };
      });
      res.status(201).json({
        ...imported, received:rows.length,
        fixturesFound:collected.fixturesFound, fixturesSelected:collected.fixturesSelected,
        requestsUsed:collected.requestsUsed, bookmakersFound:transformed.bookmakersFound,
        bookmakersMissing:transformed.bookmakersMissing, skipped:transformed.skipped,
        fixtures:classifiedFixtures, fixtureErrors:collected.fixtureErrors, analyses
      });
    } catch (error) { next(error); }
  });

  app.get('/api/settings', (_req, res) => res.json(settingsResponse(readSettings(db))));
  app.put('/api/settings', (req, res, next) => {
    try {
      const current = readSettings(db);
      const values = {
        bankroll: Number(req.body.bankroll),
        surebet_stake: Number(req.body.surebet_stake ?? req.body.fixed_stake),
        ev_stake_mode: String(req.body.ev_stake_mode ?? current.ev_stake_mode),
        ev_fixed_stake: Number(req.body.ev_fixed_stake ?? req.body.fixed_stake ?? current.ev_fixed_stake),
        kelly_fraction: Number(req.body.kelly_fraction),
        max_exposure_pct: Number(req.body.max_exposure_pct),
        min_ev_pct: Number(req.body.min_ev_pct)
      };
      if (!Number.isFinite(values.bankroll) || values.bankroll <= 0) throw new Error('Banca inválida.');
      if (!Number.isFinite(values.surebet_stake) || values.surebet_stake <= 0) throw new Error('Stake total da surebet inválida.');
      if (!['kelly', 'fixed'].includes(values.ev_stake_mode)) throw new Error('Modo de stake +EV inválido.');
      if (!Number.isFinite(values.ev_fixed_stake) || values.ev_fixed_stake <= 0) throw new Error('Stake fixa +EV inválida.');
      if (!Number.isFinite(values.kelly_fraction) || values.kelly_fraction < 0 || values.kelly_fraction > 1) throw new Error('Kelly deve estar entre 0 e 1.');
      if (!Number.isFinite(values.max_exposure_pct) || values.max_exposure_pct <= 0 || values.max_exposure_pct > 100) throw new Error('Exposição deve estar entre 0 e 100%.');
      if (!Number.isFinite(values.min_ev_pct)) throw new Error('EV mínimo inválido.');
      db.prepare(`UPDATE settings SET bankroll=?, fixed_stake=?, surebet_stake=?, ev_stake_mode=?, ev_fixed_stake=?,
        kelly_fraction=?, max_exposure_pct=?, min_ev_pct=? WHERE id=1`)
        .run(values.bankroll, values.surebet_stake, values.surebet_stake, values.ev_stake_mode, values.ev_fixed_stake,
          values.kelly_fraction, values.max_exposure_pct, values.min_ev_pct);
      res.json(settingsResponse(readSettings(db)));
    } catch (error) { next(error); }
  });

  function demoRows(input) {
    const rows = validateImportRows(input);
    if (simulationOnly && rows.some((row) => !row.is_demo)) throw new Error('Esta versão aceita somente cotações fictícias com is_demo=true.');
    return rows;
  }

  app.post('/api/import/json', (req, res, next) => {
    try {
      const rows = demoRows(req.body);
      res.status(201).json({ ...importRows(db, rows), received: rows.length });
    } catch (error) { next(error); }
  });
  app.post('/api/import/csv', (req, res, next) => {
    try {
      const rows = demoRows(parseCsv(req.body));
      res.status(201).json({ ...importRows(db, rows), received: rows.length });
    } catch (error) { next(error); }
  });

  app.get('/api/markets', (req, res) => {
    const type = String(req.query.type ?? 'all');
    const minEv = Number(req.query.minEv ?? -100);
    const sort = String(req.query.sort ?? 'event');
    let result = listMarkets(db).map((market) => marketAnalysis(market, readSettings(db), enforceFreshness));
    if (type === 'surebet') result = result.filter((market) => market.surebet?.isSurebet);
    if (type === 'ev') result = result.filter((market) => market.ev.some((item) => item.evPct >= minEv));
    if (sort === 'roi') result.sort((a, b) => (b.surebet?.roundedRoiPct ?? -Infinity) - (a.surebet?.roundedRoiPct ?? -Infinity));
    if (sort === 'ev') result.sort((a, b) => (b.ev[0]?.evPct ?? -Infinity) - (a.ev[0]?.evPct ?? -Infinity));
    res.json(result);
  });

  app.post('/api/analyze/surebet', (req, res, next) => {
    try {
      const market = getMarket(db, Number(req.body.marketId));
      if (!market) return res.status(404).json({ error: 'Mercado não encontrado.' });
      const settings = readSettings(db);
      const risk = riskSummary(settings);
      const totalStake = Number(req.body.totalStake ?? risk.effectiveSurebetStake);
      if (!Number.isFinite(totalStake) || totalStake <= 0) throw new Error('Stake total inválida.');
      if (totalStake > risk.maxStake + 1e-9) throw new Error(`A stake excede sua exposição máxima por oportunidade (${risk.maxStake.toFixed(2)}).`);
      assertMarketIntegrity(market, { enforceFreshness });
      const result = calculateSurebet(market.quotes, totalStake);
      if (!result.isSurebet || result.roundedMinProfit <= 0) throw new Error('As cotações atuais não formam uma surebet com lucro positivo após o arredondamento.');
      const historyId = saveHistory(db, 'surebet', market.id, result);
      res.json({ ...result, historyId });
    } catch (error) { next(error); }
  });

  app.post('/api/analyze/surebet/preview', (req, res, next) => {
    try {
      const market = getMarket(db, Number(req.body.marketId));
      if (!market) return res.status(404).json({ error:'Mercado não encontrado.' });
      const risk = riskSummary(readSettings(db));
      const totalStake = Number(req.body.totalStake ?? risk.effectiveSurebetStake);
      if (!Number.isFinite(totalStake) || totalStake <= 0) throw new Error('Stake total inválida.');
      if (totalStake > risk.maxStake + 1e-9) throw new Error(`A stake excede sua exposição máxima por oportunidade (${risk.maxStake.toFixed(2)}).`);
      assertMarketIntegrity(market, { enforceFreshness });
      res.json(calculateSurebet(market.quotes, totalStake));
    } catch (error) { next(error); }
  });

  app.post('/api/analyze/ev', (req, res, next) => {
    try {
      const market = getMarket(db, Number(req.body.marketId));
      if (!market) return res.status(404).json({ error: 'Mercado não encontrado.' });
      assertMarketIntegrity(market, { enforceFreshness });
      const quote = market.quotes.find((item) => item.id === Number(req.body.quoteId));
      if (!quote) return res.status(404).json({ error: 'Cotação não encontrada.' });
      const settings = readSettings(db);
      const outcomes = [...new Set(market.quotes.map((item) => item.outcome))];
      const consensus = consensusNoVig(market.quotes, outcomes);
      const manual = req.body.fairProbability == null ? quote.estimated_probability : Number(req.body.fairProbability);
      const fairProbability = manual ?? consensus.probabilities[quote.outcome];
      if (!fairProbability) throw new Error('Sem probabilidade manual ou referência no-vig completa para este resultado.');
      const result = calculateEV({
        odds: quote.odds,
        fairProbability,
        bankroll: settings.bankroll,
        fixedStake: settings.ev_fixed_stake,
        kellyFraction: settings.kelly_fraction,
        maxExposurePct: settings.max_exposure_pct,
        stakeMode: settings.ev_stake_mode
      });
      if (result.evPct < settings.min_ev_pct || result.suggestedStake <= 0) {
        throw new Error(`A cotação não atingiu o EV mínimo de ${Number(settings.min_ev_pct).toFixed(2)}% com stake positiva.`);
      }
      const payload = {
        ...result, quoteId:quote.id, outcome:quote.outcome, bookmaker:quote.bookmaker,
        minimumEvPct:settings.min_ev_pct,
        winProfit:round2(result.suggestedStake * (result.odds - 1)),
        lossAmount:round2(-result.suggestedStake)
      };
      const historyId = saveHistory(db, 'ev', market.id, payload);
      res.json({ ...payload, historyId });
    } catch (error) { next(error); }
  });

  app.get('/api/history', (_req, res) => {
    const rows = db.prepare(`SELECT h.id, h.kind, h.market_id, h.payload, h.status, h.settled_profit, h.settled_at,
      h.created_at, m.event, m.market_name
      FROM history h LEFT JOIN markets m ON m.id=h.market_id ORDER BY h.id DESC LIMIT 200`).all();
    res.json(rows.map(historyRow));
  });

  app.put('/api/history/:id/settle', (req, res, next) => {
    try {
      const status = String(req.body.status ?? '');
      if (!['open', 'win', 'loss', 'push', 'cancelled'].includes(status)) throw new Error('Resultado de liquidação inválido.');
      const row = db.prepare('SELECT * FROM history WHERE id=?').get(Number(req.params.id));
      if (!row) return res.status(404).json({ error:'Registro do histórico não encontrado.' });
      const payload = parseHistoryPayload(row.payload);
      const oldProfit = Number(row.settled_profit ?? 0);
      const newProfit = status === 'open' ? 0 : settlementProfit(row.kind, payload, status);
      const currentBankroll = Number(readSettings(db).bankroll);
      const nextBankroll = round2(currentBankroll - oldProfit + newProfit);
      if (nextBankroll < 0) throw new Error('A liquidação deixaria a banca negativa. Revise a banca ou o registro.');
      const settledAt = status === 'open' ? null : new Date().toISOString();
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE history SET status=?, settled_profit=?, settled_at=? WHERE id=?')
          .run(status, status === 'open' ? null : newProfit, settledAt, row.id);
        db.prepare('UPDATE settings SET bankroll=? WHERE id=1').run(nextBankroll);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      res.json({
        history:{ ...historyRow({ ...row, status, settled_profit:status === 'open' ? null : newProfit, settled_at:settledAt }), payload },
        bankroll:nextBankroll,
        bankrollChange:round2(newProfit - oldProfit)
      });
    } catch (error) { next(error); }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use((error, _req, res, _next) => {
    const message = String(error.message || 'Erro inesperado.');
    const safe = [process.env.ODDSPAPI_API_KEY, process.env.FOOTYSTATS_API_KEY].filter(Boolean)
      .reduce((text, secret) => text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]'), message);
    res.status(error.status || 400).json({ error:safe, details:error.details ?? [] });
  });
  return app;
}
