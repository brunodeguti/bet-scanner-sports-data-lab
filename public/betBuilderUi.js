const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
const pct = (value) => `${(value * 100).toFixed(1).replace('.', ',')}%`;
let activeSlip = null, offers = [], seasons = [];

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function status(message) { $('#builderStatus').textContent = message; }
function queryDate(value) { return value ? new Date(value).toISOString() : ''; }
const metricLabels = {
  goals:'gols FT', firstHalfGoals:'gols 1º tempo', secondHalfGoals:'gols 2º tempo',
  corners:'escanteios FT', yellow:'cartões amarelos', red:'cartões vermelhos', cardsTotal:'cartões totais',
  firstHalfCards:'cartões 1º tempo', secondHalfCards:'cartões 2º tempo', shots:'finalizações FT', onTarget:'chutes no gol FT'
};

async function loadSeasons(prefer = '') {
  seasons = await api('/api/footy-csv/seasons');
  $('#builderSeason').innerHTML = '<option value="">Escolha a temporada</option>' + seasons.map((row) =>
    `<option value="${esc(`${row.league}|${row.season}`)}">${esc(row.league.replace(/-/g, ' '))} • ${esc(row.season)} (${row.matches} jogos)</option>`).join('');
  $('#builderSeason').value = prefer || (seasons.length ? `${seasons[0].league}|${seasons[0].season}` : '');
  await loadTeams();
}

async function loadTeams() {
  const [league, season] = $('#builderSeason').value.split('|');
  const teams = league ? await api(`/api/footy-csv/teams?${new URLSearchParams({ league, season })}`) : [];
  const options = '<option value="">Selecione</option>' + teams.map((team) => `<option value="${esc(team)}">${esc(team)}</option>`).join('');
  $('#builderHome').innerHTML = options;
  $('#builderAway').innerHTML = options;
}

function updateMarketFields() {
  const market = $('#builderMarket').value;
  const subject = $('#builderSubject');
  $('#builderMetric').closest('.field').hidden = market !== 'total';
  subject.closest('.field').hidden = !['total', 'asian_handicap'].includes(market);
  $('#builderPick').closest('.field').hidden = ['asian_handicap', 'custom'].includes(market);
  $('#builderLine').closest('.field').hidden = !['total', 'asian_handicap', 'european_handicap'].includes(market);
  if (market === 'asian_handicap' && subject.value === 'match') subject.value = 'home';
  const picks = market === 'total' ? [['over', 'Mais de'], ['under', 'Menos de']]
    : market === 'result' || market === 'european_handicap' ? [['home', 'Mandante'], ['draw', 'Empate'], ['away', 'Visitante']]
      : market === 'double_chance' ? [['1x', '1X'], ['x2', 'X2'], ['12', '12']]
        : market === 'btts' ? [['yes', 'Sim'], ['no', 'Não']] : [];
  $('#builderPick').innerHTML = picks.map(([value, name]) => `<option value="${value}">${name}</option>`).join('');
  if (market === 'asian_handicap') subject.querySelector('option[value="match"]').hidden = true;
  else subject.querySelector('option[value="match"]').hidden = false;
  fillQuotes();
}

function candidate(offer) {
  const market = $('#builderMarket').value, metric = $('#builderMetric').value;
  if (market === 'custom' || /secondHalf/.test(metric) || offer.playerName || offer.playerProp) return false;
  const category = offer.category;
  const chosen = market === 'total' ? {
    goals:'Gols', firstHalfGoals:'Gols', secondHalfGoals:'Gols',
    corners:'Escanteios', yellow:'Cartões', red:'Cartões', cardsTotal:'Cartões',
    firstHalfCards:'Cartões', secondHalfCards:'Cartões', shots:'Finalizações', onTarget:'Chutes no gol'
  }[metric] : market === 'btts' ? 'Gols' : ['result', 'double_chance'].includes(market) ? 'Resultado' : 'Handicap';
  if (category !== chosen) return false;
  const selected = market === 'asian_handicap' ? ($('#builderSubject').value === 'home' ? '1' : '2')
    : $('#builderPick').value === 'home' ? '1' : $('#builderPick').value === 'away' ? '2'
      : $('#builderPick').value === 'draw' ? 'x' : $('#builderPick').value;
  if (offer.outcome.toLowerCase() !== selected) return false;
  const wantsHalf = /firstHalf/.test(metric);
  if (market === 'total' && !(/firsthalf|first half|p1/i.test(offer.period) === wantsHalf)) return false;
  const needsLine = ['total', 'asian_handicap', 'european_handicap'].includes(market);
  const found = /^([+-]?\d+(?:\.\d+)?)(?:\/|$)/.exec(offer.line);
  if (needsLine && (!found || Number(found[1]) !== Number($('#builderLine').value))) return false;
  return true;
}

