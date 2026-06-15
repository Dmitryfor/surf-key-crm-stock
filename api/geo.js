import geo from '../lib/geo.js';
import auth from '../lib/auth.js';
// Bundled into the function by esbuild (no runtime fs / import.meta — those break the CJS bundle on Vercel).
import snapshot from '../data/geo-snapshot.json';

const { bucketOrders, buildGeoResponse } = geo;

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
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
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

const pad = (n) => String(n).padStart(2, '0');
const RU_MONTHS = geo.RU_MONTHS;

// monthOffset: 0 = current month, -1 = previous
function monthRange(monthOffset) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const days = new Date(year, month, 0).getDate();
  return {
    from: `${year}-${pad(month)}-01 00:00:00`,
    to: `${year}-${pad(month)}-${pad(days)} 23:59:59`,
    ym: `${year}-${pad(month)}`,
    label: `${RU_MONTHS[d.getMonth()]} ${year}`,
  };
}

function loadSnapshot() {
  return snapshot && snapshot.months ? snapshot : { months: {} };
}

// Re-fetch current + previous month live, bucket by region.
async function fetchLiveMonths() {
  const ranges = [monthRange(0), monthRange(-1)];
  const fetched = await Promise.all(
    ranges.map((r) =>
      paginateAll('/order', { 'filter[created_between]': `${r.from},${r.to}`, include: 'shipping' })
    )
  );
  const live = {};
  ranges.forEach((r, i) => {
    live[r.ym] = { label: r.label, regions: bucketOrders(fetched[i]) };
  });
  return live;
}

async function fetchGeo() {
  const t0 = Date.now();
  const snap = loadSnapshot();
  const live = await fetchLiveMonths();
  const { overall, months } = buildGeoResponse(snap.months || {}, live);
  return {
    updated_at: new Date().toISOString(),
    took_ms: Date.now() - t0,
    snapshot_generated_at: snap.generated_at || null,
    overall,
    months,
  };
}

export default async function handler(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: 'KEYCRM_API_KEY not set in env' });
    return;
  }

  // GEO is admin-only. Role comes from the Basic Auth account (signed surf_auth cookie).
  if (!auth.authConfig().adminConfigured) {
    res.status(500).json({ error: 'Admin account not configured (set ADMIN_USER / ADMIN_PASS)' });
    return;
  }
  if (!auth.isAdmin(req.headers.cookie)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(403).json({ error: 'Доступно только администратору' });
    return;
  }

  // Admin-only data → never use the shared CDN cache (keyed by URL, not by role):
  // a cached copy could otherwise be served to a manager hitting /api/geo directly.
  res.setHeader('Cache-Control', 'no-store');

  try {
    const payload = await fetchGeo();
    res.status(200).json(payload);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' ? 504 : 500);
    let hint = '';
    if (status === 401) hint = ' — check KEYCRM_API_KEY';
    else if (status === 429) hint = ' — KeyCRM API rate limit exceeded (60 req/min)';
    else if (status === 504) hint = ' — request to KeyCRM timed out';
    console.error(`[/api/geo] ${status}: ${e.message}`);
    res.status(status).json({ error: `${e.message}${hint}` });
  }
}
