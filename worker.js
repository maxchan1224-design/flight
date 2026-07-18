/**
 * ================================================================
 *  FLIGHT DEAL FINDER — Phase 1
 *  Search-first, global, bilingual (繁中 / EN), PWA.
 *  Single Cloudflare Worker: API + UI.
 * ================================================================
 *
 *  BINDINGS
 *    Secret   TRAVELPAYOUTS_TOKEN   travelpayouts.com → Profile → API token
 *    Var      TP_MARKER             (optional) your Travelpayouts marker for booking links
 *    Var      DEFAULT_MARKET        (optional) data market, default "hk"
 *    KV       HISTORY               (optional) price history — improves deal scoring over time
 *
 *  ARCHITECTURE — the seam
 *    Providers map their raw response into ONE normalized Offer shape.
 *    Fields a provider cannot supply are null and the UI hides them.
 *    Nothing above the adapter knows which provider produced an offer,
 *    so adding a paid provider later touches only this file's PROVIDERS.
 *
 *  ROUTES
 *    GET  /                     app
 *    GET  /manifest.json        PWA manifest
 *    GET  /sw.js                service worker
 *    GET  /api/search           mode=route|month|anywhere
 *    GET  /api/places           airport/city autocomplete
 */

const TP = "https://api.travelpayouts.com";
const CACHE_TTL = 60 * 30;

/* ================================================================
 * Provider transport
 * ================================================================ */

