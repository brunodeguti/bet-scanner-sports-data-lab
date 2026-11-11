import { bestNamedMatch, normalizedName, resolveLeagueForEvent, seasonYears } from './matching.js';

const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value ?? 0);
const pct = (value) => `${Number(value ?? 0).toFixed(2)}%`;
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
let oddsPapiTournaments = [];
let footyLeagues = [];
let footyTeams = [];
let currentSettings = null;
let activeOddsMarketIds = null;
let activeMarketContext = null;
let activeFixtureInspectionMarketId = null;
let activeScannerTab = 'surebet';
let oddsPapiAnalyses = [];
const surebetPreviewTimers = new Map();

const periodLabels = {
  fulltime:'Jogo completo', p1:'1º tempo', firsthalf:'1º tempo', 'first half':'1º tempo',
  p2:'2º tempo', secondhalf:'2º tempo', 'second half':'2º tempo', overtime:'Prorrogação'
};

function readablePeriod(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return periodLabels[key] ?? (key && key !== 'não informado' ? value : 'Período não informado');
}

function readableBook(value) {
  const slug = String(value ?? '').trim().toLowerCase();
  const known = {
    'betano.bet.br':'Betano', 'superbet.bet.br':'Superbet', 'stake.bet.br':'Stake',
    'sportingbet.bet.br':'Sportingbet', 'blaze.bet.br':'Blaze', estrelabelt:'EstrelaBet',
    estrelabet:'EstrelaBet', ktoo:'KTO', kto:'KTO', pixbet:'Pixbet', pinnacle:'Pinnacle'
  };
  return known[slug] ?? String(value ?? '').replace(/\.bet\.br$/i, '').replace(/\.br$/i, '');
}

