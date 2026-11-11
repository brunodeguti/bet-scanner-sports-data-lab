// Market completeness must come from its definition, not the number of received quotes.
export function assertMarketIntegrity(market, { enforceFreshness = true, now = Date.now() } = {}) {
  const quotes = market.quotes ?? [];
  const received = [...new Set(quotes.map((quote) => quote.outcome))];
  let expected = market.expected_outcomes;
  if (typeof expected === 'string') expected = JSON.parse(expected);
  if (!Array.isArray(expected) || !expected.length) {
    const key = String(market.market_key).toLowerCase();
    if (/3way|1x2|oddspapi_h2h|match_winner/.test(key) || (key === 'h2h' && /futebol|football|soccer/i.test(market.sport))) {
      const [home, away] = String(market.event).split(' x ');
      expected = [home, 'Empate', away];
    } else if (/^total(?:_|$)/.test(key)) {
      const over = received.find((name) => /^(over|mais de)(?:\s|$)/i.test(name));
      const under = received.find((name) => /^(under|menos de)(?:\s|$)/i.test(name));
      if (over && under) expected = [over, under];
    }
  }
  const isThreeWay = /3way|1x2|oddspapi_h2h|match_winner/.test(String(market.market_key).toLowerCase()) ||
    (market.market_key === 'h2h' && /futebol|football|soccer/i.test(market.sport));
  if ((isThreeWay && expected?.length !== 3) || !Array.isArray(expected) || expected.length < 2 || expected.length > 3 ||
      received.length !== expected.length || !expected.every((outcome) => received.includes(outcome))) {
    throw new Error('Mercado incompleto ou sem definição dos resultados esperados. Informe expected_outcomes com todos os resultados exclusivos.');
  }
  // Historical synthetic scenarios remain reproducible. Real data, if inspected
  // through the library API, must satisfy the same time policy on every endpoint.
  if (enforceFreshness && !market.is_demo) {
    if (!Number.isFinite(Date.parse(market.starts_at)) || Date.parse(market.starts_at) <= now) {
      throw new Error('Partida iniciada ou data indisponível.');
    }
    if (quotes.some((quote) => {
      const time = Date.parse(quote.captured_at);
      return !Number.isFinite(time) || time > now + 60000 || now - time > 3600000;
    })) throw new Error('Cotação vencida ou sem horário válido (limite de 60 minutos).');
  }
  return expected;
}
