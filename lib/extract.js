/* Turns whatever was submitted into plain text.
   Text files are read directly. Web pages are fetched and stripped. Everything
   else (PDF, image, video, audio) goes to Gemini, which reads media natively,
   so there is no document parser to keep up to date here. */

import { gemini, AppError } from './providers.js';

const MAX_INLINE = 18 * 1024 * 1024;   /* Gemini inline data ceiling, with headroom */
const MAX_TEXT = 200000;               /* keeps one huge document from blowing up the claim pass */

const TEXTY = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|rtf))/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|yml|yaml|log|srt|vtt|html?|rtf)$/i;

const READ_MEDIA = [
  'Transcribe this faithfully.',
  'For video or audio: give the spoken words verbatim. Note the speaker when it changes.',
  'For an image or PDF: give every piece of visible text verbatim, in reading order. Then add one short line describing anything shown that is not text.',
  'Do not summarise. Do not interpret. Do not add commentary of your own.',
].join(' ');

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '-', ndash: '-', hellip: '...',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};

const decode = s => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => {
    const hit = ENT[n] !== undefined ? ENT[n] : ENT[n.toLowerCase()];
    return hit === undefined ? m : hit;
  });

export function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');

  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1] || '').trim();

  /* Drop page chrome first, then prefer the article body. Doing it in this
     order matters: sites like Wikipedia put their navigation and language
     lists inside <main>, so selecting the container alone is not enough. */
  s = s.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
  const body = (/<article[^>]*>([\s\S]*?)<\/article>/i.exec(s)
    || /<main[^>]*>([\s\S]*?)<\/main>/i.exec(s) || [])[1];
  s = body || s;

  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  s = decode(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: s };
}

/* A page can come back with nothing readable in it for three different
   reasons, and from here they all look the same: status 200, no text. The
   difference is in the markup, so it is read off the markup rather than
   guessed at. Reddit, for one, answers a robot with a proof-of-work form that
   carries a hidden "solution" field and submits itself, which is a refusal
   wearing the clothes of a 200. */
