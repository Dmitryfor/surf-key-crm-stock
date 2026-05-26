# KeyCRM Stocks Dashboard

Локальный веб-инструмент, который тянет остатки товаров из KeyCRM API и показывает их в виде таблицы. Используется владельцем surf.ua (Дмитрий) для мониторинга остатков на этапе подготовки WooCommerce-магазина (источник правды по остаткам — KeyCRM, сайт ещё не запущен).

## Quick start

```bash
cd ~/Desktop/keycrm-stocks
nvm use 22                    # КРИТИЧНО: дефолтный node v10 не работает
node server.js
# → http://localhost:3000
```

Останов: `lsof -ti:3000 | xargs kill -9`

## Стек

- **Node.js 22+** (использует встроенный `fetch`, синтаксис `??`/`?.`)
- **Express 5** — статика + один JSON endpoint
- **dotenv** — конфиг через `.env`
- **Vanilla HTML/JS** — никакого билд-процесса, один файл

## Архитектура

```
keycrm-stocks/
├── .env                # KEYCRM_API_KEY, PORT (gitignored, в репо не идёт)
├── .env.example        # Шаблон без секретов
├── .gitignore
├── package.json
├── server.js           # Express + прокси к KeyCRM
└── public/
    └── index.html      # UI: таблица + поиск + сортировка
```

**Поток данных:**

```
Браузер → GET localhost:3000/api/stocks
            ↓
        server.js
            ↓ (Bearer + пагинация + 250ms между страницами)
        KeyCRM API: GET /offers?include=product&limit=50&page=N
            ↓
        Маппинг полей → JSON { updated_at, count, items: [...] }
            ↓
        Браузер рендерит таблицу
```

Один полный обновление = `Math.ceil(total / 50)` запросов к KeyCRM. На ~445 вариантах = 9 запросов = ~2.5 сек.

## KeyCRM API — что нужно помнить

### Авторизация
- Base URL: `https://openapi.keycrm.app/v1`
- Header: `Authorization: Bearer <API_KEY>`
- Ключ хранится в `.env` (поле `KEYCRM_API_KEY`)
- Получить/перевыпустить: KeyCRM → Settings → API → API keys

### Лимиты
- **60 запросов в минуту** с одного IP на ключ
- Между страницами стоит задержка 250ms (`PAGE_DELAY_MS` в `server.js`)
- При 9 страницах × 250ms = 2.25 сек на полное обновление
- Если упрёшься в 429 — KeyCRM возвращает rate-limit, сервер пробросит ошибку наверх

