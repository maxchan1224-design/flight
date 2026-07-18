/**
 * ================================================================
 *  FLIGHT DEAL INTELLIGENCE — Cloudflare Worker (single file)
 *  Phase 2: owns its own price history, scans a watchlist nightly,
 *  aggregates public deal sources, scores everything, and serves
 *  a "Today's Opportunities" dashboard.
 * ================================================================
 *
 *  BINDINGS REQUIRED
 *    Secrets:  AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET
 *    Vars:     AMADEUS_ENV = "test" | "production"
 *              INGEST_TOKEN = any long random string (for email ingest)
 *    KV:       CACHE   (token + response cache)
 *              HISTORY (price history + feed items — keep separate, it grows)
 *    AI:       AI      (Workers AI, optional — falls back to rules)
 *
 *  CRON (wrangler.toml):
 *    [triggers]
 *    crons = ["0 19 * * *"]      # 03:00 HKT daily
 *
 *  ROUTES
 *    GET  /                      dashboard
 *    GET  /api/opportunities     ranked deals from own price history
 *    GET  /api/feed              aggregated public deal-source items
 *    GET  /api/history?route=    raw price series for one route
 *    GET  /api/watchlist         current watchlist
 *    POST /api/watchlist         { add: "HKG-TPE" } or { remove: "HKG-TPE" }
 *    POST /api/scan              manual trigger (same work as cron)
 *    POST /api/ingest            newsletter/webhook ingest (needs INGEST_TOKEN)
 */

/* ================================================================
 * CONFIG
 * ================================================================ */

const HOME = "HKG";

// Seed watchlist. Editable at runtime via /api/watchlist.
const DEFAULT_WATCHLIST = [
  "TPE", "NRT", "KIX", "ICN", "BKK", "SIN", "KUL",
  "DAD", "SGN", "CEB", "MNL", "KTM", "DPS", "HND",
];

// Alternative departure airports + real ground cost/time from HK (one-way).
const ALT_ORIGINS = {
  SZX: { city: "Shenzhen",  transport: "HSR to Futian + Metro L11", costHKD: 95,  minutes: 150, difficulty: "Easy" },
  CAN: { city: "Guangzhou", transport: "HSR to GZ South + Metro",   costHKD: 235, minutes: 210, difficulty: "Moderate" },
  MFM: { city: "Macau",     transport: "HZMB Gold Bus",             costHKD: 68,  minutes: 120, difficulty: "Easy" },
};

/**
 * Public deal sources. Only feeds/pages that are publicly readable.
 * type: "rss" | "reddit" | "telegram"
 * Add or remove freely — failures are isolated and never break the scan.
 */
const SOURCES = [
  { id: "reddit-awardtravel", type: "reddit", sub: "awardtravel", label: "r/awardtravel" },
  { id: "reddit-flights",     type: "reddit", sub: "flights",     label: "r/flights" },
  { id: "reddit-travel-deals",type: "reddit", sub: "TravelDeals", label: "r/TravelDeals" },
  // Telegram public channels expose a readable preview at t.me/s/<name>.
  // Replace with channels you actually follow.
  { id: "tg-example",         type: "telegram", channel: "flightdealshk", label: "Telegram: flightdealshk" },
  // Any blog/newsroom RSS works here.
  { id: "rss-example",        type: "rss", url: "https://www.flyertalk.com/forum/external.php?type=RSS2", label: "FlyerTalk" },
];

// Words that make a feed item likely to be a real fare opportunity.
const DEAL_KEYWORDS = [
  "error fare", "mistake fare", "flash sale", "promo", "promotion", "sale",
  "deal", "discount", "% off", "cheap", "fare drop", "glitch",
];
// Extra weight if the item mentions somewhere you can actually fly from.
const HOME_KEYWORDS = ["hong kong", "hkg", "shenzhen", "szx", "guangzhou", "can", "macau", "mfm", "cathay", "hk express", "greater bay"];

