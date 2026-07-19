/**
 * ================================================================
 *  FLIGHT DEAL OPTIMIZATION ENGINE — Phase 2
 *
 *  Search (route / month / anywhere)  +  nearby-airport optimizer
 *  +  multi-destination booking links  +  promotions feed  +  AI analysis
 *  Global, bilingual (繁中 / EN), PWA. One Cloudflare Worker.
 * ================================================================
 *
 *  BINDINGS
 *    Secret   TRAVELPAYOUTS_TOKEN   travelpayouts.com → Profile → API token
 *    Secret   GEMINI_API_KEY        (optional) narration layer
 *    Var      TP_MARKER             (optional) marker appended to Aviasales links
 *    Var      DEFAULT_MARKET        (optional) data market, default "hk"
 *    KV       HISTORY               (optional) price history + feed cache
 *
 *  HONEST SCOPE
 *    Price data comes from ONE source (Travelpayouts / Aviasales cached fares).
 *    Google Flights, Skyscanner and Kayak have no public API, so this app does
 *    NOT search them. It builds verified deep links so you can price-check the
 *    same itinerary there yourself, and links you to the airline's own site to
 *    book direct. Booking destinations are plural; the price source is not.
 *
 *  ROUTES
 *    GET /                    app
 *    GET /manifest.json       PWA manifest
 *    GET /sw.js               service worker
 *    GET /api/search          mode=route|month|anywhere, trip=return|oneway
 *    GET /api/nearby          alternative departure/arrival airports
 *    GET /api/deals           promotions + community signals
 *    GET /api/analyze         Gemini narration over computed facts
 *    GET /api/places          autocomplete
 */

const TP = "https://api.travelpayouts.com";

/* ================================================================
 * Transport
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
 * BOOKING DESTINATIONS
 *
 * Deep links are constructed, never scraped. Airline-direct is listed
 * first because booking with the carrier is the safest place to be when
 * a flight is cancelled or needs changing — OTA middlemen are where
 * refunds go to die. Metasearch links exist so the price can be
 * independently verified before paying anywhere.
 * ================================================================ */

// Booking pages for carriers likely to appear on these routes.
// Value is the airline's own booking entry point. Dates are not
// pre-filled (patterns break constantly), and the UI says so.
const AIRLINE_SITES = {
  CX: { name: "Cathay Pacific", url: "https://www.cathaypacific.com/cx/en_HK/book-a-trip.html" },
  UO: { name: "HK Express", url: "https://www.hkexpress.com/en-hk/" },
  HX: { name: "Hong Kong Airlines", url: "https://www.hongkongairlines.com/en_HK/homepage" },
  KA: { name: "Cathay Dragon", url: "https://www.cathaypacific.com/cx/en_HK/book-a-trip.html" },
  SQ: { name: "Singapore Airlines", url: "https://www.singaporeair.com/" },
  TR: { name: "Scoot", url: "https://www.flyscoot.com/" },
  NH: { name: "ANA", url: "https://www.ana.co.jp/en/us/" },
  JL: { name: "Japan Airlines", url: "https://www.jal.co.jp/en/" },
  MM: { name: "Peach", url: "https://www.flypeach.com/en" },
  KE: { name: "Korean Air", url: "https://www.koreanair.com/" },
  OZ: { name: "Asiana Airlines", url: "https://flyasiana.com/" },
  "7C": { name: "Jeju Air", url: "https://www.jejuair.net/en/main/base/main.do" },
  TW: { name: "T'way Air", url: "https://www.twayair.com/app/main" },
  BR: { name: "EVA Air", url: "https://www.evaair.com/" },
  CI: { name: "China Airlines", url: "https://www.china-airlines.com/" },
  AK: { name: "AirAsia", url: "https://www.airasia.com/" },
  FD: { name: "Thai AirAsia", url: "https://www.airasia.com/" },
  D7: { name: "AirAsia X", url: "https://www.airasia.com/" },
  TG: { name: "Thai Airways", url: "https://www.thaiairways.com/" },
  VN: { name: "Vietnam Airlines", url: "https://www.vietnamairlines.com/" },
  VJ: { name: "VietJet Air", url: "https://www.vietjetair.com/" },
  PR: { name: "Philippine Airlines", url: "https://www.philippineairlines.com/" },
  "5J": { name: "Cebu Pacific", url: "https://www.cebupacificair.com/" },
  MH: { name: "Malaysia Airlines", url: "https://www.malaysiaairlines.com/" },
  GA: { name: "Garuda Indonesia", url: "https://www.garuda-indonesia.com/" },
  EK: { name: "Emirates", url: "https://www.emirates.com/" },
  QR: { name: "Qatar Airways", url: "https://www.qatarairways.com/" },
  BA: { name: "British Airways", url: "https://www.britishairways.com/" },
  AF: { name: "Air France", url: "https://www.airfrance.com/" },
  LH: { name: "Lufthansa", url: "https://www.lufthansa.com/" },
  KL: { name: "KLM", url: "https://www.klm.com/" },
  TK: { name: "Turkish Airlines", url: "https://www.turkishairlines.com/" },
  UA: { name: "United Airlines", url: "https://www.united.com/" },
  AA: { name: "American Airlines", url: "https://www.aa.com/" },
  DL: { name: "Delta Air Lines", url: "https://www.delta.com/" },
  QF: { name: "Qantas", url: "https://www.qantas.com/" },
  CZ: { name: "China Southern", url: "https://www.csair.com/" },
  MU: { name: "China Eastern", url: "https://us.ceair.com/" },
  CA: { name: "Air China", url: "https://www.airchina.us/" },
};

const dm = (iso) => iso.slice(8, 10) + iso.slice(5, 7);   // DDMM
const ymd = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10); // YYMMDD

/**
 * Every place this itinerary can be booked or verified.
 * kind: "airline" (book direct) | "meta" (verify price)
 */
function bookingOptions(o, marker, pax) {
  const out = [];
  const p = pax || 1;
  if (!o.origin || !o.destination || !o.departDate) return out;

  // 1. Airline direct — safest for changes, cancellations, disputes.
  const air = o.airlineCode && AIRLINE_SITES[o.airlineCode];
  if (air) {
    out.push({ id: "airline", kind: "airline", label: air.name, url: air.url, datesPrefilled: false });
  }

  // 2. Google Flights — best independent cross-check, dates pre-filled.
  const gq =
    "Flights from " + o.origin + " to " + o.destination +
    " on " + o.departDate + (o.returnDate ? " through " + o.returnDate : " one way");
  out.push({
    id: "google", kind: "meta", label: "Google Flights",
    url: "https://www.google.com/travel/flights?q=" + encodeURIComponent(gq),
    datesPrefilled: true,
  });

  // 3. Skyscanner — /transport/flights/from/to/YYMMDD/YYMMDD/
  let sky = "https://www.skyscanner.net/transport/flights/" +
    o.origin.toLowerCase() + "/" + o.destination.toLowerCase() + "/" + ymd(o.departDate) + "/";
  if (o.returnDate) sky += ymd(o.returnDate) + "/";
  out.push({ id: "skyscanner", kind: "meta", label: "Skyscanner", url: sky, datesPrefilled: true });

  // 4. Kayak — /flights/ORIG-DEST/YYYY-MM-DD/YYYY-MM-DD
  let kayak = "https://www.kayak.com/flights/" + o.origin + "-" + o.destination + "/" + o.departDate;
  if (o.returnDate) kayak += "/" + o.returnDate;
  out.push({ id: "kayak", kind: "meta", label: "Kayak", url: kayak, datesPrefilled: true });

  // 5. Aviasales — the source of this price, so the figure should match here.
  let seg = o.origin + dm(o.departDate) + o.destination;
  if (o.returnDate) seg += dm(o.returnDate);
  seg += String(p);
  out.push({
    id: "aviasales", kind: "meta", label: "Aviasales",
    url: "https://www.aviasales.com/search/" + seg + (marker ? "?marker=" + marker : ""),
    datesPrefilled: true, isPriceSource: true,
  });

  return out;
}