function readableMarket(value, event = '') {
  const [home = 'Mandante', away = 'Visitante'] = String(event).split(' x ');
  let name = String(value ?? 'Mercado').replace(/^\d+\s*[—-]\s*/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = [
    [/^1x2$/i, 'Vencedor da partida'],
    [/^corners?\s+1x2$/i, 'Vencedor em escanteios'],
    [/^both teams to score$/i, 'Ambas as equipes marcam'],
    [/^(full time )?result$/i, 'Vencedor da partida'],
    [/^double chance$/i, 'Dupla chance'],
    [/^draw no bet$/i, 'Empate anula'],
    [/^half time full time$/i, 'Resultado no intervalo/final'],
    [/^winning margin$/i, 'Margem de vitória'],
    [/^first goal$/i, 'Primeiro gol'],
    [/^last goal$/i, 'Último gol'],
    [/^correct score$/i, 'Placar correto'],
    [/^exact score$/i, 'Placar exato']
  ];
  for (const [pattern, label] of exact) if (pattern.test(name)) return label;
  name = name
    .replace(/First Half|1st Half/gi, '').replace(/Second Half|2nd Half/gi, '').replace(/Full Time/gi, '')
    .replace(/Team 1/gi, home).replace(/Team 2/gi, away)
    .replace(/Both Teams To Score/gi, 'Ambas as equipes marcam')
    .replace(/Half Time Full Time/gi, 'Resultado no intervalo/final')
    .replace(/Winning Margin/gi, 'Margem de vitória').replace(/Draw No Bet/gi, 'Empate anula')
    .replace(/Double Chance/gi, 'Dupla chance').replace(/Race To (\d+) Goals?/gi, 'Primeiro a $1 gols')
    .replace(/First Goal/gi, 'Primeiro gol').replace(/Last Goal/gi, 'Último gol')
    .replace(/Player Shots On Target/gi, 'Chutes no gol do jogador')
    .replace(/Player Shots/gi, 'Finalizações do jogador')
    .replace(/Shots On Target/gi, 'Chutes no gol').replace(/Total Shots/gi, 'Total de finalizações').replace(/Shots/gi, 'Finalizações')
    .replace(/Corners? Over Under/gi, 'Total de escanteios').replace(/Corners?/gi, 'Escanteios')
    .replace(/Cards? Over Under/gi, 'Total de cartões').replace(/Cards?/gi, 'Cartões')
    .replace(/Team Total Goals?/gi, 'Total de gols da equipe').replace(/Total Goals?/gi, 'Total de gols')
    .replace(/Goals? Over Under/gi, 'Total de gols').replace(/Exact Team Goals?/gi, 'Total exato de gols da equipe')
    .replace(/Goal Kicks?/gi, 'Tiros de meta').replace(/Throw Ins?/gi, 'Laterais')
    .replace(/Asian Handicap/gi, 'Handicap asiático').replace(/European Handicap/gi, 'Handicap europeu')
    .replace(/Over Under/gi, 'Total — mais/menos').replace(/Clean Sheet/gi, 'Não sofrer gol')
    .replace(/To Score In Both Halves/gi, 'marca nos dois tempos').replace(/To Win Either Half/gi, 'vence qualquer tempo')
    .replace(/Win To Nil/gi, 'vence sem sofrer gol').replace(/Clean Sheet/gi, 'não sofre gol')
    .replace(/To Qualify/gi, 'Classificação').replace(/Correct Score/gi, 'Placar correto').replace(/Exact Score/gi, 'Placar exato')
    .replace(/Winner/gi, 'Vencedor').replace(/Result/gi, 'Resultado').replace(/Player/gi, 'Jogador')
    .replace(/Saves?/gi, 'Defesas').replace(/Fouls?/gi, 'Faltas').replace(/Offsides?/gi, 'Impedimentos')
    .replace(/Odd Even/gi, 'Ímpar ou par').replace(/Yes No/gi, 'Sim ou não')
    .replace(/\s+/g, ' ').trim();
  return name ? name.charAt(0).toLocaleUpperCase('pt-BR') + name.slice(1) : 'Mercado';
}

function cleanLine(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const [candidate] = raw.split('/');
  return /^[+-]?\d+(?:\.\d+)?$/.test(candidate) && candidate.length < 8 ? candidate.replace('.', ',') : '';
}

function readableOutcome(value, event = '') {
  const [home, away] = String(event).split(' x ');
  const key = String(value ?? '').trim().toLowerCase();
  if (key === '1' && home) return home;
  if (key === 'home' && home) return home;
  if ((key === '2' || key === 'away') && away) return away;
  if (key === 'x' || key === 'draw') return 'Empate';
  if (key === 'yes') return 'Sim';
  if (key === 'no') return 'Não';
  if (key === 'over') return 'Mais de';
  if (key === 'under') return 'Menos de';
  if (key === 'odd') return 'Ímpar';
  if (key === 'even') return 'Par';
  if (key === '1x') return `${home} ou empate`;
  if (key === 'x2') return `Empate ou ${away}`;
  if (key === '12') return `${home} ou ${away}`;
  return value || 'Seleção';
}

function opportunitySelection(row, event) {
  const outcome = readableOutcome(row.outcome, event);
  const line = row.line ? String(row.line).replace('.', ',') : cleanLine(row.line);
  if (row.subject) return `${row.subject} — ${outcome}${line ? ` ${line}` : ''}`;
  return `${outcome}${line && !String(outcome).includes(line) ? ` ${line}` : ''}`;
}

function marketSubtitle(row, event = '') {
  const parts = [readableMarket(row.marketName, event), readablePeriod(row.period)];
  if (row.line && !row.subject) parts.push(`linha ${String(row.line).replace('.', ',')}`);
  return parts.join(' • ');
}

function setScannerTab(tab, { scroll = false } = {}) {
  activeScannerTab = tab;
  const targets = { opportunities:'#opportunityMarkets', 'all-markets':'#allOddsMarkets', surebet:'#markets' };
  for (const [name, selector] of Object.entries(targets)) $(selector).hidden = name !== tab;
  document.querySelectorAll('.scanner-tab').forEach((button) => {
    const active = button.dataset.scannerTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (scroll) document.querySelector('.scanner-tabs')?.scrollIntoView({ behavior:'smooth', block:'start' });
}

document.querySelectorAll('.scanner-tab').forEach((button) => button.addEventListener('click', () => setScannerTab(button.dataset.scannerTab)));

function renderOpportunities(analyses = []) {
  const container = $('#opportunityMarkets');
  if (!analyses.length) {
    container.innerHTML = '<div class="empty">Faça uma busca na OddsPapi para analisar oportunidades em todos os mercados.</div>';
    return;
  }
  container.innerHTML = analyses.map((analysis) => {
    const rows = analysis.opportunities ?? [];
    const content = rows.length ? `<div class="table-wrap"><table class="opportunity-table"><thead><tr><th>Seleção / mercado / casa</th><th class="num">Odd</th><th class="num">Prob.</th><th class="num">Edge</th><th class="num">EV</th><th class="num">Stake</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong class="opportunity-selection">${esc(opportunitySelection(row, analysis.event))}</strong><span class="opportunity-market">${esc(marketSubtitle(row, analysis.event))}</span><span class="opportunity-book">${esc(readableBook(row.bookmaker))}</span></td><td class="num"><strong>${Number(row.odds).toFixed(2)}</strong></td><td class="num">${pct(row.fairProbabilityPct)}</td><td class="num positive">${pct(row.edgePct)}</td><td class="num positive">${pct(row.evPct)}</td><td class="num">${money(row.suggestedStake)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty compact-empty"><strong>Nenhuma oportunidade confirmada</strong><span>Há ${analysis.marketCount} mercados disponíveis, mas nenhum atingiu o EV mínimo com uma referência Pinnacle completa para a mesma linha.</span></div>`;
    return `<article class="panel market"><div class="market-head"><div><h3>${esc(analysis.event)}</h3><span class="muted small">${esc(analysis.tournament || '')}${analysis.startsAt ? ` • ${new Date(analysis.startsAt).toLocaleString('pt-BR')}` : ''}</span></div><div class="tags"><span class="tag ${rows.length ? 'good' : ''}">${rows.length} oportunidade${rows.length === 1 ? '' : 's'}</span><span class="tag">${analysis.comparableGroups} referências válidas</span></div></div><div class="opportunity-body"><h3>${rows.length ? 'Melhores oportunidades' : 'Análise concluída'}</h3><p class="small muted">Probabilidade calculada pela Pinnacle sem margem, comparando exatamente mercado, período, linha e jogador/time.</p>${content}</div></article>`;
  }).join('');
}

function groupedMarkets(analysis) {
  const groups = new Map();
  for (const book of analysis.books ?? []) for (const market of book.markets ?? []) for (const offer of market.offers ?? []) {
    if (!offer.active) continue;
    const line = cleanLine(offer.line) || (Number.isFinite(Number(market.handicap)) && Number(market.handicap) !== 0 ? String(market.handicap).replace('.', ',') : '');
    const key = `${market.id}\u0000${offer.playerName ?? ''}\u0000${line}`;
    const group = groups.get(key) ?? { marketName:market.name, category:market.category, period:market.period, subject:offer.playerName, line, offers:[] };
    group.offers.push({ outcome:offer.outcome, price:offer.price, bookmaker:book.slug });
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.category.localeCompare(b.category, 'pt-BR') || a.marketName.localeCompare(b.marketName, 'pt-BR'));
}

function quoteOutcomeLabel(outcome, line, event) {
  const label = readableOutcome(outcome, event);
  if (!line || !['Mais de', 'Menos de'].includes(label)) return label;
  return `${label} ${line}`;
}

function quoteGroupsHtml(group, analysis) {
  const outcomes = new Map();
  for (const offer of group.offers) {
    const label = quoteOutcomeLabel(offer.outcome, group.line, analysis.event);
    const byBook = outcomes.get(label) ?? new Map();
    const book = readableBook(offer.bookmaker);
    const current = byBook.get(book);
    if (!current || Number(offer.price) > Number(current.price)) byBook.set(book, offer);
    outcomes.set(label, byBook);
  }
  return [...outcomes.entries()].map(([label, offers]) => {
    const ordered = [...offers.entries()].sort((a, b) => Number(b[1].price) - Number(a[1].price));
    return `<div class="quote-outcome"><span class="quote-outcome-name">${esc(label)}</span><div class="quote-options">${ordered.map(([book, offer], index) => `<span class="quote-option ${index === 0 ? 'best' : ''}" title="${index === 0 ? 'Melhor odd disponível para esta seleção' : ''}"><strong>${Number(offer.price).toFixed(2)}</strong><small>${esc(book)}</small>${index === 0 && ordered.length > 1 ? '<i>MELHOR</i>' : ''}</span>`).join('')}</div></div>`;
  }).join('');
}

function applyMarketFilters() {
  const query = normalizedName($('#marketSearch')?.value ?? '');
  const category = $('#marketCategory')?.value ?? '';
  document.querySelectorAll('#allOddsMarkets .readable-market-row').forEach((row) => {
    row.hidden = Boolean((category && row.dataset.category !== category) || (query && !normalizedName(row.dataset.search).includes(query)));
  });
  document.querySelectorAll('#allOddsMarkets .readable-market-group').forEach((group) => {
    group.hidden = ![...group.querySelectorAll('.readable-market-row')].some((row) => !row.hidden);
  });
  document.querySelectorAll('#allOddsMarkets .raw-fixture').forEach((fixture) => {
    fixture.hidden = ![...fixture.querySelectorAll('.readable-market-row')].some((row) => !row.hidden);
  });
  const visible = [...document.querySelectorAll('#allOddsMarkets .readable-market-row')].filter((row) => !row.hidden).length;
  const counter = $('#marketFilterCount');
  if (counter) counter.textContent = `${visible} linha${visible === 1 ? '' : 's'} exibida${visible === 1 ? '' : 's'}`;
}

function renderAllOddsMarkets(analyses = []) {
  const container = $('#allOddsMarkets');
  if (!analyses.length) {
    container.innerHTML = '<div class="empty">Faça uma busca para visualizar os mercados disponíveis.</div>';
    return;
  }
  const allGroups = analyses.flatMap(groupedMarkets);
  const categoryNames = [...new Set(allGroups.map((group) => group.category || 'Outros'))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const filters = `<div class="market-filter-bar panel"><div class="field"><label for="marketSearch">Buscar mercado, time, jogador ou casa</label><input id="marketSearch" type="search" placeholder="Ex.: escanteios 1º tempo, Arsenal, Betano"></div><div class="field"><label for="marketCategory">Categoria</label><select id="marketCategory"><option value="">Todas as categorias</option>${categoryNames.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select></div><div class="market-filter-status"><span id="marketFilterCount">${allGroups.length} linhas exibidas</span><button id="clearMarketFilters" type="button">Limpar filtros</button></div></div>`;
  container.innerHTML = filters + analyses.map((analysis) => {
    const groups = groupedMarkets(analysis);
    const categories = new Map();
    for (const group of groups) {
      const category = group.category || 'Outros';
      categories.set(category, [...(categories.get(category) ?? []), group]);
    }
    const sections = [...categories.entries()].map(([category, items], index) => `<details class="readable-market-group" data-category="${esc(category)}" ${index === 0 ? 'open' : ''}><summary><strong>${esc(category)}</strong><span class="tag">${items.length} mercados</span></summary><div class="readable-market-list">${items.map((group) => {
      const title = group.subject || readableMarket(group.marketName, analysis.event);
      const details = [group.subject ? readableMarket(group.marketName, analysis.event) : readablePeriod(group.period), group.subject ? readablePeriod(group.period) : '', group.line && !/mais|menos/i.test(title) ? `linha ${group.line}` : ''].filter(Boolean).join(' • ');
      const searchable = [analysis.event, category, title, details, ...group.offers.map((offer) => `${offer.outcome} ${readableBook(offer.bookmaker)}`)].join(' ');
      return `<div class="readable-market-row" data-category="${esc(category)}" data-search="${esc(searchable)}"><div class="market-description"><strong>${esc(title)}</strong><span>${esc(details)}</span></div><div class="quote-groups">${quoteGroupsHtml(group, analysis)}</div></div>`;
    }).join('')}</div></details>`).join('');
    return `<article id="raw-fixture-${esc(analysis.fixtureId)}" class="panel market raw-fixture"><div class="market-head"><div><h3>${esc(analysis.event)}</h3><span class="muted small">${esc(analysis.tournament || '')}${analysis.startsAt ? ` • ${new Date(analysis.startsAt).toLocaleString('pt-BR')}` : ''}</span></div><div class="tags"><span class="tag">${groups.length} linhas</span><span class="tag">${analysis.bookmakerCount} casas</span></div></div><div class="readable-markets">${sections || '<div class="empty">Nenhum mercado retornado.</div>'}</div></article>`;
  }).join('');
  $('#marketSearch').addEventListener('input', applyMarketFilters);
  $('#marketCategory').addEventListener('change', applyMarketFilters);
  $('#clearMarketFilters').addEventListener('click', () => {
    $('#marketSearch').value = '';
    $('#marketCategory').value = '';
    applyMarketFilters();
  });
}

function errorText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(errorText).filter(Boolean).join('\n');
  if (typeof value === 'object') return errorText(value.message ?? value.error ?? value.detail) || JSON.stringify(value);
  return String(value);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`Resposta inválida do servidor (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error([errorText(data.error), errorText(data.details)].filter(Boolean).join('\n') || `HTTP ${response.status}`);
  return data;
}

function surebetHtml(market) {
  if (!market.surebet) return `<p class="muted">${esc(market.surebetError)}</p>`;
  const result = market.surebet;
  const color = result.isSurebet ? 'positive' : 'bad';
  return `<h3>Surebet</h3>
    <div class="big-number ${color}">${result.isSurebet ? 'SIM' : 'NÃO'}</div>
    <p id="surebet-summary-${market.id}" class="small muted">Soma implícita: ${pct(result.impliedTotalPct)} • ROI arredondado: ${pct(result.roundedRoiPct)} • Stake total: ${money(result.totalStake)}</p>
    <div class="table-wrap"><table><thead><tr><th>Resultado</th><th>Casa</th><th class="num">Odd</th><th class="num">Stake</th><th class="num">Lucro</th></tr></thead><tbody id="surebet-rows-${market.id}">
    ${result.allocation.map((row) => `<tr><td>${esc(row.outcome)}</td><td>${esc(row.bookmaker)}</td><td class="num">${row.odds.toFixed(2)}</td><td class="num">${money(row.stake)}</td><td class="num">${money(row.netProfit)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="inline surebet-actions"><input id="stake-${market.id}" aria-label="Stake total" type="number" min="0.01" max="${market.risk.maxStake}" step="0.01" value="${result.totalStake.toFixed(2)}"><button type="button" onclick="window.previewSurebet(${market.id})">Atualizar cálculo</button><button type="button" ${result.isSurebet ? '' : 'disabled'} onclick="window.runSurebet(${market.id})">Registrar aposta</button></div>
    <p id="surebet-feedback-${market.id}" class="small muted surebet-feedback">Altere a stake para recalcular automaticamente.</p>
    ${market.risk.warnings.length ? `<p class="small amber">${esc(market.risk.warnings.join(' '))}</p>` : ''}`;
}

function evHtml(market) {
  if (!market.ev.length) return `<h3>+EV</h3><p class="muted">Sem probabilidade manual e sem referência completa marcada para cálculo no-vig.</p>`;
  const hasPositive = market.ev.some((row) => row.evPct > 0);
  return `<h3>${hasPositive ? 'Melhores cotações +EV' : 'Nenhuma cotação +EV'}</h3><p class="small muted">Referências: ${esc(market.referenceSources.join(', ') || 'probabilidade manual')}</p>
    <div class="table-wrap"><table><thead><tr><th>Resultado / casa</th><th class="num">Odd</th><th class="num">Prob.</th><th class="num">Edge</th><th class="num">EV</th><th class="num">Stake</th><th></th></tr></thead><tbody>
    ${market.ev.slice(0, 8).map((row) => `<tr><td>${esc(row.outcome)}<br><span class="muted small">${esc(row.bookmaker)} • ${esc(row.probabilitySource)}</span></td><td class="num">${row.odds.toFixed(2)}</td><td class="num">${pct(row.fairProbabilityPct)}</td><td class="num ${row.edgePct > 0 ? 'positive' : 'bad'}">${pct(row.edgePct)}</td><td class="num ${row.evPct > 0 ? 'positive' : 'bad'}">${pct(row.evPct)}</td><td class="num">${money(row.suggestedStake)}</td><td><button ${row.minimumMet ? '' : 'disabled title="Abaixo do EV mínimo ou sem stake"'} onclick="window.runEv(${market.id},${row.quoteId})">Registrar</button></td></tr>`).join('')}
    </tbody></table></div>`;
}

function renderMarkets(allMarkets) {
  const existingComparison = $('#footyComparison');
  if (existingComparison && $('#markets').contains(existingComparison)) $('#footyComparisonAnchor').append(existingComparison);
  const existingInspection = $('#oddsPapiFixtureInspection');
  if (existingInspection && $('#markets').contains(existingInspection)) $('#oddsPapiFixtureInspectionAnchor').append(existingInspection);
  const markets = activeOddsMarketIds === null
    ? allMarkets
    : allMarkets.filter((market) => activeOddsMarketIds.has(Number(market.id)));
  const surebets = markets.filter((market) => market.surebet?.isSurebet).length;
  const evs = markets.reduce((sum, market) => sum + market.ev.filter((item) => item.evPct > 0).length, 0);
  const demos = markets.filter((market) => market.is_demo).length;
  $('#metrics').innerHTML = [
    ['Mercados', markets.length], ['Surebets', surebets], ['Cotações +EV', evs], ['Mercados demo', demos]
  ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
  $('#markets').innerHTML = markets.length ? markets.map((market) => {
    const [home, ...awayParts] = market.event.split(' x ');
    const away = awayParts.join(' x ');
    const footyButton = market.source === 'oddspapi' && home && away ? `<button class="footy-market" data-market-id="${market.id}" data-home="${esc(home)}" data-away="${esc(away)}" data-league="${esc(market.league)}" data-starts-at="${esc(market.starts_at)}">Analisar times</button>` : '';
    return `<article id="market-${market.id}" class="panel market">
    <div class="market-head"><div><h3>${esc(market.event)}</h3><span class="muted small">${esc(market.league)} • ${esc(market.market_name)} • ${new Date(market.starts_at).toLocaleString('pt-BR')}</span></div><div class="tags">${footyButton}${market.is_demo ? '<span class="tag demo">DEMO</span>' : ''}${market.surebet?.isSurebet ? '<span class="tag good">SUREBET</span>' : ''}<span class="tag">${market.outcomes.length} resultados</span></div></div>
    <div id="footy-status-${market.id}" class="market-footy-status" hidden></div>
    <div class="market-body"><div>${surebetHtml(market)}</div><div>${evHtml(market)}</div></div>
  </article>`;
  }).join('') : '<div class="empty">Nenhum mercado passou pelos filtros.</div>';
  const activeCard = activeMarketContext ? $(`#market-${activeMarketContext.marketId}`) : null;
  if (activeCard && existingComparison && !existingComparison.hidden) activeCard.insertAdjacentElement('afterend', existingComparison);
  placeFixtureInspection(activeFixtureInspectionMarketId);
  document.querySelectorAll('.footy-market').forEach((button) => button.addEventListener('click', () => useFootyForMarket(button.dataset)));
  document.querySelectorAll('[id^="stake-"]').forEach((input) => input.addEventListener('input', () => {
    const marketId = Number(input.id.replace('stake-', ''));
    clearTimeout(surebetPreviewTimers.get(marketId));
    surebetPreviewTimers.set(marketId, setTimeout(() => window.previewSurebet(marketId, true), 350));
  }));
}

async function loadMarkets() {
  try {
    const query = new URLSearchParams({ type: $('#type').value, minEv: $('#minEv').value, sort: $('#sort').value });
    renderMarkets(await api(`/api/markets?${query}`));
  } catch (error) { $('#markets').innerHTML = `<div class="notice">${esc(error.message)}</div>`; }
}

async function loadSettings() {
  const settings = await api('/api/settings');
  currentSettings = settings;
  Object.entries(settings).forEach(([key, value]) => { if ($(`#${key}`)) $(`#${key}`).value = value; });
  $('#minEv').value = settings.min_ev_pct;
  renderRiskSummary(settings);
  return settings;
}

function renderRiskSummary(settings = null) {
  const bankroll = Number(settings?.bankroll ?? $('#bankroll').value);
  const exposure = Number(settings?.max_exposure_pct ?? $('#max_exposure_pct').value);
  const surebetStake = Number(settings?.surebet_stake ?? $('#surebet_stake').value);
  const evFixedStake = Number(settings?.ev_fixed_stake ?? $('#ev_fixed_stake').value);
  if (![bankroll, exposure, surebetStake, evFixedStake].every(Number.isFinite)) return;
  const limit = bankroll * exposure / 100;
  const messages = [
    `<strong>Teto por oportunidade: ${money(limit)}</strong>`,
    `Surebet aplicada: ${money(Math.min(surebetStake, limit))}`,
    `+EV fixa aplicada: ${money(Math.min(evFixedStake, limit))}`
  ];
  $('#riskSummary').innerHTML = messages.map((message) => `<span>${message}</span>`).join('');
}

const historyStatus = {
  open:['ABERTA', ''], win:['VERDE', 'good'], loss:['VERMELHO', 'bad'],
  push:['DEVOLVIDA', 'demo'], cancelled:['CANCELADA', 'demo']
};

function historyDetails(row) {
  const payload = row.payload ?? {};
  if (row.kind === 'surebet') {
    const allocation = Array.isArray(payload.allocation) ? payload.allocation : [];
    return `<div class="history-numbers"><span>Stake total <strong>${money(row.stake)}</strong></span><span>Lucro mínimo <strong>${money(payload.roundedMinProfit)}</strong></span><span>ROI <strong>${pct(payload.roundedRoiPct)}</strong></span></div>
      ${allocation.length ? `<div class="history-allocation">${allocation.map((item) => `<span>${esc(item.outcome)} · ${esc(item.bookmaker)} · ${Number(item.odds).toFixed(2)} · ${money(item.stake)}</span>`).join('')}</div>` : ''}`;
  }
  return `<div class="history-numbers"><span>Seleção <strong>${esc(payload.outcome ?? '—')}</strong></span><span>Casa <strong>${esc(payload.bookmaker ?? '—')}</strong></span><span>Odd <strong>${Number(payload.odds ?? 0).toFixed(2)}</strong></span><span>Stake <strong>${money(row.stake)}</strong></span><span>EV <strong>${pct(payload.evPct)}</strong></span><span>Lucro se verde <strong>${money(payload.winProfit ?? row.stake * (Number(payload.odds ?? 1) - 1))}</strong></span></div>`;
}

async function loadHistory() {
  const history = await api('/api/history');
  $('#history').innerHTML = history.length ? history.map((row) => {
    const [statusLabel, statusKind] = historyStatus[row.status] ?? [row.status, ''];
    const result = row.settled_profit == null ? '' : `<span class="history-result ${Number(row.settled_profit) >= 0 ? 'positive' : 'bad'}">Resultado líquido: ${money(row.settled_profit)}</span>`;
    return `<article class="history-item">
      <div class="history-head"><div class="tags"><span class="tag">${row.kind === 'surebet' ? 'SUREBET' : '+EV'}</span><span class="tag ${statusKind}">${statusLabel}</span></div><time class="muted small">${new Date(`${row.created_at}Z`).toLocaleString('pt-BR')}</time></div>
      <div><strong>${esc(row.event || 'Mercado removido')}</strong><br><small class="muted">${esc(row.market_name || '')}</small></div>
      ${historyDetails(row)}${result}
      <div class="settlement-actions" data-history-id="${row.id}">
        <span class="small muted">Liquidar:</span>
        <button data-status="win" class="settle-win">Verde</button><button data-status="loss" class="settle-loss">Vermelho</button><button data-status="push">Push</button><button data-status="cancelled">Cancelada</button>${row.status !== 'open' ? '<button data-status="open">Reabrir</button>' : ''}
      </div>
    </article>`;
  }).join('') : '<span class="muted">Histórico vazio.</span>';
  document.querySelectorAll('.settlement-actions button').forEach((button) => button.addEventListener('click', async () => {
    const id = button.closest('.settlement-actions').dataset.historyId;
    try {
      button.disabled = true;
      const result = await api(`/api/history/${id}/settle`, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({ status:button.dataset.status }) });
      await Promise.all([loadHistory(), loadSettings(), loadMarkets()]);
      alert(`Resultado salvo. Banca atual: ${money(result.bankroll)}.`);
    } catch (error) { alert(error.message); button.disabled = false; }
  }));
}

function applySurebetPreview(marketId, result) {
  const summary = $(`#surebet-summary-${marketId}`);
  const rows = $(`#surebet-rows-${marketId}`);
  if (!summary || !rows) return;
  summary.textContent = `Soma implícita: ${pct(result.impliedTotalPct)} • ROI arredondado: ${pct(result.roundedRoiPct)} • Stake total: ${money(result.totalStake)}`;
  rows.innerHTML = result.allocation.map((row) => `<tr><td>${esc(row.outcome)}</td><td>${esc(row.bookmaker)}</td><td class="num">${row.odds.toFixed(2)}</td><td class="num">${money(row.stake)}</td><td class="num">${money(row.netProfit)}</td></tr>`).join('');
}

window.previewSurebet = async (marketId, automatic = false) => {
  const feedback = $(`#surebet-feedback-${marketId}`);
  try {
    const totalStake = Number($(`#stake-${marketId}`).value);
    const result = await api('/api/analyze/surebet/preview', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ marketId, totalStake }) });
    applySurebetPreview(marketId, result);
    if (feedback) {
      feedback.className = 'small positive surebet-feedback';
      feedback.textContent = automatic ? 'Cálculo atualizado automaticamente.' : 'Cálculo atualizado. Confira a divisão antes de registrar.';
    }
    return result;
  } catch (error) {
    if (feedback) {
      feedback.className = 'small bad surebet-feedback';
      feedback.textContent = error.message;
    }
    if (!automatic) alert(error.message);
    return null;
  }
};

window.runSurebet = async (marketId) => {
  try {
    const totalStake = Number($(`#stake-${marketId}`).value);
    const result = await api('/api/analyze/surebet', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ marketId, totalStake }) });
    applySurebetPreview(marketId, result);
    alert(`Aposta registrada. Lucro mínimo após arredondamento: ${money(result.roundedMinProfit)}`);
    loadHistory();
  } catch (error) { alert(error.message); }
};
window.runEv = async (marketId, quoteId) => {
  try { const result = await api('/api/analyze/ev', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ marketId, quoteId }) }); alert(`Registrado. EV: ${pct(result.evPct)} | Stake sugerida: ${money(result.suggestedStake)}`); loadHistory(); }
  catch (error) { alert(error.message); }
};

