# Flight Deal Finder — Phase 1

A search-first flight deal web app. Works from **any airport to any airport**, on any dates. Traditional Chinese by default, English toggle. Installable as a PWA on iPhone.

One Cloudflare Worker serves both the API and the UI.

---

## Deploy

### 1. Worker
Dashboard → **Workers & Pages → Create → Workers** → Create Worker → **Edit code** → paste all of `worker.js` → Save and deploy.

(Git route: put `worker.js` and `wrangler.toml` at the repo root. Make sure `name` in the toml matches the Worker name Cloudflare expects, and that the KV id is a real ID, not the placeholder — those two things caused every failed deploy last time.)

### 2. Secret
**Settings → Variables and Secrets → Add → Secret**

| Name | Value |
|---|---|
| `TRAVELPAYOUTS_TOKEN` | your token from travelpayouts.com → Profile → API token |

### 3. Optional
| Type | Name | Value |
|---|---|---|
| KV binding | `HISTORY` | a KV namespace — enables price history |
| Variable | `TP_MARKER` | your Travelpayouts marker, appended to booking links |
| Variable | `DEFAULT_MARKET` | data market, default `hk` |

The app runs **without** the KV binding — deal scoring just falls back to comparing against the current result set instead of your recorded history.

### 4. Install on iPhone
Open the Worker URL in Safari → Share → **Add to Home Screen**.

---

## The three search modes

| Mode | What it does | Endpoint used |
|---|---|---|
| 指定日期 / Fixed dates | Specific route + dates. Falls back to a whole-month view if the exact dates return nothing. | `aviasales/v3/prices_for_dates` |
| 整月最平 / Cheapest month | Cheapest fare for every day in a month | `v2/prices/month-matrix` |
| 去邊都得 / Anywhere | Cheapest destinations from your origin, no destination needed | `aviasales/v3/get_latest_prices` |

Nothing is hardcoded to Hong Kong. `LHR`, `JFK`, `CDG` all work identically — there's a test asserting no home airport is baked in.

---

## Deal scoring

Two baselines, in priority order:

1. **Your own recorded price history** for that route — used once ≥5 days exist. Every search silently records that day's cheapest fare, so this gets better the more you use it.
2. **Median of the current result set** — works from the very first search, so the app is useful immediately.

The UI always states which baseline it used and how many samples back it, so a 60% discount computed from six data points is labelled *low confidence* rather than being oversold.

| Discount | Badge |
|---|---|
| ≥40% | 🔥 超值筍盤 / Exceptional |
| ≥20% | ⭐ 好抵 / Great deal |
| ≥8% | 👍 價錢唔錯 / Good price |
| ±8% | ⚠️ 普通 / Average |
| below | ❌ 偏貴 / Expensive |

---

## The architecture seam

Every provider maps its raw response into one normalized `Offer`:

```
origin destination departDate returnDate
priceTotal currency stops airlineCode airlineName bookingUrl
flightNumber departTime arriveTime durationMin cabin baggage   ← null when unsupported
provider fetchedAt isCached
```

Fields a provider cannot supply come back `null` and the UI hides them. **They are never fabricated** — there's a test asserting `arriveTime`, `cabin` and `baggage` are null rather than plausible-looking guesses.

To add a paid provider later (Duffel, or whatever replaces Amadeus), you write one object in `PROVIDERS` with `searchRoute` / `searchMonth` / `searchAnywhere` returning `makeOffer(...)`. Scoring, sorting, history, UI and i18n need no changes. That's the whole migration.

---

## Honest limitations

**Prices are cached, not live.** Travelpayouts serves fares from real Aviasales searches in the last 48 hours. Good for spotting anomalies, not a booking quote. The UI says so on every result page.

**No flight numbers, times, cabin, or baggage** on most results — that data doesn't exist in cached-price feeds. Tapping **訂票 / Book** opens Aviasales with your route and dates pre-filled, where the live itinerary lives. As of July 2026 no free API provides this: Amadeus shut down its self-service portal on 17 July 2026, Skyscanner and Kiwi are partner-only, and Duffel's free test mode returns fake "Duffel Airways" flights with unrealistic schedules.

**Some routes return nothing** if nobody searched them recently on Aviasales. The fixed-date mode automatically falls back to a month view rather than showing an empty page.

---

## Next phases

**Phase 2** — alternative airports via `v2/prices/nearest-places-matrix`, which works globally: give it any origin plus a radius and it returns nearby airports with their prices, so London yields LHR/LGW/STN/LTN and Hong Kong yields SZX/CAN/MFM with no hardcoded tables. Plus a user-editable ground-cost table for your own home airports.

**Phase 3** — Gemini narration on top of the computed scores, and the deal-signal feed (Reddit / Telegram / RSS / newsletter ingest) from the earlier scanner build, merged in as a discovery tab.

**Phase 4** — a paid provider behind the adapter for full itinerary detail.
