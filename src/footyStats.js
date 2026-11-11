const BASE_URL = 'https://api.football-data-api.com';
const CACHE_TTL_MS = 10 * 60 * 1000;
const DIRECTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
const directoryCache = new Map();

function requireKey(key) {
  if (!key) throw new Error('FOOTYSTATS_API_KEY não configurada no arquivo .env.');
  return key;
}

function validTeamId(teamId) {
  if (!/^\d+$/.test(String(teamId ?? '')) || Number(teamId) < 1) throw new Error('ID FootyStats do time inválido.');
  return Number(teamId);
}

function providerError(payload, status) {
  const value = payload?.message ?? payload?.error ?? payload?.detail;
  if (typeof value === 'string') {
    if (/league is not chosen by the user/i.test(value)) {
      return 'Este campeonato não está liberado nas ligas escolhidas da sua conta FootyStats. Se você acabou de liberá-lo, a própria FootyStats informa que o cache pode levar até 1 hora.';
    }
    return value;
  }
  if (value && typeof value === 'object') return value.message ?? JSON.stringify(value);
  return `FootyStats respondeu HTTP ${status}.`;
}

async function request(path, params, { key, fetchImpl }) {
  const query = new URLSearchParams({ ...params, key:requireKey(key) });
  const response = await fetchImpl(`${BASE_URL}${path}?${query}`, { signal:AbortSignal.timeout(15000) });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`FootyStats respondeu em formato inválido (HTTP ${response.status}).`); }
  if (!response.ok || payload?.success === false) throw new Error(`FootyStats: ${providerError(payload, response.status)}`);
  return payload;
}

export async function fetchFootyStatsLastX({ key, teamId, fetchImpl = fetch }) {
  return request('/lastx', { team_id:String(validTeamId(teamId)) }, { key, fetchImpl });
}

export async function fetchFootyStatsLeagues({ key, fetchImpl = fetch, chosenOnly = false }) {
  return request('/league-list', chosenOnly ? { chosen_leagues_only:'true' } : {}, { key, fetchImpl });
}

export async function fetchFootyStatsLeagueTeams({ key, seasonId, fetchImpl = fetch }) {
  if (!/^\d+$/.test(String(seasonId ?? '')) || Number(seasonId) < 1) throw new Error('Temporada FootyStats inválida.');
  return request('/league-teams', { season_id:String(seasonId) }, { key, fetchImpl });
}

function payloadData(payload) { return Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []); }

function latestSeason(seasons) {
  return [...(Array.isArray(seasons) ? seasons : [])].filter((item) => Number(item?.id) > 0)
    .sort((a, b) => Number(b?.year ?? 0) - Number(a?.year ?? 0) || Number(b.id) - Number(a.id))[0] ?? null;
}

export function normalizeFootyStatsLeagues(payload) {
  return payloadData(payload).map((league) => {
    const season = latestSeason(league?.season);
    return season ? {
      seasonId:Number(season.id), year:String(season.year ?? ''),
      name:league?.league_name || league?.name || `Liga ${season.id}`,
      fullName:league?.name || league?.league_name || `Liga ${season.id}`,
      country:league?.country ?? '', image:league?.image ?? null
    } : null;
  }).filter(Boolean).sort((a, b) => `${a.country} ${a.name}`.localeCompare(`${b.country} ${b.name}`, 'pt-BR'));
}