$('#refresh').addEventListener('click', loadMarkets);
$('#refreshMarkets').addEventListener('click', loadMarkets);
$('#type').addEventListener('change', loadMarkets); $('#sort').addEventListener('change', loadMarkets);
$('#file').addEventListener('change', async (event) => { const [file] = event.target.files; if (file) $('#payload').value = await file.text(); });
$('#importCsv').addEventListener('click', async () => {
  try { const result = await api('/api/import/csv', { method:'POST', headers:{'content-type':'text/csv'}, body:$('#payload').value }); $('#importResult').textContent = JSON.stringify(result, null, 2); loadMarkets(); }
  catch (error) { $('#importResult').textContent = error.message; }
});
$('#importJson').addEventListener('click', async () => {
  try { const parsed = JSON.parse($('#payload').value); const result = await api('/api/import/json', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(parsed) }); $('#importResult').textContent = JSON.stringify(result, null, 2); loadMarkets(); }
  catch (error) { $('#importResult').textContent = error.message; }
});
$('#settings').addEventListener('submit', async (event) => {
  event.preventDefault(); const body = Object.fromEntries(new FormData(event.target).entries());
  try {
    const settings = await api('/api/settings', { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    currentSettings = settings;
    renderRiskSummary(settings);
    alert(settings.risk.warnings.length ? `Configurações salvas.\n${settings.risk.warnings.join('\n')}` : 'Configurações salvas.');
    await loadMarkets();
  }
  catch (error) { alert(error.message); }
});
['bankroll', 'max_exposure_pct', 'surebet_stake', 'ev_fixed_stake'].forEach((id) => $(`#${id}`).addEventListener('input', () => renderRiskSummary()));
$('#loadHistory').addEventListener('click', loadHistory);

function localDate(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString('en-CA');
}

async function loadOddsPapiStatus() {
  const status = await api('/api/providers/oddspapi/status');
  $('#oddsPapiStatus').textContent = status.configured ? 'CONFIGURADA' : 'SEM CHAVE';
  $('#oddsPapiStatus').className = `tag ${status.configured ? 'good' : 'demo'}`;
  $('#oddsPapiImport').disabled = !status.configured;
  $('#reloadOddsPapiTournaments').disabled = !status.configured;
  $('#loadOddsPapiMarkets').disabled = !status.configured;
  $('#oddsPapiBookmakers').value = status.defaultBookmakers.join(', ');
  if (status.configured) await loadOddsPapiTournaments();
}

async function loadOddsPapiTournaments(refresh = false) {
  const countrySelect = $('#oddsPapiCountry');
  const select = $('#oddsPapiTournament');
  countrySelect.innerHTML = '<option value="">Carregando países…</option>';
  select.innerHTML = '<option value="">Carregando campeonatos…</option>';
  try {
    const result = await api(`/api/providers/oddspapi/tournaments${refresh ? '?refresh=true' : ''}`);
    oddsPapiTournaments = result.tournaments;
    countrySelect.innerHTML = '<option value="">Selecione o país</option>' + result.countries.map((item) => `<option value="${esc(item.slug)}">${esc(item.name)} (${item.tournaments})</option>`).join('');
    const brazil = result.countries.find((item) => normalizedName(item.slug) === 'brazil' || normalizedName(item.name) === 'brazil');
    if (brazil) countrySelect.value = brazil.slug;
    fillOddsPapiTournaments();
    $('#oddsPapiResult').textContent = `${result.totalTournaments ?? oddsPapiTournaments.length} campeonatos disponíveis em ${result.countries.length} países.`;
  } catch (error) {
    countrySelect.innerHTML = '<option value="">Falha ao carregar países</option>';
    select.innerHTML = '<option value="">Falha ao carregar campeonatos</option>';
    $('#oddsPapiResult').textContent = error.message;
  }
}

function fillOddsPapiTournaments() {
  const country = $('#oddsPapiCountry').value;
  const tournaments = country ? oddsPapiTournaments.filter((item) => item.countrySlug === country) : [];
  $('#oddsPapiTournament').innerHTML = '<option value="">Selecione o campeonato</option>' + tournaments.map((item) => `<option value="${item.id}">${esc(item.name)}${item.fixtures ? ` (${item.fixtures} jogos)` : ''}</option>`).join('');
  $('#oddsPapiTournament').disabled = !country;
}

$('#oddsPapiCountry').addEventListener('change', fillOddsPapiTournaments);
$('#reloadOddsPapiTournaments').addEventListener('click', () => loadOddsPapiTournaments(true));

function renderOddsPapiMarketCatalog(result) {
  const container = $('#oddsPapiMarketCatalog');
  const rows = result.markets ?? [];
  container.innerHTML = `<div class="diagnostic-head"><div><strong>Catálogo de futebol</strong><span class="muted small">${rows.length} mercados • ${result.playerProps} props de jogadores • ${result.cached ? 'cache local' : 'consultado agora'}</span></div><button type="button" id="closeOddsPapiCatalog">Fechar</button></div>
    <div class="diagnostic-tags">${(result.categories ?? []).map((item) => `<span>${esc(item.name)} <strong>${item.count}</strong></span>`).join('')}</div>
    <div class="table-wrap diagnostic-table"><table><thead><tr><th>ID</th><th>Mercado</th><th>Categoria</th><th>Período</th><th>Jogador</th><th>Resultados</th></tr></thead><tbody>
    ${rows.map((market) => `<tr><td>${market.id}</td><td><strong>${esc(market.name)}</strong><br><span class="muted small">${esc(market.type)}</span></td><td>${esc(market.category)}</td><td>${esc(market.period)}</td><td>${market.playerProp ? '<span class="tag good">SIM</span>' : 'Não'}</td><td>${esc((market.outcomes ?? []).map((item) => item.name).join(' / '))}</td></tr>`).join('')}
    </tbody></table></div>`;
  container.hidden = false;
  $('#closeOddsPapiCatalog').addEventListener('click', () => { container.hidden = true; });
}

$('#loadOddsPapiMarkets').addEventListener('click', async () => {
  const button = $('#loadOddsPapiMarkets');
  const container = $('#oddsPapiMarketCatalog');
  try {
    button.disabled = true;
    container.hidden = false;
    container.innerHTML = '<div class="empty">Carregando catálogo de mercados…</div>';
    renderOddsPapiMarketCatalog(await api('/api/providers/oddspapi/markets'));
  } catch (error) {
    container.innerHTML = `<div class="notice">${esc(error.message)}</div>`;
  } finally { button.disabled = false; }
});

$('#oddsPapiFrom').value = localDate(0);
$('#oddsPapiTo').value = localDate(3);

function renderOddsPapiFixtures(fixtures = []) {
  const container = $('#oddsPapiFixtures');
  const labels = {
    updated:['ATUALIZADO AGORA', 'good'], already_saved:['JÁ ESTAVA SALVO', 'saved'],
    imported:['COM ODDS', 'good'], no_odds:['SEM ODDS NA API', 'demo'],
    no_complete_1x2:['SEM 1X2 COMPLETO', 'demo'], error:['ERRO NA CONSULTA', 'bad'],
    not_queried_limit:['NÃO CONSULTADO: LIMITE', 'demo'], pending:['AGUARDANDO', '']
  };
  if (!fixtures.length) { container.hidden = true; container.innerHTML = ''; return; }
  container.innerHTML = `<div class="fixture-directory-head"><strong>Todos os jogos encontrados (${fixtures.length})</strong><span class="muted small">Os sem odds continuam visíveis, mas não entram no scanner.</span></div>` + fixtures.map((fixture) => {
    const [label, kind] = labels[fixture.status] ?? [fixture.status, ''];
    const time = fixture.startsAt ? new Date(fixture.startsAt).toLocaleString('pt-BR') : 'Horário não informado';
    const inspect = fixture.hasOdds && fixture.fixtureId
      ? `<button type="button" class="inspect-fixture-markets" data-fixture-id="${esc(fixture.fixtureId)}" data-market-id="${esc(fixture.marketId ?? '')}" data-event="${esc(`${fixture.home} × ${fixture.away}`)}">Ver mercados</button>` : '';
    const builder = fixture.fixtureId ? `<button type="button" class="build-fixture" data-fixture-id="${esc(fixture.fixtureId)}" data-home="${esc(fixture.home)}" data-away="${esc(fixture.away)}" data-starts-at="${esc(fixture.startsAt ?? '')}" data-league="${esc(fixture.tournament ?? '')}">Criar Aposta</button>` : '';
    return `<div class="fixture-row"><div><strong>${esc(fixture.home)} × ${esc(fixture.away)}</strong><span class="muted small">${esc(time)}</span></div><div class="fixture-actions"><span class="tag ${kind}">${esc(label)}</span>${inspect}${builder}</div></div>`;
  }).join('');
  container.hidden = false;
  document.querySelectorAll('.inspect-fixture-markets').forEach((button) => button.addEventListener('click', () => inspectFixtureMarkets(button)));
  document.querySelectorAll('.build-fixture').forEach((button) => button.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('bet-fixture-selected', { detail:button.dataset }));
  }));
}

