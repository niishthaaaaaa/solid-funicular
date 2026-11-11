/* Thin clients for the model providers.
   Keys are read from the environment only. They are never taken from a request,
   never returned to the browser and never written into a report. */

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const MODEL = {
  gemini: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  claude: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  perplexity: process.env.PERPLEXITY_MODEL || 'sonar',
};

export const has = name => Boolean(process.env[name] && process.env[name].trim());

function key(name) {
  if (!has(name)) throw new AppError(503, name + ' is not set. Copy .env.example to .env and fill it in.');
  return process.env[name].trim();
}

export const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/* One place for every outbound call, so a provider outage reads the same
   whichever provider it was. */
async function call(label, url, init) {
  let r;
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(Number(process.env.TIMEOUT_MS) || 120000) });
  } catch (e) {
    throw new AppError(502, label + ' did not respond: ' + e.message);
  }
  const body = await r.text();
  if (!r.ok) throw new AppError(502, label + ' returned ' + r.status + ': ' + body.slice(0, 300));
  try { return JSON.parse(body); }
  catch { throw new AppError(502, label + ' returned a body that is not JSON'); }
}

/* ---------- Gemini: reads media, and stands in for the other two ---------- */

export async function gemini(parts, { system, json, search } = {}) {
  const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  /* Structured output and the search tool cannot be requested together, so the
     callers that need citations parse prose instead. */
  if (json && !search) body.generationConfig.responseMimeType = 'application/json';
  if (search) body.tools = [{ google_search: {} }];

  const d = await call('Gemini',
    'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL.gemini + ':generateContent',
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key('GEMINI_API_KEY') }, body: JSON.stringify(body) });

  const cand = (d.candidates || [])[0];
  const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text).filter(Boolean).join('\n').trim();
  const chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const sources = chunks.map(c => c.web && { title: c.web.title || hostOf(c.web.uri), url: c.web.uri }).filter(Boolean);
  if (!text) throw new AppError(502, 'Gemini returned no text (finish reason: ' + ((cand && cand.finishReason) || 'unknown') + ')');
  return { text, sources };
}

/* ---------- Claude: the judge ---------- */

export async function claude(system, user, { max = 2000 } = {}) {
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const d = await call('Claude', base + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL.claude, max_tokens: max, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
  });
  const text = (d.content || []).map(b => b.text).filter(Boolean).join('\n').trim();
  if (!text) throw new AppError(502, 'Claude returned no text');
  return { text, sources: [] };
}

/* ---------- Perplexity: the researcher ---------- */

export async function perplexity(query) {
  const d = await call('Perplexity', 'https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key('PERPLEXITY_API_KEY') },
    body: JSON.stringify({ model: MODEL.perplexity, temperature: 0, messages: [{ role: 'user', content: query }] }),
  });
  const text = (((d.choices || [])[0] || {}).message || {}).content || '';
  const raw = d.citations || d.search_results || [];
  const sources = raw.map(c => typeof c === 'string'
    ? { title: hostOf(c), url: c }
    : { title: c.title || hostOf(c.url), url: c.url }).filter(s => s.url);
  return { text: text.trim(), sources };
}

/* ---------- Google Fact Check Tools: free, and the only check here that
     returns someone else's published verdict rather than our own ---------- */

export async function factCheck(query) {
  const k = (process.env.FACTCHECK_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!k) return [];
  const u = new URL('https://factchecktools.googleapis.com/v1alpha1/claims:search');
  u.searchParams.set('query', query.slice(0, 200));
  u.searchParams.set('pageSize', '5');
  u.searchParams.set('key', k);
  try {
    const d = await call('Fact Check Tools', u.toString(), {});
    return (d.claims || []).flatMap(c => (c.claimReview || []).map(r => ({
      claim: c.text,
      claimant: c.claimant || '',
      rating: (r.textualRating || '').trim(),
      publisher: (r.publisher && r.publisher.name) || hostOf(r.url || ''),
      url: r.url || '',
      date: (r.reviewDate || '').slice(0, 10),
    })));
  } catch (e) {
    /* A bonus check, so it never fails the run. It does say so on the console
       though, otherwise a wrong key looks exactly like "no fact checks found". */
    console.warn('[fact check] skipped: ' + e.message);
    return [];
  }
}

/* ---------- role routing: use the best provider present ---------- */

/* A key the provider refuses outright is worse than no key, because it takes
   down a run that a configured fallback could have handled. So an auth failure
   retires that provider for the life of the process and the next one takes
   over. Only auth failures: a timeout or a 500 is surfaced, since silently
   swapping providers on a transient error would hide a real outage. */
const RETIRED = new Set();

const isAuthFailure = e =>
  /\b(401|403)\b/.test(e.message)
  && /auth|api[-_ ]?key|credential|unauthor|permission|token/i.test(e.message);

async function withFallback(role, primary, name, fallback) {
  if (primary && !RETIRED.has(name)) {
    try { return await primary(); }
    catch (e) {
      if (!isAuthFailure(e) || !fallback) throw e;
      RETIRED.add(name);
      console.warn('[' + role + '] ' + name + ' rejected its key, so it is retired for this run. '
        + 'Falling back to Gemini. Fix or comment out the key to skip this call entirely.');
      console.warn('[' + role + '] ' + e.message.slice(0, 160));
    }
  }
  if (fallback) return fallback();
  throw new AppError(503, 'No ' + role + ' provider is configured.');
}

export async function research(query) {
  if (!has('PERPLEXITY_API_KEY') && !has('GEMINI_API_KEY')) {
    throw new AppError(503, 'No research provider. Set PERPLEXITY_API_KEY or GEMINI_API_KEY.');
  }
  return withFallback('research',
    has('PERPLEXITY_API_KEY') ? () => perplexity(query) : null, 'Perplexity',
    has('GEMINI_API_KEY') ? () => gemini([{ text: query }], { search: true }) : null);
}

export async function judge(system, user, opts) {
  if (!has('ANTHROPIC_API_KEY') && !has('GEMINI_API_KEY')) {
    throw new AppError(503, 'No judge provider. Set ANTHROPIC_API_KEY or GEMINI_API_KEY.');
  }
  return withFallback('judge',
    has('ANTHROPIC_API_KEY') ? () => claude(system, user, opts) : null, 'Claude',
    has('GEMINI_API_KEY') ? () => gemini([{ text: user }], { system, json: true }) : null);
}

export const capabilities = () => ({
  reader: has('GEMINI_API_KEY') ? 'gemini' : null,
  researcher: has('PERPLEXITY_API_KEY') ? 'perplexity' : has('GEMINI_API_KEY') ? 'gemini' : null,
  judge: has('ANTHROPIC_API_KEY') ? 'claude' : has('GEMINI_API_KEY') ? 'gemini' : null,
  factcheck: Boolean(process.env.FACTCHECK_API_KEY || process.env.GOOGLE_API_KEY),
  models: MODEL,
});
