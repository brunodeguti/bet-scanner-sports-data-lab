const REQUIRED_FIELDS = ['sport', 'event', 'starts_at', 'market_key', 'outcome', 'bookmaker', 'odds'];

export function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('CSV vazio.');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (quoted) throw new Error('CSV inválido: aspas não fechadas.');
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (rows.length < 2) throw new Error('CSV precisa de cabeçalho e ao menos uma linha.');
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  return rows.slice(1).filter((values) => values.some((value) => value.trim())).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  );
}

function parseBoolean(value) {
  return ['1', 'true', 'sim', 'yes'].includes(String(value ?? '').trim().toLowerCase()) ? 1 : 0;
}

export function validateImportRows(input) {
  const rows = Array.isArray(input) ? input : input?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Envie um array não vazio em rows.');
  const errors = [];
  const normalized = [];

  rows.forEach((raw, index) => {
    const missing = REQUIRED_FIELDS.filter((field) => String(raw?.[field] ?? '').trim() === '');
    const odds = Number(raw?.odds);
    const probabilityRaw = String(raw?.estimated_probability ?? '').trim();
    const estimatedProbability = probabilityRaw === '' ? null : Number(probabilityRaw);
    const startsAt = new Date(raw?.starts_at);
    const capturedAt = raw?.captured_at ? new Date(raw.captured_at) : new Date();
    if (missing.length) errors.push(`Linha ${index + 1}: campos ausentes: ${missing.join(', ')}.`);
    if (!Number.isFinite(odds) || odds <= 1) errors.push(`Linha ${index + 1}: odds deve ser maior que 1.`);
    if (probabilityRaw !== '' && (!Number.isFinite(estimatedProbability) || estimatedProbability <= 0 || estimatedProbability >= 1)) {
      errors.push(`Linha ${index + 1}: estimated_probability deve estar entre 0 e 1.`);
    }
    if (Number.isNaN(startsAt.getTime())) errors.push(`Linha ${index + 1}: starts_at inválido.`);
    if (Number.isNaN(capturedAt.getTime())) errors.push(`Linha ${index + 1}: captured_at inválido.`);
    let expectedOutcomes = raw?.expected_outcomes ?? null;
    if (typeof expectedOutcomes === 'string' && expectedOutcomes.trim()) {
      try { expectedOutcomes = JSON.parse(expectedOutcomes); }
      catch { errors.push(`Linha ${index + 1}: expected_outcomes deve ser um array JSON.`); }
    }
    if (expectedOutcomes != null && expectedOutcomes !== '' &&
        (!Array.isArray(expectedOutcomes) || ![2, 3].includes(expectedOutcomes.length) ||
         expectedOutcomes.some((item) => typeof item !== 'string' || !item.trim()) ||
         new Set(expectedOutcomes).size !== expectedOutcomes.length)) {
      errors.push(`Linha ${index + 1}: informe 2 ou 3 resultados distintos em expected_outcomes.`);
    }
    normalized.push({
      expected_outcomes:Array.isArray(expectedOutcomes) ? JSON.stringify(expectedOutcomes) : null,
      sport: String(raw?.sport ?? '').trim(),
      league: String(raw?.league ?? '').trim(),
      event: String(raw?.event ?? '').trim(),
      starts_at: Number.isNaN(startsAt.getTime()) ? '' : startsAt.toISOString(),
      market_key: String(raw?.market_key ?? '').trim(),
      market_name: String(raw?.market_name ?? raw?.market_key ?? '').trim(),
      outcome: String(raw?.outcome ?? '').trim(),
      bookmaker: String(raw?.bookmaker ?? '').trim(),
      odds,
      is_reference: parseBoolean(raw?.is_reference),
      estimated_probability: estimatedProbability,
      captured_at: Number.isNaN(capturedAt.getTime()) ? '' : capturedAt.toISOString(),
      source: String(raw?.source ?? 'manual').trim() || 'manual',
      is_demo: parseBoolean(raw?.is_demo)
    });
  });
  if (errors.length) {
    const error = new Error('Falha de validação na importação.');
    error.details = errors;
    throw error;
  }
  return normalized;
}
