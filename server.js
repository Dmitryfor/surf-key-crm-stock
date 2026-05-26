require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.KEYCRM_API_KEY;
const BASE_URL = 'https://openapi.keycrm.app/v1';
const PAGE_LIMIT = 50;
const PAGE_DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function keycrmGet(pathname, params = {}) {
  const url = new URL(BASE_URL + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`KeyCRM ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function paginate(pathname, extraParams = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await keycrmGet(pathname, { ...extraParams, limit: PAGE_LIMIT, page });
    if (Array.isArray(data.data)) all.push(...data.data);
    const last = data.last_page || (data.data && data.data.length < PAGE_LIMIT ? page : page + 1);
    if (page >= last || !data.data || data.data.length === 0) break;
    page += 1;
    await sleep(PAGE_DELAY_MS);
  }
  return all;
}

function buildVariantLabel(offer) {
  const props = Array.isArray(offer.properties) ? offer.properties : [];
  const label = props.map((p) => p.value).filter(Boolean).join(' / ');
  return label || '—';
}

app.get('/api/stocks', async (req, res) => {
  if (!API_KEY || API_KEY === 'your-api-key-here') {
    return res.status(500).json({ error: 'KEYCRM_API_KEY не задан в .env' });
  }
  try {
    const offers = await paginate('/offers', { include: 'product' });

    const items = offers.map((o) => {
      const quantity = Number(o.quantity || 0);
      const reserve = Number(o.in_reserve || 0);
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
    });

    res.json({
      updated_at: new Date().toISOString(),
      count: items.length,
      items,
    });
  } catch (e) {
    const status = e.status || 500;
    let hint = '';
    if (status === 401) hint = ' — проверь KEYCRM_API_KEY в .env';
    if (status === 429) hint = ' — превышен лимит KeyCRM API (60 req/min)';
    res.status(status).json({ error: `${e.message}${hint}` });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`KeyCRM stocks dashboard → http://localhost:${PORT}`);
});
