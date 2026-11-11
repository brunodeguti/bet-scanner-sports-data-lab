import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'https://api.oddspapi.io/v4';
const SOCCER_ID = 10;
const FULL_TIME_RESULT_MARKET = '101';
const DIRECTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MARKET_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let tournamentsCache = null;
let marketsCache = null;

function requireKey(key) {
  if (!key) throw new Error('ODDSPAPI_API_KEY não configurada no arquivo .env.');
  return key;
}

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) throw new Error(`${label} inválida.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} inválida.`);
  return date;
}

function addUtcDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function brazilDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit'
  }).format(date);
}

function readableError(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(readableError).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    return readableError(value.message ?? value.error ?? value.detail) || JSON.stringify(value);
  }
  return String(value);
}

function providerError(payload, status) {
  return readableError(payload?.message ?? payload?.error ?? payload?.detail) || `OddsPapi respondeu HTTP ${status}.`;
}

async function request(path, params, { key, fetchImpl }) {
  requireKey(key);
  const query = new URLSearchParams({ ...params, apiKey:key });
  const response = await fetchImpl(`${BASE_URL}${path}?${query}`, { signal:AbortSignal.timeout(15000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`OddsPapi: ${providerError(payload, response.status)}`);
  return payload;
}

export async function fetchOddsPapiTournaments({ key, fetchImpl = fetch }) {
  const payload = await request('/tournaments', { sportId:String(SOCCER_ID), language:'en' }, { key, fetchImpl });
  return Array.isArray(payload) ? payload : (payload?.tournaments ?? payload?.data ?? []);
}

export function normalizeOddsPapiTournaments(payload, { country = '' } = {}) {
  const wanted = String(country).trim().toLowerCase();
  return (payload ?? []).map((item) => ({
    id:Number(item?.tournamentId),
    name:item?.tournamentName ?? item?.tournamentSlug ?? `Campeonato ${item?.tournamentId}`,
    slug:item?.tournamentSlug ?? '',
    country:item?.categoryName ?? item?.categorySlug ?? '',
    countrySlug:item?.categorySlug ?? '',
    fixtures:Number(item?.futureFixtures ?? 0) + Number(item?.upcomingFixtures ?? 0) + Number(item?.liveFixtures ?? 0)
  })).filter((item) => Number.isInteger(item.id) && item.id > 0)
    .filter((item) => !wanted || `${item.country} ${item.countrySlug}`.toLowerCase().includes(wanted))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function tournamentCountries(tournaments) {
  const countries = new Map();
  for (const item of tournaments) {
    const key = item.countrySlug || item.country.toLowerCase();
    if (!key) continue;
    const current = countries.get(key) ?? { slug:key, name:item.country || item.countrySlug, tournaments:0 };
    current.tournaments += 1;
    countries.set(key, current);
  }
  return [...countries.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export async function getOddsPapiTournaments({ key, fetchImpl = fetch, now = Date.now(), country = '', force = false }) {
  const cached = Boolean(tournamentsCache && now - tournamentsCache.savedAt < DIRECTORY_CACHE_TTL_MS);
  if (force || !cached) {
    tournamentsCache = { savedAt:now, data:await fetchOddsPapiTournaments({ key, fetchImpl }) };
  }
  const allTournaments = normalizeOddsPapiTournaments(tournamentsCache.data);
  return {
    tournaments:normalizeOddsPapiTournaments(tournamentsCache.data, { country }),
    countries:tournamentCountries(allTournaments),
    totalTournaments:allTournaments.length,
    cached:cached && !force
  };
}

export function clearOddsPapiDirectoryCache() { tournamentsCache = null; }

export async function fetchOddsPapiMarkets({ key, fetchImpl = fetch }) {
  const payload = await request('/markets', { language:'en' }, { key, fetchImpl });
  return Array.isArray(payload) ? payload : (payload?.markets ?? payload?.data ?? []);
}

function marketCategory(name) {
  const value = String(name ?? '').toLowerCase();
  if (value.includes('shot on target') || value.includes('shots on target')) return 'Chutes no gol';
  if (value.includes('shot') || value.includes('attempt')) return 'Finalizações';
  if (value.includes('corner')) return 'Escanteios';
  if (value.includes('card') || value.includes('booking')) return 'Cartões';
  if (value.includes('save')) return 'Defesas';
  if (value.includes('foul')) return 'Faltas';
  if (value.includes('offside')) return 'Impedimentos';
  if (value.includes('throw in') || value.includes('throw-in')) return 'Laterais';
  if (value.includes('goal kick')) return 'Tiros de meta';
  if (value.includes('penalty')) return 'Pênaltis';
  if (value.includes('possession')) return 'Posse de bola';
  if (value.includes('goal') || value.includes('score') || value.includes('clean sheet') || value.includes('win to nil') || value.includes('both teams')) return 'Gols';
  if (value.includes('result') || value.includes('winner') || value.includes('moneyline') || value.includes('double chance') || value.includes('draw no bet') || value.includes('to qualify') || value.includes('winning margin') || value.includes('half time full time')) return 'Resultado';
  if (value.includes('handicap') || value.includes('spread')) return 'Handicap';
  if (value.includes('player')) return 'Jogadores';
  return 'Outros';
}

function comparableLine(value, fallback = null) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw.includes('/')) {
    const [line] = raw.split('/');
    if (/^[+-]?\d+(?:\.\d+)?$/.test(line)) return line;
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw) && raw.length < 8) return raw;
  return Number.isFinite(Number(fallback)) && Number(fallback) !== 0 ? String(Number(fallback)) : '';
}

function normalizedSubject(value) {
  return String(value ?? '').trim().toLocaleLowerCase('pt-BR');
}

export function normalizeOddsPapiMarkets(payload) {
  return (payload ?? []).filter((item) => Number(item?.sportId) === SOCCER_ID).map((item) => ({
    id:Number(item.marketId),
    name:item.marketName ?? `Mercado ${item.marketId}`,
    playerProp:Boolean(item.playerProp),
    handicap:item.handicap != null && Number.isFinite(Number(item.handicap)) ? Number(item.handicap) : null,
    period:item.period ?? 'não informado',
    type:item.marketType ?? 'não informado',
    category:marketCategory(item.marketName),
    outcomes:(item.outcomes ?? []).map((outcome) => ({
      id:Number(outcome.outcomeId), name:outcome.outcomeName ?? String(outcome.outcomeId)
    }))
  })).filter((item) => Number.isInteger(item.id) && item.id > 0)
    .sort((a, b) => a.category.localeCompare(b.category, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR'));
}

function readMarketCache(cacheFile, now) {
  if (!cacheFile || !fs.existsSync(cacheFile)) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!Array.isArray(stored.data) || now - Number(stored.savedAt) >= MARKET_CACHE_TTL_MS) return null;
    return stored;
  } catch { return null; }
}

function writeMarketCache(cacheFile, value) {
  if (!cacheFile) return;
  fs.mkdirSync(path.dirname(cacheFile), { recursive:true });
  fs.writeFileSync(cacheFile, JSON.stringify(value, null, 2));
}

export async function getOddsPapiMarkets({ key, fetchImpl = fetch, now = Date.now(), force = false, cacheFile = null }) {
  if (!force && (!marketsCache || now - marketsCache.savedAt >= MARKET_CACHE_TTL_MS)) {
    marketsCache = readMarketCache(cacheFile, now);
  }
  const cached = Boolean(marketsCache && now - marketsCache.savedAt < MARKET_CACHE_TTL_MS);
  if (force || !cached) {
    marketsCache = { savedAt:now, data:await fetchOddsPapiMarkets({ key, fetchImpl }) };
    writeMarketCache(cacheFile, marketsCache);
  }
  const markets = normalizeOddsPapiMarkets(marketsCache.data);
  const categories = Object.entries(markets.reduce((result, market) => {
    result[market.category] = (result[market.category] ?? 0) + 1;
    return result;
  }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'));
  const periods = [...new Set(markets.map((market) => market.period))].sort();
  return {
    markets, categories, periods,
    total:markets.length,
    playerProps:markets.filter((market) => market.playerProp).length,
    cached:cached && !force,
    savedAt:new Date(marketsCache.savedAt).toISOString()
  };
}

export function clearOddsPapiMarketCache() { marketsCache = null; }

export async function fetchOddsPapiFixtures({ key, from, to, tournamentId, fetchImpl = fetch }) {
  const start = validDate(from, 'Data inicial');
  const end = validDate(to, 'Data final');
  const days = (end - start) / 86400000;
  if (days < 0 || days > 9) throw new Error('O período deve ter entre 1 e 10 dias.');
  // A API usa `to` como limite do intervalo. Enviamos o dia seguinte para que
  // a data final escolhida na interface seja inclusiva, inclusive quando from=to.
  const params = { sportId:String(SOCCER_ID), from, to:addUtcDays(end, 1) };
  if (tournamentId != null && String(tournamentId).trim()) {
    if (!/^\d+$/.test(String(tournamentId))) throw new Error('ID do campeonato inválido.');
    params.tournamentId = String(tournamentId);
  }
  const payload = await request('/fixtures', params, { key, fetchImpl });
  const fixtures = Array.isArray(payload) ? payload : (payload?.fixtures ?? payload?.data ?? []);
  return fixtures.filter((fixture) => {
    const date = brazilDate(fixture?.startTime);
    return !date || (date >= from && date <= to);
  });
}

export async function fetchOddsPapiOdds({ key, fixtureId, bookmakers = '', verbosity = null, fetchImpl = fetch }) {
  if (!/^[-a-zA-Z0-9_]+$/.test(String(fixtureId ?? ''))) throw new Error('Fixture ID inválido.');
  const params = { fixtureId:String(fixtureId) };
  if (String(bookmakers).trim()) params.bookmakers = String(bookmakers).trim();
  if (verbosity != null) params.verbosity = String(verbosity);
  params.language = 'en';
  return request('/odds', params, { key, fetchImpl });
}

export function summarizeOddsPapiFixture(payload, catalog = [], { bookmakers = [] } = {}) {
  const requested = new Set((Array.isArray(bookmakers) ? bookmakers : String(bookmakers).split(','))
    .map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  const metadata = new Map((catalog ?? []).map((market) => [String(market.id), market]));
  const outcomeMetadata = new Map();
  for (const market of catalog ?? []) {
    for (const outcome of market.outcomes ?? []) outcomeMetadata.set(`${market.id}:${outcome.id}`, outcome.name);
  }
  const sourceBooks = payload?.bookmakerOdds ?? payload?.odds?.bookmakerOdds ?? {};
  const books = [];
  for (const [slug, book] of Object.entries(sourceBooks)) {
    if (requested.size && !requested.has(slug.toLowerCase())) continue;
    const markets = [];
    for (const [marketId, rawMarket] of Object.entries(book?.markets ?? {})) {
      const meta = metadata.get(String(marketId));
      const offers = [];
      for (const [outcomeId, rawOutcome] of Object.entries(rawMarket?.outcomes ?? {})) {
        const players = rawOutcome?.players && typeof rawOutcome.players === 'object'
          ? Object.values(rawOutcome.players) : [rawOutcome];
        for (const offer of players) {
          const price = Number(offer?.price);
          if (!Number.isFinite(price) || price <= 1) continue;
          offers.push({
            outcomeId:Number(outcomeId),
            outcome:outcomeMetadata.get(`${marketId}:${outcomeId}`) ?? String(outcomeId),
            playerName:offer?.playerName ?? null,
            price,
            active:offer?.active !== false,
            mainLine:Boolean(offer?.mainLine),
            line:offer?.bookmakerOutcomeId ?? null,
            changedAt:offer?.changedAt ?? rawMarket?.updatedAt ?? book?.updatedAt ?? payload?.updatedAt ?? null
          });
        }
      }
      if (!offers.length) continue;
      markets.push({
        id:Number(marketId),
        name:meta?.name ?? `Mercado ${marketId}`,
        category:meta?.category ?? 'Não catalogado',
        period:meta?.period ?? 'não informado',
        type:meta?.type ?? 'não informado',
        handicap:meta?.handicap ?? null,
        expectedOutcomes:(meta?.outcomes ?? []).map((outcome) => ({ id:outcome.id, name:outcome.name })),
        playerProp:meta?.playerProp ?? offers.some((offer) => Boolean(offer.playerName)),
        active:rawMarket?.marketActive !== false,
        offers
      });
    }
    markets.sort((a, b) => a.category.localeCompare(b.category, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR'));
    books.push({
      slug,
      name:book?.bookmakerName ?? book?.name ?? slug,
      active:book?.bookmakerIsActive !== false && book?.suspended !== true,
      marketCount:markets.length,
      offerCount:markets.reduce((sum, market) => sum + market.offers.length, 0),
      markets
    });
  }
  books.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return {
    fixtureId:payload?.fixtureId ?? null,
    event:`${payload?.participant1Name ?? 'Casa'} x ${payload?.participant2Name ?? 'Visitante'}`,
    startsAt:payload?.startTime ?? null,
    tournament:payload?.tournamentName ?? '',
    status:payload?.statusName ?? '',
    updatedAt:payload?.updatedAt ?? null,
    bookmakerCount:books.length,
    marketCount:new Set(books.flatMap((book) => book.markets.map((market) => market.id))).size,
    books
  };
}

export function analyzeOddsPapiFixture(summary, {
  bankroll = 1000, maxExposurePct = 2, kellyFraction = 0.25,
  fixedStake = 20, stakeMode = 'kelly', minEvPct = 2
} = {}) {
  const groups = new Map();
  for (const book of summary?.books ?? []) {
    if (!book.active) continue;
    for (const market of book.markets ?? []) {
      if (!market.active) continue;
      for (const offer of market.offers ?? []) {
        if (!offer.active) continue;
        const subject = normalizedSubject(offer.playerName);
        const line = comparableLine(offer.line, market.handicap);
        const key = `${market.id}\u0000${subject}\u0000${line}`;
        const group = groups.get(key) ?? {
          key, marketId:market.id, marketName:market.name, category:market.category,
          period:market.period, playerProp:market.playerProp, subject:offer.playerName ?? null,
          line:line || null, expectedOutcomes:market.expectedOutcomes ?? [], offers:[]
        };
        group.offers.push({ ...offer, bookmaker:book.slug, bookmakerName:book.name });
        groups.set(key, group);
      }
    }
  }

  const opportunities = [];
  const comparableGroups = [];
  for (const group of groups.values()) {
    const referenceOffers = group.offers.filter((offer) => offer.bookmaker.toLowerCase() === 'pinnacle');
    const referenceByOutcome = new Map();
    for (const offer of referenceOffers) {
      const current = referenceByOutcome.get(offer.outcomeId);
      if (!current || offer.price > current.price) referenceByOutcome.set(offer.outcomeId, offer);
    }
    const expectedIds = group.expectedOutcomes.map((outcome) => Number(outcome.id)).filter(Number.isFinite);
    const complete = expectedIds.length >= 2
      ? expectedIds.every((id) => referenceByOutcome.has(id))
      : referenceByOutcome.size >= 2;
    if (!complete) continue;
    const references = expectedIds.length >= 2
      ? expectedIds.map((id) => referenceByOutcome.get(id))
      : [...referenceByOutcome.values()];
    const impliedTotal = references.reduce((sum, offer) => sum + 1 / offer.price, 0);
    if (!(impliedTotal > 0)) continue;
    const probabilities = new Map(references.map((offer) => [offer.outcomeId, (1 / offer.price) / impliedTotal]));
    const bestByOutcome = new Map();
    for (const offer of group.offers.filter((item) => item.bookmaker.toLowerCase() !== 'pinnacle')) {
      const probability = probabilities.get(offer.outcomeId);
      if (!probability) continue;
      const current = bestByOutcome.get(offer.outcomeId);
      if (!current || offer.price > current.price) bestByOutcome.set(offer.outcomeId, offer);
    }
    for (const offer of bestByOutcome.values()) {
      const fairProbability = probabilities.get(offer.outcomeId);
      const edgePct = (fairProbability - (1 / offer.price)) * 100;
      const evPct = (fairProbability * offer.price - 1) * 100;
      const fullKelly = Math.max(0, (fairProbability * offer.price - 1) / (offer.price - 1));
      const maxStake = Number(bankroll) * Number(maxExposurePct) / 100;
      const suggestedStake = stakeMode === 'fixed'
        ? Math.min(Number(fixedStake), maxStake)
        : Math.min(Number(bankroll) * fullKelly * Number(kellyFraction), maxStake);
      if (evPct <= 0 || evPct + 1e-9 < Number(minEvPct) || suggestedStake <= 0) continue;
      opportunities.push({
        ...group, outcomeId:offer.outcomeId, outcome:offer.outcome,
        bookmaker:offer.bookmaker, bookmakerName:offer.bookmakerName, odds:offer.price,
        fairProbabilityPct:fairProbability * 100, edgePct, evPct,
        suggestedStake:Math.round(suggestedStake * 100) / 100, reference:'Pinnacle (sem margem)'
      });
    }
    comparableGroups.push(group.key);
  }
  opportunities.sort((a, b) => b.evPct - a.evPct || b.odds - a.odds);
  return { ...summary, opportunities, comparableGroups:comparableGroups.length };
}

function isCountry(fixture, country) {
  const wanted = String(country ?? '').trim().toLowerCase();
  return !wanted || `${fixture?.categorySlug ?? ''} ${fixture?.categoryName ?? ''}`.toLowerCase().includes(wanted);
}

export async function collectOddsPapi({
  key, from, to, tournamentId, country = '', maxFixtures = 10, fetchImpl = fetch,
  cooldownMs = fetchImpl === fetch ? 2100 : 0
}) {
  const fixtures = await fetchOddsPapiFixtures({ key, from, to, tournamentId, fetchImpl });
  const limit = Math.max(1, Math.min(20, Number(maxFixtures) || 10));
  const scopedFixtures = fixtures.filter((fixture) => tournamentId || isCountry(fixture, country));
  const selected = scopedFixtures
    .filter((fixture) => fixture?.hasOdds !== false)
    .slice(0, limit);
  const selectedIds = new Set(selected.map((fixture) => String(fixture?.fixtureId)));
  const fixtureStatuses = new Map(scopedFixtures.map((fixture) => [
    String(fixture?.fixtureId),
    fixture?.hasOdds === false ? 'no_odds' : (selectedIds.has(String(fixture?.fixtureId)) ? 'pending' : 'not_queried_limit')
  ]));
  const results = [];
  const fixtureErrors = [];
  for (const fixture of selected) {
    if (cooldownMs > 0) await new Promise((resolve) => setTimeout(resolve, cooldownMs));
    try {
      results.push({ fixture, payload:await fetchOddsPapiOdds({ key, fixtureId:fixture.fixtureId, fetchImpl }) });
      fixtureStatuses.set(String(fixture.fixtureId), 'consulted');
    } catch (error) {
      fixtureStatuses.set(String(fixture?.fixtureId), 'error');
      fixtureErrors.push({ fixtureId:fixture?.fixtureId ?? null, event:`${fixture?.participant1Name ?? 'Casa'} x ${fixture?.participant2Name ?? 'Visitante'}`, error:error.message });
    }
  }
  const fixtureList = scopedFixtures.map((fixture) => ({
    fixtureId:fixture?.fixtureId ?? null,
    home:fixture?.participant1Name ?? 'Casa', away:fixture?.participant2Name ?? 'Visitante',
    startsAt:fixture?.startTime ?? null,
    tournament:fixture?.tournamentName ?? '', country:fixture?.categoryName ?? fixture?.categorySlug ?? '',
    hasOdds:fixture?.hasOdds !== false,
    status:fixtureStatuses.get(String(fixture?.fixtureId)) ?? 'not_queried_limit'
  }));
  return { fixturesFound:scopedFixtures.length, fixturesSelected:selected.length, requestsUsed:1 + selected.length, fixtures:fixtureList, fixtureErrors, results };
}

function firstPrice(outcome) {
  if (outcome?.active === false) return NaN;
  if (Number.isFinite(Number(outcome?.price))) return Number(outcome.price);
  const players = outcome?.players;
  if (!players || typeof players !== 'object') return NaN;
  for (const player of Object.values(players)) {
    if (player?.active !== false && Number.isFinite(Number(player?.price))) return Number(player.price);
  }
  return NaN;
}

function fixtureDetails(fixture, payload) {
  const source = payload?.fixture ?? payload ?? {};
  return {
    home:fixture?.participant1Name ?? source.participant1Name ?? source.homeTeamName ?? 'Casa',
    away:fixture?.participant2Name ?? source.participant2Name ?? source.awayTeamName ?? 'Visitante',
    startsAt:fixture?.startTime ?? source.startTime,
    league:fixture?.tournamentName ?? source.tournamentName ?? fixture?.categoryName ?? source.categoryName ?? 'Brasil'
  };
}

export function transformOddsPapi(results, { bookmakers = [] } = {}) {
  const requested = new Set((Array.isArray(bookmakers) ? bookmakers : String(bookmakers).split(','))
    .map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  const rows = [];
  const bookmakerSet = new Set();
  const fixtureCoverage = [];
  const skipped = { invalidOdds:0, incompleteMarkets:0, missingFullTimeResult:0 };
  for (const { fixture, payload } of results ?? []) {
    const details = fixtureDetails(fixture, payload);
    const coverage = { fixtureId:fixture?.fixtureId ?? null, completeBookmakers:0, rows:0 };
    if (!details.startsAt) { fixtureCoverage.push(coverage); continue; }
    const bookmakerOdds = payload?.bookmakerOdds ?? payload?.odds?.bookmakerOdds ?? {};
    for (const [slug, book] of Object.entries(bookmakerOdds)) {
      const normalizedSlug = slug.toLowerCase();
      if (requested.size && !requested.has(normalizedSlug)) continue;
      if (book?.bookmakerIsActive === false || book?.suspended === true) continue;
      bookmakerSet.add(normalizedSlug);
      const market = book?.markets?.[FULL_TIME_RESULT_MARKET] ?? book?.markets?.[Number(FULL_TIME_RESULT_MARKET)];
      if (!market) { skipped.missingFullTimeResult += 1; continue; }
      if (market.marketActive === false) continue;
      const outcomes = market.outcomes ?? {};
      const selections = [
        ['101', details.home], ['102', 'Empate'], ['103', details.away]
      ].map(([id, name]) => ({ id, name, odds:firstPrice(outcomes[id] ?? outcomes[Number(id)]) }));
      const valid = selections.filter((item) => Number.isFinite(item.odds) && item.odds > 1);
      skipped.invalidOdds += selections.length - valid.length;
      if (valid.length !== 3) { skipped.incompleteMarkets += 1; continue; }
      const capturedAt = market.updatedAt ?? book.updatedAt ?? payload.updatedAt;
      if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) { skipped.invalidOdds += valid.length; continue; }
      coverage.completeBookmakers += 1;
      coverage.rows += valid.length;
      const bookmakerName = book.bookmakerName ?? book.name ?? slug;
      for (const selection of valid) rows.push({
        sport:'Futebol', league:details.league,
        event:`${details.home} x ${details.away}`, starts_at:details.startsAt,
        market_key:'oddspapi_h2h', market_name:'Vencedor da partida',
        outcome:selection.name, bookmaker:bookmakerName, odds:selection.odds,
        is_reference:normalizedSlug === 'pinnacle' ? 1 : 0,
        captured_at:capturedAt, source:'oddspapi', is_demo:0
      });
    }
    fixtureCoverage.push(coverage);
  }
  return {
    rows, bookmakersFound:[...bookmakerSet].sort(),
    bookmakersMissing:[...requested].filter((item) => !bookmakerSet.has(item)).sort(), skipped, fixtureCoverage
  };
}

export const ODDS_PAPI_DEFAULT_BOOKMAKERS = [
  'betano.bet.br', 'superbet.bet.br', 'stake.bet.br', 'sportingbet.bet.br',
  'estrelabet', 'pixbet', 'kto', 'blaze.bet.br', 'pinnacle'
];
