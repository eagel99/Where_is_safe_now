# Where is safe now? — דשבורד התרעות פיקוד העורף

A dashboard that ranks Israeli cities by how many missile and UAV alerts they received
over the last 7 days, using the public Pikud HaOref (Home Front Command) alert history.

> **This is a historical statistics dashboard, not an alerting system.** It shows where
> sirens *have* sounded over the past week. It will not warn you about anything. For real
> warnings use the official Pikud HaOref app and the sirens themselves.

## What it does

- Reads a list of 85 cities from [israel_cities_2026.csv](israel_cities_2026.csv) and expands
  each into query variants — the base city plus its sub-regions (`צפון`/`דרום`/`מזרח`/`מערב`,
  and custom sub-region lists for Ashdod, Tzfat, Tel Aviv, Herzliya, Hadera, Haifa, Jerusalem).
- Queries the Pikud HaOref alert-history endpoint for each variant over a rolling 7-day window,
  in batches of 10 with a delay between batches.
- Keeps alerts in categories 1 (missiles) and 2 (UAVs), de-duplicates by alert id, and counts
  per sub-region. Sub-region counts are merged back to a base city by taking the **max**, not
  the sum, so a city split into many zones isn't double-counted.
- Serves the result as a ranking: the 3 most-hit cities, the 3 least-hit, a per-city breakdown,
  and totals for the window.

The Hebrew, right-to-left UI in [index.html](index.html) is a single static file with no build
step. It opens the SSE stream on load, renders partial results as they arrive behind a progress
bar, then polls the cached JSON endpoint once a minute.

### Refresh and caching

The server starts fetching on boot without waiting for a client, and refreshes on a loop.
Results are cached for 2 minutes; concurrent requests share one in-flight query rather than
each starting their own.

Zone pruning keeps the query cheap: a full scan of every variant runs on the first query and
then every 4 days. In between, sub-region variants that have produced no alerts for 3 days are
skipped, while base cities are always queried.

## Running locally

Node 18 or newer, no dependencies to install.

```bash
npm start                       # http://localhost:3000
```

## Configuration

All configuration is environment variables; there is no config file.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `ALLOWED_ORIGIN` | *(unset)* | If set, sent as `Access-Control-Allow-Origin`. Leave unset for same-origin only. |
| `TRUST_PROXY` | *(unset)* | Set to `1` **only** when the app sits behind a reverse proxy you control. See below. |

### `TRUST_PROXY`

Rate limiting keys on the client IP. `X-Forwarded-For` is a request header that any client can
set, so it is only trustworthy when a proxy you control overwrites it.

- **Not set (default)** — the header is ignored and the socket address is used. Correct for
  direct exposure and for local runs.
- **`TRUST_PROXY=1`** — the leftmost `X-Forwarded-For` hop is used as the client IP. Correct
  when Cloudflare, Nginx, or a load balancer terminates the connection in front of the app.

Getting this wrong breaks rate limiting in one direction or the other: set it without a proxy
in front and anyone can rotate the header to bypass the limit; leave it unset behind a proxy
and every user shares the proxy's IP, so one busy client rate-limits everyone.

## Endpoints

| Route | Response |
|---|---|
| `/`, `/index.html` | The dashboard. |
| `/api/alerts` | JSON ranking. Returns the cache when it's fresh, otherwise waits for a full query. |
| `/api/alerts/stream` | Server-sent events: `progress`, `update`, and a final `done` carrying the same JSON. Returns the cached result immediately if one is fresh. |

Any other path returns 404. Routes are an explicit allow-list — there is no static file server,
so there is nothing to traverse out of.

## Deployment

### Docker (recommended)

The image is distroless and runs as `nonroot`:

```bash
docker build -t pikud-dashboard .
docker run -p 3000:3000 pikud-dashboard
```

Pushes to `main` build and publish `ghcr.io/eagel99/pikud-dashboard` via
[.github/workflows/docker.yml](.github/workflows/docker.yml), which also scans the built image
with Trivy for CRITICAL and HIGH CVEs.

Behind a reverse proxy, remember to pass the environment variable:

```bash
docker run -p 3000:3000 -e TRUST_PROXY=1 pikud-dashboard
```

### Netlify

[netlify.toml](netlify.toml) publishes the repo root as static files and redirects `/api/alerts`
to the function in [netlify/functions/alerts.mjs](netlify/functions/alerts.mjs).

Note that this function is a **standalone, older variant** of the query, not a wrapper around
`server.mjs`: it discovers area names by querying Hebrew letters instead of reading the CSV, and
it counts missiles only (category 1, no UAVs). It also provides no `/api/alerts/stream`, and the
bundled `index.html` opens that stream on load — so a Netlify deployment serves the JSON API,
not the working dashboard. Use the Node or Docker deployment for the full app.

## Security

The app has no database, no cookies, no authentication, and stores no personal data. What is
deliberately in place:

- **Route allow-list** — four exact paths, everything else 404s.
- **Security headers on every response** — CSP, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`.
- **Rate limiting** — 60 requests per minute per IP, with expired entries swept every minute.
  See [`TRUST_PROXY`](#trust_proxy) for how the IP is determined.
- **SSE connection cap** — 100 concurrent listeners, then 503.
- **Upstream response validation** — API responses must be a JSON array, and objects carrying
  `__proto__` or `constructor` keys are dropped.
- **Output escaping** — all values from the API are HTML-escaped before insertion into the DOM.
- **Error responses** — generic messages, no stack traces.

### Tests

```bash
node --test --test-force-exit --experimental-test-isolation=none security.test.mjs
```

[security.test.mjs](security.test.mjs) covers the above as regressions: route allow-list and
traversal attempts, headers, error-message leakage, prototype-pollution payloads, the rate
limiter (including that a rotating `X-Forwarded-For` cannot bypass it), and the SSE cap. It runs
on every push and pull request via
[.github/workflows/security.yml](.github/workflows/security.yml), alongside `npm audit`.

## Data source

Alert history comes from `alerts-history.oref.org.il`, the same endpoint the public Pikud HaOref
history page uses. This project is not affiliated with or endorsed by Pikud HaOref. The data is
fetched as-is; gaps, delays, or changes in the upstream API will show up here.
