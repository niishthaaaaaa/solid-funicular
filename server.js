/* A local HTTP service. No framework, no dependencies, no database.
   Start it with: npm start */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Load .env before anything reads process.env. Node has done this natively
   since 20.12, so there is no dotenv dependency here. The imports below are
   dynamic for the same reason: the provider module reads its keys and model
   ids at load time, so it must not load until after this line. */
try { process.loadEnvFile(path.join(HERE, '.env')); }
catch { /* no .env yet: /api/health will say which keys are missing */ }

const { extract } = await import('./lib/extract.js');
const { provenance } = await import('./lib/provenance.js');
const { analyse } = await import('./lib/analyse.js');
const { capabilities, AppError } = await import('./lib/providers.js');

const PORT = Number(process.env.PORT) || 8788;
const MAX_BODY = 40 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AppError(413, 'That upload is over the ' + Math.round(MAX_BODY / 1048576) + ' MB limit.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function check(input) {
  const started = Date.now();

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const caps = capabilities();
      return send(res, 200, {
        ok: Boolean(caps.researcher && caps.judge),
        ...caps,
        missing: [
          !caps.reader && 'GEMINI_API_KEY (needed to read PDFs, images, audio and video)',
          !caps.researcher && 'PERPLEXITY_API_KEY or GEMINI_API_KEY (needed to research claims)',
          !caps.judge && 'ANTHROPIC_API_KEY or GEMINI_API_KEY (needed to rule on claims)',
        ].filter(Boolean),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/check') {
      const raw = await readBody(req);
      let input;
      try { input = JSON.parse(raw); } catch { throw new AppError(400, 'The request body was not valid JSON.'); }
      return send(res, 200, await check(input));
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      /* Confine every read to public/, whatever the request path says. */
      const file = path.join(HERE, 'public', path.normalize(rel).replace(/^(\.\.(\\|\/|$))+/, ''));
      if (!file.startsWith(path.join(HERE, 'public'))) return send(res, 403, { error: 'Forbidden' });
      try {
        const body = await readFile(file);
        return send(res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream');
      } catch { return send(res, 404, { error: 'Not found' }); }
    }

    return send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500;
    if (status >= 500) console.error('[error]', e);
    if (!res.headersSent) send(res, status, { error: e.message || 'Something went wrong.' });
  }
});

server.listen(PORT, () => {
  const caps = capabilities();
  console.log('content-verifier listening on http://localhost:' + PORT);
  console.log('  reader      ' + (caps.reader || 'MISSING: set GEMINI_API_KEY to read PDFs and media'));
  console.log('  researcher  ' + (caps.researcher || 'MISSING: set PERPLEXITY_API_KEY or GEMINI_API_KEY'));
  console.log('  judge       ' + (caps.judge || 'MISSING: set ANTHROPIC_API_KEY or GEMINI_API_KEY'));
  console.log('  fact checks ' + (caps.factcheck ? 'on' : 'off (optional: set FACTCHECK_API_KEY)'));
});