/* ================================================================
 * THE SEAM — normalized Offer
 * ================================================================ */

function makeOffer(x) {
  const returnDate = x.returnDate || null;
  return {
    origin: x.origin || null,
    destination: x.destination || null,
    departDate: x.departDate || null,
    returnDate,
    // Explicit, never inferred by the UI. A one-way price must never be
    // presented as though it answered a round-trip question.
    tripType: returnDate ? "return" : "oneway",
    priceTotal: x.priceTotal != null ? Math.round(x.priceTotal) : null,
    currency: x.currency || "HKD",
    stops: x.stops != null ? x.stops : null,
    airlineCode: x.airlineCode || null,
    airlineName: x.airlineName || x.airlineCode || null,
    // Unsupported by cached-price providers → null, never fabricated.
    flightNumber: x.flightNumber != null ? String(x.flightNumber) : null,
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
 * PROVIDERS
 * ================================================================ */

const PROVIDERS = {
  travelpayouts: {
    id: "travelpayouts",
    label: "Travelpayouts / Aviasales",
    supportsLiveItinerary: false,

    async searchRoute(env, q, names) {
      const b = await tpGet(env, "/aviasales/v3/prices_for_dates", {
        origin: q.origin,
        destination: q.destination,
        departure_at: q.departDate,
        // Only send return_at when a round trip is actually wanted.
        return_at: q.trip === "return" ? q.returnDate : "",
        one_way: q.trip === "return" ? "false" : "true",
        direct: q.directOnly ? "true" : "false",
        currency: (q.currency || "hkd").toLowerCase(),
        sorting: "price", limit: 30, page: 1, market: q.market,
      });
      return (b.data || []).map((d) =>
        makeOffer({
          origin: d.origin, destination: d.destination,
          departDate: (d.departure_at || "").slice(0, 10),
          returnDate: (d.return_at || "").slice(0, 10) || null,
          priceTotal: d.price, currency: (q.currency || "HKD").toUpperCase(),
          stops: d.transfers != null ? d.transfers : d.number_of_changes,
          airlineCode: d.airline, airlineName: names[d.airline] || d.airline,
          flightNumber: d.flight_number,
          departTime: d.departure_at && d.departure_at.length > 10 ? d.departure_at : null,
          durationMin: d.duration != null ? d.duration : null,
          provider: "travelpayouts",
        })
      );
    },

    /** month-matrix reliably carries return_date pairs — the round-trip workhorse. */
    async searchMonth(env, q, names) {
      const b = await tpGet(env, "/v2/prices/month-matrix", {
        currency: (q.currency || "hkd").toLowerCase(),
        origin: q.origin, destination: q.destination,
        month: q.month + "-01",
        show_to_affiliates: "true", market: q.market,
      });
      return (b.data || []).map((d) =>
        makeOffer({
          origin: q.origin, destination: q.destination,
          departDate: d.depart_date, returnDate: d.return_date || null,
          priceTotal: d.value, currency: (q.currency || "HKD").toUpperCase(),
          stops: d.number_of_changes,
          airlineCode: d.gate || null, airlineName: names[d.gate] || d.gate || null,
          provider: "travelpayouts",
        })
      );
    },

    /** Last-resort route lookup — whatever was cached recently, any dates. */
    async searchLatestForRoute(env, q, names) {
      const b = await tpGet(env, "/v2/prices/latest", {
        currency: (q.currency || "hkd").toLowerCase(),
        origin: q.origin, destination: q.destination,
        period_type: "year", one_way: q.trip === "return" ? "false" : "true",
        page: 1, limit: 30, show_to_affiliates: "true", sorting: "price", market: q.market,
      });
      return (b.data || []).map((d) =>
        makeOffer({
          origin: d.origin || q.origin, destination: d.destination || q.destination,
          departDate: d.depart_date, returnDate: d.return_date || null,
          priceTotal: d.value, currency: (q.currency || "HKD").toUpperCase(),
          stops: d.number_of_changes,
          airlineCode: d.gate || null, airlineName: names[d.gate] || d.gate || null,
          provider: "travelpayouts",
        })
      );
    },

    async searchAnywhere(env, q, names) {
      const b = await tpGet(env, "/aviasales/v3/get_latest_prices", {
        currency: (q.currency || "hkd").toLowerCase(),
        origin: q.origin, period_type: "year",
        one_way: q.trip === "return" ? "false" : "true",
        page: 1, limit: 100, show_to_affiliates: "true", sorting: "price", market: q.market,
      });
      return (b.data || []).map((d) =>
        makeOffer({
          origin: d.origin, destination: d.destination,
          departDate: d.depart_date, returnDate: d.return_date || null,
          priceTotal: d.value, currency: (q.currency || "HKD").toUpperCase(),
          stops: d.number_of_changes,
          airlineCode: d.gate || null, airlineName: names[d.gate] || d.gate || null,
          provider: "travelpayouts",
        })
      );
    },

    /** Nearby airports, globally — no hardcoded city tables. */
    async nearbyMatrix(env, q) {
      return await tpGet(env, "/v2/prices/nearest-places-matrix", {
        currency: (q.currency || "hkd").toLowerCase(),
        origin: q.origin, destination: q.destination,
        depart_date: q.departDate, return_date: q.returnDate,
        distance: q.distance || 500,
        limit: 20, flexibility: 7, show_to_affiliates: "true", market: q.market,
      });
    },
  },
};

/* ================================================================
 * SCORING
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

/**
 * Round-trip and one-way fares are never mixed into one baseline —
 * comparing them would manufacture fake discounts.
 */
function scoreOffers(offers, history) {
  const byType = { return: [], oneway: [] };
  for (const o of offers) if (o.priceTotal != null) byType[o.tripType].push(o.priceTotal);

  const histPoints = (history && history.points ? history.points : []);

  const baselineFor = (tripType) => {
    const hist = histPoints.filter((p) => p.tripType === tripType && p.price != null).map((p) => p.price);
    if (hist.length >= 5) {
      return {
        base: median(hist), kind: "history", samples: hist.length,
        confidence: hist.length >= 45 ? "high" : hist.length >= 20 ? "medium" : "low",
      };
    }
    const set = byType[tripType];
    if (!set.length) return null;
    return { base: median(set), kind: "resultset", samples: set.length, confidence: "low" };
  };

  const bases = { return: baselineFor("return"), oneway: baselineFor("oneway") };
  const cheapest = {
    return: byType.return.length ? Math.min(...byType.return) : null,
    oneway: byType.oneway.length ? Math.min(...byType.oneway) : null,
  };

  return offers.map((o) => {
    const b = bases[o.tripType];
    if (o.priceTotal == null || !b) return { ...o, score: null };
    const pct = Math.round(((b.base - o.priceTotal) / b.base) * 100);
    return {
      ...o,
      score: {
        ...verdict(pct),
        discountPct: pct,
        baseline: Math.round(b.base),
        baselineKind: b.kind,
        baselineTripType: o.tripType,
        samples: b.samples,
        confidence: b.confidence,
        isCheapest: o.priceTotal === cheapest[o.tripType],
      },
    };
  });
}

async function recordHistory(env, route, offer) {
  if (!env.HISTORY || !offer || offer.priceTotal == null) return;
  const key = "hist:" + route;
  const h = (await env.HISTORY.get(key, "json")) || { route, points: [] };
  const date = new Date().toISOString().slice(0, 10);
  h.points = h.points.filter((p) => !(p.date === date && p.tripType === offer.tripType));
  h.points.push({ date, price: offer.priceTotal, currency: offer.currency, tripType: offer.tripType });
  h.points.sort((a, b) => a.date.localeCompare(b.date));
  if (h.points.length > 180) h.points = h.points.slice(-180);
  await env.HISTORY.put(key, JSON.stringify(h));
}

/* ================================================================
 * /api/search
 * ================================================================ */

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function handleSearch(request, env) {
  const p = new URL(request.url).searchParams;
  const mode = p.get("mode") || "route";
  const trip = p.get("trip") === "oneway" ? "oneway" : "return";
  const q = {
    origin: (p.get("origin") || "").toUpperCase().trim(),
    destination: (p.get("destination") || "").toUpperCase().trim(),
    departDate: p.get("departDate") || "",
    returnDate: p.get("returnDate") || "",
    month: p.get("month") || "",
    currency: (p.get("currency") || "HKD").toUpperCase(),
    directOnly: p.get("direct") === "1",
    trip,
    pax: parseInt(p.get("pax") || "1", 10),
    market: env.DEFAULT_MARKET || "hk",
  };

  if (!env.TRAVELPAYOUTS_TOKEN) return json({ error: "TRAVELPAYOUTS_TOKEN is not configured." }, 500);
  if (!q.origin) return json({ error: "origin required" }, 400);
  if (mode !== "anywhere" && !q.destination) return json({ error: "destination required" }, 400);

  const provider = PROVIDERS.travelpayouts;
  const names = await airlineNames(env);
  const notes = [];
  let offers = [];

  try {
    if (mode === "anywhere") {
      offers = await provider.searchAnywhere(env, q, names);
    } else if (mode === "month") {
      if (!q.month) return json({ error: "month required (YYYY-MM)" }, 400);
      offers = await provider.searchMonth(env, q, names);
    } else {
      // ---- Round-trip resolution ladder ----
      // Each rung is tried only if the previous produced nothing matching the
      // requested trip type. What actually happened is reported to the user.
      offers = await provider.searchRoute(env, q, names);

      const matches = (list) => list.filter((o) => o.tripType === q.trip);

      if (!matches(offers).length && q.trip === "return") {
        const month = (q.departDate || "").slice(0, 7);
        if (month) {
          const m = await provider.searchMonth(env, { ...q, month }, names);
          if (matches(m).length) { offers = m; notes.push("fallback_month"); }
        }
      }
      if (!matches(offers).length && q.trip === "return") {
        const l = await provider.searchLatestForRoute(env, q, names);
        if (matches(l).length) { offers = l; notes.push("fallback_latest"); }
      }
    }
  } catch (e) {
    return json({ error: e.message }, 502);
  }

  offers = offers.filter((o) => o.priceTotal != null && o.priceTotal > 0);
  if (q.directOnly) offers = offers.filter((o) => o.stops === 0);

  // Honest trip-type separation: never let a one-way price masquerade as a return.
  const wanted = offers.filter((o) => o.tripType === q.trip);
  const other = offers.filter((o) => o.tripType !== q.trip);
  if (!wanted.length && other.length) notes.push("only_other_triptype");

  const primary = wanted.length ? wanted : [];
  primary.sort((a, b) => a.priceTotal - b.priceTotal);
  other.sort((a, b) => a.priceTotal - b.priceTotal);

  let history = null;
  if (mode !== "anywhere" && q.origin && q.destination) {
    const route = q.origin + "-" + q.destination;
    if (env.HISTORY) history = await env.HISTORY.get("hist:" + route, "json");
    if (primary.length) { try { await recordHistory(env, route, primary[0]); } catch (e) {} }
  }

  const scored = scoreOffers(primary.concat(other), history);
  const withLinks = scored.map((o) => ({
    ...o,
    booking: bookingOptions(o, env.TP_MARKER, q.pax),
  }));

  return json({
    mode, trip, query: q,
    provider: {
      id: provider.id, label: provider.label,
      supportsLiveItinerary: provider.supportsLiveItinerary,
      priceSourceCount: 1,
    },
    count: withLinks.filter((o) => o.tripType === q.trip).length,
    otherTripTypeCount: withLinks.filter((o) => o.tripType !== q.trip).length,
    offers: withLinks.slice(0, 60),
    historyPoints: history && history.points ? history.points.length : 0,
    notes,
  });
}

/* ================================================================
 * /api/nearby — alternative airports, globally
 * ================================================================ */

async function handleNearby(request, env) {
  const p = new URL(request.url).searchParams;
  const q = {
    origin: (p.get("origin") || "").toUpperCase().trim(),
    destination: (p.get("destination") || "").toUpperCase().trim(),
    departDate: p.get("departDate") || "",
    returnDate: p.get("returnDate") || "",
    currency: (p.get("currency") || "HKD").toUpperCase(),
    distance: parseInt(p.get("distance") || "500", 10),
    market: env.DEFAULT_MARKET || "hk",
  };
  if (!q.origin || !q.destination) return json({ error: "origin and destination required" }, 400);
  if (!env.TRAVELPAYOUTS_TOKEN) return json({ error: "TRAVELPAYOUTS_TOKEN is not configured." }, 500);

  let raw;
  try {
    raw = await PROVIDERS.travelpayouts.nearbyMatrix(env, q);
  } catch (e) {
    return json({ error: e.message }, 502);
  }

  const names = await airlineNames(env);
  const rows = (raw.prices || raw.data || []).map((d) =>
    makeOffer({
      origin: d.origin, destination: d.destination,
      departDate: d.depart_date, returnDate: d.return_date || null,
      priceTotal: d.value, currency: q.currency,
      stops: d.number_of_changes,
      airlineCode: d.gate || null, airlineName: names[d.gate] || d.gate || null,
      provider: "travelpayouts",
    })
  ).filter((o) => o.priceTotal != null);

  // Baseline: the requested airport pair, if present in the matrix.
  const exact = rows.filter((o) => o.origin === q.origin && o.destination === q.destination);
  const baseline = exact.length ? Math.min(...exact.map((o) => o.priceTotal)) : null;

  const alts = rows
    .filter((o) => o.origin !== q.origin || o.destination !== q.destination)
    .map((o) => ({
      ...o,
      changedOrigin: o.origin !== q.origin,
      changedDestination: o.destination !== q.destination,
      savingVsBaseline: baseline != null ? baseline - o.priceTotal : null,
      booking: bookingOptions(o, env.TP_MARKER, 1),
    }))
    .sort((a, b) => a.priceTotal - b.priceTotal);

  return json({
    query: q,
    baseline,
    baselineOffers: exact.map((o) => ({ ...o, booking: bookingOptions(o, env.TP_MARKER, 1) })),
    alternatives: alts.slice(0, 20),
    // Ground transport cost is NOT known globally. Distance/time between
    // airports is the user's call — the app must not invent HSR fares.
    groundCostKnown: false,
  });
}

/* ================================================================
 * /api/deals — promotions + community signals (public sources only)
 * ================================================================ */

const SOURCES = [
  { id: "r-traveldeals", type: "reddit", sub: "TravelDeals", label: "r/TravelDeals" },
  { id: "r-awardtravel", type: "reddit", sub: "awardtravel", label: "r/awardtravel" },
  { id: "r-flights", type: "reddit", sub: "flights", label: "r/flights" },
];

const DEAL_WORDS = ["error fare", "mistake fare", "flash sale", "promo", "promotion",
  "sale", "deal", "discount", "% off", "fare drop", "glitch"];

function scoreSignal(title, body, origin) {
  const t = (title + " " + (body || "")).toLowerCase();
  let score = 0; const matched = [];
  for (const k of DEAL_WORDS) if (t.includes(k)) { score += 2; matched.push(k); }
  if (t.includes("error fare") || t.includes("mistake fare")) score += 6;
  if (origin && t.includes(origin.toLowerCase())) { score += 4; matched.push(origin); }
  return { score, matched: [...new Set(matched)] };
}

async function handleDeals(request, env) {
  const origin = (new URL(request.url).searchParams.get("origin") || "").toUpperCase();
  const cacheKey = "deals:" + (origin || "all");
  if (env.HISTORY) {
    const hit = await env.HISTORY.get(cacheKey, "json");
    if (hit) return json({ ...hit, cached: true });
  }

  const jobs = SOURCES.map(async (s) => {
    try {
      const r = await fetch("https://www.reddit.com/r/" + s.sub + "/new.json?limit=25", {
        headers: { "User-Agent": "flight-deal-engine/1.0 (personal use)" },
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      const items = (d.data && d.data.children ? d.data.children : []).map((c) => ({
        source: s.label, title: c.data.title,
        url: "https://reddit.com" + c.data.permalink,
        body: (c.data.selftext || "").slice(0, 300),
        ts: c.data.created_utc * 1000,
      }));
      return { id: s.id, ok: true, items };
    } catch (e) {
      return { id: s.id, ok: false, error: e.message, items: [] };
    }
  });

  const settled = await Promise.all(jobs);

  const fp = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 70);
  const seen = new Map();
  for (const it of settled.flatMap((s) => s.items)) {
    const sc = { ...it, ...scoreSignal(it.title, it.body, origin) };
    if (sc.score < 3) continue;
    const k = fp(sc.title);
    const prev = seen.get(k);
    if (!prev) seen.set(k, { ...sc, alsoSeenIn: [] });
    else if (prev.source !== sc.source && !prev.alsoSeenIn.includes(sc.source)) {
      prev.alsoSeenIn.push(sc.source); prev.score += 1;
    }
  }

  const payload = {
    items: [...seen.values()].sort((a, b) => b.score - a.score || b.ts - a.ts).slice(0, 30),
    sources: settled.map((s) => ({ id: s.id, ok: s.ok, error: s.error, count: s.items.length })),
    refreshedAt: new Date().toISOString(),
  };
  if (env.HISTORY) await env.HISTORY.put(cacheKey, JSON.stringify(payload), { expirationTtl: 10800 });
  return json(payload);
}

/* ================================================================
 * /api/analyze — Gemini narrates computed facts only
 * ================================================================ */

async function handleAnalyze(request, env) {
  const body = await request.json().catch(() => ({}));
  const { offers, nearby, query, lang } = body;
  const top = (offers || []).slice(0, 5);

  const zh = lang === "zh";
  const fallbackParts = [];
  if (top.length) {
    const b = top[0];
    fallbackParts.push(zh
      ? "最平係 " + b.origin + "→" + b.destination + " " + b.currency + b.priceTotal +
        (b.score ? ",比基準" + (b.score.discountPct >= 0 ? "平" : "貴") + Math.abs(b.score.discountPct) + "%" : "")
      : "Cheapest is " + b.origin + "→" + b.destination + " " + b.currency + b.priceTotal +
        (b.score ? ", " + Math.abs(b.score.discountPct) + "% " + (b.score.discountPct >= 0 ? "below" : "above") + " baseline" : ""));
  }
  if (nearby && nearby.best) {
    fallbackParts.push(zh
      ? "改用 " + nearby.best.origin + " 出發平 " + nearby.best.savingVsBaseline + " 蚊,但要自己計埋交通費同時間。"
      : "Departing " + nearby.best.origin + " saves " + nearby.best.savingVsBaseline + ", before your own ground transport cost and time.");
  }
  const fallback = fallbackParts.join(" ") ||
    (zh ? "未有足夠資料做分析。" : "Not enough data to analyse yet.");

  if (!env.GEMINI_API_KEY) return json({ text: fallback, source: "rules" });

  try {
    const facts = {
      query,
      offers: top.map((o) => ({
        origin: o.origin, destination: o.destination, price: o.priceTotal, currency: o.currency,
        tripType: o.tripType, stops: o.stops, airline: o.airlineName,
        departDate: o.departDate, returnDate: o.returnDate,
        discountPct: o.score ? o.score.discountPct : null,
        confidence: o.score ? o.score.confidence : null,
        baselineKind: o.score ? o.score.baselineKind : null,
      })),
      nearbyAlternatives: nearby && nearby.alternatives
        ? nearby.alternatives.slice(0, 4).map((a) => ({
            origin: a.origin, destination: a.destination, price: a.priceTotal,
            saving: a.savingVsBaseline, changedOrigin: a.changedOrigin, changedDestination: a.changedDestination,
          }))
        : [],
    };

    const prompt =
      "You are a flight deal analyst. Use ONLY the numbers in this JSON. Never invent, adjust, " +
      "or estimate a price, and never claim to have searched any website. " +
      "Ground transport costs between airports are unknown to you — if you mention an alternative " +
      "airport, say the traveller must add their own transport cost and time. " +
      (zh ? "Reply in Traditional Chinese (Hong Kong style), under 120 words, plain text. "
          : "Reply in English, under 120 words, plain text. ") +
      "Say which option is best and why, and whether to book now or wait. " +
      "If confidence is low, say the baseline is thin. JSON: " + JSON.stringify(facts);

    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
        env.GEMINI_API_KEY,
      {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 320, temperature: 0.3 },
        }),
      }
    );
    const b = await r.json();
    if (!r.ok) throw new Error((b.error && b.error.message) || "HTTP " + r.status);
    const text = b.candidates && b.candidates[0] && b.candidates[0].content &&
      b.candidates[0].content.parts && b.candidates[0].content.parts[0] &&
      b.candidates[0].content.parts[0].text;
    return json({ text: (text && text.trim()) || fallback, source: "gemini" });
  } catch (e) {
    return json({ text: fallback, source: "rules", error: e.message });
  }
}

