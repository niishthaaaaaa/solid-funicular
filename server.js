/* A local HTTP service. No framework, no dependencies, no database.
   Start it with: npm start

   The routes here are thin. What they call lives in lib/check.js, which is the
   same code the Vercel functions in api/ call, so a hosted deployment and this
   one cannot drift apart. */

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

const { check, health, guard } = await import('./lib/check.js');
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, health(req.headers['x-access-password']));
    }

    if (req.method === 'POST' && url.pathname === '/api/check') {
      guard(req.headers['x-access-password']);
      const raw = await readBody(req);
      let input;
      try { input = JSON.parse(raw); } catch { throw new AppError(400, 'The request body was not valid JSON.'); }
      return send(res, 200, await check(input));
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      /* Confine every read to public/, whatever the request path says. */
      const file = path.join(HERE, 'public', path.normalize(rel).replace(/^(\.\.(\|\/|$))+/, ''));
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
  console.log('  access      ' + (process.env.ACCESS_PASSWORD ? 'password required' : 'open (no ACCESS_PASSWORD set)'));
});