const EMPTY_WHY = [
  [/name=["']?solution["']?|captcha|are you (a )?(human|robot)|verify (that )?you(r|'re)? ?(are )?(a )?human|checking your browser|just a moment|unusual traffic|access denied|cf[-_]challenge|challenge-platform/i,
    'served a challenge page to prove the request came from a browser, instead of the article'],
  [/\b(log ?in|sign ?in)\b/i,
    'served a sign-in page instead of the article'],
  [/<div[^>]+id=["'](root|__next|app)["']|data-reactroot|__NUXT__|ng-version=/i,
    'is assembled in the browser by JavaScript, which this service does not run'],
];

function whyEmpty(html, host) {
  for (const [pattern, reason] of EMPTY_WHY) {
    if (pattern.test(html)) return host + ' ' + reason + '.';
  }
  return 'That page carries almost no readable text of its own.';
}

/* When a page says it was published. Sites declare this in several places and
   mostly agree with themselves, so the most dependable form is tried first and
   the rest are fallbacks. A date that cannot be found is left null: the report
   says nothing rather than guessing. */
const DATE_SOURCES = [
  /"datePublished"\s*:\s*"([^"]{4,40})"/i,
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
  /<meta[^>]+(?:name|itemprop)=["'](?:pubdate|publishdate|publish-date|dc\.date\.issued|datePublished)["'][^>]+content=["']([^"']+)["']/i,
  /* A bare <time> is not a publication date: on Wikipedia the first one on
     the page is an unrelated revision stamp, which this read as 2012. The tag
     has to say that is what it is. */
  /<time[^>]+(?:itemprop=["']datePublished["']|pubdate)[^>]*datetime=["']([^"']{4,40})["']/i,
  /<time[^>]+datetime=["']([^"']{4,40})["'][^>]*(?:itemprop=["']datePublished["']|pubdate)/i,
];

function publishedAt(html) {
  const ceiling = Date.now() + 86400000;
  for (const re of DATE_SOURCES) {
    const hit = re.exec(html);
    if (!hit) continue;
    const t = new Date(hit[1].trim());
    /* A parse that lands before the web or after tomorrow is a misread of some
       other number, not a publication date. */
    if (isNaN(t) || t.getFullYear() < 1990 || t.getTime() > ceiling) continue;
    return t.toISOString();
  }
  return null;
}

const mb = n => (n / 1048576).toFixed(1) + ' MB';

async function readMedia(buf, mime, name) {
  if (buf.length > MAX_INLINE) {
    throw new AppError(413, 'That file is ' + mb(buf.length) + ' and the inline limit is '
      + mb(MAX_INLINE) + '. Trim it, or pull the audio track out and submit that.');
  }
  const { text } = await gemini([
    { inlineData: { mimeType: mime, data: buf.toString('base64') } },
    { text: READ_MEDIA },
  ]);
  return { text, via: 'read by Gemini from ' + (name || mime) };
}

/* Browsers leave the type blank for plenty of files, so fall back to the bytes. */
function sniff(buf, name) {
  const head = buf.slice(0, 12);
  const at = (a, b) => buf.slice(a, b).toString('latin1');
  if (at(0, 4) === '%PDF') return 'application/pdf';
  if (head[0] === 0x89 && at(1, 4) === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return 'image/webp';
  if (at(0, 3) === 'GIF') return 'image/gif';
  if (at(4, 8) === 'ftyp') return 'video/mp4';
  if (at(0, 4) === 'OggS') return 'audio/ogg';
  if (at(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (head[0] === 0x1a && head[1] === 0x45) return 'video/webm';
  const ext = ((name.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  return {
    pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  }[ext] || 'text/plain';
}

export async function extract(input) {
  const kind = input && input.kind;

  if (kind === 'text') {
    const text = String(input.text || '').trim();
    if (!text) throw new AppError(400, 'No text was submitted.');
    return { text: text.slice(0, MAX_TEXT), via: 'pasted text', bytes: null, mime: 'text/plain' };
  }

  if (kind === 'url') {
    let url;
    try { url = new URL(input.url); } catch { throw new AppError(400, 'That does not look like a URL.'); }
    if (!/^https?:$/.test(url.protocol)) throw new AppError(400, 'Only http and https URLs are supported.');

    let r;
    try {
      r = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
        /* A generic client name. Never identify the operator to a third-party site. */
        headers: {
          'user-agent': 'content-verifier/0.1',
          accept: 'text/html,application/xhtml+xml,application/pdf,*/*',
        },
      });
    } catch (e) {
      throw new AppError(502, 'Could not fetch that URL: ' + e.message);
    }
    if (!r.ok) {
      /* 401, 403 and 429 are what a platform that refuses robots sends back,
         so only suggest pasting the text when that is what actually happened. */
      const blocked = [401, 403, 429].includes(r.status);
      throw new AppError(502, 'That URL returned ' + r.status + '.'
        + (blocked ? ' That site refuses automated requests, which social platforms and some news'
          + ' sites both do. Open it in a browser and paste the text instead.' : ''));
    }

    const mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    const looksHtml = /^(text\/html|application\/xhtml)/.test(mime)
      || (!mime && /<html/i.test(buf.slice(0, 2000).toString('utf8')));

    if (looksHtml) {
      const raw = buf.toString('utf8');
      const { title, text } = htmlToText(raw);
      if (text.length < 200) {
        throw new AppError(422, whyEmpty(raw, url.hostname)
          + ' Open it in a browser and paste the text instead.');
      }
      return {
        text: (title ? title + '\n\n' : '') + text.slice(0, MAX_TEXT),
        via: 'fetched from ' + url.hostname, bytes: buf, mime, title,
        published: publishedAt(raw),
      };
    }
    if (TEXTY.test(mime)) {
      return { text: buf.toString('utf8').slice(0, MAX_TEXT), via: 'fetched from ' + url.hostname, bytes: buf, mime };
    }
    const out = await readMedia(buf, mime || 'application/pdf', url.pathname.split('/').pop());
    return { ...out, bytes: buf, mime };
  }

  if (kind === 'file') {
    const name = String(input.name || 'file');
    const buf = Buffer.from(String(input.data || ''), 'base64');
    if (!buf.length) throw new AppError(400, 'That file came through empty.');

    let mime = String(input.mime || '').split(';')[0].trim().toLowerCase();
    if (!mime || mime === 'application/octet-stream') mime = sniff(buf, name);

    const isPdf = mime === 'application/pdf';
    if (!isPdf && (TEXTY.test(mime) || TEXT_EXT.test(name))) {
      const raw = buf.toString('utf8');
      const isHtml = /^(text\/html|application\/xhtml)/.test(mime) || /\.html?$/i.test(name);
      const text = isHtml ? htmlToText(raw).text : raw;
      return { text: text.slice(0, MAX_TEXT), via: 'read from ' + name, bytes: buf, mime };
    }
    const out = await readMedia(buf, mime, name);
    return { ...out, bytes: buf, mime };
  }

  throw new AppError(400, 'Submit a file, a URL or some text.');
}
