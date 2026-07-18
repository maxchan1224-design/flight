/**
 * ============================================================
 *  FLIGHT STRATEGY AI — single-file Cloudflare Worker
 *  Backend (Amadeus proxy + strategy engine + AI) + frontend UI
 * ============================================================
 *
 *  Required bindings (Cloudflare dashboard → Worker → Settings):
 *    Secrets:
 *      AMADEUS_CLIENT_ID      — from developers.amadeus.com
 *      AMADEUS_CLIENT_SECRET
 *    Variables (plain text):
 *      AMADEUS_ENV            — "test" or "production"
 *    KV namespace binding:
 *      CACHE                  — any KV namespace (used for token + response cache)
 *    Optional:
 *      AI                     — Workers AI binding (for natural-language explanations)
 *
 *  Routes:
 *    GET  /                   → app UI
 *    GET  /manifest.json      → PWA manifest
 *    POST /api/search         → multi-origin flight search + strategy analysis
 *    GET  /api/calendar       → cheapest-date search (route coverage limited by Amadeus)
 *    POST /api/explain        → AI explanation of a strategy result
 */

/* ------------------------------------------------------------------
 * CONFIG — edit freely
 * ------------------------------------------------------------------ */

// Ground transport from Hong Kong to alternative departure airports.
// Costs in HKD one-way, times in minutes door-to-airport ADDITIONAL vs going to HKG.
// Edit these to match your own routes (e.g. from Tai Wai vs Central).
const ALT_ORIGINS = {
  SZX: {
    name: "Shenzhen Bao'an",
    city: "Shenzhen",
    transport: "HSR West Kowloon → Futian + Metro L11",
    costOneWayHKD: 95,
    extraMinutesOneWay: 150,
    difficulty: "Easy",
    note: "Border crossing required; allow buffer for immigration.",
  },
  CAN: {
    name: "Guangzhou Baiyun",
    city: "Guangzhou",
    transport: "HSR West Kowloon → Guangzhou South + Metro L2/L3",
    costOneWayHKD: 235,
    extraMinutesOneWay: 210,
    difficulty: "Moderate",
    note: "Long metro leg from GZ South to Baiyun; HSR to Guangzhou East is closer to city.",
  },
  MFM: {
    name: "Macau International",
    city: "Macau",
    transport: "HZMB Gold Bus (or ferry)",
    costOneWayHKD: 68,
    extraMinutesOneWay: 120,
    difficulty: "Easy",
    note: "HZMB bus runs 24h; ferry from Sheung Wan is an alternative.",
  },
};

const HOME_ORIGIN = "HKG";
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6h response cache — protects the free quota
const MAX_OFFERS_PER_ORIGIN = 12;

/* ------------------------------------------------------------------
 * Amadeus client
 * ------------------------------------------------------------------ */

function amadeusBase(env) {
  return env.AMADEUS_ENV === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";
}

async function getAmadeusToken(env) {
  // Token cached in KV (~30 min lifetime from Amadeus)
  const cached = await env.CACHE.get("amadeus_token");
  if (cached) return cached;

  const resp = await fetch(amadeusBase(env) + "/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.AMADEUS_CLIENT_ID,
      client_secret: env.AMADEUS_CLIENT_SECRET,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Amadeus auth failed (" + resp.status + "): " + t.slice(0, 300));
  }
  const data = await resp.json();
  const ttl = Math.max(60, (data.expires_in || 1799) - 90);
  await env.CACHE.put("amadeus_token", data.access_token, { expirationTtl: ttl });
  return data.access_token;
}

async function amadeusGet(env, path, params) {
  const token = await getAmadeusToken(env);
  const url = new URL(amadeusBase(env) + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    headers: { Authorization: "Bearer " + token },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail =
      (body.errors && body.errors[0] && (body.errors[0].detail || body.errors[0].title)) ||
      "HTTP " + resp.status;
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }
  return body;
}

/* ------------------------------------------------------------------
 * Parsing helpers
 * ------------------------------------------------------------------ */

