# KeyCRM Stocks Dashboard

A web tool that pulls product stocks from the KeyCRM API and shows them in a table. Used by the surf.ua owner (Dmitry) to monitor stock during the WooCommerce store preparation phase (KeyCRM is the source of truth for stocks, the site is not yet launched).

## Quick start

```bash
cd ~/Desktop/keycrm-stocks
nvm use 22                    # CRITICAL: the default node v10 does not work
node server.js
# → http://localhost:3000
```

Stop: `lsof -ti:3000 | xargs kill -9`

## Stack

- **Node.js 22+** (uses built-in `fetch`, `??`/`?.` syntax)
- **Express 5** — static files + a single JSON endpoint (local dev only)
- **dotenv** — config via `.env`
- **Vanilla HTML/JS** — no build step, a single file

## Architecture

```
keycrm-stocks/
├── .env                # KEYCRM_API_KEY, AUTH_USER, AUTH_PASS, PORT (gitignored)
├── .env.example        # Template, no secrets
├── .gitignore
├── package.json
├── server.js           # Local dev: Express + KeyCRM proxy (stocks + sales + geo)
├── lib/
│   ├── geo.js          # Shared geography helpers (region label map, bucketing) — CJS
│   └── auth.js         # Role-aware auth: signed surf_auth cookie, roleFromCookie/isAdmin — CJS
├── api/
│   ├── stocks.js       # Vercel serverless function — stocks (prod)
│   ├── sales.js        # Vercel serverless function — sales stats (prod)
│   ├── geo.js          # Vercel serverless function — geography (prod, admin-only)
│   └── role.js         # Vercel serverless function — { role, admin } from cookie (prod)
├── scripts/
│   └── geo-backfill.js # One-time/periodic full-history geo snapshot generator
├── data/
│   └── geo-snapshot.json # Per-month region aggregates (committed; read by geo endpoint)
├── middleware.js       # Vercel edge Basic Auth (prod)
├── vercel.json         # Vercel config
└── public/
    └── index.html      # UI: tabs (Остатки + Продажи + География), table, dashboards
```

UI has three tabs: **Остатки** (stocks table), **Продажи** (sales stats: KPI cards, status breakdown, per-manager breakdown), and **География** (orders by delivery region, bar chart, month dropdown + overall). Each tab has its own refresh button + localStorage cache.

**Data flow (prod, Vercel):**

```
Browser → GET surf-stocks.vercel.app/api/stocks
            ↓ (Basic Auth via middleware.js)
        api/stocks.js (serverless)
            ↓ (Bearer + parallel pagination)
        KeyCRM API: GET /offers?include=product&limit=50&page=N
            ↓
        Field mapping → JSON { updated_at, count, items: [...] }
            ↓ (Cache-Control: s-maxage=30, SWR=60 — Vercel edge cache)
        Browser renders the table
```

One full refresh = `Math.ceil(total / 50)` requests to KeyCRM. ~445 variants = 9 requests = ~2.5 sec.

## KeyCRM API — things to remember

### Authorization
- Base URL: `https://openapi.keycrm.app/v1`
- Header: `Authorization: Bearer <API_KEY>`
- Key stored in `.env` (field `KEYCRM_API_KEY`)
- Get/rotate: KeyCRM → Settings → API → API keys

### Limits
- **60 requests per minute** per IP per key
- Concurrent pagination with `CONCURRENCY = 4` and 200ms between batches
- 9 pages with concurrency 4 → ~2.5 sec full refresh
- On 429 — KeyCRM returns rate-limit, server bubbles the error up

