require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.KEYCRM_API_KEY;
const BASE_URL = 'https://openapi.keycrm.app/v1';
const PAGE_LIMIT = 50;
const CONCURRENCY = 4;
const BATCH_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30_000;

if (!API_KEY || API_KEY === 'your-api-key-here') {
  console.error('FATAL: KEYCRM_API_KEY не задан в .env');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function keycrmGet(pathname, params = {}) {
  const url = new URL(BASE_URL + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`KeyCRM ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function paginateAll(pathname, extraParams = {}) {
  const first = await keycrmGet(pathname, { ...extraParams, limit: PAGE_LIMIT, page: 1 });
  const items = Array.isArray(first.data) ? [...first.data] : [];
  const lastPage = Number(first.last_page) || 1;
  if (lastPage <= 1) return items;

  const pages = [];
  for (let p = 2; p <= lastPage; p++) pages.push(p);

  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((page) => keycrmGet(pathname, { ...extraParams, limit: PAGE_LIMIT, page }))
    );
    for (const r of results) {
      if (Array.isArray(r.data)) items.push(...r.data);
    }
    if (i + CONCURRENCY < pages.length) await sleep(BATCH_DELAY_MS);
  }
  return items;
}

function buildVariantLabel(offer) {
  const props = Array.isArray(offer.properties) ? offer.properties : [];
  const label = props.map((p) => p.value).filter(Boolean).join(' / ');
  return label || '—';
}

function mapOffer(o) {
  const quantity = Number(o.quantity) || 0;
  const reserve = Number(o.in_reserve) || 0;
  return {
    id: o.id,
    sku: o.sku || '—',
    product_id: o.product_id || 0,
    product_name: (o.product && o.product.name) || 'Без товара',
    variant_name: buildVariantLabel(o),
    price: o.price != null ? o.price : null,
    quantity,
    reserve,
    available: quantity - reserve,
  };
}

let cache = null;
let inflight = null;

async function fetchStocks() {
  const t0 = Date.now();
  const offers = await paginateAll('/offers', { include: 'product' });
  return {
    updated_at: new Date().toISOString(),
    count: offers.length,
    took_ms: Date.now() - t0,
    items: offers.map(mapOffer),
  };
}

app.get('/api/stocks', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const force = req.query.fresh === '1';

  if (!force && cache && now - cache.ts < CACHE_TTL_MS) {
    return res.json({ ...cache.payload, cached: true, age_ms: now - cache.ts });
  }

  try {
    if (!inflight) {
      inflight = fetchStocks().finally(() => { inflight = null; });
    }
    const payload = await inflight;
    cache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' ? 504 : 500);
    let hint = '';
    if (status === 401) hint = ' — проверь KEYCRM_API_KEY в .env';
    else if (status === 429) hint = ' — превышен лимит KeyCRM API (60 req/min)';
    else if (status === 504) hint = ' — таймаут запроса к KeyCRM';
    console.error(`[/api/stocks] ${status}: ${e.message}`);
    res.status(status).json({ error: `${e.message}${hint}` });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
}));

app.listen(PORT, () => {
  console.log(`KeyCRM stocks dashboard → http://localhost:${PORT}`);
});