function parseISODuration(iso) {
  // "PT14H30M" → minutes
  if (!iso) return 0;
  const h = /(\d+)H/.exec(iso);
  const m = /(\d+)M/.exec(iso);
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}

function fmtMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + "h" + (m ? String(m).padStart(2, "0") + "m" : "");
}

function simplifyOffers(raw, origin) {
  const carriers = (raw.dictionaries && raw.dictionaries.carriers) || {};
  const out = [];
  for (const offer of raw.data || []) {
    const itins = offer.itineraries || [];
    const legs = itins.map((it) => {
      const segs = it.segments || [];
      const first = segs[0] || {};
      const last = segs[segs.length - 1] || {};
      return {
        from: first.departure && first.departure.iataCode,
        to: last.arrival && last.arrival.iataCode,
        depart: first.departure && first.departure.at,
        arrive: last.arrival && last.arrival.at,
        stops: Math.max(0, segs.length - 1),
        durationMin: parseISODuration(it.duration),
        carriers: [...new Set(segs.map((s) => s.carrierCode))],
        flightNumbers: segs.map((s) => s.carrierCode + s.number),
      };
    });
    const codes = [...new Set(legs.flatMap((l) => l.carriers))];
    out.push({
      origin,
      price: parseFloat(offer.price && offer.price.grandTotal),
      currency: offer.price && offer.price.currency,
      airlines: codes.map((c) => carriers[c] || c),
      airlineCodes: codes,
      legs,
      totalDurationMin: legs.reduce((a, l) => a + l.durationMin, 0),
      maxStops: Math.max(...legs.map((l) => l.stops), 0),
      bookableSeats: offer.numberOfBookableSeats,
      oneWay: legs.length === 1,
    });
  }
  out.sort((a, b) => a.price - b.price);
  return out;
}

/* ------------------------------------------------------------------
 * Deal scoring (Amadeus itinerary price metrics → quartile verdict)
 * ------------------------------------------------------------------ */

function dealVerdict(price, metrics) {
  if (!metrics) return { label: "No history", badge: "—", tier: "unknown" };
  const q = {};
  for (const p of metrics) q[p.quartileRanking] = parseFloat(p.amount);
  // rankings: MINIMUM, FIRST, MEDIUM, THIRD, MAXIMUM
  if (price <= q.FIRST) return { label: "Exceptional deal", badge: "🔥", tier: "exceptional", quartiles: q };
  if (price <= q.MEDIUM) return { label: "Great deal", badge: "⭐", tier: "great", quartiles: q };
  if (price <= q.THIRD) return { label: "Good price", badge: "👍", tier: "good", quartiles: q };
  if (price <= q.MAXIMUM) return { label: "Average", badge: "⚠️", tier: "average", quartiles: q };
  return { label: "Expensive", badge: "❌", tier: "expensive", quartiles: q };
}

function buyOrWait(tier) {
  switch (tier) {
    case "exceptional": return "Book now — this is in the bottom quartile of historical fares.";
    case "great": return "Book now or very soon — below the historical median.";
    case "good": return "Reasonable. Book if dates matter; wait 1–2 weeks if flexible.";
    case "average": return "Wait if you can — fares on this route are often lower.";
    case "expensive": return "Wait — well above the usual range. Try shifting dates.";
    default: return "No historical data for this route — compare a few nearby dates before deciding.";
  }
}

/* ------------------------------------------------------------------
 * /api/search — the strategy engine
 * ------------------------------------------------------------------ */