### Несоответствия Swagger ↔ реальный API
Swagger-спека (https://keycrm.s3.de.io.cloud.ovh.net/static/open-api.yml) в нескольких местах расходится с реальностью. Подтверждённые расхождения:

| Endpoint | Swagger говорит | API реально возвращает |
|---|---|---|
| `/offers` | поле `reserve` | поле **`in_reserve`** |
| `/offers/stocks` | поле `reserve` | (не проверяли — может быть так же) |

**Вывод:** перед добавлением новых полей делай тестовый запрос с `limit=1`, смотри реальный ответ. Не доверяй спеке.

### Какой endpoint используется
Сейчас — только `GET /offers?include=product`. Он одним вызовом отдаёт:
- `id`, `sku`, `quantity`, `in_reserve` (остатки)
- `thumbnail_url`, `price`
- `properties[]` (цвет, размер и т.д. — для вариантов)
- `product.name` (родительский товар, через `include=product`)

`/offers/stocks` НЕ используется, потому что `/offers` уже даёт всё нужное и вдвое меньше запросов. **Понадобится `/offers/stocks` если:**
- Нужна разбивка по складам → дополнительно `filter[details]=true`
- Появится подозрение, что `quantity` на `/offers` неточен (тогда сверить)

### Маппинг полей KeyCRM → наш JSON

```js
{
  id: o.id,                                    // ID варианта
  sku: o.sku,                                  // SKU, типа "1057-12"
  name: buildOfferName(o),                     // "Топ 1057 — Рожевий / L"
  thumbnail: o.thumbnail_url,                  // URL картинки (часто null)
  price: o.price,
  quantity: o.quantity,                        // Общий остаток
  reserve: o.in_reserve,                       // ВАЖНО: in_reserve, не reserve
  available: o.quantity - o.in_reserve,        // Доступно к продаже
}
```

`buildOfferName(o)` склеивает `product.name` + значения `properties[]` через `—` и `/`.

## Конфигурация (`.env`)

| Переменная | Описание | По умолчанию |
|---|---|---|
| `KEYCRM_API_KEY` | API-ключ KeyCRM | — (обязательно) |
| `PORT` | Порт локального сервера | 3000 |

## Безопасность

- `.env` в `.gitignore` — никогда не коммитить
- Ключ KeyCRM **никогда** не должен попасть в HTML или клиентский JS — браузер не должен его видеть, всё проксируется через `server.js`
- Если ключ засветился (в чате, в скриншоте, в логах) — **перевыпускать** в KeyCRM немедленно
- Сервер слушает только `localhost:3000` — снаружи недоступен (хорошо)

## Типичные задачи

### Добавить новое поле в таблицу
1. Сделай `curl -H "Authorization: Bearer $KEY" "https://openapi.keycrm.app/v1/offers?limit=1&include=product"` и посмотри, как поле РЕАЛЬНО называется
2. В `server.js` → функция-маппер внутри `app.get('/api/stocks', ...)` — добавь поле в возвращаемый объект
3. В `public/index.html`:
   - Добавь `<th data-sort="ключ">Название</th>` в шапку
   - Добавь `<td>${escape(r.ключ)}</td>` в шаблон строки
4. Перезапусти `node server.js`

### Изменить частоту автообновления
Автообновления пока нет (запрос вручную). Если будем делать — таймер `setInterval` живёт в `public/index.html`, не на сервере. См. план в `/Users/For/.claude/plans/1-cozy-wadler.md`.

### Что делать при 401 после смены ключа
- Проверь что `.env` сохранён
- Перезапусти сервер (dotenv читает `.env` только при старте)
- Если всё равно 401 — ключ в KeyCRM могли отозвать, перевыпусти

### Что делать при 429
- Уменьши частоту обновлений (если есть автообновление)
- Увеличь `PAGE_DELAY_MS` в `server.js` (с 250 до 500)
- Подожди минуту — лимит сбросится

## Roadmap

Следующие шаги (в порядке вероятности):

1. **Автообновление по таймеру** в UI — чекбокс + селектор интервала
2. **Экспорт CSV** для выгрузки в Google Sheets
3. **Разбивка по складам** — переход на `/offers/stocks?filter[details]=true` если у Дмитрия появятся отдельные склады
4. **Webhook от KeyCRM** вместо pull — для real-time обновлений, когда каталог вырастет
5. **Интеграция с WooCommerce** — отдельный проект: при запуске магазина synca стоков из KeyCRM в WC по SKU. Это не сюда, а в плагин WP / отдельный мост.

## Ссылки

- Документация KeyCRM API: https://docs.keycrm.app/
- OpenAPI spec (YAML): https://keycrm.s3.de.io.cloud.ovh.net/static/open-api.yml
- Help: что даёт API: https://help.keycrm.app/uk/process-automation-api-and-more/iaki-mozhlivosti-nadaie-api-key-crm
- План реализации: `/Users/For/.claude/plans/1-cozy-wadler.md`

## Что НЕ нужно делать

- **Не делать запросы к KeyCRM напрямую из браузера** — CORS заблокирует + утечёт ключ
- **Не уменьшать `PAGE_DELAY_MS` ниже 100ms** — упрёшься в rate limit при больших каталогах
- **Не доверять Swagger-спеке без проверки** — она местами врёт (см. `in_reserve` vs `reserve`)
- **Не коммитить `.env`** — `.gitignore` уже защищает, но проверь перед `git add`
- **Не использовать дефолтный системный Node 10** — нужен `nvm use 22` каждый раз в новом терминале

## Стиль общения (caveman)

Все ответы в caveman-режиме (скилл `.claude/skills/caveman/SKILL.md`). Дефолт — **full**.

Drop: артикли (a/an/the), филлеры (just/really/basically/actually/simply), вежливости (sure/certainly/of course), хеджирование. Фрагменты OK. Короткие синонимы. Технические термины — точно. Код, имена функций, error-строки — без сокращений.

Pattern: `[вещь] [действие] [причина]. [next step].`

**Отступать от стиля** для:
- Предупреждений о безопасности
- Подтверждений необратимых действий (удаление, force-push)
- Многошаговых последовательностей где порядок критичен

Уровни (`/caveman lite|full|ultra`): lite держит грамматику, ultra сокращает (DB/auth/config/req/res/fn/impl). Code/commits/PRs — обычным языком.

Не спрашивай каждый раз — caveman активен по умолчанию.

## Оптимизация и работа с библиотеками (Context7)

При работе с внешними библиотеками (Express, Vercel, KeyCRM SDK, Node API и т.д.) **сперва** обращаться к Context7 MCP:
- `resolve-library-id` — найти id библиотеки
- `query-docs` — получить актуальную документацию

Не полагаться на тренировочные данные для свежих API. Особенно при апгрейдах зависимостей и работе с Vercel/serverless edge-runtime.

## Deploy

Прод — Vercel (Hobby plan), репо https://github.com/Dmitryfor/surf-key-crm-stock, ветка `main` → auto-deploy.

```
/api/stocks.js     — serverless function (Node runtime, maxDuration 10s)
/middleware.js     — edge Basic Auth (AUTH_USER / AUTH_PASS)
/public/index.html — статика (frontend без изменений)
/server.js         — локальный dev-режим (npm run dev)
/vercel.json       — конфиг
```

**Env vars в Vercel UI**: `KEYCRM_API_KEY`, `AUTH_USER`, `AUTH_PASS`.

**CDN кеш**: `/api/stocks` отдаёт `Cache-Control: s-maxage=30, stale-while-revalidate=60`. Параметр `?fresh=1` бьёт кеш.

**Локальный dev**: `npm run dev` (Express на :3000, без auth, без CDN-кеша — фолбэк к старому in-memory). Для эмуляции Vercel: `vercel dev`.