const HISTORY_DAYS = 90;          // how much price history to retain per route
const SCAN_HORIZON_DAYS = 60;     // how far ahead the scanner looks
const FEED_TTL = 60 * 60 * 3;     // 3h cache on public feeds

/* ================================================================
 * Amadeus
 * ================================================================ */

const amaBase = (env) =>
  env.AMADEUS_ENV === "production" ? "https://api.amadeus.com" : "https://test.api.amadeus.com";

async function amaToken(env) {
  const hit = await env.CACHE.get("ama_token");
  if (hit) return hit;
  const r = await fetch(amaBase(env) + "/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.AMADEUS_CLIENT_ID,
      client_secret: env.AMADEUS_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error("Amadeus auth failed: " + r.status);
  const d = await r.json();
  await env.CACHE.put("ama_token", d.access_token, { expirationTtl: Math.max(60, (d.expires_in || 1799) - 90) });
  return d.access_token;
}

async function amaGet(env, path, params) {
  const token = await amaToken(env);
  const u = new URL(amaBase(env) + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, String(v));
  const r = await fetch(u.toString(), { headers: { Authorization: "Bearer " + token } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (b.errors && b.errors[0] && (b.errors[0].detail || b.errors[0].title)) || ("HTTP " + r.status);
    throw new Error(msg);
  }
  return b;
}

/* ================================================================
 * THE ENGINE — own price history
 * ================================================================ */

const histKey = (route) => "hist:" + route;

async function getHistory(env, route) {
  return (await env.HISTORY.get(histKey(route), "json")) || { route, points: [] };
}

async function addHistoryPoint(env, route, point) {
  const h = await getHistory(env, route);
  const today = point.date;
  h.points = h.points.filter((p) => p.date !== today); // one point per day
  h.points.push(point);
  h.points.sort((a, b) => a.date.localeCompare(b.date));
  if (h.points.length > HISTORY_DAYS) h.points = h.points.slice(-HISTORY_DAYS);
  await env.HISTORY.put(histKey(route), JSON.stringify(h));
  return h;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The core scoring function. This is what makes the product different
 * from a search engine: it compares today's fare to fares WE recorded.
 */
function scoreDeal(currentPrice, points) {
  const prior = points.filter((p) => p.price != null).map((p) => p.price);
  if (prior.length < 5) {
    return {
      tier: "learning", badge: "📊", label: "Building history",
      discountPct: null, confidence: "low",
      advice: "Not enough recorded history yet (" + prior.length + "/5 days). Score unlocks as the scanner runs.",
    };
  }
  const med = median(prior);
  const min = Math.min(...prior);
  const discountPct = Math.round(((med - currentPrice) / med) * 100);
  const isNewLow = currentPrice <= min;

  // Confidence scales with how much history we own.
  const confidence = prior.length >= 45 ? "high" : prior.length >= 20 ? "medium" : "low";

  let tier, badge, label, advice;
  if (discountPct >= 40) {
    tier = "exceptional"; badge = "🔥"; label = "Exceptional — " + discountPct + "% below median";
    advice = "Book immediately. Fares this far below your recorded median rarely last more than a day.";
  } else if (discountPct >= 20) {
    tier = "great"; badge = "⭐"; label = "Great deal — " + discountPct + "% below median";
    advice = "Book now or within a day or two.";
  } else if (discountPct >= 8) {
    tier = "good"; badge = "👍"; label = "Good price — " + discountPct + "% below median";
    advice = "Solid. Book if the dates work for you.";
  } else if (discountPct >= -8) {
    tier = "average"; badge = "⚠️"; label = "Average — near typical price";
    advice = "No urgency. Wait for a drop unless dates are fixed.";
  } else {
    tier = "expensive"; badge = "❌"; label = "Expensive — " + Math.abs(discountPct) + "% above median";
    advice = "Wait. This route has been much cheaper recently.";
  }
  if (isNewLow && prior.length >= 10) {
    label += " · lowest recorded";
    badge = "🔥";
  }
  return {
    tier, badge, label, discountPct, confidence, advice,
    medianHKD: Math.round(med), lowestHKD: Math.round(min), samples: prior.length, isNewLow,
  };
}

/* ================================================================
 * SCANNER — runs on cron
 * ================================================================ */

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Cheapest round trip on a route within the horizon, via cheapest-date search. */
async function probeRoute(env, dest) {
  const route = HOME + "-" + dest;
  // Try cheapest-date search first (1 call covers the whole window).
  try {
    const r = await amaGet(env, "/v1/shopping/flight-dates", {
      origin: HOME, destination: dest, oneWay: false, viewBy: "DATE",
    });
    const rows = (r.data || [])
      .map((d) => ({ dep: d.departureDate, ret: d.returnDate, price: parseFloat(d.price && d.price.total) }))
      .filter((x) => !isNaN(x.price));
    if (rows.length) {
      rows.sort((a, b) => a.price - b.price);
      return { route, dest, ok: true, method: "flight-dates",
        price: rows[0].price, currency: "EUR", bestDepart: rows[0].dep, bestReturn: rows[0].ret };
    }
  } catch (e) { /* fall through */ }

  // Fallback: sample a few concrete weekends with flight-offers (accurate HKD).
  const samples = [];
  for (let w = 2; w <= 8; w += 2) {
    const dep = nextFriday(w * 7);
    const ret = addDays(dep, 3);
    samples.push({ dep, ret });
  }
  let best = null;
  for (const s of samples) {
    try {
      const r = await amaGet(env, "/v2/shopping/flight-offers", {
        originLocationCode: HOME, destinationLocationCode: dest,
        departureDate: s.dep, returnDate: s.ret, adults: 1, currencyCode: "HKD", max: 3,
      });
      const p = (r.data || []).map((o) => parseFloat(o.price.grandTotal)).filter((x) => !isNaN(x));
      if (p.length) {
        const lo = Math.min(...p);
        if (!best || lo < best.price) best = { price: lo, bestDepart: s.dep, bestReturn: s.ret };
      }
    } catch (e) { /* skip this sample */ }
  }
  if (best) return { route, dest, ok: true, method: "flight-offers", currency: "HKD", ...best };
  return { route, dest, ok: false, reason: "No fares returned" };
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nextFriday(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

async function getWatchlist(env) {
  return (await env.HISTORY.get("watchlist", "json")) || DEFAULT_WATCHLIST;
}

async function runScan(env, limit) {
  const list = await getWatchlist(env);
  const targets = limit ? list.slice(0, limit) : list;
  const date = todayISO();
  const results = [];

  for (const dest of targets) {
    const probe = await probeRoute(env, dest);
    if (!probe.ok) { results.push({ dest, ok: false, reason: probe.reason }); continue; }
    const hist = await getHistory(env, probe.route);
    const score = scoreDeal(probe.price, hist.points);
    await addHistoryPoint(env, probe.route, {
      date, price: probe.price, currency: probe.currency,
      depart: probe.bestDepart, return: probe.bestReturn, method: probe.method,
    });
    results.push({
      dest, ok: true, route: probe.route, price: probe.price, currency: probe.currency,
      bestDepart: probe.bestDepart, bestReturn: probe.bestReturn, score,
    });
  }

  results.sort((a, b) => {
    const ad = (a.score && a.score.discountPct) ?? -999;
    const bd = (b.score && b.score.discountPct) ?? -999;
    return bd - ad;
  });

  const snapshot = { scannedAt: new Date().toISOString(), date, results };
  await env.HISTORY.put("last_scan", JSON.stringify(snapshot));
  return snapshot;
}

/* ================================================================
 * FEED AGGREGATION — public sources only
 * ================================================================ */

function scoreFeedItem(title, body) {
  const t = (title + " " + (body || "")).toLowerCase();
  let score = 0;
  const matched = [];
  for (const k of DEAL_KEYWORDS) if (t.includes(k)) { score += 2; matched.push(k); }
  for (const k of HOME_KEYWORDS) if (t.includes(k)) { score += 3; matched.push(k); }
  if (t.includes("error fare") || t.includes("mistake fare")) score += 6;
  return { score, matched: [...new Set(matched)] };
}

async function fetchReddit(src) {
  const r = await fetch("https://www.reddit.com/r/" + src.sub + "/new.json?limit=25", {
    headers: { "User-Agent": "flight-deal-intel/1.0 (personal use)" },
  });
  if (!r.ok) throw new Error("reddit " + r.status);
  const d = await r.json();
  return (d.data && d.data.children ? d.data.children : []).map((c) => ({
    source: src.label,
    title: c.data.title,
    url: "https://reddit.com" + c.data.permalink,
    body: (c.data.selftext || "").slice(0, 400),
    ts: c.data.created_utc * 1000,
  }));
}

async function fetchTelegram(src) {
  const r = await fetch("https://t.me/s/" + src.channel, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; flight-deal-intel/1.0)" },
  });
  if (!r.ok) throw new Error("telegram " + r.status);
  const html = await r.text();
  const items = [];
  const re = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null && items.length < 25) {
    const text = m[1].replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, "").trim();
    if (text) items.push({ source: src.label, title: text.slice(0, 160), url: "https://t.me/s/" + src.channel, body: text.slice(0, 400), ts: Date.now() });
  }
  return items;
}

async function fetchRSS(src) {
  const r = await fetch(src.url, { headers: { "User-Agent": "flight-deal-intel/1.0" } });
  if (!r.ok) throw new Error("rss " + r.status);
  const xml = await r.text();
  const items = [];
  const re = /<item[\s\S]*?<\/item>/g;
  const blocks = xml.match(re) || [];
  for (const b of blocks.slice(0, 25)) {
    const pick = (tag) => {
      const mm = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">").exec(b);
      if (!mm) return "";
      return mm[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
    };
    const title = pick("title");
    if (!title) continue;
    const pd = pick("pubDate");
    items.push({
      source: src.label, title, url: pick("link"),
      body: pick("description").slice(0, 400),
      ts: pd ? Date.parse(pd) || Date.now() : Date.now(),
    });
  }
  return items;
}

async function refreshFeed(env) {
  const cached = await env.CACHE.get("feed", "json");
  if (cached) return { ...cached, cached: true };

  const jobs = SOURCES.map(async (src) => {
    try {
      let items = [];
      if (src.type === "reddit") items = await fetchReddit(src);
      else if (src.type === "telegram") items = await fetchTelegram(src);
      else if (src.type === "rss") items = await fetchRSS(src);
      return { src: src.id, ok: true, items };
    } catch (e) {
      return { src: src.id, ok: false, error: e.message, items: [] };
    }
  });

  const settled = await Promise.all(jobs);

  // Merge user-ingested newsletter items (see /api/ingest)
  const ingested = (await env.HISTORY.get("ingested", "json")) || [];

  const all = [...settled.flatMap((s) => s.items), ...ingested];

  // Deduplicate: the same deal frequently gets cross-posted across
  // subreddits/channels. Key on a normalised title fingerprint and keep
  // the highest-scoring copy, recording where else it appeared.
  const fingerprint = (t) =>
    t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 70);

  const seen = new Map();
  for (const it of all) {
    const scored = { ...it, ...scoreFeedItem(it.title, it.body) };
    if (scored.score < 3) continue;
    const fp = fingerprint(scored.title);
    const prev = seen.get(fp);
    if (!prev) {
      seen.set(fp, { ...scored, alsoSeenIn: [] });
    } else {
      if (prev.source !== scored.source && !prev.alsoSeenIn.includes(scored.source)) {
        prev.alsoSeenIn.push(scored.source);
        prev.score += 1; // corroboration across sources is a mild signal
      }
      if (scored.ts > prev.ts) prev.ts = scored.ts;
    }
  }

  const scored = [...seen.values()]
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
    .slice(0, 40);

  const payload = {
    items: scored,
    sources: settled.map((s) => ({ id: s.src, ok: s.ok, error: s.error, count: s.items.length })),
    ingestedCount: ingested.length,
    refreshedAt: new Date().toISOString(),
  };
  await env.CACHE.put("feed", JSON.stringify(payload), { expirationTtl: FEED_TTL });
  return payload;
}

