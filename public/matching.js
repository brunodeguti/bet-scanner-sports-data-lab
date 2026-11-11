const GENERIC_TOKENS = new Set([
  'fc', 'cf', 'sc', 'ac', 'ec', 'afc', 'club', 'clube', 'football', 'futebol',
  'sv', 'vv', 'rkvv', 'de', 'da', 'do', 'dos', 'das', 'the'
]);
const TOKEN_ALIASES = new Map([
  ['beker', 'cup'], ['copa', 'cup'], ['taca', 'cup'], ['pokal', 'cup'], ['coupe', 'cup']
]);

export function normalizedName(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/).filter((token) => token && !GENERIC_TOKENS.has(token))
    .map((token) => TOKEN_ALIASES.get(token) ?? token).join(' ');
}

function levenshtein(left, right) {
  if (!left) return right.length;
  if (!right) return left.length;
  const previous = Array.from({ length:right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function nameScore(target, candidates) {
  const wanted = normalizedName(target);
  if (!wanted) return 0;
  const wantedCompact = wanted.replaceAll(' ', '');
  const wantedTokens = new Set(wanted.split(' '));
  return Math.max(0, ...candidates.map((candidate) => {
    const value = normalizedName(candidate);
    if (!value) return 0;
    if (value === wanted) return 100;
    const compact = value.replaceAll(' ', '');
    if (compact === wantedCompact) return 99;
    const valueTokens = new Set(value.split(' '));
    const common = [...wantedTokens].filter((token) => valueTokens.has(token)).length;
    const coverage = common / Math.max(wantedTokens.size, valueTokens.size);
    const shorterCovered = common === Math.min(wantedTokens.size, valueTokens.size);
    if (shorterCovered && common > 0) return 88 + 8 * coverage;
    if (wantedCompact.includes(compact) || compact.includes(wantedCompact)) return 86;
    const similarity = 1 - levenshtein(wantedCompact, compact) / Math.max(wantedCompact.length, compact.length);
    return Math.max(coverage * 78, similarity * 72);
  }));
}

export function bestNamedMatch(target, items, candidatesForItem) {
  const ranked = items.map((item) => ({ item, score:nameScore(target, candidatesForItem(item)) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  if (!best) return null;
  const runnerUp = ranked[1]?.score ?? 0;
  return { ...best, runnerUp, confident:best.score >= 64 && (best.score >= 95 || best.score - runnerUp >= 7) };
}

export function seasonYears(value) {
  const text = String(value ?? '').trim();
  const shortRange = text.match(/^((?:19|20)\d{2})\D+(\d{2})$/);
  if (shortRange) {
    const first = Number(shortRange[1]);
    const second = Math.floor(first / 100) * 100 + Number(shortRange[2]);
    return [first, second < first ? second + 100 : second];
  }
  const fourDigit = [...text.matchAll(/(?:19|20)\d{2}/g)].map((match) => Number(match[0]));
  if (fourDigit.length) return [...new Set(fourDigit)];
  const compact = text.replace(/\D/g, '');
  if (/^(?:19|20)\d{6}$/.test(compact)) return [Number(compact.slice(0, 4)), Number(compact.slice(4, 8))];
  return [];
}

export function seasonIncludesDate(value, startsAt) {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return false;
  return seasonYears(value).includes(date.getFullYear());
}

export function resolveLeagueForEvent(name, startsAt, leagues) {
  const ranked = (leagues ?? []).map((league) => ({ league, score:nameScore(name, [league.name, league.fullName]) }))
    .filter((item) => item.score >= 64).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { status:'not_found' };
  const sameSeason = ranked.filter((item) => seasonIncludesDate(item.league.year, startsAt));
  const accessible = sameSeason.find((item) => item.league.accessible);
  if (accessible) return { status:'ok', ...accessible };
  if (sameSeason.length) return { status:'locked', ...sameSeason[0] };
  const historical = ranked.find((item) => item.league.accessible);
  if (historical) return { status:'historical', ...historical };
  return { status:'locked', ...ranked[0] };
}
