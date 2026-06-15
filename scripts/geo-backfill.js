// One-time (and periodic) backfill of the geography snapshot.
//
// KeyCRM has ~3800+ orders = 77 pages. The 60 req/min rate limit makes it impossible
// to fetch all of them inside a single serverless request. So we paginate the WHOLE
// history ONCE here, slowly (sequential, ~1.1s between pages → under 60/min), and write
// per-month region aggregates to data/geo-snapshot.json.
//
// The live /api/geo endpoint then reads this snapshot and only re-fetches the current +
// previous month live, overlaying them on top. Re-run this script to refresh older months:
//
//   nvm use 22 && node scripts/geo-backfill.js
//
// Then commit data/geo-snapshot.json and redeploy.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ymLabel, geoLabelOf } = require('../lib/geo');

const API_KEY = process.env.KEYCRM_API_KEY;
const BASE_URL = 'https://openapi.keycrm.app/v1';
const PAGE_LIMIT = 50;
const DELAY_MS = 1100; // ~54 req/min — safely under the 60/min KeyCRM limit
const REQUEST_TIMEOUT_MS = 20_000;
const OUT_PATH = path.join(__dirname, '..', 'data', 'geo-snapshot.json');

if (!API_KEY || API_KEY === 'your-api-key-here') {
  console.error('FATAL: KEYCRM_API_KEY not set in .env');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function keycrmGet(params) {
  const url = new URL(BASE_URL + '/order');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`KeyCRM ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function addOrders(months, orders) {
  for (const o of orders) {
    if (o.status_group_id === 6) continue; // exclude cancelled
    const ym = String(o.created_at).slice(0, 7); // "2026-06"
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    if (!months[ym]) months[ym] = { label: ymLabel(ym), regions: {} };
    const label = geoLabelOf(o);
    const rev = Number(o.grand_total) || 0;
    const r = months[ym].regions;
    if (!r[label]) r[label] = { orders: 0, revenue: 0 };
    r[label].orders += 1;
    r[label].revenue += rev;
  }
}

async function main() {
  const t0 = Date.now();
  const months = {};

  const first = await keycrmGet({ include: 'shipping', limit: PAGE_LIMIT, page: 1 });
  const lastPage = Number(first.last_page) || 1;
  const total = Number(first.total) || 0;
  addOrders(months, first.data || []);
  console.log(`Total orders: ${total} · pages: ${lastPage} · est. ~${Math.ceil((lastPage * DELAY_MS) / 1000)}s`);

  for (let p = 2; p <= lastPage; p++) {
    await sleep(DELAY_MS);
    const res = await keycrmGet({ include: 'shipping', limit: PAGE_LIMIT, page: p });
    addOrders(months, res.data || []);
    process.stdout.write(`\r  page ${p}/${lastPage}`);
  }
  process.stdout.write('\n');

  for (const v of Object.values(months)) {
    for (const r of Object.values(v.regions)) r.revenue = Math.round(r.revenue);
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    source_total: total,
    pages: lastPage,
    months,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));

  const monthKeys = Object.keys(months).sort();
  console.log(`\n✓ Wrote ${OUT_PATH}`);
  console.log(`  months: ${monthKeys.length} (${monthKeys[0]} … ${monthKeys[monthKeys.length - 1]})`);
  console.log(`  took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('\nBackfill failed:', e.message);
  process.exit(1);
});
