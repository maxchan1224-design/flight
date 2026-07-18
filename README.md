# Flight Strategy AI — Setup Guide (Phase 1)

One Cloudflare Worker. It serves the web app **and** runs the backend (Amadeus proxy, KV caching, multi-origin strategy engine, AI explanations). Works in any desktop browser; on iPhone, open the Worker URL in Safari → Share → **Add to Home Screen** for an app-like install.

---

## Step 1 — Get Amadeus API keys (free)

1. Go to **developers.amadeus.com** → Register → create a **Self-Service** app.
2. Copy the **API Key** (client ID) and **API Secret**.
3. You start in the **Test** environment. Important honesty about Test:
   - Prices are cached/older data, and **route coverage from SZX/CAN/MFM is patchy** — some alternative origins may return "no fares" in Test even though real flights exist.
   - Quota: generally a few thousand free calls/month in Test.
4. When you're happy, promote the app to **Production** in the Amadeus dashboard (requires filling billing details, but each API has a **free monthly quota** — e.g. Flight Offers Search gives free calls before any charge; check the quota page as numbers change). Production returns **live bookable fares**.

## Step 2 — Create the Worker (Cloudflare dashboard, no CLI needed)

1. Cloudflare dashboard → **Workers & Pages** → **Create Worker** → name it `flight-strategy-ai` → Deploy.
2. **Edit code** → delete the boilerplate → paste the entire contents of `worker.js` → **Save and deploy**.

## Step 3 — Bindings

Worker → **Settings**:

| Type | Name | Value |
|---|---|---|
| Secret | `AMADEUS_CLIENT_ID` | your API Key |
| Secret | `AMADEUS_CLIENT_SECRET` | your API Secret |
| Variable | `AMADEUS_ENV` | `test` (later: `production`) |
| KV namespace binding | `CACHE` | create a KV namespace (any name, e.g. `flight-cache`) and bind it as `CACHE` |
| Workers AI binding *(optional)* | `AI` | enable Workers AI and bind as `AI` |

Without the `AI` binding the app still works — explanations fall back to a rule-based template. With it, analysis uses Llama 3.1 8B on Workers AI (free tier available, runs from Cloudflare edge, so no HK API-block issue).

## Step 4 — Use it

Open `https://flight-strategy-ai.<your-subdomain>.workers.dev`.

- Type a 3-letter destination code (KTM, TPE, BKK, KIX…), pick dates or tap a **weekend chip** (next 6 Fri→Mon pairs are pre-generated).
- One search fires **4 parallel queries** (HKG, SZX, CAN, MFM), pulls historical price quartiles for the HKG route, computes the deal verdict (🔥/⭐/👍/⚠️/❌), and shows strategy cards with **real total cost** (fare + round-trip ground transport) and honest extra-time figures.
- Results are cached in KV for **6 hours** — repeat searches don't burn quota.

## Tuning

All the ground-transport assumptions live in `ALT_ORIGINS` at the top of `worker.js` — edit costs/times to match your actual door-to-airport routes (they're currently West Kowloon–centric estimates). `CACHE_TTL_SECONDS` and `MAX_OFFERS_PER_ORIGIN` are there too.

## Known limitations (Phase 1)

- **Fare calendar** uses Amadeus `flight-dates`, which covers a limited set of routes and prices in EUR — the app says so and degrades gracefully. For unsupported routes, use the weekend chips to compare specific weekends (each is one cached search).
- **No promotion tracking yet** — that's Phase 2: a scheduled Worker cron sweeping your favourite routes nightly + storing best fares in KV to build your own price history and deal feed.
- **No preference learning yet** — Phase 2, stored per-device in KV.
- Deep links to booking aren't included; the results tell you airline + times + price, and you book on the airline/OTA directly.

## Quota math (so you don't get surprised)

One full search = up to 4 Flight Offers calls + 1 price-metrics call = **5 calls**, then free for 6h from cache. At ~2,000 free Test calls/month that's ~400 fresh searches — plenty. In Production, watch the per-API free quotas in the Amadeus dashboard before heavy use.
