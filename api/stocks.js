const API_KEY = process.env.KEYCRM_API_KEY;
const BASE_URL = 'https://openapi.keycrm.app/v1';
const PAGE_LIMIT = 50;
const CONCURRENCY = 4;
const BATCH_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 15_000;

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
  return label || '-';
}

function mapOffer(o) {
  const quantity = Number(o.quantity) || 0;
  const reserve = Number(o.in_reserve) || 0;
  return {
    id: o.id,
    sku: o.sku || '-',
    product_id: o.product_id || 0,
    product_name: (o.product && o.product.name) || 'No product',
    variant_name: buildVariantLabel(o),
    price: o.price != null ? o.price : null,
    quantity,
    reserve,
    available: quantity - reserve,
  };
}

async function fetchStocks() {
  const t0 = Date.now();
  const offers = await paginateAll('/offers', { include: 'product' });
  const active = offers.filter((o) => !o.is_archived); // hide archived variants
  return {
    updated_at: new Date().toISOString(),
    count: active.length,
    archived_hidden: offers.length - active.length,
    took_ms: Date.now() - t0,
    items: active.map(mapOffer),
  };
}

export default async function handler(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: 'KEYCRM_API_KEY not set in env' });
    return;
  }

  const force = req.query?.fresh === '1';
  res.setHeader(
    'Cache-Control',
    force ? 'no-store' : 'public, s-maxage=30, stale-while-revalidate=60'
  );

  try {
    const payload = await fetchStocks();
    res.status(200).json(payload);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' ? 504 : 500);
    let hint = '';
    if (status === 401) hint = ' — check KEYCRM_API_KEY';
    else if (status === 429) hint = ' — KeyCRM API rate limit exceeded (60 req/min)';
    else if (status === 504) hint = ' — request to KeyCRM timed out';
    console.error(`[/api/stocks] ${status}: ${e.message}`);
    res.status(status).json({ error: `${e.message}${hint}` });
  }
}