/* ================================================================
 * AI layer — summarises the day, falls back to rules
 * ================================================================ */

async function briefing(env, scan, feed) {
  const top = (scan.results || []).filter((r) => r.ok && r.score && r.score.discountPct != null).slice(0, 5);
  const fallback = top.length
    ? "Today's best: " + top.map((r) => r.dest + " at " + Math.round(r.price) + " " + r.currency +
        " (" + r.score.discountPct + "% vs median)").join("; ") + "."
    : "No scored opportunities yet — the scanner needs at least 5 days of history per route before discounts become meaningful.";

  if (!env.AI) return { text: fallback, source: "rules" };
  try {
    const out = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{
        role: "user",
        content:
          "You are a flight deal analyst for a Hong Kong traveller. In under 110 words, plain text, no markdown: " +
          "state the single best opportunity and why, mention any second-best, and say clearly if nothing is worth acting on today. " +
          "Data: " + JSON.stringify({
            deals: top.map((r) => ({ dest: r.dest, price: Math.round(r.price), cur: r.currency,
              discountPct: r.score.discountPct, confidence: r.score.confidence, depart: r.bestDepart })),
            headlines: (feed.items || []).slice(0, 6).map((i) => i.title),
          }),
      }],
      max_tokens: 260,
    });
    return { text: (out && out.response) || fallback, source: "workers-ai" };
  } catch (e) {
    return { text: fallback, source: "rules", error: e.message };
  }
}