function fillQuotes() {
  const select = $('#builderQuote');
  select.innerHTML = '<option value="">Sem cotação vinculada</option>' + offers.flatMap((offer, index) => candidate(offer)
    ? [`<option value="${index}">${esc(`${offer.marketName} • ${offer.period} • ${offer.outcome} ${offer.line} • ${offer.bookmaker} @${offer.price.toFixed(2)}`)}</option>`]
    : []).join('');
}

async function loadSlips(prefer = activeSlip) {
  const slips = await api('/api/bet-slips');
  $('#builderSlip').innerHTML = '<option value="">Escolha um bilhete</option>' + slips.map((slip) =>
    `<option value="${slip.id}">#${slip.id} • ${esc(slip.home_team)} × ${esc(slip.away_team)} • ${slip.legs.length} seleções</option>`).join('');
  activeSlip = slips.some((slip) => slip.id === Number(prefer)) ? Number(prefer) : null;
  $('#builderSlip').value = String(activeSlip ?? '');
  $('#builderLegForm').hidden = !activeSlip;
  if (activeSlip) await analyzeSlip();
  else $('#builderResults').innerHTML = '';
}

function legName(leg) {
  if (leg.label) return leg.label;
  if (leg.market === 'total') return `${leg.subject === 'match' ? 'Partida' : leg.subject === 'home' ? 'Mandante' : 'Visitante'} • ${metricLabels[leg.metric]} • ${leg.pick === 'over' ? 'mais' : 'menos'} de ${leg.line}`;
  if (leg.market === 'asian_handicap') return `HA ${leg.subject === 'home' ? 'mandante' : 'visitante'} ${leg.line >= 0 ? '+' : ''}${leg.line}`;
  if (leg.market === 'european_handicap') return `HE mandante ${leg.line >= 0 ? '+' : ''}${leg.line} • ${leg.pick}`;
  return `${leg.market.replace(/_/g, ' ')} • ${leg.pick}`;
}

function rates(sample) {
  const c = sample.counts;
  return `${c.green} green / ${c.half_green} meio green / ${c.push} push / ${c.half_red} meio red / ${c.red} red • ${c.observed}/${c.total} com dados`;
}