### Swagger ↔ real API mismatches
The Swagger spec (https://keycrm.s3.de.io.cloud.ovh.net/static/open-api.yml) diverges from reality in several places. Confirmed mismatches:

| Endpoint | Swagger says | API actually returns |
|---|---|---|
| `/offers` | field `reserve` | field **`in_reserve`** |
| `/offers/stocks` | field `reserve` | (not checked — may be the same) |

**Conclusion:** before adding new fields, do a test request with `limit=1` and inspect the real response. Do not trust the spec.

### Which endpoint is used
Currently — only `GET /offers?include=product`. A single call returns:
- `id`, `sku`, `quantity`, `in_reserve` (stocks)
- `thumbnail_url`, `price`
- `properties[]` (color, size, etc. — for variants)
- `product.name` (parent product, via `include=product`)

`/offers/stocks` is NOT used because `/offers` already returns everything needed and uses half the requests. **You will need `/offers/stocks` if:**
- You need a per-warehouse breakdown → additionally `filter[details]=true`
- A suspicion appears that `quantity` on `/offers` is inaccurate (then cross-check)

### Field mapping KeyCRM → our JSON

```js
{
  id: o.id,                                    // Variant ID
  sku: o.sku,                                  // SKU, e.g. "1057-12"
  product_name: o.product.name,                // Parent product name
  variant_name: buildVariantLabel(o),          // "Pink / L" (from properties[])
  price: o.price,
  quantity: o.quantity,                        // Total stock
  reserve: o.in_reserve,                       // IMPORTANT: in_reserve, not reserve
  available: o.quantity - o.in_reserve,        // Available for sale
}
```

`buildVariantLabel(o)` joins values from `properties[]` with ` / `.

### Orders endpoint (`/order`) — sales tab

`GET /order?include=manager&filter[created_between]=FROM,TO` — used by `/api/sales`.

Verified live (do not trust spec):
- **Total orders is large** (~3500+), so ALWAYS filter by date. One month ≈ 480 orders ≈ 10 pages (limit=50). Two months (current + previous) ≈ 20 requests ≈ 1.5 sec.
- **Date filter**: `filter[created_between]=2026-05-01 00:00:00,2026-05-31 23:59:59` (comma-separated FROM,TO). `URLSearchParams` encodes the space as `+` and KeyCRM accepts it — the existing `keycrmGet` code path works as-is.
- **Revenue** = `grand_total` (order total). `payments_total` = actually paid (less for partial payments). We use `grand_total`.
- **Manager**: `o.manager.full_name` (requires `include=manager`). May be null → fallback `'Без менеджера'`.
- **Status**: `o.status_group_id` (NOT `status_id` — group is the stable bucket). Fetch the map from `GET /order/status` (`id`, `group_id`, `name`, `alias`).

Status `group_id` → UI bucket (see `GROUP_BUCKET` in `api/sales.js` / `server.js`):

| group_id | meaning | bucket | color |
|---|---|---|---|
| 1 | new | pending | yellow |
| 2 | принято / waiting_for_prepayment | pending | yellow |
| 3 | бронь | pending | yellow |
| 4 | доставка (відділення / в дорозі / повернення / платіж отримано) | shipped | blue |
| 5 | completed | done | green |
| 6 | canceled / повернути / обмін | cancelled | red |

Headline KPI (revenue, orders, avg check) + status block = **all buckets except cancelled (group 6)**, by **creation date** (`created_between`).

**Per-manager breakdown shows two sums** (mirrors KeyCRM's "Дата оформлення / Дата закриття" grouping):
- `created_revenue` / `created_orders` — orders **created** in the period (excl. cancelled).
- `closed_revenue` / `closed_orders` — orders **closed** in the period (completed, group 5).

⚠️ KeyCRM allows NO closed-date filter. Allowed order filters: `status_id, source_id, buyer_email, buyer_phone, has_tracking_code, created_between, updated_between, payment_status, source_uuid, shipping_between`. So "closed in period" is computed: fetch `updated_between=period` candidates (closing updates the order), then keep those with `closed_at` in the period AND `status_group_id===5`. This doubles the fetches → `fetchPeriod` does 2 paginations (created + updated) × 2 months ≈ 35 requests/refresh. `closed_at` format is `"YYYY-MM-DD HH:MM:SS"` (space, NOT ISO — unlike `created_at`); compare via `.slice(0,7)` against `ym`.

`/api/sales` returns `{ updated_at, took_ms, current:{label,statuses,managers}, previous:{...} }`. Managers sorted by `created_revenue` desc.

### Geography (`/order` + `shipping`) — geography tab

`GET /order?include=shipping` — orders by delivery region. Used by `/api/geo`.

Verified live:
- **Region field**: `o.shipping.shipping_address_region` → oblast adjective, Ukrainian (`"Київська"`, `"Львівська"`, `"Закарпатська"`). Well-populated (~1% empty). `lib/geo.js` `REGION_SHORT` maps oblast → short label as on Dmitry's screenshot (`"Київська"→"Київ"`, `"Закарпатська"→"Закарпаття (Ужгород)"`, `"Волинська"→"Луцьк"`, …). Unknown regions fall through to the raw value.
- **Foreign orders**: no region, only `shipping_address_country` → `COUNTRY_SHORT` (`"Poland"→"Польща"`). Else `"Не указано"`.
- **Counts exclude cancelled** (`status_group_id===6`) — not real demand, mirrors the sales tab.
- Each region row carries `orders` (primary, drives bar width) + `revenue` (`grand_total` sum, muted).

**The all-time problem & the snapshot fix.** Total orders ≈ 3800 = 77 pages. The 60 req/min limit makes a full all-time scan impossible inside one serverless request (77 req can't fit in <77s; also blows maxDuration). So:

1. **`scripts/geo-backfill.js`** paginates the WHOLE history ONCE, slowly (sequential, ~1.1s/page → ~54 req/min, ~100s), and writes per-month region aggregates to **`data/geo-snapshot.json`** (committed to the repo).
2. **`/api/geo`** reads the snapshot (historical months, immutable enough) and re-fetches only **current + previous month live** (~20 req, ~1.7s), overlaying them on top. `lib/geo.buildGeoResponse` merges + computes the **overall** = sum across all months.
3. To refresh older months: re-run `node scripts/geo-backfill.js`, commit `data/geo-snapshot.json`, redeploy.

⚠️ Past months in the snapshot are frozen at backfill time — only current+previous refresh live. Re-run the backfill periodically. On Vercel the snapshot is bundled into the function via `vercel.json` → `functions["api/geo.js"].includeFiles`.

`/api/geo` returns `{ updated_at, took_ms, snapshot_generated_at, overall:{label,total_orders,total_revenue,regions:[{name,orders,revenue,pct}]}, months:[{ym,label,...,regions}] }`. Regions sorted by `orders` desc. UI: dropdown «Общая» + each month, horizontal bar chart.

`lib/geo.js` is **CommonJS** (single source of truth). `server.js`/backfill `require` it; `api/geo.js` (ESM) uses `import geo from '../lib/geo.js'` (default import of CJS) then destructures.

**GEO is admin-only, gated by the Basic Auth ACCOUNT (role).** There are **two** Basic Auth accounts:
- **manager** (`AUTH_USER` / `AUTH_PASS`) — normal access, GEO hidden.
- **admin** (`ADMIN_USER` / `ADMIN_PASS`) — sees the GEO tab + `/api/geo`.

The role is whichever account you typed at the browser's Basic Auth prompt. `middleware.js` (edge) validates either account and sets a signed cookie `surf_auth = HMAC(secret, "v1:<role>")` (base64url, no padding; secret = `AUTH_SECRET` || `AUTH_PASS`). `lib/auth.js` (CJS) re-derives & verifies that SAME token with **Node** crypto — middleware (Web Crypto) and the API (Node crypto) produce identical tokens (verified: HMAC-SHA256, same string, base64url no-pad). Admin is checked first so it wins on credential overlap.

- `GET /api/role` → `{ role, admin }` from the cookie. The UI reveals the GEO tab only when `admin:true`.
- `GET /api/geo` returns **403** unless the cookie proves admin (checked in both `server.js` and `api/geo.js`). 500 if `ADMIN_USER`/`ADMIN_PASS` unset.
- UI: GEO tab is `display:none` until `/api/role` says admin. GEO data is **not** cached in `localStorage` (admin-only section). The signed cookie remembers the role for 30 days.
- ⚠️ Switching manager↔admin needs a fresh Basic Auth login (browsers cache credentials; clear them or use a different browser/profile).

**Local dev** (`npm run dev`) has no edge middleware. If `AUTH_USER`/`AUTH_PASS` are unset in `.env` (the default), `server.js` runs in **open dev mode** → treated as admin, GEO visible. Set the accounts in `.env` to exercise the real role rules locally.

## Configuration (`.env`)

| Variable | Description | Default |
|---|---|---|
| `KEYCRM_API_KEY` | KeyCRM API key | — (required) |
| `AUTH_USER` | Basic Auth login — MANAGER account (prod) | — (required for Vercel) |
| `AUTH_PASS` | Basic Auth password — manager | — (required for Vercel) |
| `ADMIN_USER` | Basic Auth login — ADMIN account (reveals GEO) | — (required for GEO) |
| `ADMIN_PASS` | Basic Auth password — admin | — (required for GEO) |
| `AUTH_SECRET` | Secret for signing the `surf_auth` role cookie | (falls back to `AUTH_PASS`) |
| `PORT` | Local server port | 3000 |

## Security

- `.env` is in `.gitignore` — never commit it
- The KeyCRM key **must never** end up in HTML or client JS — the browser must not see it; everything is proxied through `server.js` (local) or `api/stocks.js` (prod)
- If the key leaks (in chat, in a screenshot, in logs) — **rotate** it in KeyCRM immediately
- Local server only listens on `localhost:3000` — not accessible from outside (good)
- Prod (Vercel) is protected by Basic Auth — two accounts: manager (`AUTH_*`) and admin (`ADMIN_*`). GEO is admin-only, enforced server-side on `/api/geo` (not just hidden in the UI)

## Common tasks

### Add a new field to the table
1. Run `curl -H "Authorization: Bearer $KEY" "https://openapi.keycrm.app/v1/offers?limit=1&include=product"` and check the REAL field name
2. In both `server.js` and `api/stocks.js` → the `mapOffer` function — add the field to the returned object
3. In `public/index.html`:
   - Add `<span class="sort" data-sort="key">Name <span class="arrow"></span></span>` to the header
   - Add the field to the row template
4. Restart `npm run dev`

### Change the auto-refresh frequency
There is no auto-refresh yet (manual button only). If added — the `setInterval` timer lives in `public/index.html`, not on the server.

### What to do on 401 after rotating the key
- Check that `.env` is saved
- Restart the server (dotenv reads `.env` only at startup)
- If still 401 — the KeyCRM key may have been revoked, rotate it again

### What to do on 429
- Reduce refresh frequency (if auto-refresh exists)
- Increase `BATCH_DELAY_MS` in `server.js` / `api/stocks.js` (from 200 to 500)
- Wait a minute — the limit resets

## Roadmap

Next steps (in order of likelihood):

1. **Auto-refresh by timer** in the UI — checkbox + interval selector
2. **CSV export** for Google Sheets
3. **Per-warehouse breakdown** — switch to `/offers/stocks?filter[details]=true` if Dmitry sets up separate warehouses
4. **Webhook from KeyCRM** instead of pull — for real-time updates when the catalog grows
5. **WooCommerce integration** — separate project: when the store launches, sync stocks from KeyCRM to WC by SKU. Not here — in a WP plugin or a standalone bridge.

## Links

- KeyCRM API docs: https://docs.keycrm.app/
- OpenAPI spec (YAML): https://keycrm.s3.de.io.cloud.ovh.net/static/open-api.yml
- KeyCRM API capabilities: https://help.keycrm.app/uk/process-automation-api-and-more/iaki-mozhlivosti-nadaie-api-key-crm

## Do NOT

- **Do not call KeyCRM directly from the browser** — CORS will block it + the key would leak
- **Do not lower `BATCH_DELAY_MS` below 100ms** — you will hit the rate limit on larger catalogs
- **Do not trust the Swagger spec without verifying** — it lies in places (see `in_reserve` vs `reserve`)
- **Do not commit `.env`** — `.gitignore` already protects, but double-check before `git add`
- **Do not use the default system Node 10** — `nvm use 22` is required in every new terminal

## Communication style (caveman)

All responses in caveman mode (skill `.claude/skills/caveman/SKILL.md`). Default — **full**.

Drop: articles (a/an/the), fillers (just/really/basically/actually/simply), pleasantries (sure/certainly/of course), hedging. Fragments OK. Short synonyms. Technical terms exact. Code, function names, error strings — never abbreviated.

Pattern: `[thing] [action] [reason]. [next step].`

**Drop caveman style** for:
- Security warnings
- Confirmations of irreversible actions (deletion, force-push)
- Multi-step sequences where order is critical

Levels (`/caveman lite|full|ultra`): lite keeps grammar, ultra abbreviates (DB/auth/config/req/res/fn/impl). Code/commits/PRs — plain language.

Do not ask each time — caveman is active by default.

## Communication language

All commits, PR titles/descriptions, code comments, CLAUDE.md, and any developer-facing text pushed to GitHub must be in **English**. Local conversation in chat can be either language.

**Exception — UI strings**: `public/index.html` is in **Russian** (header, buttons, table columns, banners, placeholders, error wrappers, time locale `ru-RU`). The audience is managers who read Russian. Do not translate UI strings to English. Server error hints in `api/stocks.js` / `server.js` stay English (developer-facing).

## Optimization and working with libraries (Context7)

When working with external libraries (Express, Vercel, KeyCRM SDK, Node API, etc.) **first** consult Context7 MCP:
- `resolve-library-id` — find the library id
- `query-docs` — get up-to-date documentation

Do not rely on training data for fresh APIs. Especially when upgrading dependencies and working with Vercel/serverless edge runtime.

## Deploy

Prod — Vercel (Hobby plan), repo https://github.com/Dmitryfor/surf-key-crm-stock, branch `main` → auto-deploy.

```
/api/stocks.js     — serverless function (Node runtime, maxDuration 10s)
/middleware.js     — edge Basic Auth, 2 accounts (AUTH_* manager, ADMIN_* admin) → signed role cookie
/public/index.html — static (frontend, no changes)
/server.js         — local dev mode (npm run dev)
/vercel.json       — config
```

**Env vars in Vercel UI**: `KEYCRM_API_KEY`, `AUTH_USER`, `AUTH_PASS` (manager), `ADMIN_USER`, `ADMIN_PASS` (admin) (+ optional `AUTH_SECRET`). Without `ADMIN_USER`/`ADMIN_PASS` GEO returns 500 "not configured".

**CDN cache**: `/api/stocks` returns `Cache-Control: s-maxage=30, stale-while-revalidate=60`. The `?fresh=1` query bypasses the cache.

**Local dev**: `npm run dev` (Express on :3000, no auth, no CDN cache — fallback to the old in-memory cache). For Vercel emulation: `vercel dev`.