/* ================================================================
 * ROUTER
 * ================================================================ */

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await runScan(env);
      await env.CACHE.delete("feed");
      await refreshFeed(env);
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/api/opportunities") {
        const scan = (await env.HISTORY.get("last_scan", "json")) || { results: [], scannedAt: null };
        const feed = await refreshFeed(env);
        const brief = await briefing(env, scan, feed);
        return json({ ...scan, brief, altOrigins: ALT_ORIGINS });
      }
      if (p === "/api/feed") return json(await refreshFeed(env));
      if (p === "/api/history") {
        const route = url.searchParams.get("route");
        if (!route) return json({ error: "route required, e.g. HKG-TPE" }, 400);
        return json(await getHistory(env, route));
      }
      if (p === "/api/watchlist" && request.method === "GET") return json({ watchlist: await getWatchlist(env) });
      if (p === "/api/watchlist" && request.method === "POST") {
        const b = await request.json();
        let list = await getWatchlist(env);
        if (b.add) { const c = b.add.toUpperCase().slice(0, 3); if (!list.includes(c)) list.push(c); }
        if (b.remove) list = list.filter((x) => x !== b.remove.toUpperCase());
        await env.HISTORY.put("watchlist", JSON.stringify(list));
        return json({ watchlist: list });
      }
      if (p === "/api/scan" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        return json(await runScan(env, b.limit));
      }
      if (p === "/api/ingest" && request.method === "POST") {
        // Forward airline newsletters here via an email-to-webhook service
        // (Cloudflare Email Routing → Worker, Zapier, IFTTT, Apple Shortcuts).
        const auth = request.headers.get("Authorization") || "";
        if (!env.INGEST_TOKEN || auth !== "Bearer " + env.INGEST_TOKEN) return json({ error: "unauthorized" }, 401);
        const b = await request.json();
        const list = (await env.HISTORY.get("ingested", "json")) || [];
        list.unshift({ source: b.source || "Newsletter", title: (b.subject || b.title || "").slice(0, 200),
          body: (b.body || "").slice(0, 800), url: b.url || "", ts: Date.now() });
        await env.HISTORY.put("ingested", JSON.stringify(list.slice(0, 100)));
        await env.CACHE.delete("feed");
        return json({ ok: true, stored: list.length });
      }
      return new Response(HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

/* ================================================================
 * DASHBOARD
 * ================================================================ */

const HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#07090F">
<title>Deal Intelligence</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#07090F;--panel:#0F1420;--panel2:#151C2B;--line:#222C3F;
--hot:#FF5C38;--warm:#FFB627;--cool:#3DDC97;--text:#ECEAE3;--dim:#7E889E;
--mono:'IBM Plex Mono',monospace;--sans:'Archivo',system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh}
.wrap{max-width:1080px;margin:0 auto;padding:18px 16px 70px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--line)}
h1{font-family:var(--mono);font-size:.95rem;letter-spacing:.2em;color:var(--hot);font-weight:600}
.stamp{font-family:var(--mono);font-size:.68rem;color:var(--dim)}
nav{display:flex;gap:6px;margin:16px 0}
nav button{background:var(--panel);border:1px solid var(--line);color:var(--dim);border-radius:6px;
padding:8px 14px;font-family:var(--mono);font-size:.72rem;cursor:pointer;letter-spacing:.08em}
nav button.on{color:var(--hot);border-color:var(--hot)}
nav button:focus-visible{outline:2px solid var(--warm);outline-offset:1px}
.eyebrow{font-family:var(--mono);font-size:.64rem;letter-spacing:.24em;color:var(--dim);text-transform:uppercase;margin:24px 0 10px}
.brief{background:var(--panel2);border-left:3px solid var(--hot);border-radius:8px;padding:16px;line-height:1.6;font-size:.92rem}
/* deal rows */
.deal{display:grid;grid-template-columns:44px 1fr auto;gap:14px;align-items:center;
background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:8px}
.deal.hot{border-color:var(--hot)}
.deal .badge{font-size:1.5rem;text-align:center}
.deal .dest{font-family:var(--mono);font-size:1.05rem;font-weight:600;letter-spacing:.06em}
.deal .lbl{font-size:.78rem;color:var(--dim);margin-top:3px}
.deal .adv{font-size:.74rem;color:var(--dim);margin-top:5px;font-style:italic}
.deal .price{font-family:var(--mono);font-size:1.15rem;font-weight:600;text-align:right;white-space:nowrap}
.deal .sub{font-family:var(--mono);font-size:.66rem;color:var(--dim);text-align:right;margin-top:3px}
.pct{font-family:var(--mono);font-weight:600}
.pct.up{color:var(--cool)}.pct.down{color:var(--hot)}
.conf{display:inline-block;font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;
border:1px solid var(--line);border-radius:3px;padding:1px 6px;color:var(--dim);margin-left:6px}
/* sparkline */
.spark{height:28px;width:100%;margin-top:8px}
/* feed */
.item{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:7px}
.item a{color:var(--text);text-decoration:none;font-size:.9rem;line-height:1.4;display:block}
.item a:hover{color:var(--warm)}
.item .meta{font-family:var(--mono);font-size:.64rem;color:var(--dim);margin-top:6px;display:flex;gap:10px;flex-wrap:wrap}
.tagk{color:var(--warm)}
/* watchlist */
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{background:var(--panel);border:1px solid var(--line);border-radius:99px;padding:5px 12px;
font-family:var(--mono);font-size:.72rem;color:var(--dim);display:flex;align-items:center;gap:7px}
.chip button{background:none;border:none;color:var(--hot);cursor:pointer;font-size:.9rem;line-height:1;padding:0}
.addrow{display:flex;gap:8px;margin-top:12px}
.addrow input{background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);
font-family:var(--mono);padding:9px;width:110px;text-transform:uppercase}
button.act{background:var(--hot);color:#12060380;color:#1a0a05;border:none;border-radius:6px;
font-weight:700;padding:10px 18px;cursor:pointer;font-size:.85rem}
button.act.ghost{background:transparent;color:var(--warm);border:1px solid var(--line)}
.status{font-family:var(--mono);font-size:.75rem;color:var(--warm);margin-top:12px;min-height:1.2em}
.srcline{font-family:var(--mono);font-size:.68rem;color:var(--dim);line-height:1.9}
.srcline .bad{color:var(--hot)}
.hidden{display:none}
footer{margin-top:44px;border-top:1px solid var(--line);padding-top:14px;
font-family:var(--mono);font-size:.66rem;color:var(--dim);line-height:1.8}
@media(max-width:600px){.deal{grid-template-columns:36px 1fr;row-gap:6px}
.deal .price,.deal .sub{text-align:left;grid-column:2}}
</style></head><body>
<div class="wrap">
<header><h1>DEAL&nbsp;INTELLIGENCE</h1><span class="stamp" id="stamp">loading…</span></header>

