# Putting the fact checker on the dashboard server

This is for whoever has SSH access to the box that serves the Mentions Atlas
dashboard (the one `visualize_mimz`'s deploy workflow pulls into
`/srv/data-visualisation-report` and then restarts nginx on).

The dashboard is static files. The fact checker is not: it is a small Node
service that holds API keys and calls Gemini and Perplexity on the server side.
It has to run as a process, and the dashboard reaches it at `/fact-check` on
the same host, which keeps it same-origin and means nothing else changes.

Five things, in order.

## 1. Node 20.12 or newer

The service reads its own `.env` with `process.loadEnvFile`, which landed in
20.12. No npm install is needed: the project has zero dependencies.

```bash
node --version
```

## 2. The code

```bash
sudo git clone https://github.com/niishthaaaaaa/solid-funicular.git /srv/content-verifier
```

Public repo, so no deploy key.

## 3. The keys, in a file only the server can read

They are deliberately not in the repo. Create `/srv/content-verifier/.env`:

```
GEMINI_API_KEY=...
PERPLEXITY_API_KEY=...
ANTHROPIC_API_KEY=...
```

The third is optional: without it Gemini does the judging too. Ask Nishtha for
the values; they should not travel by email or chat.

```bash
sudo chown www-data:www-data /srv/content-verifier/.env
sudo chmod 600 /srv/content-verifier/.env
```

## 4. Run it as a service

So it survives a reboot and restarts itself if it falls over.
`/etc/systemd/system/content-verifier.service`:

```ini
[Unit]
Description=Nians Fact Check
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/content-verifier
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=8788

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now content-verifier
sudo systemctl status content-verifier
curl -s localhost:8788/api/health
```

That last command should print JSON with `"ok":true` and name a reader, a
researcher and a judge. If any is null, a key is missing from `.env`.

## 5. Point nginx at it

Inside the existing `server { }` block for the dashboard:

```nginx
location /fact-check/ {
    proxy_pass http://127.0.0.1:8788/;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # A check takes 30 to 60 seconds and can run longer on a long document.
    # nginx gives up after 60 by default and the user sees a 504.
    proxy_read_timeout 300s;

    # Uploads are sent as base64 inside the request body, so an 18 MB file
    # arrives as about 24 MB. nginx rejects anything over 1 MB by default,
    # which would break every file upload while text and links kept working.
    client_max_body_size 32M;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The two settings with comments are the ones that go wrong quietly. Without
them text checks work and file checks fail, which looks like an application
bug and is not.

## Checking it worked

```bash
curl -s https://<the dashboard host>/fact-check/api/health
```

Same JSON as before. Then open the dashboard and click the **Fact Check** tab:
the checker should appear inside the page, not in a box with its own
scrollbar.

## Keeping it up to date (optional)

The dashboard redeploys on every push to its `main`. To do the same here, add
a step to that workflow, or give this repo its own:

```bash
cd /srv/content-verifier && git pull && sudo systemctl restart content-verifier
```

`.env` is gitignored, so a pull never touches the keys.

## One thing worth deciding

The checker will be reachable by anyone who can reach the dashboard. Every run
spends real API credit, roughly 25 provider calls. If the dashboard is public,
set a spend cap in the Google Cloud console and in Perplexity's API settings.
If it should be restricted instead, add `ACCESS_PASSWORD=something` to `.env`
and the service asks for it once per browser.
