// Shared geography helpers for the "География" tab.
// Used by scripts/geo-backfill.js (CJS), server.js (CJS) and api/geo.js (ESM via default import).
// Single source of truth for region label mapping + order bucketing.

const RU_MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

// KeyCRM shipping.shipping_address_region (oblast, Ukrainian) → short label as on Dmitry's screenshot.
// Unknown regions fall through to the raw value.
const REGION_SHORT = {
  'Київська': 'Київ', 'Київ': 'Київ', 'м. Київ': 'Київ',
  'Львівська': 'Львів',
  'Рівненська': 'Рівне',
  'Одеська': 'Одеса',
  'Вінницька': 'Вінниця',
  'Волинська': 'Луцьк',
  'Дніпропетровська': 'Дніпро',
  'Закарпатська': 'Закарпаття (Ужгород)',
  'Івано-Франківська': 'Івано-Франківськ',
  'Харківська': 'Харків',
  'Хмельницька': 'Хмельницький',
  'Чернівецька': 'Чернівці',
  'Черкаська': 'Черкаси',
  'Полтавська': 'Полтава',
  'Житомирська': 'Житомир',
  'Тернопільська': 'Тернопіль',
  'Чернігівська': 'Чернігів',
  'Миколаївська': 'Миколаїв',
  'Сумська': 'Суми',
  'Кіровоградська': 'Кропивницький',
  'Запорізька': 'Запоріжжя',
  'Херсонська': 'Херсон',
  'Донецька': 'Донецьк',
  'Луганська': 'Луганськ',
  'Севастополь': 'Севастополь', 'м. Севастополь': 'Севастополь',
  'АР Крим': 'Крим', 'Автономна Республіка Крим': 'Крим',
};

// Foreign orders: no region, only a country. Normalize a few common ones.
const COUNTRY_SHORT = {
  'Poland': 'Польща', 'Польша': 'Польща', 'Польща': 'Польща',
  'Ukraine': 'Україна (інше)', 'Украина': 'Україна (інше)', 'Україна': 'Україна (інше)',
};

// "2026-06" → "Июнь 2026"
function ymLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return `${RU_MONTHS[(m || 1) - 1]} ${y}`;
}

// One order → geography label. Region first, country fallback, then "Не указано".
function geoLabelOf(order) {
  const s = order && order.shipping;
  if (!s) return 'Не указано';
  const region = (s.shipping_address_region || '').trim();
  if (region) return REGION_SHORT[region] || region;
  const country = (s.shipping_address_country || '').trim();
  if (country) return COUNTRY_SHORT[country] || country;
  return 'Не указано';
}

// orders[] → { label: { orders, revenue } }. ALL orders counted, including cancelled —
// this matches KeyCRM's own "Замовлення по регіонах" report (its source of truth for Dmitry).
// (The sales tab still excludes cancelled — that's about revenue, this is about order geography.)
function bucketOrders(orders) {
  const out = {};
  for (const o of orders) {
    const label = geoLabelOf(o);
    const rev = Number(o.grand_total) || 0;
    if (!out[label]) out[label] = { orders: 0, revenue: 0, cancelled: 0 };
    out[label].orders += 1;
    out[label].revenue += rev;
    if (o.status_group_id === 6) out[label].cancelled += 1; // total counts all; track cancelled separately
  }
  return out;
}

// One order line item → variant label from properties[] ("Лимонний", "Беж / L"). Empty if none.
function variantLabelOf(product) {
  const props = Array.isArray(product && product.properties) ? product.properties : [];
  return props.map((p) => p && p.value).filter(Boolean).join(' / ');
}

const pct1 = (part, whole) => (whole ? +((part / whole) * 100).toFixed(1) : 0);

// orders[] (ALL orders of one month, every status) → cancelled summary grouped by product
// with a per-color (variant) breakdown. Cancelled = status_group_id === 6.
// Per position we track BOTH cancelled and total (all-status) distinct orders, so the UI
// can show "Заказов = всего по позиции" and "% отказов" = cancelled / total orders.
// Distinct orders (not line items): one order may hold several colors of the same product.
function aggregateCancelled(orders) {
  const products = {}; // name → { name, qty, cancOrders:Set, allOrders:Set, revenue, variants }
  for (const o of orders) {
    const isCanc = o.status_group_id === 6;
    for (const p of o.products || []) {
      const variant = variantLabelOf(p) || '—';
      const name = p.name || p.sku || '—';
      const qty = Number(p.quantity) || 0;
      const rev = (Number(p.price) || 0) * qty;
      if (!products[name]) products[name] = { name, qty: 0, cancOrders: new Set(), allOrders: new Set(), revenue: 0, variants: {} };
      const prod = products[name];
      prod.allOrders.add(o.id);
      const vkey = `${p.sku || ''}||${variant}`;
      if (!prod.variants[vkey]) prod.variants[vkey] = { label: variant, sku: p.sku || '', qty: 0, cancOrders: new Set(), allOrders: new Set(), revenue: 0 };
      const v = prod.variants[vkey];
      v.allOrders.add(o.id);
      if (isCanc) {
        prod.qty += qty; prod.revenue += rev; prod.cancOrders.add(o.id);
        v.qty += qty; v.revenue += rev; v.cancOrders.add(o.id);
      }
    }
  }
  const items = Object.values(products)
    .filter((prod) => prod.cancOrders.size > 0) // only positions with at least one refusal
    .map((prod) => ({
      name: prod.name,
      qty: prod.qty,
      orders: prod.cancOrders.size,        // cancelled distinct orders
      total_orders: prod.allOrders.size,   // all distinct orders with this position
      pct: pct1(prod.cancOrders.size, prod.allOrders.size),
      revenue: Math.round(prod.revenue),
      variants: Object.values(prod.variants)
        .filter((v) => v.cancOrders.size > 0)
        .map((v) => ({
          label: v.label,
          sku: v.sku,
          qty: v.qty,
          orders: v.cancOrders.size,
          total_orders: v.allOrders.size,
          pct: pct1(v.cancOrders.size, v.allOrders.size),
          revenue: Math.round(v.revenue),
        }))
        .sort((a, b) => b.qty - a.qty || b.orders - a.orders),
    }))
    .sort((a, b) => b.qty - a.qty || b.orders - a.orders);
  const canc = orders.filter((o) => o.status_group_id === 6);
  return {
    orders: canc.length,
    revenue: Math.round(canc.reduce((s, o) => s + (Number(o.grand_total) || 0), 0)),
    items,
  };
}

