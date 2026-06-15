require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const geo = require('./lib/geo');
const auth = require('./lib/auth');

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
  console.error('FATAL: KEYCRM_API_KEY not set in .env');
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

// ── Sales aggregation ──

const RU_MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

// KeyCRM order status group_id → UI bucket.
// g1 new · g2 принято/предоплата · g3 бронь · g4 доставка · g5 completed · g6 отмена/возврат/обмен
const GROUP_BUCKET = { 1: 'pending', 2: 'pending', 3: 'pending', 4: 'shipped', 5: 'done', 6: 'cancelled' };

const BUCKETS = [
  { cls: 'done', name: 'Выполнено и оплачено' },
  { cls: 'shipped', name: 'Отправлено / в доставке' },
  { cls: 'pending', name: 'Новые / не отправлены' },
  { cls: 'cancelled', name: 'Отменённые' },
];

const pad = (n) => String(n).padStart(2, '0');

// monthOffset: 0 = current month, -1 = previous
function monthRange(monthOffset) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 1-12
  const days = new Date(year, month, 0).getDate();
  return {
    from: `${year}-${pad(month)}-01 00:00:00`,
    to: `${year}-${pad(month)}-${pad(days)} 23:59:59`,
    ym: `${year}-${pad(month)}`,
    label: `${RU_MONTHS[d.getMonth()]} ${year}`,
  };
}

// created  — orders created in the period (filter[created_between])
// closed   — orders whose closed_at falls in the period AND status is completed (g5)
function aggregateSales(created, closed) {
  const status = { done: { orders: 0, revenue: 0 }, shipped: { orders: 0, revenue: 0 }, pending: { orders: 0, revenue: 0 }, cancelled: { orders: 0, revenue: 0 } };
  const mgr = new Map();
  const ensure = (name) => {
    let m = mgr.get(name);
    if (!m) { m = { name, created_orders: 0, created_revenue: 0, closed_orders: 0, closed_revenue: 0 }; mgr.set(name, m); }
    return m;
  };

  // by creation date — status block + KPI + manager "Дата оформлення"
  for (const o of created) {
    const rev = Number(o.grand_total) || 0;
    const bucket = GROUP_BUCKET[o.status_group_id] || 'pending';
    status[bucket].orders += 1;
    status[bucket].revenue += rev;
    if (bucket !== 'cancelled') {
      const m = ensure((o.manager && o.manager.full_name) || 'Без менеджера');
      m.created_orders += 1;
      m.created_revenue += rev;
    }
  }

  // by closing date — manager "Дата закриття"
  for (const o of closed) {
    const rev = Number(o.grand_total) || 0;
    const m = ensure((o.manager && o.manager.full_name) || 'Без менеджера');
    m.closed_orders += 1;
    m.closed_revenue += rev;
  }

  return {
    statuses: BUCKETS.map((b) => ({
      cls: b.cls,
      name: b.name,
      orders: status[b.cls].orders,
      revenue: Math.round(status[b.cls].revenue),
    })),
    managers: [...mgr.values()]
      .map((m) => ({ ...m, created_revenue: Math.round(m.created_revenue), closed_revenue: Math.round(m.closed_revenue) }))
      .sort((a, b) => b.created_revenue - a.created_revenue),
  };
}

async function fetchPeriod(monthOffset) {
  const range = monthRange(monthOffset);
  // KeyCRM has no closed-date filter → fetch updated_between candidates, keep those closed in the period.
  const [created, updated] = await Promise.all([
    paginateAll('/order', { 'filter[created_between]': `${range.from},${range.to}`, include: 'manager' }),
    paginateAll('/order', { 'filter[updated_between]': `${range.from},${range.to}`, include: 'manager' }),
  ]);
  const closed = updated.filter(
    (o) => o.closed_at && String(o.closed_at).slice(0, 7) === range.ym && o.status_group_id === 5
  );
  return { label: range.label, ym: range.ym, ...aggregateSales(created, closed) };
}

async function fetchSales() {
  const t0 = Date.now();
  const [current, previous] = await Promise.all([fetchPeriod(0), fetchPeriod(-1)]);
  return {
    updated_at: new Date().toISOString(),
    took_ms: Date.now() - t0,
    current,
    previous,
  };
}

// ── Geography aggregation ──

const GEO_SNAPSHOT_PATH = path.join(__dirname, 'data', 'geo-snapshot.json');

function loadGeoSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(GEO_SNAPSHOT_PATH, 'utf8'));
  } catch {
    return { months: {} };
  }
}

// Re-fetch current + previous month live, bucket by region (overlays the snapshot).
async function fetchGeoLiveMonths() {
  const ranges = [monthRange(0), monthRange(-1)];
  const fetched = await Promise.all(
    ranges.map((r) =>
      paginateAll('/order', { 'filter[created_between]': `${r.from},${r.to}`, include: 'shipping' })
    )
  );
  const live = {};
  ranges.forEach((r, i) => {
    live[r.ym] = { label: r.label, regions: geo.bucketOrders(fetched[i]) };
  });
  return live;
}

async function fetchGeo() {
  const t0 = Date.now();
  const snapshot = loadGeoSnapshot();
  const live = await fetchGeoLiveMonths();
  const { overall, months } = geo.buildGeoResponse(snapshot.months || {}, live);
  return {
    updated_at: new Date().toISOString(),
    took_ms: Date.now() - t0,
    snapshot_generated_at: snapshot.generated_at || null,
    overall,
    months,
  };
}