function gameDetail(side, evidence, title) {
  return `<details class="builder-evidence"><summary>${esc(title)} • ${rates(evidence.last10)}</summary>
    <p class="small muted">Últimos 5 no local: ${rates(evidence.last5)}<br>Geral últimos 5: ${rates(evidence.general5)}<br>Geral últimos 10: ${rates(evidence.general10)}</p>
    <div class="table-wrap"><table><thead><tr><th>Data</th><th>Jogo</th><th>Dado</th><th>Resultado</th></tr></thead><tbody>
    ${evidence.last10.games.map((game) => `<tr><td>${new Date(game.kickoff * 1000).toLocaleDateString('pt-BR', { timeZone:'UTC' })}</td><td>${esc(game.home)} × ${esc(game.away)}</td><td>${esc(game.value == null ? '—' : typeof game.value === 'object' ? `${game.value.home}–${game.value.away}` : game.value)}</td><td>${esc(game.result)}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

function renderAnalysis(data) {
  const labels = { frequencia_alta:'Frequência alta na amostra', frequencia_baixa:'Perna frágil na amostra', intermediaria:'Frequência intermediária', sem_base:'Sem base suficiente' };
  const warnings = data.correlations.map((pair) => `<li>Seleções #${pair.firstId} e #${pair.secondId}: ${esc(pair.reason)}</li>`).join('');
  $('#builderResults').innerHTML = `<div class="builder-heading"><h3>Bilhete #${data.id}: ${esc(data.home_team)} × ${esc(data.away_team)}</h3><button id="builderAnalyze" type="button">Atualizar análise</button></div>
    <p class="small muted">${esc(data.league)} • ${esc(data.season)} • ${new Date(data.kickoff).toLocaleString('pt-BR')} • ${data.legs.length} seleções. Probabilidades abaixo são frequências empíricas, condicionadas à amostra usada.</p>
    ${data.oddsWarning ? `<p class="sample-warning">${esc(data.oddsWarning)}</p>` : ''}
    ${data.legs.map((leg) => `<article class="stat-block builder-leg"><div class="builder-heading"><h3>#${leg.id} ${esc(legName(leg))}</h3><button type="button" data-delete-leg="${leg.id}">Remover</button></div>
      <p><strong>${esc(labels[leg.strength])}</strong> • amostra combinada: ${rates({ counts:leg.pooled })}.</p>
      ${leg.reason ? `<p class="sample-warning">${esc(leg.reason)}</p>` : ''}
      ${leg.fairOddsReason ? `<p class="sample-warning">${esc(leg.fairOddsReason)}</p>` : ''}
      ${leg.probability ? `<p>Chance empírica de green: <strong>${pct(leg.probability.green)}</strong>${leg.probability.half_green ? ` • meio green: ${pct(leg.probability.half_green)}` : ''} • push: ${pct(leg.probability.push)} • red: ${pct(leg.probability.red)}${leg.probability.half_red ? ` • meio red: ${pct(leg.probability.half_red)}` : ''} • odd justa empírica: <strong>${leg.fairOdds == null ? '—' : Number(leg.fairOdds).toFixed(2)}</strong></p>` : '<p>Probabilidade, odd justa e EV: indisponíveis.</p>'}
      ${leg.quote ? `<p>OddsPapi • ${esc(leg.quote.bookmaker)} • ${esc(leg.quote.market)} • @${Number(leg.quote.price).toFixed(2)} • cotada em ${new Date(leg.quote.changedAt).toLocaleString('pt-BR')}${leg.evPct == null ? '' : ` • EV empírico: <strong>${Number(leg.evPct).toFixed(2)}%</strong>`}</p>` : ''}
      ${leg.quoteStatus ? `<p class="sample-warning">Cotação: ${esc(leg.quoteStatus)}</p>` : ''}
      <div class="builder-evidence-grid">${gameDetail('home', leg.evidence.home, `${data.home_team} em casa`)}${gameDetail('away', leg.evidence.away, `${data.away_team} fora`)}</div>
    </article>`).join('')}
    ${data.legs.length > 1 ? `<div class="sample-warning"><strong>Dependência entre seleções</strong>${warnings ? `<ul>${warnings}</ul>` : '<p>Nenhuma relação direta foi identificada pelas regras disponíveis; a correlação ainda não foi medida.</p>'}<p>Probabilidades individuais não são multiplicadas para prever o bilhete.</p></div>` : ''}`;
  $('#builderAnalyze').addEventListener('click', analyzeSlip);
  $('#builderResults').querySelectorAll('[data-delete-leg]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/bet-slips/${activeSlip}/legs/${button.dataset.deleteLeg}`, { method:'DELETE' });
      await loadSlips();
      status('Seleção removida.');
    } catch (error) { status(error.message); }
  }));
}

async function analyzeSlip() {
  if (!activeSlip) return;
  try { renderAnalysis(await api(`/api/bet-slips/${activeSlip}/analyze`)); }
  catch (error) { status(error.message); }
}

$('#builderSeason').addEventListener('change', loadTeams);
$('#builderMarket').addEventListener('change', updateMarketFields);
for (const id of ['builderMetric', 'builderSubject', 'builderPick', 'builderLine']) $(`#${id}`).addEventListener('change', fillQuotes);
$('#builderSlip').addEventListener('change', async () => {
  activeSlip = Number($('#builderSlip').value) || null;
  offers = []; fillQuotes();
  $('#builderLegForm').hidden = !activeSlip;
  if (activeSlip) await analyzeSlip(); else $('#builderResults').innerHTML = '';
});

