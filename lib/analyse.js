/* The claim pipeline: text in, a verdict per claim out.

   Retrieval and judgement are deliberately separate calls. The researcher
   gathers evidence without being told what we hope it says, and the judge
   rules only on what came back. That split is what makes a verdict auditable,
   and it is why every verdict carries the sources it was based on. */

import { research, judge, factCheck } from './providers.js';

const CLAIM_LIMIT = Math.max(1, Math.min(30, Number(process.env.CLAIM_LIMIT) || 12));
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.CONCURRENCY) || 3));
const CLAIM_INPUT_CHARS = 60000;

const VERDICTS = ['supported', 'contradicted', 'unverified'];

/* Models wrap JSON in prose or code fences often enough that this is cheaper
   than retrying the call. */
function parseJson(raw, fallback) {
  let s = String(raw || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* fall through to bracket matching */ }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const a = s.indexOf(open), b = s.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch { /* keep trying */ }
    }
  }
  return fallback;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/* ---------- step 1: what in here can actually be checked ---------- */

const CLAIM_SYSTEM = `You pull checkable factual claims out of a document.

A claim qualifies only if a researcher could confirm or refute it against public sources. Include statements of fact, figures, dates, events, and statements attributed to a named person or organisation.

Exclude opinions, predictions, recommendations, questions, instructions, hypotheticals, and generic marketing language. A negative opinion is not a claim. "The service was slow" is an opinion. "The service was down for six hours on 3 March" is a claim.

Rewrite each claim as one standalone sentence. Resolve every pronoun and vague reference, so the claim can be understood with no other context. Keep names, numbers, dates and organisations exactly as the document states them. Do not correct them, and do not add anything the document does not say.

Also give "quote": the exact run of text from the document that the claim came from, copied character for character. Do not paraphrase it, do not fix its spelling, do not resolve its pronouns, and do not add or remove words. It is used to find the claim's position in the original document, so it has to match. Keep it to the sentence or clause carrying the claim rather than a whole paragraph.

Order them by how much damage the claim would do if it were false.

Reply with JSON only, in this shape:
{"claims":[{"text":"...","quote":"...","type":"factual|attributed|statistic","attributed_to":"name or empty string"}]}

Return an empty array if the document makes no checkable claims.`;

export async function findClaims(text, limit = CLAIM_LIMIT) {
  const body = text.slice(0, CLAIM_INPUT_CHARS);
  const truncated = text.length > CLAIM_INPUT_CHARS;
  const { text: raw } = await judge(
    CLAIM_SYSTEM,
    'Return at most ' + limit + ' claims from the document below.\n\n--- DOCUMENT ---\n' + body,
    { max: 2000 },
  );
  const parsed = parseJson(raw, { claims: [] });
  const claims = (Array.isArray(parsed) ? parsed : parsed.claims || [])
    .map(c => (typeof c === 'string' ? { text: c } : c))
    .filter(c => c && typeof c.text === 'string' && c.text.trim().length > 12)
    .slice(0, limit)
    .map((c, i) => ({
      id: i + 1,
      text: c.text.trim(),
      quote: typeof c.quote === 'string' ? c.quote.trim() : '',
      type: ['factual', 'attributed', 'statistic'].includes(c.type) ? c.type : 'factual',
      attributed_to: typeof c.attributed_to === 'string' ? c.attributed_to.trim() : '',
    }));
  return { claims, truncated };
}

/* ---------- locating a claim back in the document ----------

   Claims are rewritten into standalone sentences, so they never match the
   source verbatim. The quote does, in theory. In practice a model will often
   normalise whitespace while copying, so an exact search is tried first and a
   whitespace-insensitive search second, carrying an index map so the offsets
   it returns still point into the original string. */

function locate(text, quote) {
  if (!quote || quote.length < 10) return null;

  const exact = text.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };

  const map = [];
  let flat = '';
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (flat.endsWith(' ')) continue;
      flat += ' ';
    } else {
      flat += text[i];
    }
    map.push(i);
  }

  const needle = quote.replace(/\s+/g, ' ').trim();
  const at = flat.indexOf(needle);
  if (at < 0 || needle.length < 10) return null;
  const last = map[at + needle.length - 1];
  return { start: map[at], end: (last === undefined ? text.length - 1 : last) + 1 };
}

/* Marks cannot nest, so overlapping quotes have to compete. Shortest wins:
   a model will often quote a whole opening sentence for one claim and a precise
   clause inside it for another, and the clause is the more useful highlight.
   Taking shortest first also tends to fit more claims onto the page. */
