# Content Verifier

Takes a document, a link or a recording, pulls out the claims that can actually be checked, researches each one, and reports what held up.

It runs as its own service with its own HTTP API, so it can be used on its own now and called from the dashboard later.

## What it does not do

Worth stating first, because the brief that led here asked for it.

- **No deepfake detection.** It does not inspect pixels for manipulation. Nothing in a language model receives the signal a forensic detector needs, so no prompt produces this. Buy a purpose-built detector if it is required.
- **No AI-written text score.** Those detectors falsely accuse human writing, and the error rate climbs on non-native English and on short posts. A commercial detector with published independent evaluation is the honest route if this becomes a requirement.
- **No social media extraction.** Instagram, X and Facebook block automated fetching. News pages and blogs fetch cleanly. For a social post, paste the text.

What it does instead is check whether the content is **true**, which is the question with business value behind it. A real photograph can carry a false claim, and an AI-generated image can carry a true one. Those are separate axes, and this tool works on the second.

## Setup

```bash
npm start
```

No dependencies and no build step. Node 20.12 or newer.

Before the first run, copy `.env.example` to `.env` and add at least one key. Then open http://localhost:8788.

### Keys

| Key | Role | Needed? |
|---|---|---|
| `GEMINI_API_KEY` | Reads PDFs, images, video and audio. Also stands in as researcher and judge. | Required for any file that is not plain text |
| `PERPLEXITY_API_KEY` | Researches each claim and returns citations | Optional, falls back to Gemini |
| `ANTHROPIC_API_KEY` | Rules on the evidence | Optional, falls back to Gemini |
| `FACTCHECK_API_KEY` | Google Fact Check Tools, looks up claims already ruled on by professional fact-checkers | Optional and free |

A Gemini key alone runs the whole pipeline. Adding Perplexity and Anthropic improves it, because research and judgement come from different models rather than one model grading its own homework.

`/api/health` lists what is configured and what is missing.

## Putting it online

The same code runs two ways. Locally `server.js` holds a port open. On Vercel
there is no long-lived server, so every request starts its own function from
`api/`. Both call `lib/check.js`, so neither can drift away from the other.

1. Push this repository, then import it at vercel.com. There is no framework and
   no build step, so take the defaults.
2. Add the keys under Settings, Environment Variables. They live there and never
   in the repository.
3. Set `ACCESS_PASSWORD` to something and share it with whoever should have it.
   Skip this only if you mean the URL to be open to anyone who finds it.
4. Deploy, then open the URL.

Three things are different once it is hosted:

- **Uploads stop at 3 MB.** A Vercel request body cannot exceed 4.5 MB on any
  plan, and base64 adds a third to a file on the way up. Long PDFs are fine, a
  recording is not. Run it locally for those, where the ceiling is 18 MB.
- **A run has 300 seconds.** That is the Hobby ceiling with Fluid Compute, and a
  twelve-claim run lands well inside it. If the deploy is rejected for asking
  too long, Fluid Compute is switched off for the project: turn it on under
  Settings, Functions, or drop maxDuration in vercel.json to 60. Lower
  `CLAIM_LIMIT` if a long document ever runs out of time.
- **The deployment asks not to be indexed.** `vercel.json` sends
  `x-robots-tag: noindex`, so the URL has to be handed to someone rather than
  found. Remove that header if you want it findable.

## How it works

```
input  ->  extract  ->  find claims  ->  research each  ->  judge  ->  report
```

1. **Extract.** Text files are read directly. Web pages are fetched and stripped to article text. PDFs, images, video and audio go to Gemini, which reads media natively, so there is no document parser here to maintain.
2. **Provenance.** A deterministic pass over the raw bytes for C2PA Content Credentials, IPTC AI labels, and generator metadata that tools like ComfyUI and Stable Diffusion write into PNGs. No network call. Finding something is evidence. Finding nothing is not, because upload pipelines strip metadata.
3. **Find claims.** One model pass turns the text into atomic, standalone, checkable statements. Opinions, predictions and marketing language are dropped. A negative opinion is not a claim.
4. **Research.** Each claim goes to a search-grounded model, asked for evidence both for and against. In parallel, the Google Fact Check Tools API looks for a published verdict from a real fact-checking organisation.
5. **Judge.** A separate call rules on the evidence alone. Retrieval and judgement are kept apart on purpose: it is what makes a verdict auditable rather than a vibe.

## Reading the result

Three verdicts, and the distinction between the last two matters:

- **supported** - independent published sources state this. The claim's own author repeating it does not count.
- **contradicted** - reliable sources state the opposite, or a figure, date, quote or attribution is demonstrably wrong.
- **unverified** - the evidence does not settle it. Nothing found, paywalled, too recent, or only the original source.

**Unverified is not a soft "false".** Most content that nobody has written about lands here, and that is the correct answer rather than a failure.

The headline is a label and a set of counts, not a percentage dressed up as a probability. There is no calibrated model behind a number like "72% fake", so the tool does not print one. The claim table with its sources is the actual product; the counts are a summary of it.

## Limits worth knowing before a demo

- **It is not deterministic.** The same input can produce a slightly different claim set run to run. Temperature is pinned at 0 and the claim count is capped, which reduces it but does not remove it.
- **Thin coverage drags scores down.** Paywalled reporting and events from the last few hours come back unverified, which is honest but can read as suspicion.
- **It costs tokens and time.** Every claim is a research call plus a judgement call. A long PDF takes a few minutes. `CLAIM_LIMIT` caps the spend per run.
- **Non-English content works but is weaker**, because the sources the researcher can reach are thinner.
- **Content leaves your machine.** Submitted text and files are sent to whichever providers are configured. Do not run client material through it without checking that is allowed.

## API

`POST /api/check`

```json
{ "kind": "text", "text": "..." }
{ "kind": "url",  "url": "https://..." }
{ "kind": "file", "name": "report.pdf", "mime": "application/pdf", "data": "<base64>" }
```

Returns the score, every claim with its verdict and sources, the provenance findings, and the text the service actually read.

`GET /api/health` returns which providers are configured, the upload ceiling,
and whether a password is set.

When `ACCESS_PASSWORD` is set, both routes read it from an `x-access-password`
header. Without it `/api/check` answers 401.

## Joining it to the dashboard later

The dashboard is a static single file with no backend. This service is the backend it does not have. To connect them, have the dashboard POST a Brand Mention's content to `/api/check` and render the returned claims. Nothing in this repository needs to change for that, which is why it was built as an endpoint rather than a page.