<nav>
  <button class="on" data-tab="ops">OPPORTUNITIES</button>
  <button data-tab="feed">SIGNALS</button>
  <button data-tab="watch">WATCHLIST</button>
</nav>

<section id="tab-ops">
  <div class="eyebrow">Today's briefing</div>
  <div class="brief" id="brief">Loading…</div>
  <div class="eyebrow">Ranked by discount vs your own recorded price history</div>
  <div id="deals"></div>
</section>

<section id="tab-feed" class="hidden">
  <div class="eyebrow">Public deal signals — keyword-scored</div>
  <div id="feed"></div>
  <div class="eyebrow">Source status</div>
  <div class="srcline" id="srcstatus"></div>
</section>

<section id="tab-watch" class="hidden">
  <div class="eyebrow">Routes the scanner tracks nightly from HKG</div>
  <div class="chips" id="chips"></div>
  <div class="addrow">
    <input id="newcode" placeholder="TPE" maxlength="3">
    <button class="act ghost" id="addBtn">Add route</button>
  </div>
  <div class="eyebrow">Manual scan</div>
  <div class="srcline">The cron runs nightly. Trigger it now to seed history — each route costs 1–4 API calls.</div>
  <div class="addrow"><button class="act" id="scanBtn">Scan now</button></div>
  <div class="status" id="status"></div>