async function handleSearch(request, env) {
  const body = await request.json();
  const { destination, departDate, returnDate, adults = 1, includeAltOrigins = true } = body;

  if (!destination || !departDate) {
    return json({ error: "destination and departDate are required" }, 400);
  }

  const origins = includeAltOrigins ? [HOME_ORIGIN, ...Object.keys(ALT_ORIGINS)] : [HOME_ORIGIN];
  const cacheKey =
    "search:" + [origins.join("-"), destination, departDate, returnDate || "ow", adults].join(":");

  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ ...cached, cached: true });

  // Fire all origin searches + price metrics in parallel
  const searches = origins.map((o) =>
    amadeusGet(env, "/v2/shopping/flight-offers", {
      originLocationCode: o,
      destinationLocationCode: destination,
      departureDate: departDate,
      returnDate: returnDate,
      adults: String(adults),
      currencyCode: "HKD",
      max: String(MAX_OFFERS_PER_ORIGIN),
    })
      .then((raw) => ({ origin: o, offers: simplifyOffers(raw, o) }))
      .catch((e) => ({ origin: o, offers: [], error: e.message }))
  );

  const metricsPromise = amadeusGet(env, "/v1/analytics/itinerary-price-metrics", {
    originIataCode: HOME_ORIGIN,
    destinationIataCode: destination,
    departureDate: departDate,
    currencyCode: "HKD",
    oneWay: returnDate ? "false" : "true",
  })
    .then((r) => (r.data && r.data[0] && r.data[0].priceMetrics) || null)
    .catch(() => null);

  const [results, metrics] = await Promise.all([Promise.all(searches), metricsPromise]);

  const byOrigin = {};
  for (const r of results) byOrigin[r.origin] = r;

  const home = byOrigin[HOME_ORIGIN];
  const homeCheapest = home && home.offers[0] ? home.offers[0].price : null;

  // Deal verdict on the HKG cheapest fare
  const verdict = homeCheapest != null ? dealVerdict(homeCheapest, metrics) : dealVerdict(null, null);

  // Strategy comparison: alt origins vs HKG, with real total cost
  const strategies = [];
  for (const code of Object.keys(ALT_ORIGINS)) {
    const r = byOrigin[code];
    if (!r || !r.offers.length) {
      strategies.push({
        origin: code, ...pickMeta(code),
        available: false,
        reason: r && r.error ? r.error : "No fares returned",
      });
      continue;
    }
    const cheapest = r.offers[0];
    const meta = ALT_ORIGINS[code];
    const roundTripFactor = returnDate ? 2 : 1; // ground transport both ways if round trip
    const groundCost = meta.costOneWayHKD * roundTripFactor;
    const extraTime = meta.extraMinutesOneWay * roundTripFactor;
    const totalCost = cheapest.price + groundCost;
    const savings = homeCheapest != null ? homeCheapest - totalCost : null;
    strategies.push({
      origin: code, ...pickMeta(code),
      available: true,
      fare: cheapest.price,
      groundCostHKD: groundCost,
      totalCostHKD: Math.round(totalCost),
      extraMinutes: extraTime,
      extraTimeLabel: fmtMinutes(extraTime),
      savingsHKD: savings != null ? Math.round(savings) : null,
      worthIt: savings != null && savings > 300 && savings / homeCheapest > 0.08,
      cheapestOffer: cheapest,
    });
  }
  strategies.sort((a, b) => (b.savingsHKD || -1e9) - (a.savingsHKD || -1e9));

  const payload = {
    query: { destination, departDate, returnDate, adults },
    home: {
      origin: HOME_ORIGIN,
      offers: home ? home.offers : [],
      error: home && home.error,
      cheapest: homeCheapest,
    },
    verdict,
    advice: buyOrWait(verdict.tier),
    strategies,
    generatedAt: new Date().toISOString(),
  };

  await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
  return json(payload);
}

function pickMeta(code) {
  const m = ALT_ORIGINS[code];
  return {
    airportName: m.name, city: m.city, transport: m.transport,
    difficulty: m.difficulty, note: m.note,
  };
}

/* ------------------------------------------------------------------
 * /api/calendar — cheapest date search (limited route coverage)
 * ------------------------------------------------------------------ */

