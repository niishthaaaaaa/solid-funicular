/* The service itself, with no HTTP server wrapped around it.

   Locally this runs inside server.js. On Vercel there is no long-lived server
   to run inside, so each request gets its own function and both entry points
   call the same two functions here. Nothing in this file knows which it is. */

import { createHash, timingSafeEqual } from 'node:crypto';
import { extract } from './extract.js';
import { provenance } from './provenance.js';
import { analyse } from './analyse.js';
import { capabilities, AppError } from './providers.js';

/* A request body on Vercel cannot exceed 4.5 MB on any plan, and base64
   inflates a file by a third on the way up, so a hosted deployment has to stop
   the upload well before the 18 MB that Gemini itself would accept. Running
   locally there is no such ceiling. */
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB)
  || (process.env.VERCEL ? 3 : 18);

/* Set ACCESS_PASSWORD and the service will only run for someone who knows it.
   Left unset the service is open, which is right on localhost and a decision
   worth making deliberately anywhere else: every run spends real API credit,
   and the keys being spent are the operator's. */
const PASSWORD = (process.env.ACCESS_PASSWORD || '').trim();

export const locked = () => Boolean(PASSWORD);

/* Hashing both sides first means the comparison runs over two fixed-length
   buffers, so neither the password's length nor how far a guess got before it
   diverged can be read off the time the check took. */
const digest = s => createHash('sha256').update(String(s == null ? '' : s).trim()).digest();

export const allowed = supplied => !PASSWORD || timingSafeEqual(digest(supplied), digest(PASSWORD));

export function guard(supplied) {
  if (!allowed(supplied)) throw new AppError(401, 'Wrong password.');
}

export function health(supplied) {
  const caps = capabilities();
  return {
    ok: Boolean(caps.researcher && caps.judge),
    ...caps,
    hosted: Boolean(process.env.VERCEL),
    locked: locked(),
    authed: allowed(supplied),
    max_upload_mb: MAX_UPLOAD_MB,
    missing: [
      !caps.reader && 'GEMINI_API_KEY (needed to read PDFs, images, audio and video)',
      !caps.researcher && 'PERPLEXITY_API_KEY or GEMINI_API_KEY (needed to research claims)',
      !caps.judge && 'ANTHROPIC_API_KEY or GEMINI_API_KEY (needed to rule on claims)',
    ].filter(Boolean),
  };
}

export async function check(input) {
  const started = Date.now();

  if (input && input.kind === 'file') {
    const bytes = Math.floor(String(input.data || '').length * 3 / 4);
    if (bytes > MAX_UPLOAD_MB * 1048576) {
      throw new AppError(413, 'That file is over the ' + MAX_UPLOAD_MB + ' MB limit for this deployment.');
    }
  }

  const extracted = await extract(input);
  const prov = provenance(extracted.bytes, extracted.mime, input.name || null);
  const { claims, score, spans, body, truncated, note } = await analyse(extracted.text);

  return {
    input: {
      kind: input.kind,
      name: input.name || null,
      url: input.kind === 'url' ? input.url : null,
      mime: extracted.mime,
      via: extracted.via,
      characters: extracted.text.length,
      truncated: Boolean(truncated),
    },
    provenance: prov,
    score,
    claims,
    note,
    /* `spans` are character offsets into `extracted_text`, so these two must
       always be sent as a pair and neither may be re-sliced after this point. */
    spans,
    extracted_text: body,
    took_seconds: Math.round((Date.now() - started) / 100) / 10,
    checked_at: new Date().toISOString(),
  };
}