</section>

<footer>
Prices from Amadeus · discounts computed against price history this Worker recorded itself ·
signals from public sources only · always verify final price with the airline before booking.
</footer>
</div>

<script>
(function(){
var $=function(i){return document.getElementById(i)};
var tabs=['ops','feed','watch'];
document.querySelectorAll('nav button').forEach(function(b){
  b.addEventListener('click',function(){
    document.querySelectorAll('nav button').forEach(function(x){x.classList.remove('on')});
    b.classList.add('on');
    tabs.forEach(function(t){$('tab-'+t).classList.toggle('hidden',t!==b.dataset.tab)});
  });
});

function money(v,cur){return (cur==='HKD'?'HK$':'€')+Math.round(v).toLocaleString()}

function sparkline(points){
  if(!points||points.length<2)return'';
  var vals=points.map(function(p){return p.price}),
      min=Math.min.apply(null,vals),max=Math.max.apply(null,vals),span=(max-min)||1;
  var w=100,h=28,step=w/(vals.length-1);
  var d=vals.map(function(v,i){return (i?'L':'M')+(i*step).toFixed(1)+','+(h-((v-min)/span)*h).toFixed(1)}).join(' ');
  return '<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none">'+
    '<path d="'+d+'" fill="none" stroke="var(--dim)" stroke-width="1.2"/></svg>';
}

function loadOps(){
  fetch('/api/opportunities').then(function(r){return r.json()}).then(function(d){
    $('stamp').textContent=d.scannedAt?('last scan '+new Date(d.scannedAt).toLocaleString()):'never scanned — run one from Watchlist';
    $('brief').textContent=(d.brief&&d.brief.text)||'—';
    var box=$('deals');box.innerHTML='';
    var rows=(d.results||[]).filter(function(r){return r.ok});
    if(!rows.length){box.innerHTML='<div class="item">No scan data yet. Open Watchlist and run a scan to start building history.</div>';return}
    rows.forEach(function(r){
      var s=r.score||{},hot=s.tier==='exceptional'||s.tier==='great';
      var pct=s.discountPct==null?'':'<span class="pct '+(s.discountPct>0?'up':'down')+'">'+
        (s.discountPct>0?'−':'+')+Math.abs(s.discountPct)+'%</span>';
      var el=document.createElement('div');el.className='deal'+(hot?' hot':'');
      el.innerHTML='<div class="badge">'+(s.badge||'·')+'</div>'+
        '<div><div class="dest">HKG → '+r.dest+
          (s.confidence?'<span class="conf">'+s.confidence+' confidence</span>':'')+'</div>'+
        '<div class="lbl">'+(s.label||'')+(s.samples?(' · '+s.samples+' days recorded'):'')+'</div>'+
        '<div class="adv">'+(s.advice||'')+'</div></div>'+
        '<div><div class="price">'+money(r.price,r.currency)+' '+pct+'</div>'+
        '<div class="sub">'+(r.bestDepart||'')+(r.bestReturn?(' → '+r.bestReturn):'')+'</div></div>';
      box.appendChild(el);
      fetch('/api/history?route='+r.route).then(function(x){return x.json()}).then(function(h){
        if(h.points&&h.points.length>2){
          var sp=document.createElement('div');sp.innerHTML=sparkline(h.points);
          el.querySelector('.adv').insertAdjacentElement('afterend',sp.firstChild);
        }
      }).catch(function(){});
    });
  });
}

function loadFeed(){
  fetch('/api/feed').then(function(r){return r.json()}).then(function(d){
    var box=$('feed');box.innerHTML='';
    if(!d.items||!d.items.length){box.innerHTML='<div class="item">No signals scored above threshold. Sources may be unreachable — check status below.</div>'}
    (d.items||[]).forEach(function(i){
      var el=document.createElement('div');el.className='item';
      el.innerHTML='<a href="'+(i.url||'#')+'" target="_blank" rel="noopener">'+
        i.title.replace(/</g,'&lt;')+'</a><div class="meta"><span>'+i.source+'</span>'+
        '<span>score '+i.score+'</span>'+
        (i.alsoSeenIn&&i.alsoSeenIn.length?'<span class="tagk">also in '+i.alsoSeenIn.length+' more</span>':'')+
        (i.matched&&i.matched.length?'<span class="tagk">'+i.matched.slice(0,4).join(' · ')+'</span>':'')+
        '<span>'+new Date(i.ts).toLocaleDateString()+'</span></div>';
      box.appendChild(el);
    });
    $('srcstatus').innerHTML=(d.sources||[]).map(function(s){
      return (s.ok?'✓ ':'<span class="bad">✕ </span>')+s.id+' — '+(s.ok?(s.count+' items'):s.error)}).join('<br>')+
      '<br>· ingested newsletter items: '+(d.ingestedCount||0);
  });
}

function loadWatch(){
  fetch('/api/watchlist').then(function(r){return r.json()}).then(function(d){
    var c=$('chips');c.innerHTML='';
    d.watchlist.forEach(function(code){
      var el=document.createElement('span');el.className='chip';
      el.innerHTML=code+' <button title="Remove">×</button>';
      el.querySelector('button').addEventListener('click',function(){
        fetch('/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({remove:code})}).then(loadWatch);
      });
      c.appendChild(el);
    });
  });
}

$('addBtn').addEventListener('click',function(){
  var v=$('newcode').value.trim().toUpperCase();
  if(v.length!==3){$('status').textContent='Enter a 3-letter airport code.';return}
  fetch('/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({add:v})}).then(function(){$('newcode').value='';loadWatch()});
});

$('scanBtn').addEventListener('click',function(){
  $('status').textContent='Scanning… this can take a minute.';
  $('scanBtn').disabled=true;
  fetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
  .then(function(r){return r.json()}).then(function(d){
    $('scanBtn').disabled=false;
    if(d.error){$('status').textContent='Error: '+d.error;return}
    var ok=(d.results||[]).filter(function(r){return r.ok}).length;
    $('status').textContent='Scanned '+ok+'/'+(d.results||[]).length+' routes. Opportunities updated.';
    loadOps();
  }).catch(function(e){$('scanBtn').disabled=false;$('status').textContent='Failed: '+e.message});
});

loadOps();loadFeed();loadWatch();
})();
</script></body></html>`;
