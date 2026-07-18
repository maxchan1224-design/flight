# Flight Deal Intelligence — Complete System

Not a search engine. A scanner that records its own price history nightly, scores every route against fares **it recorded itself**, and merges public deal signals into one dashboard.

The key idea: after ~6 weeks of nightly scans you own a price history for your specific routes that nobody else has. "45% below the last 60 days" becomes a fact you can compute, not a guess. That's the moat — and it costs nothing but time.

---

## What's in the box

| File | What it is |
|---|---|
| `intel-worker.js` | The whole system — scanner, scoring engine, feed aggregator, AI layer, dashboard |
| `wrangler-intel.toml` | Config with the nightly cron trigger (rename to `wrangler.toml`) |

---

## Deploy

### 1. Two KV namespaces
Dashboard → **Workers & Pages → KV → Create namespace**, twice:
- `flight-cache` → binds as `CACHE` (short-lived: auth tokens, feed cache)
- `flight-history` → binds as `HISTORY` (the valuable one: price history, watchlist)

Keep them separate. `CACHE` gets cleared constantly; `HISTORY` is the asset you're accumulating and must never be wiped.

### 2. Create the Worker
**Workers & Pages → Create → Workers → Create Worker.** Deploy the placeholder, then **Edit code**, paste all of `intel-worker.js`, **Save and deploy**.

(If you prefer git: rename `wrangler-intel.toml` → `wrangler.toml`, put it at the repo root beside `intel-worker.js`, fill in both KV namespace IDs, commit, push.)

### 3. Bindings — Settings tab

| Type | Name | Value |
|---|---|---|
| Secret | `AMADEUS_CLIENT_ID` | your Amadeus key |
| Secret | `AMADEUS_CLIENT_SECRET` | your Amadeus secret |
| Secret | `INGEST_TOKEN` | any long random string you invent |
| Variable | `AMADEUS_ENV` | `test`, later `production` |
| KV | `CACHE` | flight-cache |
| KV | `HISTORY` | flight-history |
| Workers AI | `AI` | *(optional — falls back to rule-based briefings)* |

### 4. Cron
Worker → **Settings → Triggers → Cron Triggers → Add**: `0 19 * * *` (19:00 UTC = 03:00 HKT).

### 5. Seed it
Open the Worker URL → **Watchlist** tab → **Scan now**. Then be patient: scores stay "📊 Building history" until each route has 5 daily samples, and confidence only reaches *high* at 45 days. **This is a system that gets better while you ignore it.**

---

## How scoring actually works

Each night the scanner records the cheapest round-trip it can find on every watchlist route. Today's fare is then compared to the **median of everything previously recorded**:

| Discount vs your median | Verdict |
|---|---|
| ≥ 40% | 🔥 Exceptional — book immediately |
| ≥ 20% | ⭐ Great — book within a day or two |
| ≥ 8% | 👍 Good — book if dates work |
| ±8% | ⚠️ Average — no urgency |
| < −8% | ❌ Expensive — wait |

Plus a **lowest recorded** flag when a fare beats everything in history. Confidence is reported honestly: `low` under 20 samples, `medium` under 45, `high` beyond. A 46% discount computed from 6 days of data is labelled low-confidence, because it is.

---

## Feed signals — what's real and what isn't

Reachable and included: **Reddit** public JSON (r/awardtravel, r/flights, r/TravelDeals), **Telegram public channels** via their `t.me/s/` preview pages, and any **RSS/Atom** feed.

Not included, deliberately: Facebook groups (auth-walled and against their terms), private Telegram channels, and Google Flights/Skyscanner/Kayak (no public APIs — scraping them would be both fragile and against their terms).

Items get keyword-scored, with extra weight for anything mentioning Hong Kong, your alternative airports, or the carriers you'd actually use. Cross-posts are deduplicated, and a deal appearing in several independent channels gets a **corroboration bonus** — multiple sources reporting the same fare is real signal about whether it's genuine.

Edit the `SOURCES` array at the top of the file to add channels you actually follow.

### Getting your newsletters in
The one source that beats all of the above is your own inbox — airline sale emails arrive before they hit any forum. `POST /api/ingest` accepts them:

```
POST https://your-worker.workers.dev/api/ingest
Authorization: Bearer YOUR_INGEST_TOKEN
{ "source": "Cathay", "subject": "Flash sale: Tokyo from HK$980", "body": "24h only", "url": "https://..." }
```

Wire it up with **Cloudflare Email Routing** (route a dedicated address to a Worker), or an Apple Shortcut on your iPhone that posts a selected email, or Zapier/IFTTT. Then subscribe that address to every airline newsletter you care about.

---

## API reference

| Endpoint | Purpose |
|---|---|
| `GET /api/opportunities` | Ranked deals + AI briefing |
| `GET /api/feed` | Scored, deduped public signals |
| `GET /api/history?route=HKG-TPE` | Raw recorded price series |
| `GET/POST /api/watchlist` | View / `{add:"TPE"}` / `{remove:"TPE"}` |
| `POST /api/scan` | Manual scan; `{limit: 5}` to conserve quota |
| `POST /api/ingest` | Newsletter ingest (token required) |

---

## Quota reality

A scan costs 1 call per route when Amadeus cheapest-date search covers it, up to 4 when it falls back to sampling weekends. With 14 routes that's roughly **14–56 calls nightly**, so 400–1,700/month. Test tier absorbs this. If you approach limits: trim the watchlist, or change the cron to alternate days (`0 19 */2 * *`).

---

## What this deliberately doesn't do

No booking links or deep links into airline sites — it tells you the airline, dates and price, and you book directly. No error-fare *guarantee*: a fare being 60% below your median often means a genuine sale, occasionally a mistake fare, and sometimes a data quirk. The system flags anomalies; you verify before you get excited.

## Where to take it next

The multi-origin strategy engine from Phase 1 (`worker.js` — HKG vs SZX/CAN/MFM with real ground-transport maths) is the natural merge: run it on the top 3 scored opportunities each night so the briefing can say *"Tokyo is 38% below median, and departing Shenzhen saves another HK$900."* The `ALT_ORIGINS` table is already present in this file for exactly that.
