/* Vercel entry point. There is no long-lived server here, so this function is
   started per request and does what server.js does on one route. The work
   itself lives in lib/check.js and is shared between the two. */

import { check, guard } from '../lib/check.js';
import { AppError } from '../lib/providers.js';

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
};

/* Vercel parses a JSON body for us, but only when the request arrives with the
   right content type. Reading the stream covers the case where it did not. */
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    raw = Buffer.concat(chunks).toString('utf8');
  }
  try { return JSON.parse(raw); }
  catch { throw new AppError(400, 'The request body was not valid JSON.'); }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    guard(req.headers['x-access-password']);
    return send(res, 200, await check(await body(req)));
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500;
    if (status >= 500) console.error('[error]', e);
    return send(res, status, { error: e.message || 'Something went wrong.' });
  }
}