$('#builderCreate').addEventListener('click', async () => {
  try {
    const [league, season] = $('#builderSeason').value.split('|');
    const body = { league, season, home:$('#builderHome').value, away:$('#builderAway').value,
      kickoff:queryDate($('#builderKickoff').value), fixtureId:$('#builderFixtureId').value };
    const slip = await api('/api/bet-slips', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    await loadSlips(slip.id);
    offers = []; fillQuotes();
    status(`Bilhete #${slip.id} criado. Cadastre cada seleção abaixo.`);
  } catch (error) { status(error.message); }
});

$('#builderDeleteSlip').addEventListener('click', async () => {
  if (!activeSlip) return;
  try {
    await api(`/api/bet-slips/${activeSlip}`, { method:'DELETE' });
    activeSlip = null; offers = []; fillQuotes();
    await loadSlips(); status('Bilhete excluído.');
  } catch (error) { status(error.message); }
});

$('#builderFetchQuotes').addEventListener('click', async () => {
  try {
    if (!activeSlip) throw new Error('Abra um bilhete primeiro.');
    status('Consultando cotações da partida na OddsPapi…');
    const summary = await api(`/api/bet-slips/${activeSlip}/quotes`);
    offers = summary.books.filter((book) => book.active).flatMap((book) => book.markets.filter((market) => market.active)
      .flatMap((market) => market.offers.filter((offer) => offer.active).map((offer) => ({
        bookmaker:book.slug, marketId:market.id, marketName:market.name, category:market.category,
        playerProp:market.playerProp, period:market.period, outcomeId:offer.outcomeId, outcome:offer.outcome,
        line:String(offer.line ?? ''), playerName:offer.playerName, price:offer.price
      }))));
    fillQuotes();
    status(`${offers.length} ofertas ativas encontradas na OddsPapi para esta partida. Selecione a linha correspondente.`);
  } catch (error) { status(error.message); }
});

$('#builderAddLeg').addEventListener('click', async () => {
  try {
    if (!activeSlip) throw new Error('Crie ou abra um bilhete primeiro.');
    const offer = offers[Number($('#builderQuote').value)];
    const body = {
      market:$('#builderMarket').value, metric:$('#builderMetric').value, subject:$('#builderSubject').value,
      pick:$('#builderPick').value, line:$('#builderLine').value, label:$('#builderLabel').value,
      quoteRef:$('#builderQuote').value === '' ? null : {
        bookmaker:offer.bookmaker, marketId:offer.marketId, outcomeId:offer.outcomeId,
        line:offer.line, playerName:offer.playerName ?? ''
      }
    };
    await api(`/api/bet-slips/${activeSlip}/legs`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    $('#builderLabel').value = '';
    await loadSlips();
    status('Seleção salva. Confira a amostra e os avisos abaixo.');
  } catch (error) { status(error.message); }
});

window.addEventListener('bet-fixture-selected', async (event) => {
  const fixture = event.detail;
  $('#builderProvider').open = true;
  $('#builderFixtureId').value = fixture.fixtureId ?? '';
  const local = new Date(fixture.startsAt);
  if (Number.isFinite(local.getTime())) {
    const adjusted = new Date(local.getTime() - local.getTimezoneOffset() * 60000);
    $('#builderKickoff').value = adjusted.toISOString().slice(0, 16);
  }
  const clean = (name) => String(name ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const league = clean(fixture.league);
  const match = league.length >= 5 && seasons.find((row) => row.season.includes(String(local.getFullYear())) && clean(row.league).includes(league.slice(0, 5)));
  if (match) { $('#builderSeason').value = `${match.league}|${match.season}`; await loadTeams(); }
  for (const [selector, name] of [['#builderHome', fixture.home], ['#builderAway', fixture.away]]) {
    const option = [...$(selector).options].find((item) => clean(item.value) === clean(name));
    if (option) $(selector).value = option.value;
  }
  $('#builderProvider').scrollIntoView({ behavior:'smooth', block:'start' });
});
window.addEventListener('footy-csv-imported', () => loadSeasons().catch((error) => status(error.message)));

updateMarketFields();
Promise.all([loadSeasons(), loadSlips()]).catch((error) => status(error.message));
