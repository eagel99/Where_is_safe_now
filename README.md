# Where is safe now? — התרעות פיקוד העורף

Two things in one Node service:

1. **Live alerts** — aggregates Pikud HaOref (Home Front Command) alerts from several
   sources at once, including **early warning** (`התרעה מקדימה`), correlates duplicate
   reports into one event, and tracks a live state per area.
2. **7-day ranking** — the original dashboard: which Israeli cities took the most and
   fewest missile/UAV alerts over a rolling week.

> **Supplementary tool only.** The official Pikud HaOref app, the sirens themselves and
> Pikud HaOref instructions are the authoritative safety sources. Push sources here are
> not a public documented API and can change without notice, so treat this as a faster
> secondary indicator, never as your warning system.

## Alert sources

| Source | Role | Default |
|---|---|---|
| Tzeva Adom WebSocket | fast third-party push | on |
| Pushy / MQTT app channel | fast push, experimental | off |
| `Alerts.json` | official real time, polled every second | on |
| `AlertsHistory.json` | recovery of missed events | on |
| `GetAlarmsHistory.aspx` | deep history recovery, and the ranking query | on |

An event is published the moment the **first** source reports it; later sources merge into
the same event and are recorded in `sources`, so verification never delays the alert.
Correlation requires matching `kind` and `category`, arrival inside the correlation window,
and overlapping area names or ids.

### Early warning

Category `14` is early warning — *"בדקות הקרובות צפויות להתקבל התרעות באזורך"*, and on the
northern border *"איום מלבנון - התקרבו למרחב מוגן"*. It is not a rocket alert; it means one is
expected shortly. It is a large share of real traffic: over a recent 120-day window, 1102 of
3000 history rows were category 14.

It is handled as a distinct state, not folded into regular alerts:

- `kind: "pre_alert"`, severity 2 (a live alert is 3), with its own longer TTL
  (`PRE_ALERT_STATE_TTL_SECONDS`, default 20 minutes).
- A real alert for an area **overrides** a pre-alert there; a pre-alert never downgrades an
  area that already has an active alert.
- Derived from three places: history category 14, real-time category 10 whose text matches
  the early-warning wording, and Tzeva Adom `SYSTEM_MESSAGE` with `instructionType: 0`.
- The dashboard banner turns amber for pre-alert and red for an active alert.

## Running locally

Node 20 or newer.

```bash
npm install
cp .env.example .env      # optional, every value has a default
npm start                 # http://localhost:3000
```

Best run from a server with an Israeli IP address.

| Page | What it is |
|---|---|
| `/` | Ranking dashboard with the live alert banner at the top |
| `/live` | Full command center: map, timeline, source health, action deliveries |

## Endpoints

### Live alerts

| Route | Response |
|---|---|
| `GET /api/v1/health` | Service and per-source health. 503 when no official source is healthy. |
| `GET /api/v1/state` | Current unified state per area. |
| `GET /api/v1/alerts` | Recent correlated events. `limit`, `kind`, `source` filters. |
| `GET /api/v1/sources` | Per-source status and latency. |
| `GET /api/v1/actions` | Rules and recent deliveries. |
| `GET /api/v1/geojson` | Custom area polygons, empty collection when none configured. |
| `GET /api/v1/events` | SSE: `connected`, `alert`, `alert-update`, `state`, `source-status`, `action-delivery`. |
| `GET /metrics` | Prometheus gauges and counters, including `oref_pre_alert_areas`. |
| `GET /current`, `GET /history` | Compatibility shapes for existing proxy consumers. |

`/health`, `/state`, `/sources`, `/alerts` and `/events` are unprefixed aliases.

### 7-day ranking

| Route | Response |
|---|---|
| `GET /api/alerts` | Ranking JSON. Cache when fresh, otherwise waits for a full query. |
| `GET /api/v1/rankings` | Same payload under the versioned prefix. |
| `GET /api/alerts/stream` | SSE: `progress`, `update`, and a final `done`. Returns a fresh cached result immediately. |

The payload carries `most`, `least`, `allCities`, `totalAlerts`, `totalCities` (cities hit),
`areasKnown` (size of the area catalog), `truncated`, and the window dates.

