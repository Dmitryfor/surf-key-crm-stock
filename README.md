# KeyCRM Stocks Dashboard

A lightweight web tool that pulls product stocks from the [KeyCRM](https://keycrm.app/) API and shows them in a searchable, sortable table. Used by the [surf.ua](https://surf.ua) team to monitor stock during the WooCommerce store preparation phase.

**Live**: [surf-stocks.vercel.app](https://surf-stocks.vercel.app) (Basic Auth required)

![dashboard](https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white)
![dashboard](https://img.shields.io/badge/Vercel-deployed-000000?logo=vercel&logoColor=white)
![dashboard](https://img.shields.io/badge/license-MIT-blue)

---

## Table of contents

- [Features](#features)
- [Stack](#stack)
- [Quick start (local)](#quick-start-local)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Deploy to Vercel](#deploy-to-vercel)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

---

## Features

- Pulls all product variants from KeyCRM in parallel batches (~2.5s for 445 variants)
- Groups variants by parent product, with totals per group
- Color-coded status: green (5+), yellow (1–4), red (0 or negative)
- Client-side search with debounce + column sorting
- Staleness banner when the data is older than 30 minutes
- Edge CDN cache on Vercel (30s) — one fetch serves many managers
- HTTP Basic Auth in production (single shared credential)
- Mobile-friendly responsive layout

> UI strings are in Russian (audience: store managers). Source code, comments, and docs are in English.

---

## Stack

- **Node.js 22+** — built-in `fetch`, `AbortSignal.timeout`, modern syntax
- **Express 5** — local dev server only
- **Vercel** — production: serverless function + edge middleware + CDN
- **Vanilla HTML/JS** — no build step, a single `public/index.html`
- **dotenv** — environment config

---

## Quick start (local)

Prerequisite: Node.js 22+ via [nvm](https://github.com/nvm-sh/nvm). The system Node 10 will not work.

```bash
git clone https://github.com/Dmitryfor/surf-key-crm-stock.git
cd surf-key-crm-stock
nvm use 22
npm install
cp .env.example .env
# edit .env and set KEYCRM_API_KEY
npm run dev
# → http://localhost:3000
```

Stop the server:

```bash
lsof -ti:3000 | xargs kill -9
```

> Local dev runs the Express server (`server.js`) with no auth and no CDN caching — fast iteration on UI changes.
> To test the exact production path (serverless function + Basic Auth middleware), use `vercel dev`.

---

## Configuration

`.env` (gitignored — never commit):

| Variable | Description | Default |
|---|---|---|
| `KEYCRM_API_KEY` | API key from KeyCRM → Settings → API → API keys | — (required) |
| `AUTH_USER` | Basic Auth login (production only) | — |
| `AUTH_PASS` | Basic Auth password (production only) | — |
| `PORT` | Local server port | `3000` |

---

## Architecture

```
keycrm-stocks/
├── .env.example        # Template, no secrets
├── .gitignore
├── package.json
├── server.js           # Local dev: Express + KeyCRM proxy
├── api/
│   └── stocks.js       # Vercel serverless function (prod)
├── middleware.js       # Vercel edge Basic Auth (prod)
├── vercel.json         # Vercel config
├── public/
│   └── index.html      # UI (Russian, mobile-friendly)
├── CLAUDE.md           # Claude Code project memory
└── README.md
```

### Data flow (production)

```
Browser → GET surf-stocks.vercel.app/api/stocks
            ↓ (Basic Auth via middleware.js)
        api/stocks.js (serverless)
            ↓ (Bearer + parallel pagination, concurrency 4)
        KeyCRM API: GET /offers?include=product&limit=50&page=N
            ↓
        Field mapping → JSON { updated_at, count, items: [...] }
            ↓ (Cache-Control: s-maxage=30, SWR=60 — Vercel edge cache)
        Browser renders the table
```

One full refresh = `Math.ceil(total / 50)` requests to KeyCRM (e.g. 9 requests for 445 variants). The 30-second CDN cache means most page loads do not hit KeyCRM at all.

### KeyCRM API notes

- Base URL: `https://openapi.keycrm.app/v1`
- Auth: `Authorization: Bearer <KEYCRM_API_KEY>`
- Rate limit: **60 requests per minute** per IP per key
- Endpoint used: `GET /offers?include=product`
- **Field name gotcha**: the response field is `in_reserve`, not `reserve` as the Swagger spec claims

---

## Deploy to Vercel

The repo is wired to auto-deploy from the `main` branch.

1. Push to GitHub.
2. On [vercel.com/new](https://vercel.com/new) → Import this repository.
3. Set **Application Preset**: `Other` (do not use the Express preset — it would conflict with the `api/` and `middleware.js` layout).
4. Environment Variables:
   - `KEYCRM_API_KEY`
   - `AUTH_USER`
   - `AUTH_PASS`
5. Click **Deploy**.

Subsequent commits to `main` will auto-deploy.

Edge Middleware (`middleware.js`) gates every route with HTTP Basic Auth. The browser shows a native login prompt and stores the credentials in its keychain.

### Local Vercel emulation

For testing the production pipeline locally (including middleware and serverless function):

```bash
npm i -g vercel
vercel link            # link this folder to the Vercel project
vercel dev             # runs on :3000 with full Vercel runtime
```

---

## Troubleshooting

### `401 Unauthorized` from KeyCRM
- Verify `KEYCRM_API_KEY` is set in `.env` (local) or Vercel env vars (prod).
- Restart the local server after editing `.env` (dotenv reads it only at startup).
- If still failing, rotate the key in KeyCRM and retry.

### `429 Too Many Requests` from KeyCRM
- Hit the 60-req/min rate limit. Increase `BATCH_DELAY_MS` in `server.js` / `api/stocks.js` from `200` to `500`.
- Wait one minute — the limit resets.

### `MIDDLEWARE_INVOCATION_FAILED` on Vercel
- Usually a Latin-1 encoding issue if non-ASCII characters are used in `AUTH_PASS`. The middleware now uses `TextEncoder` + UTF-8 → Latin-1 → base64 to handle any character. If you see this error, check the Vercel runtime logs for the actual exception.

### Mobile Safari zooms in on the search input
- The input has `font-size: 16px` to prevent iOS Safari from auto-zooming on focus. If you customize the CSS, do not drop the search font-size below `16px`.

### Adding a new field to the table
1. Run `curl -H "Authorization: Bearer $KEY" "https://openapi.keycrm.app/v1/offers?limit=1&include=product"` and inspect the **real** field name (the Swagger spec lies in places).
2. In both `server.js` and `api/stocks.js` → the `mapOffer` function — add the field.
3. In `public/index.html`:
   - Add a `<span class="sort" data-sort="key">…</span>` to the header.
   - Add the field to the row template and adjust `grid-template-columns`.
4. Restart `npm run dev`.

---

## Roadmap

In rough order of likelihood:

1. Auto-refresh by timer in the UI (checkbox + interval selector)
2. CSV export for Google Sheets
3. Per-warehouse breakdown — switch to `/offers/stocks?filter[details]=true` if separate warehouses appear
4. Webhook from KeyCRM instead of pull, for real-time updates as the catalog grows
5. WooCommerce sync — separate project: when the store launches, sync stocks from KeyCRM to WC by SKU

---

## Links

- [KeyCRM API docs](https://docs.keycrm.app/)
- [KeyCRM OpenAPI spec (YAML)](https://keycrm.s3.de.io.cloud.ovh.net/static/open-api.yml)
- [Vercel docs — Edge Middleware](https://vercel.com/docs/routing-middleware)

---

## License

MIT