let cache = null;
let inflight = null;
let salesCache = null;
let salesInflight = null;
const SALES_CACHE_TTL_MS = 300_000;
let geoCache = null;
let geoInflight = null;
const GEO_CACHE_TTL_MS = 300_000;

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

// ── Local Basic Auth (dev parity with the edge middleware) ──
// Active ONLY when AUTH_USER/AUTH_PASS are set in .env. Mirrors middleware.js so you can test
// the manager vs admin role split locally in the browser. Without those vars → open dev mode.
app.use((req, res, next) => {
  const cfg = auth.authConfig();
  if (!cfg.managerConfigured) return next(); // open dev mode

  const managerToken = auth.roleToken('manager', cfg.secret);
  const adminToken = cfg.adminConfigured ? auth.roleToken('admin', cfg.secret) : null;

  // 1) Already logged in → valid role cookie.
  const cookie = auth.readCookie(req.headers.cookie, auth.COOKIE_NAME);
  if (adminToken && auth.safeEqual(cookie, adminToken)) return next();
  if (auth.safeEqual(cookie, managerToken)) return next();

  // 2) Validate Basic Auth header, then remember via cookie (redirect to self).
  const m = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (m) {
    let decoded = '';
    try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (_) {}
    const i = decoded.indexOf(':');
    const u = decoded.slice(0, i);
    const p = decoded.slice(i + 1);
    const remember = (token) => {
      res.set('Set-Cookie', `${auth.COOKIE_NAME}=${token}; Path=/; Max-Age=${auth.COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`);
      res.set('Cache-Control', 'no-store');
      res.redirect(302, req.originalUrl);
    };
    if (cfg.adminConfigured && auth.safeEqual(u, cfg.adminUser) && auth.safeEqual(p, cfg.adminPass)) return remember(adminToken);
    if (auth.safeEqual(u, cfg.managerUser) && auth.safeEqual(p, cfg.managerPass)) return remember(managerToken);
  }

  // 3) Challenge.
  res.set('WWW-Authenticate', 'Basic realm="KeyCRM Stocks (local)"');
  res.set('Cache-Control', 'no-store');
  res.status(401).send('Auth required');
});

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
    if (status === 401) hint = ' — check KEYCRM_API_KEY in .env';
    else if (status === 429) hint = ' — KeyCRM API rate limit exceeded (60 req/min)';
    else if (status === 504) hint = ' — request to KeyCRM timed out';
    console.error(`[/api/stocks] ${status}: ${e.message}`);
    res.status(status).json({ error: `${e.message}${hint}` });
  }
});

app.get('/api/sales', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const force = req.query.fresh === '1';

  if (!force && salesCache && now - salesCache.ts < SALES_CACHE_TTL_MS) {
    return res.json({ ...salesCache.payload, cached: true, age_ms: now - salesCache.ts });
  }

  try {
    if (!salesInflight) {
      salesInflight = fetchSales().finally(() => { salesInflight = null; });
    }
    const payload = await salesInflight;
    salesCache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' ? 504 : 500);
    let hint = '';
    if (status === 401) hint = ' — check KEYCRM_API_KEY in .env';
    else if (status === 429) hint = ' — KeyCRM API rate limit exceeded (60 req/min)';
    else if (status === 504) hint = ' — request to KeyCRM timed out';
    console.error(`[/api/sales] ${status}: ${e.message}`);
    res.status(status).json({ error: `${e.message}${hint}` });
  }
});

// Local dev (npm run dev) has no Basic Auth → treat the developer as admin so GEO works.
// If AUTH_USER/AUTH_PASS are set locally, enforce the same role rules as prod.
function localIsAdmin(req) {
  const cfg = auth.authConfig();
  if (!cfg.managerConfigured) return true; // open dev mode
  return auth.isAdmin(req.headers.cookie);
}

app.get('/api/role', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const cfg = auth.authConfig();
  if (!cfg.managerConfigured) return res.json({ role: 'admin', admin: true, dev: true });
  const role = auth.roleFromCookie(req.headers.cookie) || 'manager';
  res.json({ role, admin: role === 'admin' });
});

app.get('/api/geo', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  // GEO is admin-only (role from the Basic Auth account).
  if (!localIsAdmin(req)) {
    return res.status(403).json({ error: 'Доступно только администратору' });
  }

  const now = Date.now();
  const force = req.query.fresh === '1';

  if (!force && geoCache && now - geoCache.ts < GEO_CACHE_TTL_MS) {
    return res.json({ ...geoCache.payload, cached: true, age_ms: now - geoCache.ts });
  }

  try {
    if (!geoInflight) {
      geoInflight = fetchGeo().finally(() => { geoInflight = null; });
    }
    const payload = await geoInflight;
    geoCache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' ? 504 : 500);
    let hint = '';
    if (status === 401) hint = ' — check KEYCRM_API_KEY in .env';
    else if (status === 429) hint = ' — KeyCRM API rate limit exceeded (60 req/min)';
    else if (status === 504) hint = ' — request to KeyCRM timed out';
    console.error(`[/api/geo] ${status}: ${e.message}`);
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