/* ================================================================
 * places
 * ================================================================ */

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

/* ================================================================
 * Router
 * ================================================================ */

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    try {
      if (p === "/api/search") return await handleSearch(request, env);
      if (p === "/api/nearby") return await handleNearby(request, env);
      if (p === "/api/deals") return await handleDeals(request, env);
      if (p === "/api/analyze" && request.method === "POST") return await handleAnalyze(request, env);
      if (p === "/api/places") return await handlePlaces(request);
      if (p === "/manifest.json")
        return new Response(JSON.stringify({
          name: "Flight Deal Engine", short_name: "FlightDeal",
          start_url: "/", display: "standalone",
          background_color: "#0d1117", theme_color: "#0d1117", icons: [],
        }), { headers: { "Content-Type": "application/json" } });
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
  "  if (new URL(e.request.url).pathname.indexOf('/api/') === 0) return;",
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
<title>Flight Deal Engine</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0d1117;--card:#161b22;--card2:#1c2330;--line:#262d3a;--tx:#e6edf3;--dim:#8b949e;
--acc:#3fb950;--acc2:#2ea043;--hot:#f85149;--warm:#d29922;--cool:#58a6ff;--vio:#a371f7;
--f:'Inter','Noto Sans TC',system-ui,-apple-system,sans-serif}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--tx);font-family:var(--f);min-height:100vh;font-size:15px;line-height:1.5}
.wrap{max-width:980px;margin:0 auto;padding:14px 14px 90px}
header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0 12px}
.logo{font-weight:700;font-size:1.05rem;letter-spacing:-.01em}.logo span{color:var(--acc)}
.lang{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.lang button{background:transparent;border:none;color:var(--dim);padding:6px 11px;font-size:.78rem;cursor:pointer;font-family:var(--f)}
.lang button.on{background:var(--card2);color:var(--tx);font-weight:600}
.tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px}
.tabs button{background:var(--card);border:1px solid var(--line);color:var(--dim);border-radius:9px;
padding:10px 4px;font-size:.79rem;cursor:pointer;font-family:var(--f);font-weight:500}
.tabs button.on{border-color:var(--acc);color:var(--acc);background:var(--card2)}
.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}
.modes button{background:var(--card);border:1px solid var(--line);color:var(--dim);border-radius:9px;
padding:10px 4px;font-size:.78rem;cursor:pointer;font-family:var(--f)}
.modes button.on{border-color:var(--cool);color:var(--cool);background:var(--card2)}
.trip{display:flex;gap:6px;margin-bottom:10px}
.trip button{flex:1;background:var(--card);border:1px solid var(--line);color:var(--dim);border-radius:9px;
padding:9px;font-size:.79rem;cursor:pointer;font-family:var(--f);font-weight:500}
.trip button.on{border-color:var(--acc);color:var(--acc);background:var(--card2)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.row{display:grid;gap:10px;margin-bottom:10px}.r2{grid-template-columns:1fr 1fr}.r3{grid-template-columns:1fr 1fr 1fr}
label{display:block;font-size:.7rem;color:var(--dim);margin-bottom:5px;font-weight:500}
input,select{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--tx);
padding:11px 10px;font-size:16px;font-family:var(--f);appearance:none}
input:focus,select:focus{outline:none;border-color:var(--acc)}
.ac{position:relative}
.aclist{position:absolute;top:100%;left:0;right:0;z-index:40;background:var(--card2);border:1px solid var(--line);
border-radius:8px;margin-top:4px;max-height:220px;overflow-y:auto;display:none}
.aclist.show{display:block}
.acitem{padding:10px;cursor:pointer;font-size:.85rem;border-bottom:1px solid var(--line)}
.acitem:last-child{border-bottom:none}.acitem:hover{background:var(--card)}
.acitem b{color:var(--acc)}.acitem small{color:var(--dim);display:block;font-size:.72rem}
.opts{display:flex;gap:14px;flex-wrap:wrap;margin:4px 0 12px}
.opts label{display:flex;align-items:center;gap:6px;font-size:.8rem;color:var(--dim);margin:0;cursor:pointer}
.opts input{width:auto;padding:0}
button.go{width:100%;background:var(--acc);color:#04260d;border:none;border-radius:9px;padding:14px;
font-size:.95rem;font-weight:700;cursor:pointer;font-family:var(--f)}
button.go:disabled{opacity:.5}
button.sec{width:100%;background:transparent;color:var(--cool);border:1px solid var(--line);border-radius:9px;
padding:12px;font-size:.85rem;font-weight:600;cursor:pointer;font-family:var(--f);margin-top:8px}
.status{font-size:.82rem;color:var(--warm);margin:12px 2px;min-height:1.2em}
.status.err{color:var(--hot)}
.sum{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 10px}
.pill{background:var(--card2);border:1px solid var(--line);border-radius:20px;padding:5px 11px;font-size:.72rem;color:var(--dim)}
.pill b{color:var(--tx)}
.ai{background:linear-gradient(180deg,#1a1430,#161b22);border:1px solid #2f2450;border-left:3px solid var(--vio);
border-radius:0 10px 10px 0;padding:13px;margin:12px 0;font-size:.88rem;line-height:1.65}
.ai .lbl{font-size:.66rem;color:var(--vio);letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px;font-weight:700}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:9px}
.card.hot{border-color:var(--acc)}
.card.alt{border-left:3px solid var(--warm)}
.ctop{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.route{font-weight:700;font-size:1rem}.route .ar{color:var(--dim);font-weight:400;margin:0 5px}
.meta{font-size:.77rem;color:var(--dim);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap}
.tt{display:inline-block;font-size:.66rem;font-weight:700;border-radius:5px;padding:2px 7px;letter-spacing:.03em}
.tt-return{background:#0f2a33;color:#58a6ff}.tt-oneway{background:#2b2313;color:#d29922}
.badge{display:inline-flex;gap:4px;font-size:.72rem;font-weight:600;border-radius:6px;padding:3px 8px;margin-top:6px}
.b-exceptional{background:#0f2f1a;color:#3fb950}.b-great{background:#0f2a33;color:#58a6ff}
.b-good{background:#1c2330;color:#8b949e}.b-average{background:#2b2313;color:#d29922}
.b-expensive{background:#2d1618;color:#f85149}
.price{font-size:1.25rem;font-weight:700;white-space:nowrap;text-align:right}
.blinks{margin-top:11px;padding-top:10px;border-top:1px solid var(--line)}
.blab{font-size:.66rem;color:var(--dim);margin-bottom:7px;letter-spacing:.04em}
.bwrap{display:flex;gap:6px;flex-wrap:wrap}
.bl{text-decoration:none;border-radius:7px;padding:7px 12px;font-size:.76rem;font-weight:600;white-space:nowrap;
border:1px solid var(--line);color:var(--dim);background:var(--bg)}
.bl.airline{background:var(--acc);color:#04260d;border-color:var(--acc)}
.bl.src{border-color:#33405c;color:var(--cool)}
.note{background:var(--card2);border:1px solid var(--line);border-left:3px solid var(--warm);
border-radius:0 8px 8px 0;padding:11px 13px;font-size:.78rem;color:var(--dim);line-height:1.6;margin:10px 0}
.note.warn{border-left-color:var(--hot)}
.empty{text-align:center;padding:40px 20px;color:var(--dim);font-size:.88rem}
.item{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-bottom:7px}
.item a{color:var(--tx);text-decoration:none;font-size:.88rem;line-height:1.4;display:block}
.item a:hover{color:var(--acc)}
.item .m{font-size:.66rem;color:var(--dim);margin-top:6px;display:flex;gap:9px;flex-wrap:wrap}
footer{margin-top:28px;padding-top:14px;border-top:1px solid var(--line);font-size:.7rem;color:var(--dim);line-height:1.7}
.hidden{display:none}
@media(max-width:560px){.r3{grid-template-columns:1fr}.ctop{flex-direction:column}.price{text-align:left}}
</style></head><body>
<div class="wrap">
<header>
  <div class="logo">Flight<span>Deal</span></div>
  <div class="lang"><button id="lz" class="on">繁中</button><button id="le">EN</button></div>
</header>

<div class="tabs">
  <button class="on" data-tab="search" data-i18n="tab_search">搜尋</button>
  <button data-tab="nearby" data-i18n="tab_nearby">附近機場</button>
  <button data-tab="deals" data-i18n="tab_deals">優惠情報</button>
</div>

<!-- ============ SEARCH ============ -->
<section id="t-search">
  <div class="trip">
    <button class="on" data-trip="return" data-i18n="trip_return">來回</button>
    <button data-trip="oneway" data-i18n="trip_oneway">單程</button>
  </div>
  <div class="modes">
    <button class="on" data-mode="route" data-i18n="mode_route">指定日期</button>
    <button data-mode="month" data-i18n="mode_month">整月最平</button>
    <button data-mode="anywhere" data-i18n="mode_any">去邊都得</button>
  </div>
  <div class="panel">
    <div class="row r2">
      <div class="ac"><label data-i18n="from">出發地</label><input id="origin" placeholder="HKG" autocomplete="off"><div class="aclist" id="ac-origin"></div></div>
      <div class="ac" id="destWrap"><label data-i18n="to">目的地</label><input id="dest" placeholder="NRT" autocomplete="off"><div class="aclist" id="ac-dest"></div></div>
    </div>
    <div class="row r2" id="dateRow">
      <div><label data-i18n="depart">去程</label><input id="dep" type="date"></div>
      <div id="retWrap"><label data-i18n="ret">回程</label><input id="ret" type="date"></div>
    </div>
    <div class="row" id="monthRow" style="display:none">
      <div><label data-i18n="month">月份</label><input id="month" type="month"></div>
    </div>
    <div class="row r3">
      <div><label data-i18n="cur">貨幣</label><select id="cur"><option>HKD</option><option>USD</option><option>EUR</option><option>GBP</option><option>JPY</option><option>TWD</option><option>SGD</option><option>CNY</option></select></div>
      <div><label data-i18n="pax">人數</label><select id="pax"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
      <div><label data-i18n="sort">排序</label><select id="sort"><option value="price" data-i18n="sort_price">最平</option><option value="stops" data-i18n="sort_stops">最少轉機</option><option value="date" data-i18n="sort_date">日期</option></select></div>
    </div>
    <div class="opts"><label><input type="checkbox" id="direct"> <span data-i18n="direct">只顯示直航</span></label></div>
    <button class="go" id="go" data-i18n="search">搜尋航班</button>
    <button class="sec" id="optimize" data-i18n="optimize">🔍 順便睇下附近機場有冇平啲</button>
  </div>
  <div class="status" id="status"></div>
  <div class="sum" id="sum"></div>
  <div id="aiBox"></div>
  <div id="results"></div>
</section>

<!-- ============ NEARBY ============ -->
<section id="t-nearby" class="hidden">
  <div class="panel">
    <div class="row r2">
      <div><label data-i18n="from">出發地</label><input id="n-origin" placeholder="HKG" autocomplete="off"></div>
      <div><label data-i18n="to">目的地</label><input id="n-dest" placeholder="KTM" autocomplete="off"></div>
    </div>
    <div class="row r2">
      <div><label data-i18n="depart">去程</label><input id="n-dep" type="date"></div>
      <div><label data-i18n="ret">回程</label><input id="n-ret" type="date"></div>
    </div>
    <div class="row"><div><label data-i18n="radius">搜尋半徑 (公里)</label>
      <select id="n-dist"><option value="200">200 km</option><option value="500" selected>500 km</option><option value="1000">1000 km</option></select></div></div>
    <button class="go" id="n-go" data-i18n="find_alt">搵附近機場</button>
  </div>
  <div class="status" id="n-status"></div>
  <div id="n-results"></div>
</section>

<!-- ============ DEALS ============ -->
<section id="t-deals" class="hidden">
  <div class="status" id="d-status"></div>
  <div id="d-results"></div>
</section>

<footer><span data-i18n="foot"></span></footer>
</div>

<script>
(function(){
var $=function(i){return document.getElementById(i)};

var I18N={
zh:{
 tab_search:'搜尋',tab_nearby:'附近機場',tab_deals:'優惠情報',
 trip_return:'來回',trip_oneway:'單程',
 mode_route:'指定日期',mode_month:'整月最平',mode_any:'去邊都得',
 from:'出發地',to:'目的地',depart:'去程',ret:'回程',month:'月份',
 cur:'貨幣',pax:'人數',sort:'排序',sort_price:'最平',sort_stops:'最少轉機',sort_date:'日期',
 direct:'只顯示直航',search:'搜尋航班',optimize:'🔍 順便睇下附近機場有冇平啲',
 radius:'搜尋半徑 (公里)',find_alt:'搵附近機場',
 searching:'搜尋緊…',analyzing:'分析緊…',found:'搵到 {n} 個',
 nores:'搵唔到相關票價。呢個路線可能最近冇人搜過,試下改日期或者用「整月最平」。',
 err:'出錯:',stops0:'直航',stops1:'轉機 1 次',stopsN:'轉機 {n} 次',
 tt_return:'來回',tt_oneway:'單程',
 base_history:'對比你記錄嘅歷史價',base_resultset:'對比今次結果中位價',
 conf_low:'低信心',conf_medium:'中信心',conf_high:'高信心',
 below:'平 {n}%',above:'貴 {n}%',
 t_exceptional:'超值筍盤',t_great:'好抵',t_good:'唔錯',t_average:'普通',t_expensive:'偏貴',
 book_direct:'✈ 航空公司官網訂 (最穩陣)',book_verify:'比價 / 核實:',
 no_dates_prefill:'官網要自己揀日期',
 note_cached:'票價來自 Aviasales 過去 48 小時嘅搜尋快取,唔係即時報價,亦唔保證訂到同一價。',
 note_single_source:'⚠️ 呢個 app 只有一個票價來源。Google Flights / Skyscanner / Kayak 冇公開 API,所以下面嘅連結係俾你自己去核實價錢,唔係搜尋結果。',
 note_book_airline:'💡 建議盡量喺航空公司官網訂。改期、取消、賠償嗰陣,直接同航空公司處理會易好多,經第三方旅行社好容易卡住。',
 note_fallback_month:'搵唔到指定日期,已改為顯示整個月。',
 note_fallback_latest:'搵唔到指定日期,已改為顯示最近快取到嘅日期。',
 note_only_oneway:'⚠️ 你揀咗來回,但呢個路線暫時只搵到單程票價。下面顯示嘅係單程價,唔好當成來回價。',
 no_alt:'搵唔到更平嘅附近機場。',
 alt_saving:'平 {n}',alt_costlier:'貴 {n}',
 alt_origin:'改出發機場',alt_dest:'改到達機場',
 note_ground:'⚠️ 呢啲差價未計去另一個機場嘅交通費同時間。過境、車票、住一晚都要自己計埋先算得準。',
 need_origin:'請輸入出發地',need_dest:'請輸入目的地',need_month:'請揀月份',
 loading_deals:'載入緊優惠情報…',no_deals:'暫時冇相關優惠情報。',
 foot:'票價資料:Travelpayouts / Aviasales 快取。訂票連結會帶你去航空公司或其他比價網。本工具只作參考,落單前請自行核實。'
},
en:{
 tab_search:'Search',tab_nearby:'Nearby airports',tab_deals:'Deal signals',
 trip_return:'Round trip',trip_oneway:'One way',
 mode_route:'Fixed dates',mode_month:'Cheapest month',mode_any:'Anywhere',
 from:'From',to:'To',depart:'Depart',ret:'Return',month:'Month',
 cur:'Currency',pax:'Travellers',sort:'Sort',sort_price:'Cheapest',sort_stops:'Fewest stops',sort_date:'Date',
 direct:'Direct only',search:'Search flights',optimize:'🔍 Also check nearby airports',
 radius:'Search radius (km)',find_alt:'Find alternatives',
 searching:'Searching…',analyzing:'Analysing…',found:'{n} found',
 nores:'No fares found. This route may not have been searched recently — try other dates or Cheapest month.',
 err:'Error: ',stops0:'Direct',stops1:'1 stop',stopsN:'{n} stops',
 tt_return:'Round trip',tt_oneway:'One way',
 base_history:'vs your recorded history',base_resultset:'vs median of these results',
 conf_low:'low confidence',conf_medium:'medium confidence',conf_high:'high confidence',
 below:'{n}% below',above:'{n}% above',
 t_exceptional:'Exceptional',t_great:'Great deal',t_good:'Good price',t_average:'Average',t_expensive:'Expensive',
 book_direct:'✈ Book on airline site (safest)',book_verify:'Compare / verify:',
 no_dates_prefill:'dates not pre-filled',
 note_cached:'Prices come from Aviasales cached searches (last 48h), not live quotes, and are not guaranteed at booking.',
 note_single_source:'⚠️ This app has ONE price source. Google Flights, Skyscanner and Kayak have no public API, so the links below are for you to verify the price yourself — they are not search results from those sites.',
 note_book_airline:'💡 Prefer booking on the airline site. When flights change or cancel, dealing with the carrier directly is far easier than going through a third-party agency.',
 note_fallback_month:'No fares for those exact dates — showing the whole month instead.',
 note_fallback_latest:'No fares for those exact dates — showing the most recently cached dates instead.',
 note_only_oneway:'⚠️ You asked for a round trip, but only one-way fares were found for this route. The prices below are ONE WAY — do not read them as return fares.',
 no_alt:'No cheaper nearby airport found.',
 alt_saving:'{n} cheaper',alt_costlier:'{n} more',
 alt_origin:'different departure',alt_dest:'different arrival',
 note_ground:'⚠️ These differences exclude the cost and time of getting to the other airport. Border crossings, train tickets and an extra night must be added yourself.',
 need_origin:'Enter a departure airport',need_dest:'Enter a destination',need_month:'Pick a month',
 loading_deals:'Loading deal signals…',no_deals:'No relevant deal signals right now.',
 foot:'Fare data: Travelpayouts / Aviasales cache. Booking links lead to airlines and other comparison sites. Indicative only — verify before paying.'
}};

var lang='zh',mode='route',trip='return',last=null,lastNearby=null;
function t(k,v){var s=(I18N[lang]&&I18N[lang][k])||k;if(v)for(var x in v)s=s.replace('{'+x+'}',v[x]);return s}
function applyLang(){
  document.documentElement.lang=lang==='zh'?'zh-Hant':'en';
  var e=document.querySelectorAll('[data-i18n]');
  for(var i=0;i<e.length;i++){var k=e[i].getAttribute('data-i18n');if(I18N[lang][k])e[i].textContent=I18N[lang][k]}
  $('lz').className=lang==='zh'?'on':'';$('le').className=lang==='en'?'on':'';
  if(last)renderSearch(last);
  if(lastNearby)renderNearby(lastNearby);
}
$('lz').onclick=function(){lang='zh';applyLang()};
$('le').onclick=function(){lang='en';applyLang()};

/* tabs */
var tabBtns=document.querySelectorAll('.tabs button');
for(var i=0;i<tabBtns.length;i++)tabBtns[i].onclick=function(){
  for(var j=0;j<tabBtns.length;j++)tabBtns[j].className='';
  this.className='on';
  var tab=this.getAttribute('data-tab');
  $('t-search').className=tab==='search'?'':'hidden';
  $('t-nearby').className=tab==='nearby'?'':'hidden';
  $('t-deals').className=tab==='deals'?'':'hidden';
  if(tab==='deals')loadDeals();
};

/* trip type */
var tripBtns=document.querySelectorAll('.trip button');
for(var i=0;i<tripBtns.length;i++)tripBtns[i].onclick=function(){
  for(var j=0;j<tripBtns.length;j++)tripBtns[j].className='';
  this.className='on';trip=this.getAttribute('data-trip');
  $('retWrap').style.display=trip==='return'?'block':'none';
};

/* modes */
var modeBtns=document.querySelectorAll('.modes button');
for(var i=0;i<modeBtns.length;i++)modeBtns[i].onclick=function(){
  for(var j=0;j<modeBtns.length;j++)modeBtns[j].className='';
  this.className='on';mode=this.getAttribute('data-mode');
  $('destWrap').style.display=mode==='anywhere'?'none':'block';
  $('dateRow').style.display=mode==='route'?'grid':'none';
  $('monthRow').style.display=mode==='month'?'grid':'none';
};

/* autocomplete */
function setupAC(inputId,listId){
  var inp=$(inputId),list=$(listId),tm=null;
  if(!inp)return;
  inp.addEventListener('input',function(){
    var v=inp.value.trim();clearTimeout(tm);
    if(v.length<2){list.className='aclist';return}
    tm=setTimeout(function(){
      fetch('/api/places?q='+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(d){
        if(!d.places||!d.places.length){list.className='aclist';return}
        list.innerHTML='';
        d.places.forEach(function(p){
          var el=document.createElement('div');el.className='acitem';
          el.innerHTML='<b>'+p.code+'</b> '+p.name+'<small>'+(p.country||'')+'</small>';
          el.addEventListener('mousedown',function(e){e.preventDefault();inp.value=p.code;list.className='aclist'});
          list.appendChild(el);
        });
        list.className='aclist show';
      }).catch(function(){});
    },260);
  });
  inp.addEventListener('blur',function(){setTimeout(function(){list.className='aclist'},180)});
}
setupAC('origin','ac-origin');setupAC('dest','ac-dest');

function money(v,c){
  try{return new Intl.NumberFormat(lang==='zh'?'zh-HK':'en-US',{style:'currency',currency:c,maximumFractionDigits:0}).format(v)}
  catch(e){return c+' '+v}
}
function stopsLabel(n){if(n==null)return'';if(n===0)return t('stops0');if(n===1)return t('stops1');return t('stopsN',{n:n})}
function setStatus(id,msg,err){var s=$(id);s.textContent=msg||'';s.className='status'+(err?' err':'')}

/* ---------- booking links ---------- */
function bookingHTML(o){
  if(!o.booking||!o.booking.length)return'';
  var air=o.booking.filter(function(b){return b.kind==='airline'});
  var meta=o.booking.filter(function(b){return b.kind==='meta'});
  var h='<div class="blinks">';
  if(air.length){
    h+='<div class="blab">'+t('book_direct')+'</div><div class="bwrap">';
    air.forEach(function(b){
      h+='<a class="bl airline" href="'+b.url+'" target="_blank" rel="noopener">'+b.label+'</a>';
    });
    h+='</div>';
  }
  h+='<div class="blab" style="margin-top:9px">'+t('book_verify')+'</div><div class="bwrap">';
  meta.forEach(function(b){
    h+='<a class="bl'+(b.isPriceSource?' src':'')+'" href="'+b.url+'" target="_blank" rel="noopener">'+b.label+'</a>';
  });
  h+='</div></div>';
  return h;
}

/* ---------- search ---------- */
$('go').onclick=function(){doSearch(false)};
$('optimize').onclick=function(){doSearch(true)};

function buildParams(){
  var origin=$('origin').value.trim().toUpperCase();
  var dest=$('dest').value.trim().toUpperCase();
  if(!origin){setStatus('status',t('need_origin'),true);return null}
  if(mode!=='anywhere'&&!dest){setStatus('status',t('need_dest'),true);return null}
  if(mode==='month'&&!$('month').value){setStatus('status',t('need_month'),true);return null}
  var p=new URLSearchParams();
  p.set('mode',mode);p.set('trip',trip);p.set('origin',origin);
  if(mode!=='anywhere')p.set('destination',dest);
  if(mode==='route'){
    if($('dep').value)p.set('departDate',$('dep').value);
    if(trip==='return'&&$('ret').value)p.set('returnDate',$('ret').value);
  }
  if(mode==='month')p.set('month',$('month').value);
  p.set('currency',$('cur').value);p.set('pax',$('pax').value);
  if($('direct').checked)p.set('direct','1');
  return p;
}

function doSearch(alsoNearby){
  var p=buildParams();if(!p)return;
  setStatus('status',t('searching'));
  $('go').disabled=true;$('optimize').disabled=true;
  $('results').innerHTML='';$('sum').innerHTML='';$('aiBox').innerHTML='';
  lastNearby=null;

  fetch('/api/search?'+p.toString()).then(function(r){return r.json()}).then(function(d){
    $('go').disabled=false;$('optimize').disabled=false;
    if(d.error){setStatus('status',t('err')+d.error,true);return}
    setStatus('status','');last=d;renderSearch(d);
    if(alsoNearby&&mode==='route'&&p.get('destination')){
      var np=new URLSearchParams();
      np.set('origin',p.get('origin'));np.set('destination',p.get('destination'));
      if(p.get('departDate'))np.set('departDate',p.get('departDate'));
      if(p.get('returnDate'))np.set('returnDate',p.get('returnDate'));
      np.set('currency',p.get('currency'));np.set('distance','500');
      fetch('/api/nearby?'+np.toString()).then(function(r){return r.json()}).then(function(nd){
        if(nd.error)return;
        lastNearby=nd;
        renderNearbyInline(nd);
        runAnalyze(d,nd);
      }).catch(function(){});
    }else{
      runAnalyze(d,null);
    }
  }).catch(function(e){
    $('go').disabled=false;$('optimize').disabled=false;
    setStatus('status',t('err')+e.message,true);
  });
}

function runAnalyze(searchData,nearbyData){
  var box=$('aiBox');
  box.innerHTML='<div class="ai"><div class="lbl">AI</div>'+t('analyzing')+'</div>';
  var best=null;
  if(nearbyData&&nearbyData.alternatives&&nearbyData.alternatives.length){
    var c=nearbyData.alternatives[0];
    if(c.savingVsBaseline!=null&&c.savingVsBaseline>0)best=c;
  }
  fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      offers:(searchData.offers||[]).slice(0,5),
      nearby:nearbyData?{alternatives:nearbyData.alternatives,best:best}:null,
      query:searchData.query,lang:lang
    })})
  .then(function(r){return r.json()}).then(function(a){
    box.innerHTML='<div class="ai"><div class="lbl">AI</div>'+
      String(a.text||'').replace(/</g,'&lt;')+'</div>';
  }).catch(function(){box.innerHTML=''});
}

function sortOffers(list){
  var by=$('sort').value,a=list.slice();
  if(by==='stops')a.sort(function(x,y){return (x.stops==null?9:x.stops)-(y.stops==null?9:y.stops)||x.priceTotal-y.priceTotal});
  else if(by==='date')a.sort(function(x,y){return (x.departDate||'').localeCompare(y.departDate||'')});
  else a.sort(function(x,y){return x.priceTotal-y.priceTotal});
  return a;
}

function offerCard(o,extraClass){
  var sc=o.score||{};
  var el=document.createElement('div');
  el.className='card'+(sc.tier==='exceptional'||sc.tier==='great'?' hot':'')+(extraClass?' '+extraClass:'');
  var bits=[];
  if(o.departDate)bits.push('<span>'+o.departDate+(o.returnDate?(' → '+o.returnDate):'')+'</span>');
  if(o.stops!=null)bits.push('<span>'+stopsLabel(o.stops)+'</span>');
  if(o.airlineName)bits.push('<span>'+o.airlineName+'</span>');
  if(o.flightNumber)bits.push('<span>'+(o.airlineCode||'')+o.flightNumber+'</span>');
  var badge='';
  if(sc.tier){
    var pt=sc.discountPct>=0?t('below',{n:sc.discountPct}):t('above',{n:Math.abs(sc.discountPct)});
    badge='<div class="badge b-'+sc.tier+'">'+sc.badge+' '+t('t_'+sc.tier)+(sc.discountPct!==0?(' · '+pt):'')+'</div>';
  }
  el.innerHTML='<div class="ctop"><div>'+
    '<div class="route">'+o.origin+'<span class="ar">→</span>'+o.destination+
    ' <span class="tt tt-'+o.tripType+'">'+t('tt_'+o.tripType)+'</span></div>'+
    '<div class="meta">'+bits.join('')+'</div>'+badge+'</div>'+
    '<div class="price">'+money(o.priceTotal,o.currency)+'</div></div>'+
    bookingHTML(o);
  return el;
}

function renderSearch(d){
  var box=$('results');box.innerHTML='';
  var all=d.offers||[];
  var wanted=all.filter(function(o){return o.tripType===d.trip});
  var others=all.filter(function(o){return o.tripType!==d.trip});

  if(!all.length){box.innerHTML='<div class="empty">'+t('nores')+'</div>';return}

  var sum=$('sum');sum.innerHTML='';
  function pill(h){var e=document.createElement('span');e.className='pill';e.innerHTML=h;sum.appendChild(e)}
  pill(t('found',{n:d.count}));
  var s0=(wanted[0]||all[0]||{}).score;
  if(s0){
    pill((s0.baselineKind==='history'?t('base_history'):t('base_resultset'))+' · <b>'+money(s0.baseline,(wanted[0]||all[0]).currency)+'</b>');
    pill(t('conf_'+s0.confidence)+' · '+s0.samples);
  }

  function note(txt,cls){var n=document.createElement('div');n.className='note'+(cls?' '+cls:'');n.textContent=txt;box.appendChild(n)}

  if(d.notes&&d.notes.indexOf('fallback_month')>=0)note(t('note_fallback_month'));
  if(d.notes&&d.notes.indexOf('fallback_latest')>=0)note(t('note_fallback_latest'));
  if(!wanted.length&&others.length)note(t('note_only_oneway'),'warn');

  note(t('note_single_source'));
  note(t('note_book_airline'));
  note(t('note_cached'));

  sortOffers(wanted.length?wanted:others).forEach(function(o){box.appendChild(offerCard(o))});
}

/* ---------- nearby ---------- */
function altCard(a,cur){
  var el=document.createElement('div');
  el.className='card alt';
  var tags=[];
  if(a.changedOrigin)tags.push(t('alt_origin'));
  if(a.changedDestination)tags.push(t('alt_dest'));
  var save='';
  if(a.savingVsBaseline!=null){
    save = a.savingVsBaseline>0
      ? '<span style="color:var(--acc);font-weight:700">'+t('alt_saving',{n:money(a.savingVsBaseline,cur)})+'</span>'
      : '<span style="color:var(--hot)">'+t('alt_costlier',{n:money(Math.abs(a.savingVsBaseline),cur)})+'</span>';
  }
  var bits=[];
  if(a.departDate)bits.push('<span>'+a.departDate+(a.returnDate?(' → '+a.returnDate):'')+'</span>');
  if(a.stops!=null)bits.push('<span>'+stopsLabel(a.stops)+'</span>');
  if(a.airlineName)bits.push('<span>'+a.airlineName+'</span>');
  el.innerHTML='<div class="ctop"><div>'+
    '<div class="route">'+a.origin+'<span class="ar">→</span>'+a.destination+
    ' <span class="tt tt-'+a.tripType+'">'+t('tt_'+a.tripType)+'</span></div>'+
    '<div class="meta">'+bits.join('')+(tags.length?'<span>'+tags.join(' · ')+'</span>':'')+'</div>'+
    (save?('<div style="margin-top:6px;font-size:.82rem">'+save+'</div>'):'')+
    '</div><div class="price">'+money(a.priceTotal,cur)+'</div></div>'+bookingHTML(a);
  return el;
}

function renderNearbyInline(nd){
  var box=$('results');
  if(!nd.alternatives||!nd.alternatives.length)return;
  var h=document.createElement('div');
  h.className='note';h.textContent=t('note_ground');
  box.appendChild(h);
  nd.alternatives.slice(0,6).forEach(function(a){box.appendChild(altCard(a,nd.query.currency))});
}

$('n-go').onclick=function(){
  var o=$('n-origin').value.trim().toUpperCase(),dd=$('n-dest').value.trim().toUpperCase();
  if(!o){setStatus('n-status',t('need_origin'),true);return}
  if(!dd){setStatus('n-status',t('need_dest'),true);return}
  var p=new URLSearchParams();
  p.set('origin',o);p.set('destination',dd);
  if($('n-dep').value)p.set('departDate',$('n-dep').value);
  if($('n-ret').value)p.set('returnDate',$('n-ret').value);
  p.set('distance',$('n-dist').value);p.set('currency',$('cur').value);
  setStatus('n-status',t('searching'));$('n-go').disabled=true;$('n-results').innerHTML='';
  fetch('/api/nearby?'+p.toString()).then(function(r){return r.json()}).then(function(d){
    $('n-go').disabled=false;
    if(d.error){setStatus('n-status',t('err')+d.error,true);return}
    setStatus('n-status','');lastNearby=d;renderNearby(d);
  }).catch(function(e){$('n-go').disabled=false;setStatus('n-status',t('err')+e.message,true)});
};

function renderNearby(d){
  var box=$('n-results');box.innerHTML='';
  if(!d.alternatives||!d.alternatives.length){box.innerHTML='<div class="empty">'+t('no_alt')+'</div>';return}
  var n=document.createElement('div');n.className='note';n.textContent=t('note_ground');box.appendChild(n);
  d.alternatives.forEach(function(a){box.appendChild(altCard(a,d.query.currency))});
}

/* ---------- deals ---------- */
var dealsLoaded=false;
function loadDeals(){
  if(dealsLoaded)return;
  setStatus('d-status',t('loading_deals'));
  var o=$('origin').value.trim().toUpperCase();
  fetch('/api/deals'+(o?('?origin='+o):'')).then(function(r){return r.json()}).then(function(d){
    dealsLoaded=true;setStatus('d-status','');
    var box=$('d-results');box.innerHTML='';
    if(!d.items||!d.items.length){box.innerHTML='<div class="empty">'+t('no_deals')+'</div>';return}
    d.items.forEach(function(i){
      var el=document.createElement('div');el.className='item';
      el.innerHTML='<a href="'+i.url+'" target="_blank" rel="noopener">'+String(i.title).replace(/</g,'&lt;')+'</a>'+
        '<div class="m"><span>'+i.source+'</span><span>'+new Date(i.ts).toLocaleDateString()+'</span>'+
        (i.alsoSeenIn&&i.alsoSeenIn.length?'<span style="color:var(--acc)">+'+i.alsoSeenIn.length+'</span>':'')+'</div>';
      box.appendChild(el);
    });
  }).catch(function(e){setStatus('d-status',t('err')+e.message,true)});
}

/* defaults */
(function(){
  var d=new Date();d.setDate(d.getDate()+21);
  var r=new Date(d);r.setDate(r.getDate()+5);
  $('dep').value=d.toISOString().slice(0,10);
  $('ret').value=r.toISOString().slice(0,10);
  $('month').value=d.toISOString().slice(0,7);
  $('n-dep').value=d.toISOString().slice(0,10);
  $('n-ret').value=r.toISOString().slice(0,10);
})();

applyLang();
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){})}
})();
</script></body></html>`;