The area list comes from the Oref districts endpoint — **~1486 areas**, every city, village,
kibbutz and industrial zone the Home Front Command can alert. It is refreshed daily, cached
under `DATA_DIR`, and falls back to the bundled [data/districts.json](data/districts.json)
snapshot when the endpoint is unreachable.

The whole window is pulled with a single unfiltered history query and aggregated locally,
keeping categories 1 (missiles) and 2 (UAVs), de-duplicating by alert id, and merging
sub-region counts into a base city by **max**, not sum, so a city split into many zones is not
double-counted. Base cities are derived from the catalog itself rather than a hardcoded list of
compass directions, which is what makes labels like `אשדוד -יא,יב,טו,יז,מרינה,סיטי` (no space
after the dash) and `אזור תעשייה עידן הנגב - להבים` (city on the right) resolve correctly.

`allCities` lists every known base city including those with zero alerts, so the city picker
covers the whole country; `most` and `least` rank only cities that were actually hit. Results
cache for 2 minutes and concurrent requests share one in-flight query.

Two things worth knowing about the upstream data:

- **The history endpoint truncates at 3000 rows per query**, newest first, whatever the range.
  When a window query comes back at the cap, the engine re-walks it one day at a time so each
  day gets its own budget. A single day above 3000 rows cannot be split any further — the API
  takes dates, not times — so the response is flagged `truncated: true` and the dashboard says
  the numbers are a lower bound rather than presenting an undercount as complete.
- **The ranking counts missiles and UAVs only**, so it can legitimately read zero for a week in
  which every alert was, say, an infiltration warning or early warning.

## Configuration

Everything is environment variables; see [.env.example](.env.example) for the full list.
Paths resolve against the project root, so the working directory does not matter.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `AREA_FILTER` | *(empty)* | Comma-separated exact Oref area names. Empty means the whole country. |
| `ENABLE_TZEVAADOM` | `true` | Fast third-party push source. |
| `ENABLE_PUSHY` | `false` | Experimental mobile push source. |
| `ENABLE_RANKINGS` | `true` | Set false to run alerts only and skip the weekly scan. |
| `RANKING_WINDOW_DAYS` | `7` | Size of the ranking window. |
| `DISTRICT_REFRESH_HOURS` | `24` | How often the area catalog is re-fetched. |
| `PRE_ALERT_STATE_TTL_SECONDS` | `1200` | How long an early warning stays on the board. |
| `TRUST_PROXY` | *(unset)* | Set to `1` **only** behind a reverse proxy you control. |
| `ALLOWED_ORIGIN` | *(unset)* | If set, sent as `Access-Control-Allow-Origin`. |
| `RATE_LIMIT_MAX` | `60` | Requests per minute per IP. |
| `MAX_SSE_LISTENERS` | `100` | Concurrent event-stream connections before 503. |

### `TRUST_PROXY`

Rate limiting keys on the client IP. `X-Forwarded-For` is a request header any client can set,
so it is only trustworthy when a proxy you control overwrites it.

- **Not set (default)** — the header is ignored and the socket address is used. Correct for
  direct exposure and local runs.
- **`TRUST_PROXY=1`** — the leftmost `X-Forwarded-For` hop is the client. Correct when
  Cloudflare, Nginx or a load balancer terminates the connection in front of the app.

Getting this wrong breaks rate limiting in one direction or the other: set it without a proxy
and anyone can rotate the header to bypass the limit; leave it unset behind a proxy and every
user shares the proxy's IP, so one busy client rate-limits everyone.

## Webhooks and MQTT

Rules live in `config/actions.json` (every rule in the example is disabled). Enable with
`ACTIONS_ENABLED=true` plus `ACTION_ALLOWED_HOSTS`, and ideally `ACTION_HMAC_SECRET`.

Webhook deliveries are `POST` only, HTTPS only (except localhost), never follow redirects, and
carry `Idempotency-Key`, `X-Oref-Event-Id` and an optional `X-Oref-Signature` HMAC. Rules have
a cooldown and an hourly cap.

An action marked `irreversible` runs only when all three switches agree:
`ALLOW_IRREVERSIBLE_ACTIONS=true` in the environment, `allowIrreversible: true` on the rule,
and `confirmIrreversible: true` on the action. There is no shell execution and no payment
handling anywhere in the engine.