async function handleCalendar(request, env) {
  const url = new URL(request.url);
  const destination = url.searchParams.get("destination");
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!destination) return json({ error: "destination required" }, 400);

  const cacheKey = "cal:" + destination + ":" + start + ":" + end;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ ...cached, cached: true });

  try {
    const raw = await amadeusGet(env, "/v1/shopping/flight-dates", {
      origin: HOME_ORIGIN,
      destination,
      departureDate: start && end ? start + "," + end : undefined,
      oneWay: "false",
      viewBy: "DATE",
    });
    const dates = (raw.data || []).map((d) => ({
      departureDate: d.departureDate,
      returnDate: d.returnDate,
      price: parseFloat(d.price && d.price.total),
    }));
    const payload = { available: true, currency: "EUR", note: "Amadeus flight-dates prices are indicative and returned in EUR on most routes — use them for shape, not exact totals.", dates };
    await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
    return json(payload);
  } catch (e) {
    return json({
      available: false,
      reason: "Amadeus cheapest-date search doesn't cover this route (" + e.message + "). Use the weekend chips to compare specific weekends instead.",
    });
  }
}

/* ------------------------------------------------------------------
 * /api/explain — AI layer (Workers AI, graceful fallback)
 * ------------------------------------------------------------------ */

async function handleExplain(request, env) {
  const { result } = await request.json();
  if (!result) return json({ error: "result payload required" }, 400);

  const best = (result.strategies || []).find((s) => s.worthIt);
  const fallback = buildTemplateExplanation(result, best);

  if (!env.AI) return json({ explanation: fallback, source: "template" });

  try {
    const prompt =
      "You are a concise travel strategy advisor for a Hong Kong-based traveller. " +
      "Given this flight analysis JSON, explain in under 120 words: whether the HKG fare is good " +
      "(use the verdict), whether any alternative departure airport is genuinely worth it " +
      "(consider savings vs extra time and border crossings), and a clear recommendation. " +
      "Plain text, no markdown, no emoji. JSON: " +
      JSON.stringify({
        destination: result.query && result.query.destination,
        hkgCheapestHKD: result.home && result.home.cheapest,
        verdict: result.verdict && result.verdict.label,
        advice: result.advice,
        strategies: (result.strategies || []).filter((s) => s.available).map((s) => ({
          origin: s.origin, totalCostHKD: s.totalCostHKD,
          savingsHKD: s.savingsHKD, extraTime: s.extraTimeLabel, difficulty: s.difficulty,
        })),
      });

    const out = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    });
    return json({ explanation: (out && out.response) || fallback, source: "workers-ai" });
  } catch (e) {
    return json({ explanation: fallback, source: "template", aiError: e.message });
  }
}

function buildTemplateExplanation(result, best) {
  const dest = (result.query && result.query.destination) || "your destination";
  const price = result.home && result.home.cheapest;
  let s = "HKG → " + dest + ": cheapest bookable fare found is HK$" + Math.round(price || 0) +
    " (" + ((result.verdict && result.verdict.label) || "no history") + "). " + (result.advice || "");
  if (best) {
    s += " Best alternative: depart " + best.city + " (" + best.origin + ") — total real cost HK$" +
      best.totalCostHKD + " including HK$" + best.groundCostHKD + " ground transport, saving HK$" +
      best.savingsHKD + " for about " + best.extraTimeLabel + " of extra travel. " +
      "Difficulty: " + best.difficulty + ".";
  } else {
    s += " No alternative airport beats departing HKG once ground transport cost and time are included.";
  }
  return s;
}