function teamAliases(team) {
  const aliases = [team?.name, team?.cleanName, team?.full_name, team?.english_name, team?.shorthand];
  const altNames = team?.alt_names;
  if (Array.isArray(altNames)) aliases.push(...altNames);
  else if (typeof altNames === 'string') aliases.push(...altNames.split(/[,;|]/));
  for (const [key, value] of Object.entries(team ?? {})) {
    if (/^(alt_name|altName)\d+$/i.test(key)) aliases.push(value);
  }
  return [...new Set(aliases.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

export function normalizeFootyStatsLeagueTeams(payload) {
  return payloadData(payload).map((team) => ({
    id:Number(team?.id),
    name:team?.cleanName || team?.name || team?.full_name || `Time ${team?.id}`,
    fullName:team?.full_name || team?.name || team?.cleanName || `Time ${team?.id}`,
    country:team?.country ?? '', image:team?.image ?? null,
    aliases:teamAliases(team)
  })).filter((team) => Number.isInteger(team.id) && team.id > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function cachedDirectory(key, loader, now = Date.now(), force = false) {
  const cached = directoryCache.get(key);
  if (!force && cached && now - cached.savedAt < DIRECTORY_CACHE_TTL_MS) return { payload:cached.payload, cached:true };
  const payload = await loader();
  directoryCache.set(key, { payload, savedAt:now });
  return { payload, cached:false };
}

export async function getFootyStatsLeagues({ key, fetchImpl = fetch, now = Date.now(), force = false }) {
  const [catalogResult, chosenResult] = await Promise.all([
    cachedDirectory('leagues:catalog', () => fetchFootyStatsLeagues({ key, fetchImpl }), now, force),
    cachedDirectory('leagues:chosen', () => fetchFootyStatsLeagues({ key, fetchImpl, chosenOnly:true }), now, force)
  ]);
  const catalog = normalizeFootyStatsLeagues(catalogResult.payload);
  const chosen = normalizeFootyStatsLeagues(chosenResult.payload);
  const chosenIds = new Set(chosen.map((league) => league.seasonId));
  const byId = new Map(catalog.map((league) => [league.seasonId, { ...league, accessible:chosenIds.has(league.seasonId) }]));
  for (const league of chosen) byId.set(league.seasonId, { ...(byId.get(league.seasonId) ?? league), accessible:true });
  const leagues = [...byId.values()].sort((a, b) => `${a.country} ${a.name}`.localeCompare(`${b.country} ${b.name}`, 'pt-BR'));
  const countries = [...new Set(leagues.map((league) => league.country).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return {
    leagues, countries,
    accessibleLeagues:leagues.filter((league) => league.accessible).length,
    catalogLeagues:leagues.length,
    cached:catalogResult.cached && chosenResult.cached,
    quota:quotaMetadata(chosenResult.payload)
  };
}

export async function getFootyStatsLeagueTeams({ key, seasonId, fetchImpl = fetch, now = Date.now(), force = false }) {
  const id = Number(seasonId);
  const result = await cachedDirectory(`teams:${id}`, () => fetchFootyStatsLeagueTeams({ key, seasonId:id, fetchImpl }), now, force);
  return { teams:normalizeFootyStatsLeagueTeams(result.payload), seasonId:id, cached:result.cached, quota:quotaMetadata(result.payload) };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function metric(stats, key, venue) {
  return numberOrNull(stats?.[`${key}_${venue}`]);
}

function metricAny(stats, keys, venue) {
  for (const key of keys) {
    const value = metric(stats, key, venue);
    if (value !== null) return value;
  }
  return null;
}

function venueStats(stats, venue) {
  return {
    matches:metric(stats, 'seasonMatchesPlayed', venue),
    wins:metric(stats, 'seasonWinsNum', venue),
    draws:metric(stats, 'seasonDrawsNum', venue),
    losses:metric(stats, 'seasonLossesNum', venue),
    ppg:metric(stats, 'seasonPPG', venue),
    goalsFor:metric(stats, 'seasonScoredAVG', venue),
    goalsAgainst:metric(stats, 'seasonConcededAVG', venue),
    goalsTotal:metric(stats, 'seasonAVG', venue),
    btts:metric(stats, 'seasonBTTSPercentage', venue),
    over05:metric(stats, 'seasonOver05Percentage', venue),
    over15:metric(stats, 'seasonOver15Percentage', venue),
    over25:metric(stats, 'seasonOver25Percentage', venue),
    over35:metric(stats, 'seasonOver35Percentage', venue),
    firstHalf:{
      goalsFor:metric(stats, 'scoredAVGHT', venue),
      goalsAgainst:metric(stats, 'concededAVGHT', venue),
      goalsTotal:metric(stats, 'AVGHT', venue),
      btts:metric(stats, 'seasonBTTSPercentageHT', venue) ?? metric(stats, 'btts_fhg_percentage', venue),
      over05:metric(stats, 'seasonOver05PercentageHT', venue),
      over15:metric(stats, 'seasonOver15PercentageHT', venue),
      over25:metric(stats, 'seasonOver25PercentageHT', venue)
    },
    secondHalf:{
      goalsFor:metric(stats, 'scored_2hg_avg', venue),
      goalsAgainst:metric(stats, 'conceded_2hg_avg', venue),
      goalsTotal:metric(stats, 'AVG_2hg', venue),
      btts:metric(stats, 'btts_2hg_percentage', venue),
      over05:metric(stats, 'over05_2hg_percentage', venue),
      over15:metric(stats, 'over15_2hg_percentage', venue),
      over25:metric(stats, 'over25_2hg_percentage', venue)
    },
    shots:{
      total:metric(stats, 'shotsAVG', venue),
      onTarget:metric(stats, 'shotsOnTargetAVG', venue),
      offTarget:metric(stats, 'shotsOffTargetAVG', venue)
    },
    corners:{
      for:metricAny(stats, ['cornersAVG', 'corners_for_avg', 'corners_earned_avg'], venue),
      against:metricAny(stats, ['cornersAgainstAVG', 'corners_against_avg'], venue),
      total:metricAny(stats, ['cornersTotalAVG', 'corners_total_avg'], venue)
    },
    cards:{
      team:metricAny(stats, ['cards_for_avg', 'cardsAVG'], venue),
      total:metricAny(stats, ['cards_total_avg', 'cardsTotalAVG'], venue)
    }
  };
}

function hasValues(value) {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return true;
  return Object.values(value).some(hasValues);
}

function normalizeWindow(item) {
  const stats = item?.stats ?? {};
  const venues = {
    overall:venueStats(stats, 'overall'),
    home:venueStats(stats, 'home'),
    away:venueStats(stats, 'away')
  };
  return {
    matches:Number(item?.last_x_match_num),
    sample:{ overall:venues.overall.matches, home:venues.home.matches, away:venues.away.matches },
    venues
  };
}

export function normalizeFootyStatsLastX(payload, requestedTeamId) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  if (!data.length) throw new Error('A FootyStats não retornou dados para este time no seu plano.');
  const windows = data.map(normalizeWindow).filter((item) => Number.isFinite(item.matches));
  const first = data[0];
  const result = {
    id:numberOrNull(first?.id) ?? Number(requestedTeamId),
    name:first?.full_name || first?.name || first?.english_name || `Time ${requestedTeamId}`,
    shortName:first?.name || first?.full_name || `Time ${requestedTeamId}`,
    country:first?.country ?? null,
    season:first?.season ?? null,
    competitionId:numberOrNull(first?.competition_id),
    image:first?.image ?? null,
    windows:Object.fromEntries(windows.map((item) => [String(item.matches), item])),
    availableWindows:windows.map((item) => item.matches).sort((a, b) => a - b),
    availability:{
      firstHalf:windows.some((item) => hasValues(item.venues.overall.firstHalf)),
      secondHalf:windows.some((item) => hasValues(item.venues.overall.secondHalf)),
      shots:windows.some((item) => hasValues(item.venues.overall.shots)),
      corners:windows.some((item) => hasValues(item.venues.overall.corners)),
      cards:windows.some((item) => hasValues(item.venues.overall.cards))
    }
  };
  return result;
}

function quotaMetadata(payload) {
  const metadata = payload?.metadata ?? {};
  return {
    limit:numberOrNull(metadata.request_limit),
    remaining:numberOrNull(metadata.request_remaining),
    refreshAt:numberOrNull(metadata.request_limit_refresh_next)
  };
}

export async function getFootyStatsTeam({ key, teamId, fetchImpl = fetch, now = Date.now() }) {
  const id = validTeamId(teamId);
  const cacheKey = `${key}:${id}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.savedAt < CACHE_TTL_MS) return { ...cached.value, cached:true };
  const payload = await fetchFootyStatsLastX({ key, teamId:id, fetchImpl });
  const value = { team:normalizeFootyStatsLastX(payload, id), quota:quotaMetadata(payload), cached:false };
  cache.set(cacheKey, { savedAt:now, value });
  return value;
}

export async function compareFootyStatsTeams({ key, homeTeamId, awayTeamId, fetchImpl = fetch }) {
  const [home, away] = await Promise.all([
    getFootyStatsTeam({ key, teamId:homeTeamId, fetchImpl }),
    getFootyStatsTeam({ key, teamId:awayTeamId, fetchImpl })
  ]);
  return {
    home:home.team,
    away:away.team,
    quota:away.cached ? home.quota : away.quota,
    cached:{ home:home.cached, away:away.cached },
    unavailable:{
      corners:!home.team.availability.corners || !away.team.availability.corners,
      cards:!home.team.availability.cards || !away.team.availability.cards
    }
  };
}

export function clearFootyStatsCache() { cache.clear(); directoryCache.clear(); }