## Testing without a real alert

Disabled by default:

```env
ENABLE_TEST_ENDPOINT=true
ADMIN_TOKEN=replace-with-a-long-random-token
```

```bash
# early warning
curl -X POST http://localhost:3000/api/v1/test-alert \
  -H "Authorization: Bearer replace-with-a-long-random-token" \
  -H "Content-Type: application/json" \
  -d '{"areas":["מטולה"],"category":14,"kind":"pre_alert","title":"איום מלבנון - התקרבו למרחב מוגן"}'
```

Action rules ignore test events unless they set `"allowTest": true`.

## Deployment

### Docker (recommended)

Multi-stage build; the runtime image is distroless and runs as `nonroot`:

```bash
docker build -t pikud-dashboard .
docker run -p 3000:3000 -v oref-data:/app/.data pikud-dashboard
```

Behind a reverse proxy, pass the environment variable and disable SSE buffering:

```bash
docker run -p 3000:3000 -e TRUST_PROXY=1 -v oref-data:/app/.data pikud-dashboard
```

```nginx
location /api/v1/events {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

Pushes to `main` build and publish `ghcr.io/eagel99/pikud-dashboard` via
[.github/workflows/docker.yml](.github/workflows/docker.yml), which also scans the image with
Trivy for CRITICAL and HIGH CVEs.

### Serverless is not an option

The alert pipeline needs a long-running process: a persistent WebSocket to Tzeva Adom and a
one-second poll of `Alerts.json`, with in-memory correlation state across them. Functions that
spin up per request cannot hold any of that, so deploy this as a container or a plain Node
process.

## Security

No database, no cookies, no authentication for read paths, no personal data stored.

- **Rate limiting** — 60 requests per minute per IP, ahead of the static file server, with
  expired entries swept every minute. See [`TRUST_PROXY`](#trust_proxy).
- **SSE connection cap** — 100 concurrent streams across both event endpoints, then 503.
- **Security headers** — helmet with CSP (`script-src 'self'`, no inline script),
  `X-Frame-Options: DENY`, `Referrer-Policy`, `nosniff`.
- **Admin routes** — `/api/v1/test-alert` and `/api/v1/actions/reload` need a bearer token
  compared with `crypto.timingSafeEqual`; the test endpoint 404s unless explicitly enabled.
- **Upstream response validation** — ranking responses must be a JSON array, and objects
  carrying `__proto__` or `constructor` keys are dropped.
- **Output escaping** — all values from the API are HTML-escaped before insertion into the DOM.
- **Error responses** — generic messages, no stack traces.
- **Dependencies** — `npm audit` is clean at high and critical. The city metadata is vendored
  rather than installed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for why.

### Tests

```bash
npm run verify      # syntax check + all suites
```

[test/](test/) covers normalization, category mapping, correlation, area state (including
early-warning precedence), action matching and test-event protection, the ranking math, and
the security regressions: route allow-list and traversal, headers, error-message leakage,
prototype-pollution payloads, the rate limiter (including that a rotating `X-Forwarded-For`
cannot bypass it), the SSE cap on both streams, and admin-route authentication. CI runs the
suite and `npm audit --audit-level=high` on every push and pull request via
[.github/workflows/security.yml](.github/workflows/security.yml).

## Layout

```text
src/
  sources/     push and polling alert sources
  core/        normalization, correlation, area state, event bus
  rankings/    7-day ranking engine
  actions/     webhook, MQTT and action safety
  metadata/    area catalog and segment mapping
  storage/     JSONL event log and snapshot
  http/        rate limiting and SSE cap
public/        dashboard (/) and command center (/live)
data/          district snapshot, vendored city metadata, area id map
config/        action rules
test/          unit, ranking and security suites
```

## Data sources and attribution

Alert data comes from `oref.org.il` and `alerts-history.oref.org.il`, plus the Tzeva Adom
WebSocket. This project is not affiliated with or endorsed by Pikud HaOref. Data is used as-is;
gaps, delays or upstream API changes show up here. See
[RESEARCH.md](RESEARCH.md) for the projects reviewed while designing this and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licenses.
