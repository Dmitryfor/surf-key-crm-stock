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
  const y0 = now.getFullYear();
  const m0 = now.getMonth() + monthOffset; // can go negative
  const d = new Date(y0, m0, 1);
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
function aggregate(created, closed) {
  const status = { done: { orders: 0, revenue: 0 }, shipped: { orders: 0, revenue: 0 }, pending: { orders: 0, revenue: 0 }, cancelled: { orders: 0, revenue: 0 } };
  const mgr = new Map();
  const ensure = (name) => {
    let m = mgr.get(name);
    if (!m) { m = { name, created_orders: 0, created_revenue: 0, closed_orders: 0, closed_revenue: 0 }; mgr.set(name, m); }
    return m;
  };

  // by creation date — drives the status block + KPI + manager "Дата оформлення"
  for (const o of created) {
    const rev = Number(o.grand_total) || 0;
    const bucket = GROUP_BUCKET[o.status_group_id] || 'pending';
    status[bucket].orders += 1;
    status[bucket].revenue += rev;
    if (bucket !== 'cancelled') { // managers: всё кроме отменённых
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
  return { label: range.label, ...aggregate(created, closed) };
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

export default async function handler(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: 'KEYCRM_API_KEY not set in env' });
    return;
  }

  const force = req.query?.fresh === '1';
  res.setHeader(
    'Cache-Control',
    force ? 'no-store' : 'public, s-maxage=300, stale-while-revalidate=600'
  );

  try {
    const payload = await fetchSales();
    res.status(200).json(payload);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' ? 504 : 500);
    let hint = '';
    if (status === 401) hint = ' — check KEYCRM_API_KEY';
    else if (status === 429) hint = ' — KeyCRM API rate limit exceeded (60 req/min)';
    else if (status === 504) hint = ' — request to KeyCRM timed out';
    console.error(`[/api/sales] ${status}: ${e.message}`);
    res.status(status).json({ error: `${e.message}${hint}` });
  }
}