/* ------------------------------------------------------------------
 * Router
 * ------------------------------------------------------------------ */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/api/search" && request.method === "POST") return await handleSearch(request, env);
      if (p === "/api/calendar") return await handleCalendar(request, env);
      if (p === "/api/explain" && request.method === "POST") return await handleExplain(request, env);
      if (p === "/manifest.json") return manifestResponse();
      return new Response(HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

function manifestResponse() {
  return new Response(
    JSON.stringify({
      name: "Flight Strategy AI",
      short_name: "FlightAI",
      start_url: "/",
      display: "standalone",
      background_color: "#0B0E14",
      theme_color: "#0B0E14",
      icons: [],
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

/* ------------------------------------------------------------------
 * FRONTEND — served at "/"
 * NOTE: frontend JS deliberately avoids template literals so it can
 * live inside this backtick string.
 * ------------------------------------------------------------------ */

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B0E14">
<link rel="manifest" href="/manifest.json">
<title>Flight Strategy AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#0B0E14; --panel:#121724; --panel2:#171E2E; --line:#232B3D;
  --amber:#FFB627; --amber-dim:#8a6a1f;
  --text:#E8E6DF; --dim:#8B93A7;
  --good:#4ADE80; --warn:#FBBF24; --bad:#F87171;
  --mono:'IBM Plex Mono',monospace; --sans:'Archivo',system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--ink)}
body{font-family:var(--sans);color:var(--text);background:var(--ink);min-height:100vh}
a{color:var(--amber)}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 80px}
header{display:flex;align-items:baseline;gap:12px;padding:8px 0 20px;border-bottom:1px solid var(--line)}
header h1{font-family:var(--mono);font-size:1.05rem;font-weight:600;letter-spacing:.14em;color:var(--amber)}
header .sub{color:var(--dim);font-size:.8rem}
.board-eyebrow{font-family:var(--mono);font-size:.68rem;letter-spacing:.22em;color:var(--dim);text-transform:uppercase;margin:26px 0 10px}
/* search panel */
.search{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
label{display:block;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
input,select{width:100%;background:var(--ink);border:1px solid var(--line);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:.95rem;padding:10px}
input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.chip{background:var(--panel2);border:1px solid var(--line);color:var(--dim);border-radius:99px;padding:6px 12px;font-family:var(--mono);font-size:.72rem;cursor:pointer}
.chip:hover{color:var(--amber);border-color:var(--amber-dim)}
.actions{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
button.primary{background:var(--amber);color:#1a1405;border:none;border-radius:6px;font-family:var(--sans);font-weight:700;font-size:.9rem;padding:12px 22px;cursor:pointer}
button.ghost{background:transparent;color:var(--amber);border:1px solid var(--amber-dim);border-radius:6px;font-size:.85rem;padding:11px 18px;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
.toggle{display:flex;align-items:center;gap:8px;font-size:.8rem;color:var(--dim);margin-top:14px}
.toggle input{width:auto}
/* status */
.status{font-family:var(--mono);font-size:.8rem;color:var(--amber);margin-top:14px;min-height:1.2em}
.status.err{color:var(--bad)}
/* verdict strip */
.verdict{display:flex;align-items:center;gap:14px;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--amber);border-radius:10px;padding:16px;flex-wrap:wrap}
.verdict .badge{font-size:1.6rem}
.verdict .big{font-family:var(--mono);font-size:1.5rem;font-weight:600;color:var(--amber)}
.verdict .meta{color:var(--dim);font-size:.82rem;max-width:520px}
/* quartile bar */
.qbar{position:relative;height:10px;border-radius:6px;margin:18px 4px 26px;
  background:linear-gradient(90deg,var(--good),var(--warn) 55%,var(--bad))}
.qmark{position:absolute;top:-7px;width:3px;height:24px;background:var(--text);border-radius:2px}
.qlabel{position:absolute;top:26px;font-family:var(--mono);font-size:.62rem;color:var(--dim);transform:translateX(-50%);white-space:nowrap}
/* board rows */
.board{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.row{display:grid;grid-template-columns:minmax(90px,1.4fr) 1fr 1fr .8fr .6fr auto;gap:10px;
  align-items:center;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel);font-family:var(--mono);font-size:.82rem}
.row:last-child{border-bottom:none}
.row.head{background:var(--panel2);color:var(--dim);font-size:.65rem;letter-spacing:.15em;text-transform:uppercase}
.row .price{color:var(--amber);font-weight:600;text-align:right;font-size:.95rem}
.row .air{color:var(--text)}
.row .dim{color:var(--dim)}
.rowbadge{font-size:.9rem;text-align:right}
/* strategy cards */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px}
.card.win{border-color:var(--good)}
.card .route{font-family:var(--mono);font-weight:600;letter-spacing:.06em}
.card .route .arr{color:var(--amber)}
.card .save{font-family:var(--mono);font-size:1.3rem;font-weight:600}
.card .save.pos{color:var(--good)}
.card .save.neg{color:var(--bad)}
.kv{display:flex;justify-content:space-between;font-size:.78rem;color:var(--dim)}
.kv b{color:var(--text);font-weight:500;font-family:var(--mono)}
.tag{display:inline-block;font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--line);border-radius:4px;padding:2px 8px;color:var(--dim)}
.tag.rec{border-color:var(--good);color:var(--good)}
.note{font-size:.72rem;color:var(--dim);border-top:1px dashed var(--line);padding-top:8px}
/* explanation */
.explain{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:16px;font-size:.9rem;line-height:1.55}
.hidden{display:none}
/* calendar */
.calgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
.calcell{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px;font-family:var(--mono);font-size:.7rem;cursor:pointer}
.calcell:hover{border-color:var(--amber-dim)}
.calcell .d{color:var(--dim)}
.calcell .p{font-size:.85rem;font-weight:600;margin-top:4px}
footer{margin-top:48px;color:var(--dim);font-size:.7rem;font-family:var(--mono);border-top:1px solid var(--line);padding-top:14px;line-height:1.7}
@media(max-width:640px){
  .row{grid-template-columns:1fr auto;row-gap:4px}
  .row.head{display:none}
  .row .hidemobile{display:none}
}
@media(prefers-reduced-motion:no-preference){
  .card,.verdict{transition:border-color .2s}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>FLIGHT&nbsp;STRATEGY&nbsp;AI</h1>
    <span class="sub">HKG · SZX · CAN · MFM — the smartest way out, not just the cheapest fare</span>
  </header>

  <section class="search">
    <div class="grid">
      <div><label for="dest">Destination (IATA)</label><input id="dest" placeholder="KTM" maxlength="3" autocapitalize="characters"></div>
      <div><label for="dep">Depart</label><input id="dep" type="date"></div>
      <div><label for="ret">Return</label><input id="ret" type="date"></div>
      <div><label for="pax">Travellers</label><select id="pax"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
    </div>
    <div class="chips" id="weekendChips"></div>
    <div class="toggle"><input type="checkbox" id="alt" checked><label for="alt" style="margin:0;text-transform:none;font-size:.8rem">Also check Shenzhen, Guangzhou and Macau departures</label></div>
    <div class="actions">
      <button class="primary" id="go">Search strategies</button>
      <button class="ghost" id="calBtn">Fare calendar (HKG)</button>
    </div>
    <div class="status" id="status"></div>
  </section>

  <div id="results" class="hidden">
    <div class="board-eyebrow">Price verdict — HKG departure</div>
    <div class="verdict" id="verdict"></div>
    <div id="qwrap"></div>

    <div class="board-eyebrow">Departures board — best bookable fares from HKG</div>
    <div class="board" id="board"></div>

    <div class="board-eyebrow">Alternative departure strategies — real total cost</div>
    <div class="cards" id="cards"></div>

    <div class="board-eyebrow">Analysis</div>
    <div class="explain" id="explain">Generating…</div>
  </div>

  <div id="calwrap" class="hidden">
    <div class="board-eyebrow">Cheapest dates — HKG → <span id="caldest"></span></div>
    <div id="calnote" class="status"></div>
    <div class="calgrid" id="calgrid"></div>
  </div>

  <footer>
    Fares via Amadeus Self-Service API · prices include taxes as returned by the carrier/GDS ·
    ground-transport estimates are configurable in the Worker · verify final price at booking.
  </footer>
</div>

<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var status=$('status');

  /* ---- weekend chips: next 6 Fridays → following Monday ---- */
  function pad(n){return (n<10?'0':'')+n}
  function iso(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
  function nextFridays(n){
    var out=[],d=new Date();
    d.setDate(d.getDate()+((5-d.getDay()+7)%7||7));
    for(var i=0;i<n;i++){out.push(new Date(d));d=new Date(d);d.setDate(d.getDate()+7)}
    return out;
  }
  var chipWrap=$('weekendChips');
  nextFridays(6).forEach(function(f){
    var m=new Date(f); m.setDate(m.getDate()+3); // Monday
    var b=document.createElement('button');
    b.type='button'; b.className='chip';
    b.textContent='Fri '+pad(f.getDate())+'/'+pad(f.getMonth()+1)+' → Mon';
    b.addEventListener('click',function(){$('dep').value=iso(f);$('ret').value=iso(m)});
    chipWrap.appendChild(b);
  });

  /* ---- search ---- */
  var lastResult=null;
  $('go').addEventListener('click',function(){
    var dest=($('dest').value||'').trim().toUpperCase();
    if(dest.length!==3){status.className='status err';status.textContent='Enter a 3-letter airport code (e.g. KTM, TPE, BKK).';return}
    if(!$('dep').value){status.className='status err';status.textContent='Pick a departure date.';return}
    status.className='status';status.textContent='Searching 4 origins in parallel…';
    $('go').disabled=true;
    fetch('/api/search',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({destination:dest,departDate:$('dep').value,returnDate:$('ret').value||undefined,
        adults:+$('pax').value,includeAltOrigins:$('alt').checked})})
    .then(function(r){return r.json()})
    .then(function(data){
      $('go').disabled=false;
      if(data.error){status.className='status err';status.textContent=data.error;return}
      lastResult=data;
      status.textContent=data.cached?'Served from cache (6h) — quota saved.':'Live results.';
      render(data);
    })
    .catch(function(e){$('go').disabled=false;status.className='status err';status.textContent='Request failed: '+e.message});
  });

  function hk(n){return 'HK$'+Math.round(n).toLocaleString()}

  function render(data){
    $('results').classList.remove('hidden');
    $('calwrap').classList.add('hidden');

    /* verdict strip */
    var v=data.verdict||{};
    var vhtml='<span class="badge">'+(v.badge||'—')+'</span>'
      +'<div><div class="big">'+(data.home.cheapest!=null?hk(data.home.cheapest):'No fares')+'</div>'
      +'<div class="meta">'+(v.label||'')+' · '+(data.advice||'')+'</div></div>';
    $('verdict').innerHTML=vhtml;

    /* quartile bar */
    var qw=$('qwrap');qw.innerHTML='';
    if(v.quartiles&&data.home.cheapest!=null){
      var q=v.quartiles,min=q.MINIMUM,max=q.MAXIMUM,span=max-min||1;
      function pct(x){return Math.max(0,Math.min(100,(x-min)/span*100))}
      var bar=document.createElement('div');bar.className='qbar';
      bar.innerHTML='<div class="qmark" style="left:'+pct(data.home.cheapest)+'%"></div>'
        +'<span class="qlabel" style="left:0%">'+hk(min)+'</span>'
        +'<span class="qlabel" style="left:'+pct(q.MEDIUM)+'%">median '+hk(q.MEDIUM)+'</span>'
        +'<span class="qlabel" style="left:100%">'+hk(max)+'</span>';
      qw.appendChild(bar);
    }

    /* board */
    var b=$('board');
    var rows='<div class="row head"><span>Airline</span><span>Out</span><span class="hidemobile">Back</span><span class="hidemobile">Duration</span><span class="hidemobile">Stops</span><span>Price</span></div>';
    var offers=(data.home.offers||[]).slice(0,8);
    if(!offers.length){rows+='<div class="row"><span class="dim">'+(data.home.error||'No HKG fares returned for these dates.')+'</span></div>'}
    offers.forEach(function(o){
      var out=o.legs[0],back=o.legs[1];
      function leg(l){if(!l)return'<span class="dim hidemobile">—</span>';
        return '<span class="dim '+(l===back?'hidemobile':'')+'">'+l.depart.slice(11,16)+'–'+l.arrive.slice(11,16)+'</span>'}
      rows+='<div class="row"><span class="air">'+o.airlines.join(' + ')+'</span>'
        +leg(out)+leg(back)
        +'<span class="dim hidemobile">'+fmtMin(o.totalDurationMin)+'</span>'
        +'<span class="dim hidemobile">'+(o.maxStops===0?'Direct':o.maxStops+' stop')+'</span>'
        +'<span class="price">'+hk(o.price)+'</span></div>';
    });
    b.innerHTML=rows;

    /* strategy cards */
    var c=$('cards');c.innerHTML='';
    (data.strategies||[]).forEach(function(s){
      var el=document.createElement('div');
      el.className='card'+(s.worthIt?' win':'');
      if(!s.available){
        el.innerHTML='<div class="route">'+s.origin+' <span class="arr">▸</span> '+data.query.destination+'</div>'
          +'<div class="kv"><span>'+s.city+'</span></div>'
          +'<div class="note">'+ (s.reason||'No fares') +'</div>';
      }else{
        var pos=s.savingsHKD!=null&&s.savingsHKD>0;
        el.innerHTML='<div class="route">'+s.origin+' <span class="arr">▸</span> '+data.query.destination
          +' &nbsp;'+(s.worthIt?'<span class="tag rec">Recommended</span>':'<span class="tag">'+s.difficulty+'</span>')+'</div>'
          +'<div class="save '+(pos?'pos':'neg')+'">'+(pos?'Save ':'Costs +')+hk(Math.abs(s.savingsHKD||0))+'</div>'
          +'<div class="kv"><span>Fare from '+s.city+'</span><b>'+hk(s.fare)+'</b></div>'
          +'<div class="kv"><span>Ground transport (rt)</span><b>'+hk(s.groundCostHKD)+'</b></div>'
          +'<div class="kv"><span>Real total</span><b>'+hk(s.totalCostHKD)+'</b></div>'
          +'<div class="kv"><span>Extra travel time</span><b>'+s.extraTimeLabel+'</b></div>'
          +'<div class="note">'+s.transport+'. '+s.note+'</div>';
      }
      c.appendChild(el);
    });

    /* explanation */
    $('explain').textContent='Generating…';
    fetch('/api/explain',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({result:data})})
    .then(function(r){return r.json()})
    .then(function(d){$('explain').textContent=d.explanation+(d.source==='template'?'  [rule-based — add a Workers AI binding for smarter analysis]':'')})
    .catch(function(){$('explain').textContent='Explanation unavailable.'});
  }

  function fmtMin(m){var h=Math.floor(m/60);return h+'h'+(m%60?pad(m%60)+'m':'')}

  /* ---- calendar ---- */
  $('calBtn').addEventListener('click',function(){
    var dest=($('dest').value||'').trim().toUpperCase();
    if(dest.length!==3){status.className='status err';status.textContent='Enter a destination code first.';return}
    var s=new Date(),e=new Date();e.setDate(e.getDate()+60);
    status.className='status';status.textContent='Loading fare calendar…';
    fetch('/api/calendar?destination='+dest+'&start='+iso(s)+'&end='+iso(e))
    .then(function(r){return r.json()})
    .then(function(d){
      status.textContent='';
      $('results').classList.add('hidden');
      $('calwrap').classList.remove('hidden');
      $('caldest').textContent=dest;
      var g=$('calgrid');g.innerHTML='';
      if(!d.available){$('calnote').textContent=d.reason;return}
      $('calnote').textContent=d.note||'';
      var prices=d.dates.map(function(x){return x.price});
      var min=Math.min.apply(null,prices),max=Math.max.apply(null,prices),span=max-min||1;
      d.dates.forEach(function(x){
        var t=(x.price-min)/span; /* 0 cheap → 1 expensive */
        var col=t<0.33?'var(--good)':(t<0.66?'var(--warn)':'var(--bad)');
        var cell=document.createElement('div');cell.className='calcell';
        cell.innerHTML='<div class="d">'+x.departureDate+'</div><div class="p" style="color:'+col+'">€'+Math.round(x.price)+'</div>';
        cell.addEventListener('click',function(){
          $('dep').value=x.departureDate;
          if(x.returnDate)$('ret').value=x.returnDate;
          window.scrollTo({top:0,behavior:'smooth'});
        });
        g.appendChild(cell);
      });
    })
    .catch(function(e){status.className='status err';status.textContent='Calendar failed: '+e.message});
  });
})();
</script>
</body>
</html>`;