function placeFixtureInspection(marketId = null) {
  const container = $('#oddsPapiFixtureInspection');
  const anchor = $('#oddsPapiFixtureInspectionAnchor');
  if (!container || !anchor) return;
  const marketCard = marketId ? $(`#market-${marketId}`) : null;
  if (marketCard) marketCard.insertAdjacentElement('afterend', container);
  else anchor.append(container);
}

function offersLabel(offers = []) {
  return offers.slice(0, 8).map((offer) => {
    const subject = offer.playerName ? `${offer.playerName} • ` : '';
    const line = cleanLine(offer.line);
    return `${subject}${readableOutcome(offer.outcome)}${line ? ` ${line}` : ''} • ${Number(offer.price).toFixed(2)}`;
  }).join(' | ') + (offers.length > 8 ? ` | +${offers.length - 8}` : '');
}

function renderFixtureInspection(result) {
  const container = $('#oddsPapiFixtureInspection');
  container.innerHTML = `<div class="diagnostic-head"><div><strong>${esc(result.event)}</strong><span class="muted small">${esc(result.tournament || '')} • ${result.bookmakerCount} casas • ${result.marketCount} mercados distintos • 1 consulta de cota</span></div><button type="button" id="closeFixtureInspection">Fechar</button></div>
    ${result.books.length ? result.books.map((book, index) => `<details class="book-market-group" ${index === 0 ? 'open' : ''}><summary><strong>${esc(readableBook(book.slug))}</strong><span class="tag ${book.active ? 'good' : 'bad'}">${book.marketCount} mercados • ${book.offerCount} cotações</span></summary><div class="table-wrap"><table class="odds-market-table"><thead><tr><th>Mercado</th><th>Categoria</th><th>Período</th><th>Cotações encontradas</th></tr></thead><tbody>
      ${book.markets.map((market) => `<tr><td><strong>${esc(readableMarket(market.name))}</strong>${market.playerProp ? '<br><span class="tag good">JOGADOR</span>' : ''}</td><td>${esc(market.category)}</td><td>${esc(readablePeriod(market.period))}</td><td>${esc(offersLabel(market.offers))}</td></tr>`).join('')}
      </tbody></table></div></details>`).join('') : '<div class="notice">Nenhum mercado retornado para as casas selecionadas.</div>'}`;
  container.hidden = false;
  placeFixtureInspection(activeFixtureInspectionMarketId);
  container.scrollIntoView({ behavior:'smooth', block:'start' });
  $('#closeFixtureInspection').addEventListener('click', () => {
    container.hidden = true;
    activeFixtureInspectionMarketId = null;
    $('#oddsPapiFixtureInspectionAnchor').append(container);
  });
}