async function tpGet(env, path, params) {
  const u = new URL(TP + path);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") u.searchParams.set(k, String(v));
  }
  const r = await fetch(u.toString(), {
    headers: { "X-Access-Token": env.TRAVELPAYOUTS_TOKEN || "" },
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("HTTP " + r.status + (b.error ? " — " + b.error : ""));
  if (b.success === false) throw new Error(String(b.error || "provider returned success:false"));
  return b;
}

/* ================================================================
 * THE SEAM — normalized Offer
 *
 *   origin destination departDate returnDate
 *   priceTotal currency stops airlineCode airlineName bookingUrl
 *   flightNumber departTime arriveTime durationMin cabin baggage  ← null if unsupported
 *   provider fetchedAt isCached
 * ================================================================ */

function makeOffer(x) {
  return {
    origin: x.origin || null,
    destination: x.destination || null,
    departDate: x.departDate || null,
    returnDate: x.returnDate || null,
    priceTotal: x.priceTotal != null ? Math.round(x.priceTotal) : null,
    currency: x.currency || "HKD",
    stops: x.stops != null ? x.stops : null,
    airlineCode: x.airlineCode || null,
    airlineName: x.airlineName || x.airlineCode || null,
    bookingUrl: x.bookingUrl || null,
    // Not available from cached-price providers. Never fabricated.
    flightNumber: x.flightNumber != null ? x.flightNumber : null,
    departTime: x.departTime || null,
    arriveTime: x.arriveTime || null,
    durationMin: x.durationMin != null ? x.durationMin : null,
    cabin: x.cabin || null,
    baggage: x.baggage || null,
    provider: x.provider,
    fetchedAt: x.fetchedAt || new Date().toISOString(),
    isCached: x.isCached !== false,
  };
}

/** Aviasales deep link: ORIGIN + DDMM + DEST + [DDMM] + passengers */
function bookingLink(origin, destination, departDate, returnDate, marker, pax) {
  if (!origin || !destination || !departDate) return null;
  const dm = (iso) => iso.slice(8, 10) + iso.slice(5, 7);
  let seg = origin + dm(departDate) + destination;
  if (returnDate) seg += dm(returnDate);
  seg += String(pax || 1);
  return "https://www.aviasales.com/search/" + seg + (marker ? "?marker=" + marker : "");
}

/* ---- airline name lookup (public reference file, cached) ---- */
async function airlineNames(env) {
  if (env.HISTORY) {
    const hit = await env.HISTORY.get("ref:airlines", "json");
    if (hit) return hit;
  }
  try {
    const r = await fetch(TP + "/data/airlines.json");
    const list = await r.json();
    const map = {};
    for (const a of list) if (a.code) map[a.code] = a.name;
    if (env.HISTORY) await env.HISTORY.put("ref:airlines", JSON.stringify(map), { expirationTtl: 604800 });
    return map;
  } catch (e) {
    return {};
  }
}

/* ================================================================
 * PROVIDERS — add new ones here; nothing else changes
 * ================================================================ */

const PROVIDERS = {
  travelpayouts: {
    id: "travelpayouts",
    label: "Travelpayouts / Aviasales",
    supportsLiveItinerary: false,

    /** Specific route, specific date or month. */
    async searchRoute(env, q, names) {
      const b = await tpGet(env, "/aviasales/v3/prices_for_dates", {
        origin: q.origin,
        destination: q.destination,
        departure_at: q.departDate,
        return_at: q.returnDate,
        one_way: q.returnDate ? "false" : "true",
        direct: q.directOnly ? "true" : "false",
        currency: (q.currency || "hkd").toLowerCase(),
        sorting: "price",
        limit: 30,
        page: 1,
        market: q.market,
      });
      return (b.data || []).map((d) =>
        makeOffer({
          origin: d.origin, destination: d.destination,
          departDate: (d.departure_at || "").slice(0, 10),
          returnDate: (d.return_at || "").slice(0, 10) || null,
          priceTotal: d.price, currency: (q.currency || "HKD").toUpperCase(),
          stops: d.transfers != null ? d.transfers : d.number_of_changes,
          airlineCode: d.airline, airlineName: names[d.airline] || d.airline,
          flightNumber: d.flight_number != null ? String(d.flight_number) : null,
          departTime: d.departure_at && d.departure_at.length > 10 ? d.departure_at : null,
          arriveTime: null,
          durationMin: d.duration != null ? d.duration : null,
          bookingUrl: bookingLink(d.origin, d.destination,
            (d.departure_at || "").slice(0, 10), (d.return_at || "").slice(0, 10) || null,
            env.TP_MARKER, q.pax),
          provider: "travelpayouts",
        })
      );
    },

    /** Whole month, cheapest per day. */
    async searchMonth(env, q, names) {
      const b = await tpGet(env, "/v2/prices/month-matrix", {
        currency: (q.currency || "hkd").toLowerCase(),
        origin: q.origin, destination: q.destination,
        month: q.month + "-01",
        show_to_affiliates: "true",
        market: q.market,
      });
      return (b.data || []).map((d) =>
        makeOffer({
          origin: q.origin, destination: q.destination,
          departDate: d.depart_date, returnDate: d.return_date || null,
          priceTotal: d.value, currency: (q.currency || "HKD").toUpperCase(),
          stops: d.number_of_changes,
          airlineCode: d.gate || null,
          airlineName: names[d.gate] || d.gate || null,
          bookingUrl: bookingLink(q.origin, q.destination, d.depart_date, d.return_date || null,
            env.TP_MARKER, q.pax),
          provider: "travelpayouts",
        })
      );
    },

    /** Anywhere from an origin — cheapest destinations found recently. */
    async searchAnywhere(env, q, names) {
      const b = await tpGet(env, "/aviasales/v3/get_latest_prices", {
        currency: (q.currency || "hkd").toLowerCase(),
        origin: q.origin,
        period_type: "year",
        one_way: q.returnDate === null && q.oneWay ? "true" : "false",
        page: 1, limit: 100,
        show_to_affiliates: "true",
        sorting: "price",
        market: q.market,
      });
      return (b.data || []).map((d) =>
        makeOffer({
          origin: d.origin, destination: d.destination,
          departDate: d.depart_date, returnDate: d.return_date || null,
          priceTotal: d.value, currency: (q.currency || "HKD").toUpperCase(),
          stops: d.number_of_changes,
          airlineCode: d.gate || null, airlineName: names[d.gate] || d.gate || null,
          bookingUrl: bookingLink(d.origin, d.destination, d.depart_date, d.return_date || null,
            env.TP_MARKER, q.pax),
          provider: "travelpayouts",
        })
      );
    },
  },
};

/* ================================================================
 * INTELLIGENCE — deal scoring
 *
 * Two baselines, in priority order:
 *   1. Own recorded history for the route (needs >= 5 days) — strongest
 *   2. Median of the current result set — works from the very first search
 * Confidence is reported honestly so a big % off thin data is not oversold.
 * ================================================================ */

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function verdict(pct) {
  if (pct >= 40) return { tier: "exceptional", badge: "🔥" };
  if (pct >= 20) return { tier: "great", badge: "⭐" };
  if (pct >= 8) return { tier: "good", badge: "👍" };
  if (pct >= -8) return { tier: "average", badge: "⚠️" };
  return { tier: "expensive", badge: "❌" };
}

function scoreOffers(offers, history) {
  const prices = offers.map((o) => o.priceTotal).filter((p) => p != null);
  if (!prices.length) return offers;

  const histPrices = (history && history.points ? history.points : [])
    .map((p) => p.price).filter((p) => p != null);

  const useHistory = histPrices.length >= 5;
  const base = useHistory ? median(histPrices) : median(prices);
  const samples = useHistory ? histPrices.length : prices.length;
  const confidence = useHistory
    ? (histPrices.length >= 45 ? "high" : histPrices.length >= 20 ? "medium" : "low")
    : "low";

  const lowest = Math.min(...prices);

  return offers.map((o) => {
    if (o.priceTotal == null) return { ...o, score: null };
    const pct = Math.round(((base - o.priceTotal) / base) * 100);
    const v = verdict(pct);
    return {
      ...o,
      score: {
        ...v,
        discountPct: pct,
        baseline: Math.round(base),
        baselineKind: useHistory ? "history" : "resultset",
        samples, confidence,
        isCheapest: o.priceTotal === lowest,
      },
    };
  });
}

/* ---- optional: record today's cheapest per route ---- */
async function recordHistory(env, route, price, currency) {
  if (!env.HISTORY || price == null) return null;
  const key = "hist:" + route;
  const h = (await env.HISTORY.get(key, "json")) || { route, points: [] };
  const date = new Date().toISOString().slice(0, 10);
  h.points = h.points.filter((p) => p.date !== date);
  h.points.push({ date, price: Math.round(price), currency });
  h.points.sort((a, b) => a.date.localeCompare(b.date));
  if (h.points.length > 90) h.points = h.points.slice(-90);
  await env.HISTORY.put(key, JSON.stringify(h));
  return h;
}

async function readHistory(env, route) {
  if (!env.HISTORY) return null;
  return await env.HISTORY.get("hist:" + route, "json");
}

/* ================================================================
 * API
 * ================================================================ */

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function handleSearch(request, env) {
  const u = new URL(request.url);
  const p = u.searchParams;
  const mode = p.get("mode") || "route";
  const q = {
    origin: (p.get("origin") || "").toUpperCase().trim(),
    destination: (p.get("destination") || "").toUpperCase().trim(),
    departDate: p.get("departDate") || "",
    returnDate: p.get("returnDate") || "",
    month: p.get("month") || "",
    currency: (p.get("currency") || "HKD").toUpperCase(),
    directOnly: p.get("direct") === "1",
    oneWay: p.get("oneWay") === "1",
    pax: parseInt(p.get("pax") || "1", 10),
    market: (env.DEFAULT_MARKET || "hk"),
  };

  if (!env.TRAVELPAYOUTS_TOKEN) {
    return json({ error: "TRAVELPAYOUTS_TOKEN is not configured on this Worker." }, 500);
  }
  if (!q.origin) return json({ error: "origin required" }, 400);
  if (mode !== "anywhere" && !q.destination) return json({ error: "destination required" }, 400);

  const provider = PROVIDERS.travelpayouts;
  const names = await airlineNames(env);

  let offers = [];
  let notes = [];
  try {
    if (mode === "anywhere") {
      offers = await provider.searchAnywhere(env, q, names);
    } else if (mode === "month") {
      if (!q.month) return json({ error: "month required (YYYY-MM)" }, 400);
      offers = await provider.searchMonth(env, q, names);
    } else {
      offers = await provider.searchRoute(env, q, names);
      if (!offers.length) {
        // Fall back to a whole-month view so the user sees something useful.
        const month = (q.departDate || "").slice(0, 7);
        if (month) {
          offers = await provider.searchMonth(env, { ...q, month }, names);
          if (offers.length) notes.push("no_exact_date_fallback_month");
        }
      }
    }
  } catch (e) {
    return json({ error: e.message }, 502);
  }

  offers = offers.filter((o) => o.priceTotal != null && o.priceTotal > 0);
  if (q.directOnly) offers = offers.filter((o) => o.stops === 0);
  offers.sort((a, b) => a.priceTotal - b.priceTotal);

  // History only makes sense for a fixed route
  let history = null;
  if (mode !== "anywhere" && q.origin && q.destination) {
    const route = q.origin + "-" + q.destination;
    history = await readHistory(env, route);
    if (offers.length) {
      try { await recordHistory(env, route, offers[0].priceTotal, offers[0].currency); } catch (e) {}
    }
  }

  const scored = scoreOffers(offers, history);

  return json({
    mode,
    query: q,
    provider: { id: provider.id, label: provider.label, supportsLiveItinerary: provider.supportsLiveItinerary },
    count: scored.length,
    offers: scored.slice(0, 60),
    historyPoints: history && history.points ? history.points.length : 0,
    notes,
    dataNote: "cached_prices",
  });
}

/* ---- autocomplete via Travelpayouts places ---- */
async function handlePlaces(request) {
  const term = new URL(request.url).searchParams.get("q") || "";
  if (term.length < 2) return json({ places: [] });
  try {
    const r = await fetch(
      "https://autocomplete.travelpayouts.com/places2?locale=en&types[]=city&types[]=airport&term=" +
        encodeURIComponent(term)
    );
    const list = await r.json();
    return json({
      places: (list || []).slice(0, 8).map((x) => ({
        code: x.code, name: x.name, country: x.country_name, type: x.type,
      })),
    });
  } catch (e) {
    return json({ places: [], error: e.message });
  }
}

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    try {
      if (p === "/api/search") return await handleSearch(request, env);
      if (p === "/api/places") return await handlePlaces(request);
      if (p === "/manifest.json")
        return new Response(
          JSON.stringify({
            name: "Flight Deal Finder", short_name: "FlightDeal",
            start_url: "/", display: "standalone",
            background_color: "#0d1117", theme_color: "#0d1117", icons: [],
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      if (p === "/sw.js")
        return new Response(SW, { headers: { "Content-Type": "application/javascript" } });
      return new Response(HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

const SW = [
  "self.addEventListener('install', function(e){ self.skipWaiting(); });",
  "self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });",
  "self.addEventListener('fetch', function(e){",
  "  if (e.request.method !== 'GET') return;",
  "  var url = new URL(e.request.url);",
  "  if (url.pathname.indexOf('/api/') === 0) return;",
  "  e.respondWith(fetch(e.request).catch(function(){ return caches.match(e.request); }));",
  "});",
].join("\n");

/* ================================================================
 * UI
 * ================================================================ */

const HTML = `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.json">
<title>Flight Deal Finder</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0d1117;--card:#161b22;--card2:#1c2330;--line:#262d3a;
  --tx:#e6edf3;--dim:#8b949e;
  --acc:#3fb950;--acc2:#2ea043;
  --hot:#f85149;--warm:#d29922;--cool:#58a6ff;
  --f:'Inter','Noto Sans TC',system-ui,-apple-system,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--tx);font-family:var(--f);min-height:100vh;font-size:15px;line-height:1.5}
.wrap{max-width:960px;margin:0 auto;padding:14px 14px 90px}
header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0 14px}
.logo{font-weight:700;font-size:1.05rem;letter-spacing:-.01em}
.logo span{color:var(--acc)}
.lang{display:flex;gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.lang button{background:transparent;border:none;color:var(--dim);padding:6px 11px;font-size:.78rem;cursor:pointer;font-family:var(--f)}
.lang button.on{background:var(--card2);color:var(--tx);font-weight:600}
/* tabs */
.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px}
.modes button{background:var(--card);border:1px solid var(--line);color:var(--dim);border-radius:9px;
  padding:11px 6px;font-size:.8rem;cursor:pointer;font-family:var(--f);font-weight:500;line-height:1.3}
.modes button.on{border-color:var(--acc);color:var(--acc);background:var(--card2)}
/* form */
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.row{display:grid;gap:10px;margin-bottom:10px}
.r2{grid-template-columns:1fr 1fr}
.r3{grid-template-columns:1fr 1fr 1fr}
label{display:block;font-size:.7rem;color:var(--dim);margin-bottom:5px;font-weight:500;letter-spacing:.02em}
input,select{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--tx);
  padding:11px 10px;font-size:16px;font-family:var(--f);appearance:none}
input:focus,select:focus{outline:none;border-color:var(--acc)}
.ac{position:relative}
.aclist{position:absolute;top:100%;left:0;right:0;z-index:40;background:var(--card2);border:1px solid var(--line);
  border-radius:8px;margin-top:4px;max-height:220px;overflow-y:auto;display:none}
.aclist.show{display:block}
.acitem{padding:10px;cursor:pointer;font-size:.85rem;border-bottom:1px solid var(--line)}
.acitem:last-child{border-bottom:none}
.acitem:hover,.acitem.sel{background:var(--card)}
.acitem b{color:var(--acc);font-weight:600}
.acitem small{color:var(--dim);display:block;font-size:.72rem;margin-top:2px}
.opts{display:flex;gap:14px;flex-wrap:wrap;margin:4px 0 12px}
.opts label{display:flex;align-items:center;gap:6px;font-size:.8rem;color:var(--dim);margin:0;cursor:pointer}
.opts input{width:auto;padding:0}
button.go{width:100%;background:var(--acc);color:#04260d;border:none;border-radius:9px;padding:14px;
  font-size:.95rem;font-weight:700;cursor:pointer;font-family:var(--f)}
button.go:active{background:var(--acc2)}
button.go:disabled{opacity:.5}
/* status */
.status{font-size:.82rem;color:var(--warm);margin:12px 2px;min-height:1.2em}
.status.err{color:var(--hot)}
/* summary */
.sum{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 10px;align-items:center}
.pill{background:var(--card2);border:1px solid var(--line);border-radius:20px;padding:5px 11px;font-size:.72rem;color:var(--dim)}
.pill b{color:var(--tx);font-weight:600}
/* cards */
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:9px;
  display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}
.card.hot{border-color:var(--acc)}
.route{font-weight:700;font-size:1rem;letter-spacing:-.01em}
.route .ar{color:var(--dim);font-weight:400;margin:0 5px}
.meta{font-size:.78rem;color:var(--dim);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap}
.meta span{white-space:nowrap}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:.72rem;font-weight:600;
  border-radius:6px;padding:3px 8px;margin-top:6px}
.b-exceptional{background:#0f2f1a;color:#3fb950}
.b-great{background:#0f2a33;color:#58a6ff}
.b-good{background:#1c2330;color:#8b949e}
.b-average{background:#2b2313;color:#d29922}
.b-expensive{background:#2d1618;color:#f85149}
.right{text-align:right}
.price{font-size:1.25rem;font-weight:700;white-space:nowrap;letter-spacing:-.02em}
.book{display:inline-block;margin-top:7px;background:var(--acc);color:#04260d;text-decoration:none;
  border-radius:7px;padding:8px 14px;font-size:.8rem;font-weight:700;white-space:nowrap}
.book:active{background:var(--acc2)}
.note{background:var(--card2);border:1px solid var(--line);border-left:3px solid var(--warm);border-radius:0 8px 8px 0;
  padding:11px 13px;font-size:.78rem;color:var(--dim);line-height:1.6;margin:12px 0}
.empty{text-align:center;padding:40px 20px;color:var(--dim);font-size:.88rem}
footer{margin-top:30px;padding-top:14px;border-top:1px solid var(--line);font-size:.7rem;color:var(--dim);line-height:1.7}
@media(max-width:560px){
  .r3{grid-template-columns:1fr}
  .card{grid-template-columns:1fr;gap:8px}
  .right{text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .book{margin-top:0}
}
</style></head><body>
<div class="wrap">
<header>
  <div class="logo">Flight<span>Deal</span></div>
  <div class="lang">
    <button id="lz" class="on" data-lang="zh">繁中</button>
    <button id="le" data-lang="en">EN</button>
  </div>
</header>

<div class="modes">
  <button class="on" data-mode="route" data-i18n="mode_route">指定日期</button>
  <button data-mode="month" data-i18n="mode_month">整月最平</button>
  <button data-mode="anywhere" data-i18n="mode_any">去邊都得</button>
</div>

<div class="panel">
  <div class="row r2">
    <div class="ac">
      <label data-i18n="from">出發地</label>
      <input id="origin" placeholder="HKG" autocomplete="off">
      <div class="aclist" id="ac-origin"></div>
    </div>
    <div class="ac" id="destWrap">
      <label data-i18n="to">目的地</label>
      <input id="dest" placeholder="NRT" autocomplete="off">
      <div class="aclist" id="ac-dest"></div>
    </div>
  </div>

  <div class="row r2" id="dateRow">
    <div><label data-i18n="depart">去程日期</label><input id="dep" type="date"></div>
    <div><label data-i18n="ret">回程日期</label><input id="ret" type="date"></div>
  </div>

  <div class="row" id="monthRow" style="display:none">
    <div><label data-i18n="month">月份</label><input id="month" type="month"></div>
  </div>

  <div class="row r3">
    <div><label data-i18n="cur">貨幣</label>
      <select id="cur"><option>HKD</option><option>USD</option><option>EUR</option><option>GBP</option><option>JPY</option><option>TWD</option><option>SGD</option><option>CNY</option></select></div>
    <div><label data-i18n="pax">人數</label>
      <select id="pax"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
    <div><label data-i18n="sort">排序</label>
      <select id="sort"><option value="price" data-i18n="sort_price">最平</option><option value="stops" data-i18n="sort_stops">最少轉機</option><option value="date" data-i18n="sort_date">日期</option></select></div>
  </div>

  <div class="opts">
    <label><input type="checkbox" id="direct"> <span data-i18n="direct">只顯示直航</span></label>
    <label><input type="checkbox" id="oneway"> <span data-i18n="oneway">單程</span></label>
  </div>

  <button class="go" id="go" data-i18n="search">搜尋航班</button>
</div>

<div class="status" id="status"></div>
<div class="sum" id="sum"></div>
<div id="results"></div>

<footer>
  <span data-i18n="foot"></span>
</footer>
</div>

<script>
(function(){
var $=function(i){return document.getElementById(i)};

/* ---------- i18n ---------- */
var I18N={
  zh:{
    mode_route:'指定日期',mode_month:'整月最平',mode_any:'去邊都得',
    from:'出發地',to:'目的地',depart:'去程日期',ret:'回程日期',month:'月份',
    cur:'貨幣',pax:'人數',sort:'排序',sort_price:'最平',sort_stops:'最少轉機',sort_date:'日期',
    direct:'只顯示直航',oneway:'單程',search:'搜尋航班',
    searching:'搜尋緊…',found:'搵到 {n} 個選擇',nores:'搵唔到相關票價,試下改日期或者用「整月最平」。',
    err:'出錯:',stops0:'直航',stops1:'轉機 1 次',stopsN:'轉機 {n} 次',
    baseline_history:'對比你自己記錄嘅歷史價',baseline_resultset:'對比今次搜尋結果嘅中位價',
    conf_low:'低信心',conf_medium:'中信心',conf_high:'高信心',
    cheapest:'最平',book:'訂票',below:'平 {n}%',above:'貴 {n}%',
    t_exceptional:'超值筍盤',t_great:'好抵',t_good:'價錢唔錯',t_average:'普通',t_expensive:'偏貴',
    note_cached:'票價來自 Aviasales 過去 48 小時嘅真實搜尋快取,唔係即時報價。班次號碼、起飛時間、行李規定要撳「訂票」去 Aviasales 睇實時資料。落單前請自行核實最終價錢。',
    note_month:'搵唔到指定日期嘅票價,已經自動改為顯示整個月。',
    foot:'資料來源:Travelpayouts / Aviasales 快取票價。本工具只作參考,唔保證可訂到同一價錢。',
    need_origin:'請輸入出發地',need_dest:'請輸入目的地',need_month:'請揀月份'
  },
  en:{
    mode_route:'Fixed dates',mode_month:'Cheapest month',mode_any:'Anywhere',
    from:'From',to:'To',depart:'Depart',ret:'Return',month:'Month',
    cur:'Currency',pax:'Travellers',sort:'Sort',sort_price:'Cheapest',sort_stops:'Fewest stops',sort_date:'Date',
    direct:'Direct only',oneway:'One way',search:'Search flights',
    searching:'Searching…',found:'{n} options found',nores:'No fares found. Try different dates or the "Cheapest month" mode.',
    err:'Error: ',stops0:'Direct',stops1:'1 stop',stopsN:'{n} stops',
    baseline_history:'vs your own recorded history',baseline_resultset:'vs median of these results',
    conf_low:'low confidence',conf_medium:'medium confidence',conf_high:'high confidence',
    cheapest:'Cheapest',book:'Book',below:'{n}% below',above:'{n}% above',
    t_exceptional:'Exceptional',t_great:'Great deal',t_good:'Good price',t_average:'Average',t_expensive:'Expensive',
    note_cached:'Prices come from Aviasales cached searches (last 48h), not live quotes. Flight numbers, departure times and baggage rules are not in this data — tap Book to see live details on Aviasales. Verify the final price before paying.',
    note_month:'No fares for those exact dates, so the whole month is shown instead.',
    foot:'Data: Travelpayouts / Aviasales cached fares. Indicative only — the same price is not guaranteed at booking.',
    need_origin:'Enter a departure airport',need_dest:'Enter a destination',need_month:'Pick a month'
  }
};
var lang='zh';
function t(k,vars){
  var s=(I18N[lang]&&I18N[lang][k])||k;
  if(vars)for(var v in vars)s=s.replace('{'+v+'}',vars[v]);
  return s;
}
function applyLang(){
  document.documentElement.lang = lang==='zh'?'zh-Hant':'en';
  var els=document.querySelectorAll('[data-i18n]');
  for(var i=0;i<els.length;i++){
    var k=els[i].getAttribute('data-i18n');
    if(I18N[lang][k])els[i].textContent=I18N[lang][k];
  }
  $('lz').className = lang==='zh'?'on':'';
  $('le').className = lang==='en'?'on':'';
  if(last)render(last);
}
$('lz').addEventListener('click',function(){lang='zh';applyLang()});
$('le').addEventListener('click',function(){lang='en';applyLang()});

/* ---------- mode switching ---------- */
var mode='route';
var modeBtns=document.querySelectorAll('.modes button');
for(var i=0;i<modeBtns.length;i++){
  modeBtns[i].addEventListener('click',function(){
    for(var j=0;j<modeBtns.length;j++)modeBtns[j].className='';
    this.className='on';
    mode=this.getAttribute('data-mode');
    $('destWrap').style.display = mode==='anywhere'?'none':'block';
    $('dateRow').style.display  = mode==='route'?'grid':'none';
    $('monthRow').style.display = mode==='month'?'grid':'none';
  });
}

/* ---------- autocomplete ---------- */
function setupAC(inputId,listId){
  var inp=$(inputId),list=$(listId),timer=null;
  inp.addEventListener('input',function(){
    var v=inp.value.trim();
    clearTimeout(timer);
    if(v.length<2){list.className='aclist';return}
    timer=setTimeout(function(){
      fetch('/api/places?q='+encodeURIComponent(v))
      .then(function(r){return r.json()})
      .then(function(d){
        if(!d.places||!d.places.length){list.className='aclist';return}
        list.innerHTML='';
        d.places.forEach(function(p){
          var el=document.createElement('div');
          el.className='acitem';
          el.innerHTML='<b>'+p.code+'</b> '+p.name+'<small>'+(p.country||'')+'</small>';
          el.addEventListener('mousedown',function(e){
            e.preventDefault();
            inp.value=p.code;
            list.className='aclist';
          });
          list.appendChild(el);
        });
        list.className='aclist show';
      }).catch(function(){});
    },260);
  });
  inp.addEventListener('blur',function(){setTimeout(function(){list.className='aclist'},180)});
}
setupAC('origin','ac-origin');
setupAC('dest','ac-dest');

/* ---------- search ---------- */
var last=null;
$('go').addEventListener('click',doSearch);
function doSearch(){
  var origin=$('origin').value.trim().toUpperCase();
  var dest=$('dest').value.trim().toUpperCase();
  if(!origin){setStatus(t('need_origin'),true);return}
  if(mode!=='anywhere'&&!dest){setStatus(t('need_dest'),true);return}
  if(mode==='month'&&!$('month').value){setStatus(t('need_month'),true);return}

  var p=new URLSearchParams();
  p.set('mode',mode);
  p.set('origin',origin);
  if(mode!=='anywhere')p.set('destination',dest);
  if(mode==='route'){
    if($('dep').value)p.set('departDate',$('dep').value);
    if($('ret').value&&!$('oneway').checked)p.set('returnDate',$('ret').value);
  }
  if(mode==='month')p.set('month',$('month').value);
  p.set('currency',$('cur').value);
  p.set('pax',$('pax').value);
  if($('direct').checked)p.set('direct','1');
  if($('oneway').checked)p.set('oneWay','1');

  setStatus(t('searching'));
  $('go').disabled=true;
  $('results').innerHTML='';
  $('sum').innerHTML='';

  fetch('/api/search?'+p.toString())
  .then(function(r){return r.json()})
  .then(function(d){
    $('go').disabled=false;
    if(d.error){setStatus(t('err')+d.error,true);return}
    setStatus('');
    last=d;
    render(d);
  })
  .catch(function(e){$('go').disabled=false;setStatus(t('err')+e.message,true)});
}
function setStatus(msg,isErr){
  var s=$('status');s.textContent=msg||'';
  s.className='status'+(isErr?' err':'');
}

/* ---------- render ---------- */
function money(v,c){
  try{return new Intl.NumberFormat(lang==='zh'?'zh-HK':'en-US',
    {style:'currency',currency:c,maximumFractionDigits:0}).format(v)}
  catch(e){return c+' '+v}
}
function stopsLabel(n){
  if(n==null)return '';
  if(n===0)return t('stops0');
  if(n===1)return t('stops1');
  return t('stopsN',{n:n});
}
function sortOffers(list){
  var by=$('sort').value,a=list.slice();
  if(by==='stops')a.sort(function(x,y){return (x.stops==null?9:x.stops)-(y.stops==null?9:y.stops)||x.priceTotal-y.priceTotal});
  else if(by==='date')a.sort(function(x,y){return (x.departDate||'').localeCompare(y.departDate||'')});
  else a.sort(function(x,y){return x.priceTotal-y.priceTotal});
  return a;
}

function render(d){
  var box=$('results');box.innerHTML='';
  var offers=d.offers||[];

  if(!offers.length){
    box.innerHTML='<div class="empty">'+t('nores')+'</div>';
    return;
  }

  /* summary pills */
  var sum=$('sum');sum.innerHTML='';
  function pill(html){var e=document.createElement('span');e.className='pill';e.innerHTML=html;sum.appendChild(e)}
  pill(t('found',{n:d.count}));
  var s0=offers[0].score;
  if(s0){
    pill((s0.baselineKind==='history'?t('baseline_history'):t('baseline_resultset'))+
      ' · <b>'+money(s0.baseline,offers[0].currency)+'</b>');
    pill(t('conf_'+s0.confidence)+' · '+s0.samples);
  }

  /* notes */
  if(d.notes&&d.notes.indexOf('no_exact_date_fallback_month')>=0){
    var n1=document.createElement('div');n1.className='note';n1.textContent=t('note_month');box.appendChild(n1);
  }
  var nc=document.createElement('div');nc.className='note';nc.textContent=t('note_cached');box.appendChild(nc);

  /* cards */
  sortOffers(offers).forEach(function(o){
    var sc=o.score||{};
    var el=document.createElement('div');
    el.className='card'+(sc.tier==='exceptional'||sc.tier==='great'?' hot':'');

    var metaBits=[];
    if(o.departDate)metaBits.push('<span>'+o.departDate+(o.returnDate?(' → '+o.returnDate):'')+'</span>');
    if(o.stops!=null)metaBits.push('<span>'+stopsLabel(o.stops)+'</span>');
    if(o.airlineName)metaBits.push('<span>'+o.airlineName+'</span>');
    if(o.flightNumber)metaBits.push('<span>'+(o.airlineCode||'')+o.flightNumber+'</span>');
    if(o.durationMin)metaBits.push('<span>'+Math.floor(o.durationMin/60)+'h'+(o.durationMin%60||'')+'</span>');

    var badge='';
    if(sc.tier){
      var pctTxt = sc.discountPct>=0 ? t('below',{n:sc.discountPct}) : t('above',{n:Math.abs(sc.discountPct)});
      badge='<div class="badge b-'+sc.tier+'">'+sc.badge+' '+t('t_'+sc.tier)+
        (sc.discountPct!==0?(' · '+pctTxt):'')+'</div>';
    }

    var left=document.createElement('div');
    left.innerHTML='<div class="route">'+o.origin+'<span class="ar">→</span>'+o.destination+'</div>'+
      '<div class="meta">'+metaBits.join('')+'</div>'+badge;

    var right=document.createElement('div');
    right.className='right';
    right.innerHTML='<div class="price">'+money(o.priceTotal,o.currency)+'</div>'+
      (o.bookingUrl?('<a class="book" href="'+o.bookingUrl+'" target="_blank" rel="noopener">'+t('book')+'</a>'):'');

    el.appendChild(left);el.appendChild(right);
    box.appendChild(el);
  });
}

$('sort').addEventListener('change',function(){if(last)render(last)});

/* defaults */
(function(){
  var d=new Date();d.setDate(d.getDate()+21);
  $('dep').value=d.toISOString().slice(0,10);
  var r=new Date(d);r.setDate(r.getDate()+5);
  $('ret').value=r.toISOString().slice(0,10);
  $('month').value=d.toISOString().slice(0,7);
})();

applyLang();

if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){})}
})();
</script></body></html>`;