// Merge several monthly cancelled summaries into one (for the "Общая" view). Months don't
// overlap, so order counts simply add up; pct is recomputed from the summed totals.
function mergeCancelled(list) {
  const prods = {};
  let orders = 0, revenue = 0;
  for (const c of list) {
    if (!c) continue;
    orders += c.orders || 0;
    revenue += c.revenue || 0;
    for (const it of c.items || []) {
      if (!prods[it.name]) prods[it.name] = { name: it.name, qty: 0, orders: 0, total_orders: 0, revenue: 0, variants: {} };
      const g = prods[it.name];
      g.qty += it.qty; g.orders += it.orders; g.total_orders += it.total_orders; g.revenue += it.revenue;
      for (const v of it.variants || []) {
        const vk = `${v.sku}||${v.label}`;
        if (!g.variants[vk]) g.variants[vk] = { label: v.label, sku: v.sku, qty: 0, orders: 0, total_orders: 0, revenue: 0 };
        const gv = g.variants[vk];
        gv.qty += v.qty; gv.orders += v.orders; gv.total_orders += v.total_orders; gv.revenue += v.revenue;
      }
    }
  }
  const items = Object.values(prods)
    .map((g) => ({
      name: g.name, qty: g.qty, orders: g.orders, total_orders: g.total_orders,
      pct: pct1(g.orders, g.total_orders), revenue: g.revenue,
      variants: Object.values(g.variants)
        .map((v) => ({ ...v, pct: pct1(v.orders, v.total_orders) }))
        .sort((a, b) => b.qty - a.qty || b.orders - a.orders),
    }))
    .sort((a, b) => b.qty - a.qty || b.orders - a.orders);
  return { orders, revenue, items };
}

// { label: {orders,revenue,cancelled} } → sorted [{ name, orders, cancelled, revenue, pct }] desc by orders.
function regionsArray(bucketObj) {
  const total = Object.values(bucketObj).reduce((s, r) => s + r.orders, 0) || 1;
  return Object.entries(bucketObj)
    .map(([name, r]) => ({
      name,
      orders: r.orders,
      cancelled: r.cancelled || 0,
      revenue: Math.round(r.revenue),
      pct: +((r.orders / total) * 100).toFixed(1),
    }))
    .sort((a, b) => b.orders - a.orders);
}

// snapshotMonths + liveMonths (both { ym: {label, regions:{label:{orders,revenue}}} }) →
// { overall, months[] }. liveMonths override snapshot for the same ym (current/previous refreshed live).
function buildGeoResponse(snapshotMonths, liveMonths) {
  const merged = { ...(snapshotMonths || {}) };
  for (const [ym, v] of Object.entries(liveMonths || {})) merged[ym] = v;

  const months = Object.keys(merged)
    .sort()
    .reverse()
    .map((ym) => {
      const regions = regionsArray(merged[ym].regions || {});
      return {
        ym,
        label: merged[ym].label || ymLabel(ym),
        total_orders: regions.reduce((s, r) => s + r.orders, 0),
        total_cancelled: regions.reduce((s, r) => s + r.cancelled, 0),
        total_revenue: regions.reduce((s, r) => s + r.revenue, 0),
        regions,
        cancelled: merged[ym].cancelled || null, // per-month refused-positions breakdown
      };
    });

  // overall = sum across every month
  const overallObj = {};
  for (const v of Object.values(merged)) {
    for (const [name, r] of Object.entries(v.regions || {})) {
      if (!overallObj[name]) overallObj[name] = { orders: 0, revenue: 0, cancelled: 0 };
      overallObj[name].orders += r.orders;
      overallObj[name].revenue += r.revenue;
      overallObj[name].cancelled += r.cancelled || 0;
    }
  }
  const overallRegions = regionsArray(overallObj);
  const overall = {
    ym: 'all',
    label: 'Общая',
    total_orders: overallRegions.reduce((s, r) => s + r.orders, 0),
    total_cancelled: overallRegions.reduce((s, r) => s + r.cancelled, 0),
    total_revenue: overallRegions.reduce((s, r) => s + r.revenue, 0),
    regions: overallRegions,
    cancelled: mergeCancelled(months.map((m) => m.cancelled)), // merged across all months
  };

  return { overall, months };
}

module.exports = {
  RU_MONTHS,
  REGION_SHORT,
  COUNTRY_SHORT,
  ymLabel,
  geoLabelOf,
  variantLabelOf,
  aggregateCancelled,
  mergeCancelled,
  bucketOrders,
  regionsArray,
  buildGeoResponse,
};