export function spansFor(text, claims) {
  const found = claims
    .map(c => {
      const at = locate(text, c.quote);
      return at && { ...at, verdict: c.verdict, claimId: c.id };
    })
    .filter(Boolean)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start) || a.start - b.start);

  const kept = [];
  for (const s of found) {
    if (!kept.some(k => s.start < k.end && k.start < s.end)) kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/* ---------- step 2: evidence, then a ruling on that evidence ---------- */

const JUDGE_SYSTEM = `You rule on one claim, using only the evidence supplied. You have no other knowledge to draw on and must not assume facts that the evidence does not state.

Choose exactly one verdict:

"supported" - independent published sources state this. The source of the claim repeating itself does not count.
"contradicted" - reliable sources state the opposite, or a specific figure, date, quote or attribution in the claim is demonstrably wrong.
"unverified" - the evidence does not settle it. Use this when nothing relevant was found, when the only source is the claim's own author, when sources are paywalled or inaccessible, or when the event is too recent to be covered.

"unverified" is not a polite way of saying false. Use it whenever evidence is absent rather than contrary. A claim nobody has written about is unverified, not contradicted.

Cite sources by their number. Cite only sources that genuinely bear on the claim.

Reply with JSON only:
{"verdict":"supported|contradicted|unverified","confidence":"low|medium|high","reasoning":"at most two sentences","sources":[1,2]}`;

async function verifyClaim(claim) {
  const base = { ...claim, verdict: 'unverified', confidence: 'low', reasoning: '', sources: [], factChecks: [], error: null };

  let evidence = { text: '', sources: [] };
  let checks = [];
  try {
    [evidence, checks] = await Promise.all([
      research(
        'Research this claim and report what published sources say about it. '
        + 'Give evidence that supports it and evidence that contradicts it. '
        /* Without this the researcher happily returns the subject's own website,
           and the judge then rules "unverified" on facts that are not in doubt,
           because a company is not an independent source about itself. */
        + 'Prioritise independent sources: news organisations, regulators, court and exchange filings, '
        + 'academic work and reference works. Only cite the website of the person or company the claim '
        + 'is about if you also give at least one independent source alongside it. '
        + 'If you cannot find relevant sources, say so plainly rather than guessing.\n\nClaim: ' + claim.text,
      ),
      factCheck(claim.text),
    ]);
  } catch (e) {
    return { ...base, reasoning: 'Research failed, so this claim was not checked.', error: e.message };
  }

  const numbered = evidence.sources.map((s, i) => '[' + (i + 1) + '] ' + (s.title || '') + ' - ' + s.url).join('\n');
  const priorBlock = checks.length
    ? '\n\n--- PUBLISHED FACT CHECKS ---\n' + checks.map(c =>
      c.publisher + ' rated "' + c.claim + '" as: ' + c.rating + (c.date ? ' (' + c.date + ')' : '') + ' ' + c.url).join('\n')
    : '';

  let ruling;
  try {
    const { text: raw } = await judge(
      JUDGE_SYSTEM,
      'CLAIM: ' + claim.text
      + (claim.attributed_to ? '\nATTRIBUTED TO: ' + claim.attributed_to : '')
      + '\n\n--- RESEARCH FINDINGS ---\n' + (evidence.text || '(nothing returned)')
      + (numbered ? '\n\n--- SOURCES ---\n' + numbered : '\n\n--- SOURCES ---\n(none)')
      + priorBlock,
      { max: 700 },
    );
    ruling = parseJson(raw, null);
  } catch (e) {
    return { ...base, sources: evidence.sources, factChecks: checks, reasoning: 'Judgement failed.', error: e.message };
  }

  if (!ruling || !VERDICTS.includes(ruling.verdict)) {
    return { ...base, sources: evidence.sources, factChecks: checks, reasoning: 'The judge returned an unusable response, so this claim is left unverified.' };
  }

  const picked = Array.isArray(ruling.sources)
    ? ruling.sources.map(n => evidence.sources[Number(n) - 1]).filter(Boolean)
    : [];

  return {
    ...base,
    verdict: ruling.verdict,
    confidence: ['low', 'medium', 'high'].includes(ruling.confidence) ? ruling.confidence : 'low',
    reasoning: String(ruling.reasoning || '').trim(),
    sources: picked.length ? picked : evidence.sources.slice(0, 3),
    factChecks: checks,
  };
}

/* ---------- step 3: a count, not a probability ---------- */

export function tally(results) {
  const n = k => results.filter(r => r.verdict === k).length;
  const supported = n('supported'), contradicted = n('contradicted'), unverified = n('unverified');
  const total = results.length;

  /* Deliberately a label rather than a percentage dressed up as one. The
     headline a reader should take away is the counts and the claim table. */
  const band = total === 0 ? 'Nothing checkable'
    : contradicted > 0 ? 'Contains contradicted claims'
      : unverified >= total / 2 ? 'Largely unverified'
        : 'Mostly corroborated';

  return {
    total, supported, contradicted, unverified, band,
    corroborated_share: total ? Math.round((supported / total) * 100) : null,
    caveat: 'This counts how many claims were corroborated against sources we could reach. '
      + 'It is not a probability that the content is fake. Unverified means no evidence was found either way.',
  };
}

export async function analyse(text, { limit = CLAIM_LIMIT } = {}) {
  /* Spans are offsets into this exact string, so the caller must display the
     same slice it passed in or the highlights will land in the wrong place. */
  const body = text.slice(0, CLAIM_INPUT_CHARS);
  const { claims, truncated } = await findClaims(text, limit);
  if (!claims.length) {
    return {
      claims: [], score: tally([]), spans: [], body, truncated,
      note: 'No checkable factual claims were found. The text may be opinion, commentary or too short.',
    };
  }
  const results = await mapLimit(claims, CONCURRENCY, verifyClaim);
  return { claims: results, score: tally(results), spans: spansFor(body, results), body, truncated, note: null };
}