async function inspectFixtureMarkets(button) {
  const container = $('#oddsPapiFixtureInspection');
  try {
    button.disabled = true;
    const cached = oddsPapiAnalyses.find((item) => String(item.fixtureId) === String(button.dataset.fixtureId));
    if (cached) {
      setScannerTab('all-markets', { scroll:true });
      setTimeout(() => $(`#raw-fixture-${CSS.escape(String(cached.fixtureId))}`)?.scrollIntoView({ behavior:'smooth', block:'start' }), 250);
      return;
    }
    activeFixtureInspectionMarketId = Number(button.dataset.marketId) || null;
    placeFixtureInspection(activeFixtureInspectionMarketId);
    container.hidden = false;
    container.innerHTML = `<div class="empty">Consultando todos os mercados de ${esc(button.dataset.event)}…</div>`;
    const query = new URLSearchParams({ bookmakers:$('#oddsPapiBookmakers').value });
    const result = await api(`/api/providers/oddspapi/fixtures/${encodeURIComponent(button.dataset.fixtureId)}/markets?${query}`);
    renderFixtureInspection(result);
  } catch (error) {
    container.innerHTML = `<div class="notice">${esc(error.message)}</div>`;
  } finally { button.disabled = false; }
}

$('#oddsPapiImport').addEventListener('click', async () => {
  const button = $('#oddsPapiImport');
  const body = {
    from:$('#oddsPapiFrom').value, to:$('#oddsPapiTo').value,
    country:$('#oddsPapiCountry').value,
    maxFixtures:Number($('#oddsPapiMax').value), bookmakers:$('#oddsPapiBookmakers').value
  };
  if ($('#oddsPapiTournament').value) body.tournamentId = Number($('#oddsPapiTournament').value);
  try {
    if (!body.country) throw new Error('Selecione um país.');
    if (!body.tournamentId) throw new Error('Selecione um campeonato.');
    button.disabled = true;
    activeOddsMarketIds = new Set();
    activeMarketContext = null;
    activeFixtureInspectionMarketId = null;
    $('#footyComparison').hidden = true;
    $('#footyComparison').innerHTML = '';
    renderOddsPapiFixtures([]);
    $('#oddsPapiFixtureInspection').hidden = true;
    $('#oddsPapiFixtureInspectionAnchor').append($('#oddsPapiFixtureInspection'));
    $('#markets').innerHTML = '<div class="empty">Carregando somente os jogos desta nova pesquisa…</div>';
    $('#oddsPapiResult').textContent = 'Consultando OddsPapi… respeitando o intervalo da API, cerca de 2 segundos por jogo.';
    const result = await api('/api/providers/oddspapi/import', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    oddsPapiAnalyses = result.analyses ?? [];
    renderOpportunities(oddsPapiAnalyses);
    renderAllOddsMarkets(oddsPapiAnalyses);
    setScannerTab('opportunities');
    activeOddsMarketIds = new Set((result.marketIds ?? []).map(Number));
    const importedFixtures = result.fixtures?.filter((item) => ['updated', 'already_saved', 'imported'].includes(item.status)).length ?? 0;
    const updatedFixtures = result.fixtures?.filter((item) => item.status === 'updated').length ?? 0;
    const savedFixtures = result.fixtures?.filter((item) => item.status === 'already_saved').length ?? 0;
    const errorSummary = result.fixtureErrors?.length ? ` • ${result.fixtureErrors.length} erro(s) isolado(s)` : '';
    $('#oddsPapiResult').textContent = `${result.fixturesFound} jogos encontrados • ${result.fixturesSelected} consultados • ${importedFixtures} com 1X2 completo • ${updatedFixtures} atualizados agora • ${savedFixtures} já salvos • ${result.inserted} odds novas${errorSummary}${result.warning ? `\n${result.warning}` : ''}`;
    renderOddsPapiFixtures(result.fixtures);
    await loadMarkets();
  } catch (error) {
    activeOddsMarketIds = new Set();
    oddsPapiAnalyses = [];
    renderOpportunities([]);
    renderAllOddsMarkets([]);
    $('#oddsPapiResult').textContent = error.message;
    renderOddsPapiFixtures([]);
    await loadMarkets();
  }
  finally { button.disabled = false; }
});

const statValue = (value, suffix = '') => value == null ? '—' : `${Number(value).toFixed(Number.isInteger(Number(value)) ? 0 : 2)}${suffix}`;
const statCell = (value, suffix = '', matches = null) => {
  if (value == null) return '<span class="missing-stat" title="Dado indisponível no plano/API">—</span>';
  const formatted = statValue(value, suffix);
  if (suffix === '%' && Number.isFinite(Number(matches)) && Number(matches) > 0) {
    const hits = Math.round(Number(value) * Number(matches) / 100);
    return `${formatted} <small>(${hits}/${Number(matches)})</small>`;
  }
  return formatted;
};

function statRows(home, away, group = null) {
  const left = group ? home?.[group] : home;
  const right = group ? away?.[group] : away;
  const rows = group === 'shots' ? [
    ['Chutes / jogo', 'total'], ['No gol / jogo', 'onTarget'], ['Fora / jogo', 'offTarget']
  ] : group === 'corners' ? [
    ['A favor / jogo', 'for'], ['Contra / jogo', 'against'], ['Total / jogo', 'total']
  ] : group === 'cards' ? [
    ['Do time / jogo', 'team'], ['Total / jogo', 'total']
  ] : [
    ['Jogos na amostra', 'matches'], ['Vitórias', 'wins'], ['Empates', 'draws'], ['Derrotas', 'losses'], ['Pontos por jogo', 'ppg'],
    ['Gols marcados / jogo', 'goalsFor'], ['Gols sofridos / jogo', 'goalsAgainst'], ['Gols totais / jogo', 'goalsTotal'],
    ['BTTS', 'btts', '%'], ['Over 0,5', 'over05', '%'], ['Over 1,5', 'over15', '%'], ['Over 2,5', 'over25', '%'], ['Over 3,5', 'over35', '%']
  ];
  return rows.map(([label, key, suffix]) => `<tr><td class="team-stat">${statCell(left?.[key], suffix, left?.matches)}</td><th>${label}</th><td class="team-stat">${statCell(right?.[key], suffix, right?.matches)}</td></tr>`).join('');
}

function halfRows(home, away, key) {
  const left = home?.[key]; const right = away?.[key];
  return [
    ['Gols marcados / jogo', 'goalsFor'], ['Gols sofridos / jogo', 'goalsAgainst'], ['Gols totais / jogo', 'goalsTotal'],
    ['BTTS', 'btts', '%'], ['Over 0,5', 'over05', '%'], ['Over 1,5', 'over15', '%'], ['Over 2,5', 'over25', '%']
  ].map(([label, field, suffix]) => `<tr><td class="team-stat">${statCell(left?.[field], suffix, home?.matches)}</td><th>${label}</th><td class="team-stat">${statCell(right?.[field], suffix, away?.matches)}</td></tr>`).join('');
}

function comparisonTable(title, homeName, awayName, rows, unavailable = false) {
  if (unavailable) return `<article class="stat-block unavailable"><h3>${title}</h3><p>Indisponível no plano FootyStats atual.</p></article>`;
  const missingNote = rows.includes('missing-stat') ? '<p class="missing-note">— Dado indisponível no plano/API.</p>' : '';
  return `<article class="stat-block"><h3>${title}</h3><div class="table-wrap"><table class="comparison-table"><thead><tr><th>${esc(homeName)}</th><th>Métrica</th><th>${esc(awayName)}</th></tr></thead><tbody>${rows}</tbody></table></div>${missingNote}</article>`;
}

function renderFootyComparison(result) {
  const sharedWindows = result.home.availableWindows.filter((item) => result.away.availableWindows.includes(item));
  const previousWindow = Number($('#footyWindow')?.value);
  const selectedWindow = sharedWindows.includes(previousWindow)
    ? previousWindow
    : (sharedWindows.includes(5) ? 5 : (sharedWindows.includes(10) ? 10 : sharedWindows.at(-1)));
  const windowSize = String(selectedWindow ?? '');
  const venueMode = $('#footyVenue')?.value ?? 'match';
  const homeVenue = venueMode === 'match' ? 'home' : venueMode;
  const awayVenue = venueMode === 'match' ? 'away' : venueMode;
  const home = result.home.windows[windowSize]?.venues?.[homeVenue];
  const away = result.away.windows[windowSize]?.venues?.[awayVenue];
  const container = $('#footyComparison');
  if (!sharedWindows.length) {
    container.innerHTML = '<div class="panel notice">Os dois times não têm um recorte recente em comum na resposta da FootyStats.</div>';
    container.hidden = false;
    return;
  }
  const windowOptions = sharedWindows.map((size) => `<option value="${size}" ${windowSize === String(size) ? 'selected' : ''}>Últimos ${size}</option>`).join('');
  const controls = `<div class="comparison-controls"><div class="field"><label for="footyWindow">Recorte recente</label><select id="footyWindow">${windowOptions}</select></div><div class="field"><label for="footyVenue">Local dentro do recorte</label><select id="footyVenue"><option value="match" ${venueMode === 'match' ? 'selected' : ''}>Mandante em casa × visitante fora</option><option value="overall" ${venueMode === 'overall' ? 'selected' : ''}>Todos os jogos do recorte</option><option value="home" ${venueMode === 'home' ? 'selected' : ''}>Somente jogos em casa</option><option value="away" ${venueMode === 'away' ? 'selected' : ''}>Somente jogos fora</option></select></div></div>`;
  const selectedLeague = footyLeagues.find((league) => league.seasonId === Number($('#footyLeague').value));
  const seasonLabel = selectedLeague ? `${selectedLeague.name} • temporada ${selectedLeague.year}` : [result.home.season, result.away.season].filter(Boolean).join(' / ');
  const samples = [Number(home?.matches), Number(away?.matches)].filter(Number.isFinite);
  const lowSample = samples.some((size) => size < 5);
  const venueExplanation = venueMode === 'match'
    ? `Dentro dos últimos ${windowSize} jogos gerais: ${statValue(home?.matches)} do mandante foram em casa e ${statValue(away?.matches)} do visitante foram fora.`
    : `O filtro foi aplicado dentro dos últimos ${windowSize} jogos gerais de cada equipe.`;
  const backButton = activeMarketContext ? '<button id="backToMarket" type="button">Voltar ao jogo</button>' : '';
  container.innerHTML = `<div class="panel comparison-head"><div><span class="eyebrow">COMPARAÇÃO FOOTYSTATS</span><h2>${esc(result.home.shortName)} × ${esc(result.away.shortName)}</h2><p class="small muted">${esc(seasonLabel || 'Temporada não informada')}<br>${esc(venueExplanation)}</p>${lowSample ? '<p class="small amber sample-warning">Amostra insuficiente: pelo menos um lado tem menos de 5 jogos neste recorte.</p>' : ''}</div><div class="comparison-side">${controls}${backButton}</div></div><div class="stats-grid">
    ${comparisonTable('Jogo completo', result.home.shortName, result.away.shortName, statRows(home, away))}
    ${comparisonTable('1º tempo', result.home.shortName, result.away.shortName, halfRows(home, away, 'firstHalf'), !result.home.availability.firstHalf || !result.away.availability.firstHalf)}
    ${comparisonTable('2º tempo', result.home.shortName, result.away.shortName, halfRows(home, away, 'secondHalf'), !result.home.availability.secondHalf || !result.away.availability.secondHalf)}
    ${comparisonTable('Chutes', result.home.shortName, result.away.shortName, statRows(home, away, 'shots'), !result.home.availability.shots || !result.away.availability.shots)}
    ${comparisonTable('Escanteios', result.home.shortName, result.away.shortName, statRows(home, away, 'corners'), result.unavailable.corners)}
    ${comparisonTable('Cartões', result.home.shortName, result.away.shortName, statRows(home, away, 'cards'), result.unavailable.cards)}
  </div>`;
  container.hidden = false;
  const marketCard = activeMarketContext ? $(`#market-${activeMarketContext.marketId}`) : null;
  if (marketCard) marketCard.insertAdjacentElement('afterend', container);
  $('#footyWindow').addEventListener('change', () => renderFootyComparison(result));
  $('#footyVenue').addEventListener('change', () => renderFootyComparison(result));
  $('#backToMarket')?.addEventListener('click', () => $(`#market-${activeMarketContext?.marketId}`)?.scrollIntoView({ behavior:'smooth', block:'center' }));
}

function bestTeamMatch(name) {
  const match = bestNamedMatch(name, footyTeams, (team) => [team.name, team.fullName, ...(team.aliases || [])]);
  return match ? { team:match.item, score:match.score, confident:match.confident } : null;
}

function resolveLeagueMatch(name, startsAt) {
  return resolveLeagueForEvent(name, startsAt, footyLeagues);
}

function setMarketFootyStatus(marketId, message, kind = '') {
  const container = $(`#footy-status-${marketId}`);
  if (!container) return;
  container.hidden = false;
  container.className = `market-footy-status ${kind}`.trim();
  container.textContent = message;
}

function openFootyForManual(message) {
  $('#footyProvider').open = true;
  $('#footyProvider').classList.add('needs-attention');
  $('#footyStatsResult').textContent = message;
  $('#footyProvider').scrollIntoView({ behavior:'smooth', block:'start' });
}

function fillTeamSelects(teams) {
  const options = '<option value="">Selecione o time</option>' + teams.map((team) => `<option value="${team.id}">${esc(team.name)}</option>`).join('');
  $('#footyHomeId').innerHTML = options;
  $('#footyAwayId').innerHTML = options;
}

async function loadFootyTeams(seasonId = $('#footyLeague').value) {
  if (!seasonId) { footyTeams = []; fillTeamSelects([]); return false; }
  const league = footyLeagues.find((item) => item.seasonId === Number(seasonId));
  if (league && !league.accessible) {
    footyTeams = [];
    fillTeamSelects([]);
    $('#footyStatsResult').textContent = 'Esse campeonato existe no catálogo, mas não está liberado na sua conta FootyStats.';
    return false;
  }
  $('#footyHomeId').innerHTML = '<option value="">Carregando times…</option>';
  $('#footyAwayId').innerHTML = '<option value="">Carregando times…</option>';
  try {
    const result = await api(`/api/providers/footystats/leagues/${encodeURIComponent(seasonId)}/teams`);
    footyTeams = result.teams;
    fillTeamSelects(footyTeams);
    $('#footyStatsResult').textContent = `${footyTeams.length} times carregados para a competição selecionada.`;
    return true;
  } catch (error) {
    footyTeams = [];
    fillTeamSelects([]);
    $('#footyStatsResult').textContent = error.message;
    return false;
  }
}

async function loadFootyLeagues(refresh = false) {
  const countrySelect = $('#footyCountry');
  const select = $('#footyLeague');
  countrySelect.innerHTML = '<option value="">Carregando países…</option>';
  select.innerHTML = '<option value="">Carregando campeonatos…</option>';
  try {
    const result = await api(`/api/providers/footystats/leagues${refresh ? '?refresh=true' : ''}`);
    footyLeagues = result.leagues;
    countrySelect.innerHTML = '<option value="">Selecione o país</option>' + result.countries.map((country) => `<option value="${esc(country)}">${esc(country)}</option>`).join('');
    const brazil = result.countries.find((country) => normalizedName(country) === 'brazil');
    if (brazil) countrySelect.value = brazil;
    fillFootyLeagues();
    $('#footyStatsResult').textContent = `${result.accessibleLeagues} campeonatos liberados na sua conta • ${result.catalogLeagues} no catálogo • ${result.countries.length} países.`;
  } catch (error) {
    footyLeagues = [];
    countrySelect.innerHTML = '<option value="">Falha ao carregar países</option>';
    select.innerHTML = '<option value="">Falha ao carregar campeonatos</option>';
    $('#footyStatsResult').textContent = error.message;
  }
}

function fillFootyLeagues() {
  const country = $('#footyCountry').value;
  const leagues = country ? footyLeagues.filter((league) => league.country === country) : [];
  const ordered = [...leagues].sort((a, b) => Number(b.accessible) - Number(a.accessible) || a.name.localeCompare(b.name, 'pt-BR'));
  $('#footyLeague').innerHTML = '<option value="">Selecione o campeonato</option>' + ordered.map((league) => `<option value="${league.seasonId}" ${league.accessible ? '' : 'disabled'}>${league.accessible ? '✓' : '🔒'} ${esc(league.name)} (${esc(league.year)})${league.accessible ? '' : ' — não liberado'}</option>`).join('');
  $('#footyLeague').disabled = !country;
  footyTeams = [];
  fillTeamSelects([]);
}

async function useFootyForMarket({ marketId, home, away, league, startsAt }) {
  activeMarketContext = { marketId:Number(marketId), home, away, league, startsAt };
  setMarketFootyStatus(marketId, 'Localizando campeonato, temporada e times na FootyStats…');
  if (!footyLeagues.length) {
    const message = 'A FootyStats não carregou o catálogo. Abra o painel e recarregue os campeonatos.';
    setMarketFootyStatus(marketId, message, 'bad');
    openFootyForManual(message);
    return;
  }
  const leagueMatch = resolveLeagueMatch(league, startsAt);
  if (leagueMatch.status === 'not_found') {
    const message = `Não encontrei “${league}” com segurança. Selecione o campeonato e os times manualmente.`;
    setMarketFootyStatus(marketId, message, 'amber');
    openFootyForManual(message);
    return;
  }
  if (leagueMatch.status === 'locked') {
    const message = `${leagueMatch.league.name} (${leagueMatch.league.year}) corresponde à data do jogo, mas essa temporada não está liberada na sua conta FootyStats.`;
    setMarketFootyStatus(marketId, message, 'amber');
    $('#footyStatsResult').textContent = message;
    return;
  }
  if (leagueMatch.status === 'historical') {
    const gameYear = new Date(startsAt).getFullYear();
    const availableYears = seasonYears(leagueMatch.league.year).join('/') || leagueMatch.league.year;
    const message = `Não vou usar dados históricos como se fossem atuais: o jogo é de ${gameYear}, mas a temporada liberada na FootyStats é ${availableYears}.`;
    setMarketFootyStatus(marketId, message, 'amber');
    $('#footyStatsResult').textContent = message;
    return;
  }
  $('#footyCountry').value = leagueMatch.league.country;
  fillFootyLeagues();
  $('#footyLeague').value = String(leagueMatch.league.seasonId);
  if (!await loadFootyTeams(leagueMatch.league.seasonId)) {
    setMarketFootyStatus(marketId, $('#footyStatsResult').textContent, 'bad');
    return;
  }
  const homeMatch = bestTeamMatch(home); const awayMatch = bestTeamMatch(away);
  if (homeMatch?.confident) $('#footyHomeId').value = String(homeMatch.team.id);
  if (awayMatch?.confident) $('#footyAwayId').value = String(awayMatch.team.id);
  if (!homeMatch?.confident || !awayMatch?.confident || homeMatch.team.id === awayMatch.team.id) {
    const missing = [!homeMatch?.confident ? home : null, !awayMatch?.confident ? away : null].filter(Boolean).join(' / ');
    const message = `Campeonato e temporada confirmados. Não foi possível confirmar automaticamente: ${missing || 'os dois times'}. Escolha os times manualmente.`;
    setMarketFootyStatus(marketId, message, 'amber');
    openFootyForManual(message);
    return;
  }
  setMarketFootyStatus(marketId, 'Times confirmados. Carregando a comparação…', 'positive');
  await compareSelectedFooty();
}

async function loadFootyStatsStatus() {
  const status = await api('/api/providers/footystats/status');
  $('#footyStatsStatus').textContent = status.configured ? 'CONFIGURADA' : 'SEM CHAVE';
  $('#footyStatsStatus').className = `tag ${status.configured ? 'good' : 'demo'}`;
  $('#footyCompare').disabled = !status.configured;
  $('#reloadFootyLeagues').disabled = !status.configured;
  if (status.configured) await loadFootyLeagues();
}

$('#footyCountry').addEventListener('change', fillFootyLeagues);
$('#footyLeague').addEventListener('change', () => loadFootyTeams());
$('#reloadFootyLeagues').addEventListener('click', () => loadFootyLeagues(true));

async function compareSelectedFooty() {
  const button = $('#footyCompare');
  const homeTeamId = $('#footyHomeId').value;
  const awayTeamId = $('#footyAwayId').value;
  try {
    if (!homeTeamId || !awayTeamId) throw new Error('Selecione o mandante e o visitante.');
    if (homeTeamId === awayTeamId) throw new Error('Mandante e visitante precisam ser times diferentes.');
    button.disabled = true;
    $('#footyStatsResult').textContent = 'Consultando os dois times na FootyStats…';
    const query = new URLSearchParams({ homeTeamId, awayTeamId });
    const result = await api(`/api/providers/footystats/compare?${query}`);
    $('#footyStatsResult').textContent = `Dados carregados: ${result.home.shortName} × ${result.away.shortName}${result.quota.remaining == null ? '' : ` • ${result.quota.remaining} consultas restantes`}`;
    $('#footyProvider').classList.remove('needs-attention');
    if (activeMarketContext) setMarketFootyStatus(activeMarketContext.marketId, 'Comparação carregada logo abaixo deste jogo.', 'positive');
    renderFootyComparison(result);
    $('#footyComparison').scrollIntoView({ behavior:'smooth', block:'start' });
    return result;
  } catch (error) {
    $('#footyStatsResult').textContent = error.message;
    if (activeMarketContext) setMarketFootyStatus(activeMarketContext.marketId, error.message, 'bad');
    return null;
  }
  finally { button.disabled = false; }
}

$('#footyCompare').addEventListener('click', compareSelectedFooty);

async function loadCsvSeasons(selectLeague = '') {
  const seasons = await api('/api/footy-csv/seasons');
  const selector = $('#footyCsvSeason');
  selector.innerHTML = '<option value="">Escolha a temporada</option>' + seasons.map((row) =>
    `<option value="${esc(`${row.league}|${row.season}`)}">${esc(row.league.replace(/-/g, ' '))} • ${esc(row.season)} (${row.matches} jogos)</option>`).join('');
  if (selectLeague) selector.value = selectLeague;
  if (!selector.value && seasons.length) selector.value = `${seasons[0].league}|${seasons[0].season}`;
  await loadCsvTeams();
}

async function loadCsvTeams() {
  const [league, season] = $('#footyCsvSeason').value.split('|');
  const teams = league ? await api(`/api/footy-csv/teams?${new URLSearchParams({ league, season })}`) : [];
  const options = '<option value="">Escolha o time</option>' + teams.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
  $('#footyCsvHome').innerHTML = options;
  $('#footyCsvAway').innerHTML = options;
}

$('#footyCsvSeason').addEventListener('change', loadCsvTeams);
$('#footyCsvImport').addEventListener('click', async () => {
  const button = $('#footyCsvImport'), files = [...$('#footyCsvFile').files];
  try {
    if (!files.length) throw new Error('Selecione pelo menos um CSV FootyStats.');
    button.disabled = true;
    const report = [];
    let selected = '';
    for (const file of files) {
      $('#footyCsvStatus').textContent = `Importando ${file.name}…`;
      try {
        const result = await api(`/api/footy-csv/import?${new URLSearchParams({ filename:file.name })}`, {
          method:'POST', headers:{ 'content-type':'text/csv' }, body:await file.text()
        });
        if (result.kind === 'matches') selected = `${result.league}|${result.season}`;
        const missing = result.kind === 'matches' ? Object.entries(result.coverage).filter(([, count]) => count === 0).map(([key]) => key) : [];
        report.push(`${file.name}: ${result.imported} registros • ${result.columns.length} colunas${missing.length ? ` • sem dados por partida: ${missing.join(', ')}` : ''}${result.note ? ` • ${result.note}` : ''}`);
      } catch (error) { report.push(`${file.name}: ERRO — ${error.message}`); }
    }
    await loadCsvSeasons(selected);
    window.dispatchEvent(new Event('footy-csv-imported'));
    $('#footyCsvStatus').textContent = report.join('\n');
  } catch (error) { $('#footyCsvStatus').textContent = error.message; }
  finally { button.disabled = false; }
});

function renderCsvComparison(result) {
  const element = $('#footyCsvComparison');
  const size = Number(element.querySelector('#csvWindow')?.value || 5);
  const venue = element.querySelector('#csvVenue')?.value || 'match';
  const homeVenue = venue === 'match' ? 'home' : venue;
  const awayVenue = venue === 'match' ? 'away' : venue;
  const home = result.home.windows[size][homeVenue], away = result.away.windows[size][awayVenue];
  const labels = [
    ['Gols marcados', 'goals'], ['Gols sofridos', 'goalsAgainst'], ['Gols na partida', 'totalGoals'],
    ['Cartões amarelos', 'yellow'], ['Cartões vermelhos', 'red'], ['Cartões amarelos do adversário', 'yellowAgainst'],
    ['Cartões totais (amarelos + vermelhos)', 'totalCards'],
    ['Escanteios a favor', 'corners'], ['Escanteios contra', 'cornersAgainst'], ['Escanteios totais', 'totalCorners'],
    ['Finalizações', 'shots'], ['Finalizações cedidas', 'shotsAgainst'],
    ['Chutes no gol', 'onTarget'], ['Chutes no gol cedidos', 'onTargetAgainst'],
    ['Gols no 1º tempo (total)', 'firstHalfGoals'],
    ['Gols marcados 1º tempo', 'firstHalfGoalsFor'], ['Gols sofridos 1º tempo', 'firstHalfGoalsAgainst'],
    ['Gols marcados 2º tempo', 'secondHalfGoalsFor'], ['Gols sofridos 2º tempo', 'secondHalfGoalsAgainst'],
    ['Cartões do time 1º tempo', 'firstHalfCards'], ['Cartões do time 2º tempo', 'secondHalfCards']
  ];
  const cell = (value) => value?.average == null ? '—' : `${value.average.toLocaleString('pt-BR', { maximumFractionDigits:2 })} <small>(${value.observed} jogos)</small>`;
  const gamesTable = (name, sample) => `<details class="stat-block"><summary><strong>Partidas de ${esc(name)} (${sample.matches})</strong></summary><div class="table-wrap"><table><thead><tr><th>Data</th><th>Local / adversário</th><th>Placar</th><th>Esc.</th><th>Cartões A/V</th><th>Chutes</th><th>No gol</th></tr></thead><tbody>${sample.games.map((game) => {
    const fmt = (v) => v == null ? '—' : String(v);
    return `<tr><td>${new Date(game.kickoff * 1000).toLocaleDateString('pt-BR', { timeZone:'UTC' })}</td><td>${game.venue === 'home' ? 'Casa' : 'Fora'} • ${esc(game.opponent)}</td><td>${fmt(game.for.goals)}–${fmt(game.against.goals)}</td><td>${fmt(game.for.corners)}–${fmt(game.against.corners)}</td><td>${fmt(game.for.yellow)}/${fmt(game.for.red)}</td><td>${fmt(game.for.shots)}–${fmt(game.against.shots)}</td><td>${fmt(game.for.onTarget)}–${fmt(game.against.onTarget)}</td></tr>`;
  }).join('')}</tbody></table></div></details>`;
  const last = Math.max(result.home.lastMatch, result.away.lastMatch) * 1000;
  const stale = Date.now() - last > 90 * 86400000;
  element.innerHTML = `<div class="panel comparison-head"><div><span class="eyebrow">FOOTYSTATS CSV • ${esc(result.home.season)}</span><h2>${esc(result.home.team)} × ${esc(result.away.team)}</h2>
    <p class="small muted">${esc(result.home.league.replace(/-/g, ' '))} • últimos jogos anteriores à data de corte, separados por local • médias por partida com quantidade de dados observados.</p>
    ${stale ? '<p class="small amber sample-warning">Temporada histórica: não use este recorte para estimar o jogo atual.</p>' : ''}
    ${home.matches < size || away.matches < size ? '<p class="small amber sample-warning">Amostra menor que o recorte escolhido em pelo menos um time/local.</p>' : ''}</div>
    <div class="comparison-controls"><div class="field"><label for="csvWindow">Recorte</label><select id="csvWindow"><option value="5" ${size === 5 ? 'selected' : ''}>Últimos 5</option><option value="10" ${size === 10 ? 'selected' : ''}>Últimos 10</option></select></div>
    <div class="field"><label for="csvVenue">Local</label><select id="csvVenue"><option value="match" ${venue === 'match' ? 'selected' : ''}>Mandante casa × visitante fora</option><option value="overall" ${venue === 'overall' ? 'selected' : ''}>Geral</option><option value="home" ${venue === 'home' ? 'selected' : ''}>Ambos em casa</option><option value="away" ${venue === 'away' ? 'selected' : ''}>Ambos fora</option></select></div></div></div>
    <article class="stat-block"><h3>${home.matches} jogos do mandante × ${away.matches} do visitante</h3><div class="table-wrap"><table class="comparison-table"><thead><tr><th>${esc(result.home.team)}</th><th>Média por jogo</th><th>${esc(result.away.team)}</th></tr></thead><tbody>
    ${labels.map(([label, key]) => `<tr><td class="team-stat">${cell(home[key])}</td><th>${label}</th><td class="team-stat">${cell(away[key])}</td></tr>`).join('')}
    </tbody></table></div><p class="missing-note">— Dado ausente no CSV. Finalizações e escanteios por tempo não constam desse arquivo.</p></article>
    <div class="stats-grid">${gamesTable(result.home.team, home)}${gamesTable(result.away.team, away)}</div>`;
  element.hidden = false;
  element.querySelector('#csvWindow').addEventListener('change', () => renderCsvComparison(result));
  element.querySelector('#csvVenue').addEventListener('change', () => renderCsvComparison(result));
}

$('#footyCsvCompare').addEventListener('click', async () => {
  const button = $('#footyCsvCompare');
  try {
    const [league, season] = $('#footyCsvSeason').value.split('|');
    const home = $('#footyCsvHome').value, away = $('#footyCsvAway').value;
    if (!league || !home || !away || home === away) throw new Error('Escolha a temporada e duas equipes diferentes.');
    const before = $('#footyCsvBefore').value ? new Date($('#footyCsvBefore').value).toISOString() : '';
    button.disabled = true;
    const result = await api(`/api/footy-csv/compare?${new URLSearchParams({ league, season, home, away, before })}`);
    renderCsvComparison(result);
    $('#footyCsvStatus').textContent = `Histórico ${season}: ${home} × ${away}.`;
    $('#footyCsvComparison').scrollIntoView({ behavior:'smooth', block:'start' });
  } catch (error) { $('#footyCsvStatus').textContent = error.message; }
  finally { button.disabled = false; }
});

Promise.all([api('/api/health'), loadSettings(), loadCsvSeasons()]).then(([health]) => { $('#health').textContent = health.status === 'ok' ? 'Sistema operacional' : 'Sistema indisponível'; loadMarkets(); loadHistory(); }).catch((error) => { $('#health').textContent = error.message; });
