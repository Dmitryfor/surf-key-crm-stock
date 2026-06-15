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

// orders[] → { label: { orders, revenue } }. Cancelled orders (status_group_id 6) excluded —
// they are not real demand (mirrors the sales-tab philosophy).
function bucketOrders(orders) {
  const out = {};
  for (const o of orders) {
    if (o.status_group_id === 6) continue;
    const label = geoLabelOf(o);
    const rev = Number(o.grand_total) || 0;
    if (!out[label]) out[label] = { orders: 0, revenue: 0 };
    out[label].orders += 1;
    out[label].revenue += rev;
  }
  return out;
}

// { label: {orders,revenue} } → sorted [{ name, orders, revenue, pct }] desc by orders.
function regionsArray(bucketObj) {
  const total = Object.values(bucketObj).reduce((s, r) => s + r.orders, 0) || 1;
  return Object.entries(bucketObj)
    .map(([name, r]) => ({
      name,
      orders: r.orders,
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
        total_revenue: regions.reduce((s, r) => s + r.revenue, 0),
        regions,
      };
    });

  // overall = sum across every month
  const overallObj = {};
  for (const v of Object.values(merged)) {
    for (const [name, r] of Object.entries(v.regions || {})) {
      if (!overallObj[name]) overallObj[name] = { orders: 0, revenue: 0 };
      overallObj[name].orders += r.orders;
      overallObj[name].revenue += r.revenue;
    }
  }
  const overallRegions = regionsArray(overallObj);
  const overall = {
    ym: 'all',
    label: 'Общая',
    total_orders: overallRegions.reduce((s, r) => s + r.orders, 0),
    total_revenue: overallRegions.reduce((s, r) => s + r.revenue, 0),
    regions: overallRegions,
  };

  return { overall, months };
}

module.exports = {
  RU_MONTHS,
  REGION_SHORT,
  COUNTRY_SHORT,
  ymLabel,
  geoLabelOf,
  bucketOrders,
  regionsArray,
  buildGeoResponse,
};
