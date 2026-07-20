/**
 * ================================================================
 *  AI FLIGHT DEAL ASSISTANT
 *  Search → Results → Recommendation → Booking
 *
 *  INFORMATION HIERARCHY (non-negotiable):
 *    1. Flights. Airline, times, price, booking link.
 *    2. Recommendation. Best overall, not merely cheapest.
 *    3. Cheaper alternatives. Nearby airports, other dates.
 *    4. Sources and data notes — collapsed, at the bottom.
 *
 *  A limitation is never the first thing on screen.
 *  Partial data is labelled, not withheld.
 * ================================================================
 *
 *  BINDINGS
 *    Secret  TRAVELPAYOUTS_TOKEN   required
 *    Secret  GEMINI_API_KEY        optional
 *    Var     TP_MARKER             optional
 *    KV      HISTORY               optional (prefs, ground costs, history)
 */

const TP = "https://api.travelpayouts.com";

/* ================================================================
 * Traveller profiles
 * ================================================================ */

const PROFILES = {
  backpacker: { id:"backpacker", timeValue:40,  stopPenalty:60,  channelPremium:80,  maxGroundHours:8 },
  balanced:   { id:"balanced",   timeValue:120, stopPenalty:150, channelPremium:200, maxGroundHours:4 },
  family:     { id:"family",     timeValue:200, stopPenalty:400, channelPremium:300, maxGroundHours:3 },
  business:   { id:"business",   timeValue:500, stopPenalty:600, channelPremium:400, maxGroundHours:1.5 },
};

const QUIZ = [
  { id:"q1", kind:"time", hours:2, save:500, zh:"你願唔願意多花 2 個鐘,慳 HK$500?", en:"Spend 2 extra hours to save HK$500?" },
  { id:"q2", kind:"time", hours:4, save:600, zh:"多花 4 個鐘,慳 HK$600 呢?", en:"Spend 4 extra hours to save HK$600?" },
  { id:"q3", kind:"stop", save:300, zh:"轉一次機,慳 HK$300,肯唔肯?", en:"Take 1 stop to save HK$300?" },
  { id:"q4", kind:"channel", save:400, zh:"經未聽過嘅代理訂票,慳 HK$400,肯唔肯?", en:"Book via an unknown agency to save HK$400?" },
];

function weightsFrom(answers, base) {
  const w = { ...(base || PROFILES.balanced) };
  let lo=0, hi=2000, bounded=false;
  for (const q of QUIZ) {
    const a = answers[q.id];
    if (a === undefined) continue;
    if (q.kind==="time") { const r=q.save/q.hours; if(a){hi=Math.min(hi,r)}else{lo=Math.max(lo,r)} bounded=true; }
    if (q.kind==="stop") w.stopPenalty = a ? Math.min(w.stopPenalty,q.save) : Math.max(w.stopPenalty,q.save+100);
    if (q.kind==="channel") w.channelPremium = a ? Math.min(w.channelPremium,q.save) : Math.max(w.channelPremium,q.save+100);
  }
  if (bounded) {
    if (hi<2000 && lo>0) w.timeValue=Math.round((lo+hi)/2);
    else if (hi<2000) w.timeValue=Math.round(hi*0.75);
    else w.timeValue=Math.round(lo*1.25);
  }
  w.derivedFrom = bounded ? "quiz" : "profile";
  return w;
}

/* ================================================================
 * Booking channels — every button names where it sends you
 * ================================================================ */

const AIRLINES = {
  CX:{n:"Cathay Pacific",z:"國泰航空",u:"https://www.cathaypacific.com/cx/en_HK/book-a-trip.html",rel:5},
  UO:{n:"HK Express",z:"HK Express",u:"https://www.hkexpress.com/en-hk/",rel:3,lcc:true},
  HX:{n:"Hong Kong Airlines",z:"香港航空",u:"https://www.hongkongairlines.com/en_HK/homepage",rel:4},
  CI:{n:"China Airlines",z:"中華航空",u:"https://www.china-airlines.com/",rel:4},
  BR:{n:"EVA Air",z:"長榮航空",u:"https://www.evaair.com/",rel:5},
  JX:{n:"Starlux",z:"星宇航空",u:"https://www.starlux-airlines.com/",rel:5},
  IT:{n:"Tigerair Taiwan",z:"台灣虎航",u:"https://www.tigerairtw.com/",rel:3,lcc:true},
  AE:{n:"Mandarin Airlines",z:"華信航空",u:"https://www.mandarin-airlines.com/",rel:4},
  SQ:{n:"Singapore Airlines",z:"新加坡航空",u:"https://www.singaporeair.com/",rel:5},
  TR:{n:"Scoot",z:"酷航",u:"https://www.flyscoot.com/",rel:3,lcc:true},
  NH:{n:"ANA",z:"全日空",u:"https://www.ana.co.jp/en/us/",rel:5},
  JL:{n:"Japan Airlines",z:"日本航空",u:"https://www.jal.co.jp/en/",rel:5},
  MM:{n:"Peach",z:"樂桃航空",u:"https://www.flypeach.com/en",rel:3,lcc:true},
  KE:{n:"Korean Air",z:"大韓航空",u:"https://www.koreanair.com/",rel:5},
  OZ:{n:"Asiana Airlines",z:"韓亞航空",u:"https://flyasiana.com/",rel:4},
  "7C":{n:"Jeju Air",z:"濟州航空",u:"https://www.jejuair.net/en/main/base/main.do",rel:3,lcc:true},
  TW:{n:"T'way Air",z:"德威航空",u:"https://www.twayair.com/app/main",rel:3,lcc:true},
  AK:{n:"AirAsia",z:"亞洲航空",u:"https://www.airasia.com/",rel:3,lcc:true},
  FD:{n:"Thai AirAsia",z:"泰國亞航",u:"https://www.airasia.com/",rel:3,lcc:true},
  D7:{n:"AirAsia X",z:"亞航長途",u:"https://www.airasia.com/",rel:3,lcc:true},
  TG:{n:"Thai Airways",z:"泰國航空",u:"https://www.thaiairways.com/",rel:4},
  VN:{n:"Vietnam Airlines",z:"越南航空",u:"https://www.vietnamairlines.com/",rel:4},
  VJ:{n:"VietJet Air",z:"越捷航空",u:"https://www.vietjetair.com/",rel:2,lcc:true},
  PR:{n:"Philippine Airlines",z:"菲律賓航空",u:"https://www.philippineairlines.com/",rel:3},
  "5J":{n:"Cebu Pacific",z:"宿霧太平洋",u:"https://www.cebupacificair.com/",rel:3,lcc:true},
  MH:{n:"Malaysia Airlines",z:"馬來西亞航空",u:"https://www.malaysiaairlines.com/",rel:4},
  GA:{n:"Garuda Indonesia",z:"印尼鷹航",u:"https://www.garuda-indonesia.com/",rel:4},
  EK:{n:"Emirates",z:"阿聯酋航空",u:"https://www.emirates.com/",rel:5},
  QR:{n:"Qatar Airways",z:"卡塔爾航空",u:"https://www.qatarairways.com/",rel:5},
  TK:{n:"Turkish Airlines",z:"土耳其航空",u:"https://www.turkishairlines.com/",rel:4},
  BA:{n:"British Airways",z:"英國航空",u:"https://www.britishairways.com/",rel:4},
  AF:{n:"Air France",z:"法國航空",u:"https://www.airfrance.com/",rel:4},
  LH:{n:"Lufthansa",z:"漢莎航空",u:"https://www.lufthansa.com/",rel:4},
  KL:{n:"KLM",z:"荷蘭皇家航空",u:"https://www.klm.com/",rel:4},
  UA:{n:"United Airlines",z:"聯合航空",u:"https://www.united.com/",rel:4},
  AA:{n:"American Airlines",z:"美國航空",u:"https://www.aa.com/",rel:4},
  DL:{n:"Delta Air Lines",z:"達美航空",u:"https://www.delta.com/",rel:4},
  QF:{n:"Qantas",z:"澳洲航空",u:"https://www.qantas.com/",rel:5},
  CZ:{n:"China Southern",z:"中國南方航空",u:"https://www.csair.com/",rel:3},
  MU:{n:"China Eastern",z:"中國東方航空",u:"https://us.ceair.com/",rel:3},
  CA:{n:"Air China",z:"中國國際航空",u:"https://www.airchina.us/",rel:3},
  CN:{n:"Grand China Air",z:"大新華航空",u:"https://www.hnair.com/",rel:3},
  HO:{n:"Juneyao Air",z:"吉祥航空",u:"https://www.juneyaoair.com/",rel:3,lcc:true},
};

const OTA = [
  { id:"tripcom", n:"Trip.com", z:"Trip.com", tier:1,
    url:(o)=> "https://www.trip.com/flights/" + o.origin.toLowerCase() + "-to-" + o.destination.toLowerCase() +
      "?dcity=" + o.origin + "&acity=" + o.destination + "&ddate=" + o.departDate +
      (o.returnDate ? "&rdate=" + o.returnDate + "&triptype=rt" : "&triptype=ow") },
  { id:"expedia", n:"Expedia", z:"Expedia", tier:1,
    url:(o)=> "https://www.expedia.com/Flights-Search?trip=" + (o.returnDate?"roundtrip":"oneway") +
      "&leg1=from:" + o.origin + ",to:" + o.destination + ",departure:" + o.departDate + "TANYT" +
      (o.returnDate ? "&leg2=from:" + o.destination + ",to:" + o.origin + ",departure:" + o.returnDate + "TANYT" : "") },
];

const dm = i => i.slice(8,10)+i.slice(5,7);
const ymd = i => i.slice(2,4)+i.slice(5,7)+i.slice(8,10);

function channelsFor(o, marker, pax) {
  const out = [];
  const a = o.airlineCode && AIRLINES[o.airlineCode];
  if (a) out.push({ id:"airline", kind:"book", rank:1,
    en:"Book with " + a.n + " (Official)", zh:"直接向" + a.z + "訂票(官網)", url:a.u, prefill:false });

  for (const t of OTA) out.push({ id:t.id, kind:"book", rank:2,
    en:"Book with " + t.n, zh:"經 " + t.z + " 訂票", url:t.url(o), prefill:true });

  let seg = o.origin + dm(o.departDate) + o.destination;
  if (o.returnDate) seg += dm(o.returnDate);
  seg += String(pax||1);
  out.push({ id:"aviasales", kind:"compare", rank:3,
    en:"Compare booking options", zh:"比較訂票渠道",
    url:"https://www.aviasales.com/search/"+seg+(marker?"?marker="+marker:""), prefill:true });

  const gq = "Flights from "+o.origin+" to "+o.destination+" on "+o.departDate+(o.returnDate?" through "+o.returnDate:"");
  out.push({ id:"google", kind:"verify", rank:4, en:"Check on Google Flights", zh:"喺 Google Flights 核對",
    url:"https://www.google.com/travel/flights?q="+encodeURIComponent(gq), prefill:true });

  let sk = "https://www.skyscanner.net/transport/flights/"+o.origin.toLowerCase()+"/"+o.destination.toLowerCase()+"/"+ymd(o.departDate)+"/";
  if (o.returnDate) sk += ymd(o.returnDate)+"/";
  out.push({ id:"skyscanner", kind:"verify", rank:5, en:"Check on Skyscanner", zh:"喺 Skyscanner 核對", url:sk, prefill:true });

  return out.sort((x,y)=>x.rank-y.rank);
}

/* ================================================================
 * Offer shape — partial data is LABELLED, never withheld
 * ================================================================ */

function makeOffer(x) {
  const rd = x.returnDate || null;
  const hasItin = !!(x.departTime || x.flightNumber || x.durationMin);
  return {
    origin:x.origin, destination:x.destination,
    departDate:x.departDate, returnDate:rd,
    tripType: rd ? "return" : "oneway",
    price: x.price!=null?Math.round(x.price):null,
    currency:x.currency||"HKD",
    stops: x.stops!=null?x.stops:null,
    airlineCode:x.airlineCode||null,
    airlineName:x.airlineName||x.airlineCode||null,
    flightNumber: x.flightNumber!=null?String(x.flightNumber):null,
    departTime:x.departTime||null,
    arriveTime:x.arriveTime||null,
    durationMin: x.durationMin!=null?x.durationMin:null,
    // "full" = airline + time + duration known. "price_only" = fare only.
    detail: hasItin ? "full" : "price_only",
    via: x.via || "requested",
    foundVia: x.foundVia || "search",
  };
}

/* ================================================================
 * Provider calls
 * ================================================================ */

async function tp(env, path, params) {
  const u = new URL(TP+path);
  for (const [k,v] of Object.entries(params)) if (v!=null && v!=="") u.searchParams.set(k,String(v));
  const r = await fetch(u.toString(), { headers:{ "X-Access-Token": env.TRAVELPAYOUTS_TOKEN||"" }});
  const b = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error("HTTP "+r.status);
  if (b.success===false) throw new Error(String(b.error||"provider error"));
  return b;
}

async function names(env) {
  if (env.HISTORY) { const h = await env.HISTORY.get("ref:air","json"); if (h) return h; }
  try {
    const r = await fetch(TP+"/data/airlines.json"); const l = await r.json(); const m={};
    for (const a of l) if (a.code) m[a.code]=a.name;
    if (env.HISTORY) await env.HISTORY.put("ref:air", JSON.stringify(m), { expirationTtl:604800 });
    return m;
  } catch(e){ return {}; }
}

/** Richest source: real flight numbers, departure times, durations. */
async function searchExact(env, q, nm, opts) {
  const b = await tp(env, "/aviasales/v3/prices_for_dates", {
    origin:q.origin, destination:q.destination,
    departure_at:(opts&&opts.departDate)||q.departDate,
    return_at: q.trip==="return" ? ((opts&&opts.returnDate)||q.returnDate) : "",
    one_way: q.trip==="return" ? "false":"true",
    currency:q.currency.toLowerCase(), sorting:"price", limit:30, page:1, market:q.market,
  });
  return (b.data||[]).map(d=>makeOffer({
    origin:d.origin, destination:d.destination,
    departDate:(d.departure_at||"").slice(0,10),
    returnDate:(d.return_at||"").slice(0,10)||null,
    price:d.price, currency:q.currency,
    stops: d.transfers!=null?d.transfers:d.number_of_changes,
    airlineCode:d.airline, airlineName:nm[d.airline]||d.airline,
    flightNumber:d.flight_number,
    departTime:(d.departure_at||"").length>10?d.departure_at:null,
    durationMin:d.duration, via:(opts&&opts.via)||"requested", foundVia:"exact_dates",
  }));
}

async function searchMonth(env, q, nm, month) {
  const b = await tp(env, "/v2/prices/month-matrix", {
    currency:q.currency.toLowerCase(), origin:q.origin, destination:q.destination,
    month:month+"-01", show_to_affiliates:"true", market:q.market,
  });
  return (b.data||[]).map(d=>makeOffer({
    origin:q.origin, destination:q.destination,
    departDate:d.depart_date, returnDate:d.return_date||null,
    price:d.value, currency:q.currency, stops:d.number_of_changes,
    airlineCode:d.gate||null, airlineName:nm[d.gate]||d.gate||null,
    via:"other_date", foundVia:"month_calendar",
  }));
}

/**
 * No fixed date at all — scans cached fares across the whole coming year
 * and returns the cheapest found, each with its own real date. Also the
 * mechanism that makes a country-code destination work ("HKG to Japan,
 * whenever is cheapest" returns real fares to NRT, KIX, FUK etc. mixed
 * together, sorted by price) — Travelpayouts accepts a 2-letter country
 * code in the same origin/destination field as a 3-letter airport code.
 */
async function searchAnytime(env, q, nm) {
  const b = await tp(env, "/v2/prices/latest", {
    origin:q.origin, destination:q.destination||"",
    currency:q.currency.toLowerCase(), period_type:"year",
    one_way:q.trip==="return"?"false":"true",
    page:1, limit:30, sorting:"price", show_to_affiliates:"true", market:q.market,
  });
  return (b.data||[]).map(d=>makeOffer({
    origin:d.origin||q.origin, destination:d.destination||q.destination,
    departDate:d.depart_date, returnDate:d.return_date||null,
    price:d.value, currency:q.currency, stops:d.number_of_changes,
    airlineCode:d.gate||null, airlineName:nm[d.gate]||d.gate||null,
    via:"any_date", foundVia:"anytime_cache",
  }));
}

async function searchLatest(env, q, nm) {
  const b = await tp(env, "/v2/prices/latest", {
    currency:q.currency.toLowerCase(), origin:q.origin, destination:q.destination,
    period_type:"year", one_way:q.trip==="return"?"false":"true",
    page:1, limit:30, show_to_affiliates:"true", sorting:"price", market:q.market,
  });
  return (b.data||[]).map(d=>makeOffer({
    origin:d.origin||q.origin, destination:d.destination||q.destination,
    departDate:d.depart_date, returnDate:d.return_date||null,
    price:d.value, currency:q.currency, stops:d.number_of_changes,
    airlineCode:d.gate||null, airlineName:nm[d.gate]||d.gate||null,
    via:"other_date", foundVia:"recent_cache",
  }));
}

async function searchNearby(env, q, nm) {
  const b = await tp(env, "/v2/prices/nearest-places-matrix", {
    currency:q.currency.toLowerCase(), origin:q.origin, destination:q.destination,
    depart_date:q.departDate, return_date:q.trip==="return"?q.returnDate:"",
    distance:q.distance||600, limit:20, flexibility:3, show_to_affiliates:"true", market:q.market,
  });
  return (b.prices||b.data||[]).map(d=>makeOffer({
    origin:d.origin, destination:d.destination,
    departDate:d.depart_date, returnDate:d.return_date||null,
    price:d.value, currency:q.currency, stops:d.number_of_changes,
    airlineCode:d.gate||null, airlineName:nm[d.gate]||d.gate||null,
    via: d.origin!==q.origin ? "other_origin" : (d.destination!==q.destination ? "other_destination" : "requested"),
    foundVia:"nearby_airports",
  }));
}

/* ================================================================
 * Ranking — best OVERALL, not merely cheapest
 * ================================================================ */

async function ground(env, uid) {
  if (!env.HISTORY) return {};
  return (await env.HISTORY.get("ground:"+uid,"json")) || {};
}

/**
 * Low-cost carriers advertise a fare that excludes checked baggage, while
 * full-service fares include it. Comparing the two headline numbers is not a
 * like-for-like comparison. This adds the bag back as a VISIBLE line item the
 * traveller can switch off — it is an estimate, and it is labelled as one.
 */
const BAG_ESTIMATE = 240;   // HKD, round trip, typical prepaid 20kg on an LCC

function scoreOffer(o, w, gr, home, opts) {
  let total = o.price;
  const parts = [{ k:"fare", v:o.price }];
  let groundKnown = true;

  if (o.origin !== home) {
    const g = gr[o.origin];
    if (g) {
      const mult = o.returnDate ? 2 : 1;
      const c = g.costHKD*mult, hrs = (g.minutes*mult)/60;
      total += c; parts.push({ k:"ground", v:c });
      total += hrs*w.timeValue; parts.push({ k:"groundTime", v:Math.round(hrs*w.timeValue), hours:hrs });
    } else {
      groundKnown = false;
      parts.push({ k:"ground", v:null, unknown:true });
    }
  }
  if (o.stops) { const p=o.stops*w.stopPenalty; total+=p; parts.push({ k:"stops", v:p }); }

  const a = o.airlineCode && AIRLINES[o.airlineCode];
  const rel = a ? a.rel : 3;

  // Checked bag: charged separately by LCCs, already included by full-service.
  const wantsBag = !opts || opts.bag !== false;
  const isLcc = !!(a && a.lcc);
  if (wantsBag && isLcc) {
    const b = Math.round(BAG_ESTIMATE * (o.returnDate ? 1 : 0.5));
    total += b; parts.push({ k:"baggage", v:b, estimate:true });
  }

  // Service and flexibility gap on a low-cost carrier: seat pitch, meals, and
  // above all how painful a change or cancellation is. Scaled by how much this
  // traveller says they value booking flexibility, so a backpacker barely
  // feels it while a business traveller weighs it heavily.
  if (isLcc) {
    const sv = Math.round(w.channelPremium * 0.5);
    if (sv) { total += sv; parts.push({ k:"service", v:sv }); }
  }

  // No airline site known → you'll be booking through an intermediary.
  if (!a) { total += w.channelPremium; parts.push({ k:"channel", v:w.channelPremium }); }

  return { trueCost: Math.round(total), parts, groundKnown, reliability: rel };
}

/* ================================================================
 * ORCHESTRATION — results first, and almost never empty
 * ================================================================ */

const json = (o,s=200)=>new Response(JSON.stringify(o),{status:s,
  headers:{ "Content-Type":"application/json","Cache-Control":"no-store" }});

function addDays(iso,n){ const d=new Date(iso+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }


/* ================================================================
 * THE ANSWER — the whole product in one object.
 * Rule: this function never returns null. Whatever the research
 * found, the user gets a conclusion, not homework.
 * ================================================================ */

function buildEstimate(routeFares, history) {
  // Derived expected price for the requested route from ALL cached
  // evidence (any date this year) + own recorded history. Labelled as
  // an estimate; basis and sample counts are part of the object.
  const prices = routeFares.map(o=>o.price).filter(p=>p!=null);
  const hist = (history&&history.points?history.points:[]).map(p=>p.price).filter(p=>p!=null);
  const all = prices.concat(hist);
  if (!all.length) return null;
  const sorted=[...all].sort((a,b)=>a-b);
  const q = f => sorted[Math.min(sorted.length-1, Math.floor(sorted.length*f))];
  return {
    low: sorted[0],
    typical: q(0.5),
    high: q(0.8),
    samples: all.length,
    basis: { cachedFares: prices.length, historyDays: hist.length },
  };
}

function buildAnswer(q, primary, onRouteOtherDates, altAirports, recommendation, context, estimate) {
  const best = recommendation && recommendation.best;

  if (best && (q.anyDate || (best.origin===q.origin && best.destination===q.destination))) {
    const ch = (best.channels||[]).find(c=>c.kind==="book") || (best.channels||[])[0] || null;
    return {
      kind: primary.length && primary[0].via!=="other_date" ? "exact" : "adjusted",
      headline: { origin:best.origin, destination:best.destination,
        departDate:best.departDate, returnDate:best.returnDate,
        price:best.price, currency:best.currency, airlineName:best.airlineName,
        stops:best.stops, via:best.via },
      channel: ch ? { id:ch.id, zh:ch.zh, en:ch.en, url:ch.url } : null,
      timing: context
        ? { verdict:context.verdict, percentile:context.percentile, samples:context.samples }
        : { verdict:"no_history", samples:0 },
      estimate,
      note: primary.length && primary[0].via==="other_date" ? "dates_adjusted" : null,
    };
  }

  // Tier 2: nothing on the exact route/dates, but a real alternative exists
  const alt = (onRouteOtherDates[0] || altAirports[0]) || null;
  if (alt) {
    const ch = (alt.channels||[]).find(c=>c.kind==="book") || (alt.channels||[])[0] || null;
    return {
      kind: alt.origin!==q.origin||alt.destination!==q.destination ? "alternative_airport" : "alternative_date",
      headline: { origin:alt.origin, destination:alt.destination,
        departDate:alt.departDate, returnDate:alt.returnDate,
        price:alt.price, currency:alt.currency, airlineName:alt.airlineName,
        stops:alt.stops, via:alt.via },
      channel: ch ? { id:ch.id, zh:ch.zh, en:ch.en, url:ch.url } : null,
      timing: { verdict:"no_history", samples:0 },
      estimate,
      note: "request_had_no_cached_fares",
    };
  }

  // Tier 3: estimate only — still an answer, with an expected price and a plan
  if (estimate) {
    return {
      kind: "estimate_only",
      headline: null,
      channel: null,
      timing: { verdict:"no_history", samples:0 },
      estimate,
      note: "no_bookable_cache_but_price_derivable",
    };
  }

  // Tier 4: zero data anywhere — the answer is a concrete plan, not a shrug
  return {
    kind: "action_plan",
    headline: null, channel: null,
    timing: { verdict:"no_history", samples:0 },
    estimate: null,
    note: "route_has_no_cached_data_at_all",
  };
}

async function handleSearch(request, env) {
  const t0 = Date.now();
  const p = new URL(request.url).searchParams;
  const uid = p.get("uid")||"anon";
  const q = {
    origin:(p.get("origin")||"").toUpperCase().trim(),
    destination:(p.get("destination")||"").toUpperCase().trim(),
    departDate:p.get("departDate")||"",
    returnDate:p.get("returnDate")||"",
    trip: p.get("trip")==="oneway"?"oneway":"return",
    currency:(p.get("currency")||"HKD").toUpperCase(),
    pax:parseInt(p.get("pax")||"1",10),
    distance:parseInt(p.get("distance")||"600",10),
    flexible: p.get("flexible")==="1",
    bag: p.get("nobag")!=="1",
    anyDate: p.get("anyDate")==="1",
    dateMode: p.get("dateMode")||null,
    market: env.DEFAULT_MARKET||"hk",
  };
  if (!env.TRAVELPAYOUTS_TOKEN) return json({ error:"TRAVELPAYOUTS_TOKEN not configured" },500);
  if (!q.origin || !q.destination) return json({ error:"origin and destination required" },400);
  // 2 letters = country code, 3 = city/airport code — both are valid inputs.
  if (q.origin.length<2 || q.origin.length>3 || q.destination.length<2 || q.destination.length>3)
    return json({ error:"origin/destination must be a 2-letter country code or 3-letter city/airport code" },400);
  if (!q.anyDate && !q.departDate) return json({ error:"departDate required (or enable Any date)" },400);

  let weights = PROFILES[p.get("profile")] || PROFILES.balanced;
  if (env.HISTORY) {
    const sv = await env.HISTORY.get("prefs:"+uid,"json");
    if (sv && sv.answers && Object.keys(sv.answers).length)
      weights = weightsFrom(sv.answers, PROFILES[sv.profile]||weights);
  }

  const nm = await names(env);
  const gr = await ground(env, uid);
  const sources = [];
  const mark = (id,ok,found,note)=>sources.push({ id, ok, found:found||0, note:note||null });

  let pool = [];

  if (q.anyDate) {
    // No date requested at all: scan the whole year for the cheapest cached
    // fares. Also the path that makes a country-code destination work, since
    // results arrive as a mix of real cities with no single date to fix on.
    try { const r = await searchAnytime(env,q,nm); pool=pool.concat(r); mark("anytime_cache",true,r.length); }
    catch(e){ mark("anytime_cache",false,0,e.message); }

    // Nearby-airport comparison still needs SOME concrete date to query
    // against. Best-effort: probe using the cheapest date already found.
    // Never fatal if it fails — the anytime results stand on their own.
    if (q.destination.length===3) {
      const probeDate = pool.length ? pool.slice().sort((a,b)=>a.price-b.price)[0].departDate : null;
      if (probeDate) {
        try {
          const r = await searchNearby(env, { ...q, departDate:probeDate, returnDate:"" }, nm);
          // Keep only genuine alternatives. The exact origin/destination row
          // from this probe reflects one arbitrary date, not the year-wide
          // scan, and would otherwise show up as a confusing near-duplicate
          // alongside the real any-date results for the same route.
          const alts = r.filter(o=>o.via!=="requested");
          pool = pool.concat(alts); mark("nearby_airports",true,alts.length);
        } catch(e){ mark("nearby_airports",false,0,e.message); }
      } else {
        mark("nearby_airports",false,0,"no_probe_date_available");
      }
    } else {
      mark("nearby_airports",false,0,"destination_is_a_country_not_a_single_airport");
    }
  } else {
    // --- 1. exact dates (richest itinerary data)
    try { const r = await searchExact(env,q,nm); pool=pool.concat(r); mark("exact_dates",true,r.length); }
    catch(e){ mark("exact_dates",false,0,e.message); }

    // --- 2. ±3 days around the requested date — always runs: it is evidence
    // for the estimate and the conclusion, not a fallback.
    if (true) {
      const shifts = [-3,-2,-1,1,2,3];
      const got = await Promise.all(shifts.map(async s=>{
        try {
          return await searchExact(env,q,nm,{
            departDate: addDays(q.departDate,s),
            returnDate: q.returnDate ? addDays(q.returnDate,s) : "",
            via:"other_date" });
        } catch(e){ return []; }
      }));
      const flat = got.flat(); pool = pool.concat(flat); mark("flex_dates",true,flat.length);
    }

    // --- 3. month calendar — always runs (feeds the price estimate)
    if (true) {
      try { const r = await searchMonth(env,q,nm,q.departDate.slice(0,7)); pool=pool.concat(r); mark("month_calendar",true,r.length); }
      catch(e){ mark("month_calendar",false,0,e.message); }
    }

    // --- 4. nearby airports
    try { const r = await searchNearby(env,q,nm); pool=pool.concat(r); mark("nearby_airports",true,r.filter(o=>o.via!=="requested").length); }
    catch(e){ mark("nearby_airports",false,0,e.message); }

    // --- 5. anything cached on this route this year — always runs
    if (true) {
      try { const r = await searchLatest(env,q,nm); pool=pool.concat(r); mark("recent_cache",true,r.length); }
      catch(e){ mark("recent_cache",false,0,e.message); }
    }
  }

  // weekend dateMode: keep only Fri/Sat out, Sun/Mon back, 2-4 days (holiday-adjacent also passes)
  if (q.anyDate && q.dateMode==="weekend") {
    HOLIDAYS_ACTIVE=await getHolidays(env);
    pool=pool.filter(o=>{
      if(!o.departDate||!o.returnDate) return false;
      const dw=weekday(o.departDate),rw=weekday(o.returnDate),days=tripDays(o.departDate,o.returnDate);
      const wk=(dw===5||dw===6)&&(rw===0||rw===1)&&days>=2&&days<=4;
      return wk||nearHoliday(o.departDate)||nearHoliday(o.returnDate);
    });
  }
  if (q.anyDate && q.dateMode==="month") {
    const thisMonth=new Date().toISOString().slice(0,7);
    pool=pool.filter(o=>o.departDate&&o.departDate.slice(0,7)===thisMonth);
  }

  // dedupe + trip-type filter
  const seen = new Set(); let offers = [];
  for (const o of pool) {
    if (o.price==null || o.price<=0 || !o.departDate) continue;
    if (o.tripType !== q.trip) continue;
    const k=[o.origin,o.destination,o.departDate,o.returnDate,o.price,o.airlineCode,o.flightNumber].join("|");
    if (seen.has(k)) continue; seen.add(k); offers.push(o);
  }

  // score everything
  offers = offers.map(o=>{
    const s = scoreOffer(o, weights, gr, q.origin, { bag: q.bag });
    return { ...o, ...s, isLcc: !!(AIRLINES[o.airlineCode] && AIRLINES[o.airlineCode].lcc), channels: channelsFor(o, env.TP_MARKER, q.pax) };
  });

  // ---- MAIN LIST: exactly what was asked for, cheapest first
  const main = offers.filter(o=>o.origin===q.origin && o.destination===q.destination && o.via!=="other_date")
    .sort((a,b)=>a.price-b.price);
  const onRouteOtherDates = offers.filter(o=>o.origin===q.origin && o.destination===q.destination && o.via==="other_date")
    .sort((a,b)=>a.price-b.price);
  const altAirports = offers.filter(o=>o.origin!==q.origin || o.destination!==q.destination)
    .sort((a,b)=>a.price-b.price);

  // Primary list never empty while anything at all was found.
  const primary = main.length ? main : (onRouteOtherDates.length ? onRouteOtherDates : altAirports);

  // ---- RECOMMENDATION: best overall among the primary list
  const byTrue = [...primary].sort((a,b)=>a.trueCost-b.trueCost);
  const best = byTrue[0] || null;
  const cheapest = primary[0] || null;
  let recommendation = null;
  if (best && cheapest) {
    recommendation = {
      best, cheapest,
      sameOption: best === cheapest,
      priceGap: best.price - cheapest.price,
      reasons: recommendationReasons(best, cheapest, weights),
    };
  }

  // ---- SAVINGS: cheaper than the best on-route option
  const baseline = cheapest ? cheapest.price : null;
  const savings = [];
  if (baseline != null) {
    for (const o of onRouteOtherDates.slice(0,4))
      if (o.price < baseline) savings.push({ type:"other_date", offer:o, saving: baseline-o.price });
    for (const o of altAirports.slice(0,6)) {
      if (o.price >= baseline) continue;
      const g = gr[o.origin];
      const mult = o.returnDate?2:1;
      savings.push({ type: o.origin!==q.origin ? "other_origin":"other_destination",
        offer:o, saving: baseline-o.price,
        groundCost: g ? g.costHKD*mult : null,
        netSaving: g ? (baseline-o.price) - g.costHKD*mult : null,
        groundKnown: !!g });
    }
    savings.sort((a,b)=>(b.netSaving!=null?b.netSaving:b.saving)-(a.netSaving!=null?a.netSaving:a.saving));
  }

  // record history quietly
  if (env.HISTORY && main.length) {
    try {
      const key="hist:"+q.origin+"-"+q.destination;
      const h=(await env.HISTORY.get(key,"json"))||{points:[]};
      const d=new Date().toISOString().slice(0,10);
      h.points=h.points.filter(x=>!(x.date===d&&x.tripType===q.trip));
      h.points.push({date:d,price:main[0].price,currency:q.currency,tripType:q.trip});
      h.points.sort((a,b)=>a.date.localeCompare(b.date));
      if(h.points.length>180)h.points=h.points.slice(-180);
      await env.HISTORY.put(key,JSON.stringify(h));
    } catch(e){}
  }
  let history=null;
  if (env.HISTORY) history = await env.HISTORY.get("hist:"+q.origin+"-"+q.destination,"json");

  // price context — only if we actually have history
  let context = null;
  if (history && history.points && history.points.length>=10 && cheapest) {
    const today = new Date().toISOString().slice(0,10);
    const pr = history.points.filter(x=>x.date!==today).map(x=>x.price).filter(x=>x!=null);
    const sorted=[...pr].sort((a,b)=>a-b);
    const below = pr.filter(x=>x<cheapest.price).length;
    context = pr.length < 10 ? null : { percentile: Math.round(below/pr.length*100), samples: pr.length,
      lowest: sorted[0], median: sorted[Math.floor(sorted.length/2)],
      verdict: (below/pr.length)<=0.2 ? "good_time" : ((below/pr.length)>=0.75 ? "consider_waiting" : "typical") };
  }

  // The Answer — always present, built from all evidence gathered above.
  const routeFares = offers.filter(o=>o.origin===q.origin && o.destination===q.destination);
  const estimate = buildEstimate(routeFares, history);
  const answer = buildAnswer(q, primary, onRouteOtherDates, altAirports, recommendation, context, estimate);

  // Alternative destinations when the request itself came up empty — the
  // assistant never stops helping. One extra call, only on the empty tiers.
  if (answer && (answer.kind==="estimate_only"||answer.kind==="action_plan")) {
    try{
      const ab=await tp(env,"/v2/prices/latest",{origin:q.origin,
        currency:q.currency.toLowerCase(),period_type:"year",one_way:"false",
        page:1,limit:30,sorting:"price",show_to_affiliates:"true",market:q.market});
      const seen2=new Set([q.destination]);
      answer.alternatives=[];
      for(const d of (ab.data||[])){
        if(!d.destination||d.value==null||seen2.has(d.destination))continue;
        seen2.add(d.destination);
        answer.alternatives.push({destination:d.destination,price:Math.round(d.value),
          departDate:d.depart_date,returnDate:d.return_date||null});
        if(answer.alternatives.length>=3)break;
      }
    }catch(e){ answer.alternatives=[]; }
  }

  // verification links — a footnote for checking, never the product's output
  const fallbackLinks = [];
  {
    fallbackLinks.push({ id:"google", en:"Search on Google Flights", zh:"去 Google Flights 搵",
      url:"https://www.google.com/travel/flights?q="+encodeURIComponent(
        "Flights from "+q.origin+" to "+q.destination+" on "+q.departDate+(q.returnDate?" through "+q.returnDate:"")) });
    let sk="https://www.skyscanner.net/transport/flights/"+q.origin.toLowerCase()+"/"+q.destination.toLowerCase()+"/"+ymd(q.departDate)+"/";
    if (q.returnDate) sk+=ymd(q.returnDate)+"/";
    fallbackLinks.push({ id:"skyscanner", en:"Search on Skyscanner", zh:"去 Skyscanner 搵", url:sk });
    fallbackLinks.push({ id:"aviasales", en:"Search on Aviasales", zh:"去 Aviasales 搵",
      url:"https://www.aviasales.com/search/"+q.origin+dm(q.departDate)+q.destination+(q.returnDate?dm(q.returnDate):"")+String(q.pax) });
  }

  return json({
    query:q, weights,
    answer,
    results: primary.slice(0,25),
    resultsAreExactRoute: main.length>0,
    recommendation,
    savings: savings.slice(0,6),
    otherDates: onRouteOtherDates.slice(0,8),
    context,
    verifyLinks: fallbackLinks,
    trust: {
      sources,
      sourceInventory: [
        {id:"travelpayouts", role:"core_prices", status:"live"},
        {id:"reddit", role:"community_signals", status:"live"},
        {id:"telegram_channels", role:"promo_signals", status: env.TG_CHANNELS?"live":"configure_TG_CHANNELS"},
        {id:"airline_rss", role:"promo_signals", status: env.RSS_FEEDS?"live":"configure_RSS_FEEDS"},
        {id:"newsletter_ingest", role:"promo_signals", status:"live_via_/api/ingest"},
        {id:"public_holidays_api", role:"context", status:"live_nager.date"},
        {id:"duffel", role:"core_prices_v2", status: env.DUFFEL_KEY?"live":"needs_DUFFEL_KEY_paid"},
        {id:"aviationstack", role:"enrichment_v2", status: env.AVIATIONSTACK_KEY?"live":"needs_key"},
        {id:"openweather", role:"context_v2", status: env.OPENWEATHER_KEY?"live":"needs_key"},
        {id:"flyday_flyagain", role:"deal_signals", status:"manual_links_no_api"},
        {id:"facebook_ig_threads", role:"promo_signals", status:"no_legal_api_disclosure_only"},
      ],
      unavailable: [
        { id:"google_flights_api", en:"Google Flights has no public API", zh:"Google Flights 冇公開 API" },
        { id:"tripcom_api", en:"Trip.com / Expedia have no public API", zh:"Trip.com / Expedia 冇公開 API" },
        { id:"airline_api", en:"Airline sites expose no public fare API", zh:"航空公司官網冇公開票價 API" },
      ],
      dataAge:"cached_48h",
      counts:{ total: offers.length, exactRoute: main.length, otherDates: onRouteOtherDates.length, altAirports: altAirports.length },
      elapsedMs: Date.now()-t0,
    },
  });
}

function recommendationReasons(best, cheapest, w) {
  const r = [];
  if (best === cheapest) { r.push({ k:"is_cheapest" }); return r; }
  const gap = best.price - cheapest.price;
  const cb = (cheapest.parts||[]).find(x=>x.k==="baggage");
  if (cb) r.push({ k:"baggage_included", bagCost: cb.v });
  if (best.stops!=null && cheapest.stops!=null && best.stops < cheapest.stops)
    r.push({ k:"fewer_stops", from:cheapest.stops, to:best.stops });
  const ba = best.airlineCode && AIRLINES[best.airlineCode];
  const ca = cheapest.airlineCode && AIRLINES[cheapest.airlineCode];
  if (ba && (!ca || ba.rel > ca.rel)) r.push({ k:"airline_direct", airline: ba.n, airlineZh: ba.z });
  if (best.durationMin && cheapest.durationMin && best.durationMin < cheapest.durationMin)
    r.push({ k:"faster", mins: cheapest.durationMin - best.durationMin });
  r.push({ k:"price_gap", gap });
  return r;
}

/* ================================================================
 * Prefs / ground / places / explain
 * ================================================================ */

async function handlePrefs(request, env) {
  const u=new URL(request.url), uid=u.searchParams.get("uid")||"anon";
  if (request.method==="GET") {
    const sv = env.HISTORY ? await env.HISTORY.get("prefs:"+uid,"json") : null;
    return json({ quiz:QUIZ, saved:sv, weights: weightsFrom((sv&&sv.answers)||{}, PROFILES[(sv&&sv.profile)||"balanced"]) });
  }
  const b = await request.json().catch(()=>({}));
  const rec = { profile:b.profile||"balanced", answers:b.answers||{}, savedAt:new Date().toISOString() };
  if (env.HISTORY) await env.HISTORY.put("prefs:"+uid, JSON.stringify(rec));
  return json({ ok:true, weights: weightsFrom(rec.answers, PROFILES[rec.profile]) });
}

async function handleGround(request, env) {
  const u=new URL(request.url), uid=u.searchParams.get("uid")||"anon";
  if (request.method==="GET") return json({ ground: await ground(env,uid) });
  const b = await request.json().catch(()=>({}));
  const cur = await ground(env,uid);
  if (b.code) {
    if (b.remove) delete cur[b.code.toUpperCase()];
    else cur[b.code.toUpperCase()] = { costHKD:Math.max(0,parseInt(b.costHKD||0,10)),
      minutes:Math.max(0,parseInt(b.minutes||0,10)), label:(b.label||"").slice(0,60) };
  }
  if (env.HISTORY) await env.HISTORY.put("ground:"+uid, JSON.stringify(cur));
  return json({ ok:true, ground:cur });
}


/* ================================================================
 * WATCHLIST + TARGET PRICE (Personal Intelligence layer)
 * ================================================================ */
async function handleWatch(request, env) {
  const u=new URL(request.url), uid=u.searchParams.get("uid")||"anon";
  const key="watch:"+uid;
  const cur=(env.HISTORY&&await env.HISTORY.get(key,"json"))||[];
  if(request.method==="GET"){
    // enrich with current cheapest from the cached feed where available
    let feed=null;
    if(env.HISTORY){ feed=await env.HISTORY.get("feed:"+ (u.searchParams.get("origin")||"HKG") +":"+(u.searchParams.get("currency")||"HKD"),"json"); }
    const deals=feed&&feed.deals?feed.deals:[];
    const out=cur.map(w=>{
      const d=deals.find(x=>x.destination===w.destination&&x.origin===w.origin);
      return {...w, currentPrice:d?d.price:null, currentDate:d?d.departDate:null,
        reached: d&&w.target!=null ? d.price<=w.target : false};
    });
    return json({watch:out});
  }
  const b=await request.json().catch(()=>({}));
  if(b.remove){ const nx=cur.filter(w=>!(w.origin===b.origin&&w.destination===b.destination));
    if(env.HISTORY)await env.HISTORY.put(key,JSON.stringify(nx)); return json({ok:true,watch:nx}); }
  if(b.origin&&b.destination){
    const nx=cur.filter(w=>!(w.origin===b.origin&&w.destination===b.destination));
    nx.push({origin:b.origin.toUpperCase(),destination:b.destination.toUpperCase(),
      target:b.target!=null?Math.round(b.target):null,addedAt:new Date().toISOString().slice(0,10)});
    if(nx.length>20)nx.shift();
    if(env.HISTORY)await env.HISTORY.put(key,JSON.stringify(nx));
    return json({ok:true,watch:nx});
  }
  return json({error:"origin and destination required"},400);
}

/* ================================================================
 * PUBLIC HOLIDAYS — live API (Nager.Date, free, keyless) with the
 * static 2026 HK table as offline fallback. Cached 7 days.
 * ================================================================ */
async function getHolidays(env) {
  const country=env.HOLIDAY_COUNTRY||"HK";
  const year=new Date().getUTCFullYear();
  const key="hol:"+country+":"+year;
  if(env.HISTORY){const c=await env.HISTORY.get(key,"json"); if(c)return c;}
  try{
    const r=await fetch("https://date.nager.at/api/v3/PublicHolidays/"+year+"/"+country);
    if(!r.ok)throw new Error("HTTP "+r.status);
    const list=(await r.json()).map(h=>h.date);
    if(list.length){ if(env.HISTORY)await env.HISTORY.put(key,JSON.stringify(list),{expirationTtl:604800}); return list; }
  }catch(e){}
  return HK_HOLIDAYS_2026;
}

/* ================================================================
 * PROMO INTELLIGENCE INGEST
 *  - /api/ingest : airline newsletter emails (via Cloudflare Email
 *    Routing worker or manual POST) → signals store
 *  - RSS + Telegram public channels, configured via env vars:
 *      RSS_FEEDS="https://airline1.com/rss,https://..."
 *      TG_CHANNELS="cathaydeals,hkflightdeals"
 * ================================================================ */
async function handleIngest(request, env) {
  const b=await request.json().catch(()=>({}));
  if(!b.subject&&!b.title) return json({error:"subject or title required"},400);
  const sig={source:b.source||"newsletter",title:(b.subject||b.title).slice(0,180),
    url:b.url||null,ts:Date.now(),body:(b.body||"").slice(0,300)};
  if(env.HISTORY){
    const key="ingested:signals";
    const cur=(await env.HISTORY.get(key,"json"))||[];
    cur.unshift(sig); if(cur.length>50)cur.pop();
    await env.HISTORY.put(key,JSON.stringify(cur));
  }
  return json({ok:true,stored:sig.title});
}

async function monitoredFeeds(env) {
  const out=[];
  const rss=(env.RSS_FEEDS||"").split(",").map(x=>x.trim()).filter(Boolean).slice(0,5);
  const tgs=(env.TG_CHANNELS||"").split(",").map(x=>x.trim()).filter(Boolean).slice(0,5);
  await Promise.all([
    ...rss.map(async u2=>{try{
      const r=await fetch(u2); if(!r.ok)return; const t=await r.text();
      const items=[...t.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/g)].slice(0,5);
      for(const m of items) out.push({source:"rss",title:m[1].trim().slice(0,180),url:m[2].trim(),ts:Date.now()});
    }catch(e){}}),
    ...tgs.map(async ch=>{try{
      const r=await fetch("https://t.me/s/"+ch); if(!r.ok)return; const t=await r.text();
      const items=[...t.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].slice(-4);
      for(const m of items){const txt=m[1].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
        if(txt)out.push({source:"t.me/"+ch,title:txt.slice(0,180),url:"https://t.me/s/"+ch,ts:Date.now()});}
    }catch(e){}}),
  ]);
  return out;
}

async function handlePlaces(request) {
  const t=new URL(request.url).searchParams.get("q")||"";
  if (t.length<2) return json({ places:[] });
  try {
    const r=await fetch("https://autocomplete.travelpayouts.com/places2?locale=en&types[]=city&types[]=airport&types[]=country&term="+encodeURIComponent(t));
    const l=await r.json();
    return json({ places:(l||[]).slice(0,10).map(x=>({
      code:x.code, name:x.name, country:x.country_name, type:x.type,
    })) });
  } catch(e){ return json({ places:[] }); }
}

async function handleExplain(request, env) {
  const b = await request.json().catch(()=>({}));
  const { recommendation:rec, savings, context, lang, answer } = b;
  const zh = lang==="zh";

  // Tiers 3/4: no bookable option — the narration IS the product here.
  if (answer && (answer.kind==="estimate_only" || answer.kind==="action_plan")) {
    let t;
    if (answer.kind==="estimate_only" && answer.estimate) {
      const e=answer.estimate;
      t = zh
        ? "你指定嗰日暫時冇快取票價 — 唔代表冇航班,只係最近冇人搜過。根據呢條線今年嘅 "+e.samples+" 個數據,合理價大約 "+e.typical+",低見 "+e.low+"。建議:照下面連結核實,見到接近 "+e.low+" 至 "+e.typical+" 就可以落手。"
        : "No cached fares for your exact date — that does not mean no flights, only that nobody searched it recently. From "+e.samples+" data points on this route this year, a fair price is about "+e.typical+", as low as "+e.low+". Verify via the links below; anything near "+e.low+"–"+e.typical+" is worth taking.";
    } else {
      t = zh
        ? "呢條線今年完全冇快取數據,連估價都做唔到 — 通常代表航班好少或者要轉機。建議:改用附近大機場再搜一次,或者用國家代碼(例如 JP)搵全國最平入口。"
        : "This route has zero cached data this year — not even an estimate is derivable, which usually means very thin or indirect service. Suggest re-searching from a nearby major airport, or using the country code (e.g. JP) to find the cheapest gateway.";
    }
    return json({ text:t, source:"rules" });
  }

  if (!rec || !rec.best) return json({ text:"", source:"none" });

  const bt=rec.best, ch=rec.cheapest;
  let fb;
  if (rec.sameOption) {
    fb = zh ? "最平嘅選擇同時都係最抵:" + (bt.airlineName||"") + " " + bt.currency + bt.price + "。"
            : "The cheapest option is also the best value: " + (bt.airlineName||"") + " " + bt.currency + bt.price + ".";
  } else {
    fb = zh ? (ch.airlineName||"") + " 最平,收 " + ch.currency + ch.price + ";不過建議揀 " + (bt.airlineName||"") +
              " " + bt.currency + bt.price + ",只係貴 " + Math.abs(rec.priceGap) + " 蚊。"
            : (ch.airlineName||"") + " is cheapest at " + ch.currency + ch.price + ", but " + (bt.airlineName||"") +
              " at " + bt.currency + bt.price + " is recommended for only " + Math.abs(rec.priceGap) + " more.";
  }
  if (savings && savings.length && savings[0].netSaving != null && savings[0].netSaving > 0) {
    const s=savings[0];
    fb += zh ? " 由 " + s.offer.origin + " 出發淨慳 " + s.netSaving + " 蚊。"
             : " Departing " + s.offer.origin + " nets " + s.netSaving + " more in savings.";
  }

  if (!env.GEMINI_API_KEY) return json({ text:fb, source:"rules" });
  try {
    const facts = {
      best:{ airline:bt.airlineName, flight:bt.flightNumber, price:bt.price, currency:bt.currency,
        stops:bt.stops, departTime:bt.departTime, durationMin:bt.durationMin, trueCost:bt.trueCost, detail:bt.detail },
      cheapest:{ airline:ch.airlineName, price:ch.price, stops:ch.stops, detail:ch.detail },
      priceGap:rec.priceGap, reasons:rec.reasons,
      topSaving: savings&&savings[0] ? { origin:savings[0].offer.origin, saving:savings[0].saving,
        groundCost:savings[0].groundCost, netSaving:savings[0].netSaving, groundKnown:savings[0].groundKnown } : null,
      priceContext: context,
      answerKind: answer ? answer.kind : null,
      estimate: answer ? answer.estimate : null,
    };
    const prompt =
      "You are a flight booking advisor. Use ONLY the numbers in this JSON — never invent a price, " +
      "a flight number, or a departure time. Never predict a future sale. " +
      "If topSaving.groundKnown is false, note the traveller must add their own transport cost. " +
      "If answerKind is 'adjusted' or 'alternative_date', state clearly the dates differ from the request. " +
      "If estimate is present, you may cite its typical/low values as expected-price context, always calling it an estimate. " +
      (zh ? "用香港廣東話書面語,80 字以內,純文字,唔好用 markdown。"
          : "Reply in English, under 70 words, plain text, no markdown. ") +
      "Say which flight to book and why in one short paragraph. JSON: " + JSON.stringify(facts);
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key="+env.GEMINI_API_KEY,
      { method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{ maxOutputTokens:260, temperature:0.3 }})});
    const j = await r.json();
    if (!r.ok) throw new Error("gemini");
    const tx = j.candidates&&j.candidates[0]&&j.candidates[0].content&&j.candidates[0].content.parts&&j.candidates[0].content.parts[0]&&j.candidates[0].content.parts[0].text;
    return json({ text:(tx&&tx.trim())||fb, source:"gemini" });
  } catch(e){ return json({ text:fb, source:"rules" }); }
}


/* ================================================================
 * JOURNEY 1 — DEAL DISCOVERY (no destination, no input)
 * "Today's best deals" from every legally accessible source:
 * cached fares scanned year-wide + community promotion signals.
 * Platforms without APIs are disclosed, with verification links.
 * ================================================================ */

const DEAL_WORDS=["error fare","mistake fare","flash sale","promo","promotion","sale","deal","discount","% off","fare drop"];

async function communitySignals(env, origin) {
  const key="signals:"+(origin||"any");
  if (env.HISTORY){ const c=await env.HISTORY.get(key,"json"); if(c) return c; }
  const subs=["TravelDeals","awardtravel","flights"];
  const raw=[];
  await Promise.all(subs.map(async sub=>{
    try{
      const r=await fetch("https://www.reddit.com/r/"+sub+"/new.json?limit=25",
        {headers:{"User-Agent":"flight-deal-assistant/1.0 (personal)"}});
      if(!r.ok)return;
      const d=await r.json();
      for(const c of (d.data&&d.data.children)||[])
        raw.push({source:"r/"+sub,title:c.data.title,url:"https://reddit.com"+c.data.permalink,ts:c.data.created_utc*1000});
    }catch(e){}
  }));
  const fp=t=>t.toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim().slice(0,70);
  const seen=new Map();
  for(const x of raw){
    const t=x.title.toLowerCase(); let score=0;
    for(const w of DEAL_WORDS) if(t.includes(w)) score+=2;
    if(t.includes("error fare")||t.includes("mistake fare")) score+=5;
    if(origin&&t.includes(origin.toLowerCase())) score+=4;
    if(score<4) continue;
    const k=fp(x.title); const prev=seen.get(k);
    if(!prev) seen.set(k,{...x,score,alsoSeenIn:[]});
    else if(prev.source!==x.source&&!prev.alsoSeenIn.includes(x.source)){prev.alsoSeenIn.push(x.source);prev.score+=1;}
  }
  let out=[...seen.values()];
  try{ const mon=await monitoredFeeds(env); out=out.concat(mon.map(m=>({...m,score:6}))); }catch(e){}
  if(env.HISTORY){ const ing=(await env.HISTORY.get("ingested:signals","json"))||[];
    out=out.concat(ing.map(m=>({...m,score:8,source:m.source||"newsletter"}))); }
  out=out.sort((a,b)=>b.score-a.score||b.ts-a.ts).slice(0,14);
  if(env.HISTORY) await env.HISTORY.put(key,JSON.stringify(out),{expirationTtl:10800});
  return out;
}

async function handleFeed(request, env) {
  const p=new URL(request.url).searchParams;
  const origin=(p.get("origin")||"HKG").toUpperCase().trim();
  const currency=(p.get("currency")||"HKD").toUpperCase();
  if(!env.TRAVELPAYOUTS_TOKEN) return json({error:"TRAVELPAYOUTS_TOKEN not configured"},500);

  const cacheKey="feed:"+origin+":"+currency;
  if(env.HISTORY){const c=await env.HISTORY.get(cacheKey,"json"); if(c) return json({...c,cached:true});}

  const nm=await names(env);
  let fares=[], fareErr=null;
  try{
    const b=await tp(env,"/v2/prices/latest",{
      origin, currency:currency.toLowerCase(), period_type:"year",
      one_way:"false", page:1, limit:100, sorting:"price",
      show_to_affiliates:"true", market:env.DEFAULT_MARKET||"hk"});
    fares=(b.data||[]).map(d=>makeOffer({
      origin:d.origin||origin, destination:d.destination,
      departDate:d.depart_date, returnDate:d.return_date||null,
      price:d.value, currency, stops:d.number_of_changes,
      airlineCode:d.gate||null, airlineName:nm[d.gate]||d.gate||null,
      via:"any_date", foundVia:"deal_scan"}));
  }catch(e){ fareErr=e.message; }

  // cheapest per destination, then deal-score against recorded history when we have it
  const byDest=new Map();
  for(const o of fares){
    if(o.price==null||!o.destination) continue;
    const cur=byDest.get(o.destination);
    if(!cur||o.price<cur.price) byDest.set(o.destination,o);
  }
  const deals=[];
  for(const o of byDest.values()){
    let score=null;
    if(env.HISTORY){
      const h=await env.HISTORY.get("hist:"+origin+"-"+o.destination,"json");
      const pts=(h&&h.points?h.points:[]).map(x=>x.price).filter(x=>x!=null);
      if(pts.length>=10){
        const below=pts.filter(x=>x<o.price).length;
        const pct=Math.round(below/pts.length*100);
        score={percentile:pct,samples:pts.length,
          tier:pct<=15?"hot":(pct<=35?"good":(pct>=75?"high":"typical"))};
      }
    }
    deals.push({...o,dealScore:score,channels:channelsFor(o,env.TP_MARKER,1)});
  }
  deals.sort((a,b)=>a.price-b.price);

  // Alternative-origin scan: same year-wide sweep from nearby departure
  // cities, compared per destination. This is what powers cards like
  // "Guangzhou departures saving HK$800+" — a computed fact, not a slogan.
  const ALT_ORIGINS = origin==="HKG" ? ["CAN","SZX"] : [];
  const altDeals=[];
  for (const ao of ALT_ORIGINS){
    try{
      const ab=await tp(env,"/v2/prices/latest",{
        origin:ao, currency:currency.toLowerCase(), period_type:"year",
        one_way:"false", page:1, limit:60, sorting:"price",
        show_to_affiliates:"true", market:env.DEFAULT_MARKET||"hk"});
      const altBy=new Map();
      for(const d of (ab.data||[])){
        if(d.value==null||!d.destination) continue;
        const cur=altBy.get(d.destination);
        if(!cur||d.value<cur.value) altBy.set(d.destination,d);
      }
      for(const [dest,d] of altBy){
        const home=byDest.get(dest);
        if(!home) continue;
        const saving=home.price-d.value;
        if(saving>=250){
          altDeals.push({...makeOffer({
            origin:ao,destination:dest,departDate:d.depart_date,
            returnDate:d.return_date||null,price:d.value,currency,
            stops:d.number_of_changes,airlineCode:d.gate||null,
            airlineName:nm[d.gate]||d.gate||null,via:"other_origin",foundVia:"alt_origin_scan"}),
            homePrice:home.price, saving,
            channels:channelsFor({origin:ao,destination:dest,departDate:d.depart_date,
              returnDate:d.return_date||null,airlineCode:d.gate||null},env.TP_MARKER,1)});
        }
      }
    }catch(e){}
  }
  altDeals.sort((a,b)=>b.saving-a.saving);

  const signals=await communitySignals(env,origin);
  const top=deals[0]||null;
  const payload={
    origin,currency,
    verdict: top?{destination:top.destination,price:top.price,currency,departDate:top.departDate,returnDate:top.returnDate,airlineName:top.airlineName}:null,
    deals:deals.slice(0,20),
    altDeals:altDeals.slice(0,6),
    signals,
    fareError:fareErr,
    disclosure:"integrated_legal_sources_only",
    refreshedAt:new Date().toISOString(),
  };
  if(env.HISTORY) await env.HISTORY.put(cacheKey,JSON.stringify(payload),{expirationTtl:3600*3});
  return json(payload);
}

/* ================================================================
 * JOURNEY 3 — TRAVEL INSPIRATION (budget + weekend, no destination)
 * "HK$2,000, Friday evening out, back Sunday or Monday — where?"
 * ================================================================ */

// HK public holidays 2026 — static reference list; verify near travel.
const HK_HOLIDAYS_2026=["2026-01-01","2026-02-17","2026-02-18","2026-02-19",
"2026-04-03","2026-04-04","2026-04-06","2026-05-01","2026-05-25","2026-06-19",
"2026-07-01","2026-09-26","2026-10-01","2026-10-19","2026-12-25","2026-12-26"];

function weekday(iso){ return new Date(iso+"T00:00:00Z").getUTCDay(); } // 0=Sun..6=Sat
function tripDays(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }
let HOLIDAYS_ACTIVE=HK_HOLIDAYS_2026;
function nearHoliday(iso){
  for(const h of HOLIDAYS_ACTIVE){
    const d=Math.abs(Math.round((new Date(iso)-new Date(h))/86400000));
    if(d<=1) return h;
  }
  return null;
}

async function handleInspire(request, env) {
  HOLIDAYS_ACTIVE=await getHolidays(env);
  const p=new URL(request.url).searchParams;
  const origin=(p.get("origin")||"HKG").toUpperCase().trim();
  const currency=(p.get("currency")||"HKD").toUpperCase();
  const budget=Math.max(0,parseInt(p.get("budget")||"2000",10));
  const weekendOnly=p.get("weekend")!=="0";
  if(!env.TRAVELPAYOUTS_TOKEN) return json({error:"TRAVELPAYOUTS_TOKEN not configured"},500);

  const nm=await names(env);
  let fares=[];
  try{
    const b=await tp(env,"/v2/prices/latest",{
      origin, currency:currency.toLowerCase(), period_type:"year",
      one_way:"false", page:1, limit:300, sorting:"price",
      show_to_affiliates:"true", market:env.DEFAULT_MARKET||"hk"});
    fares=(b.data||[]).map(d=>makeOffer({
      origin:d.origin||origin, destination:d.destination,
      departDate:d.depart_date, returnDate:d.return_date||null,
      price:d.value, currency, stops:d.number_of_changes,
      airlineCode:d.gate||null, airlineName:nm[d.gate]||d.gate||null,
      via:"any_date", foundVia:"inspiration_scan"}));
  }catch(e){ return json({error:e.message},502); }

  const withinBudget=fares.filter(o=>o.price!=null&&o.price<=budget&&o.departDate&&o.returnDate);
  const overBudgetCount=fares.filter(o=>o.price!=null&&o.price>budget).length;

  const annotated=withinBudget.map(o=>{
    const dw=weekday(o.departDate), rw=weekday(o.returnDate);
    const days=tripDays(o.departDate,o.returnDate);
    const weekendFit=(dw===5||dw===6)&&(rw===0||rw===1)&&days>=2&&days<=4;
    const hol=nearHoliday(o.departDate)||nearHoliday(o.returnDate);
    return {...o,weekendFit,holiday:hol,days};
  });

  const pool=weekendOnly?annotated.filter(o=>o.weekendFit||o.holiday):annotated;
  const excludedByWeekend=annotated.length-pool.length;

  // best per destination
  const byDest=new Map();
  for(const o of pool){
    const cur=byDest.get(o.destination);
    if(!cur||o.price<cur.price) byDest.set(o.destination,o);
  }
  const ideas=[...byDest.values()]
    .map(o=>({...o,channels:channelsFor(o,env.TP_MARKER,1)}))
    .sort((a,b)=>a.price-b.price);

  const top=ideas[0]||null;
  return json({
    origin,currency,budget,weekendOnly,
    verdict: top?{destination:top.destination,price:top.price,departDate:top.departDate,
      returnDate:top.returnDate,days:top.days,weekendFit:top.weekendFit,holiday:top.holiday,
      airlineName:top.airlineName,budgetLeft:budget-top.price}:null,
    ideas:ideas.slice(0,15),
    stats:{scanned:fares.length,withinBudget:withinBudget.length,
      overBudget:overBudgetCount,excludedByWeekendFilter:excludedByWeekend},
    holidaysNote:"hk_holidays_2026_static_reference_verify_before_travel",
  });
}

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    try {
      if (p==="/api/search") return await handleSearch(request, env);
      if (p==="/api/feed") return await handleFeed(request, env);
      if (p==="/api/watch") return await handleWatch(request, env);
      if (p==="/api/ingest" && request.method==="POST") return await handleIngest(request, env);
      if (p==="/api/inspire") return await handleInspire(request, env);
      if (p==="/api/prefs") return await handlePrefs(request, env);
      if (p==="/api/ground") return await handleGround(request, env);
      if (p==="/api/places") return await handlePlaces(request);
      if (p==="/api/explain" && request.method==="POST") return await handleExplain(request, env);
      if (p==="/manifest.json") return new Response(JSON.stringify({
        name:"Flight Deal", short_name:"FlightDeal", start_url:"/", display:"standalone",
        background_color:"#0d1117", theme_color:"#0d1117", icons:[] }),{headers:{"Content-Type":"application/json"}});
      if (p==="/sw.js") return new Response(SW,{headers:{"Content-Type":"application/javascript"}});
      return new Response(HTML,{headers:{"Content-Type":"text/html;charset=utf-8"}});
    } catch(e){ return json({ error:e.message },500); }
  },
};

const SW=["self.addEventListener('install',function(e){self.skipWaiting()});",
"self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});",
"self.addEventListener('fetch',function(e){if(e.request.method!=='GET')return;",
"if(new URL(e.request.url).pathname.indexOf('/api/')===0)return;",
"e.respondWith(fetch(e.request).catch(function(){return caches.match(e.request)}))});"].join("\n");

/* ================================================================
 * UI — flights first
 * ================================================================ */

const HTML = `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0d1117"><meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.json"><title>Flight Deal</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0d1117;--card:#161b22;--card2:#1c2330;--line:#262d3a;--tx:#e6edf3;--dim:#8b949e;
--acc:#3fb950;--acc2:#2ea043;--hot:#f85149;--warm:#d29922;--cool:#58a6ff;--vio:#a371f7;
--f:'Inter','Noto Sans TC',system-ui,-apple-system,sans-serif}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--tx);font-family:var(--f);font-size:15px;line-height:1.5}
.wrap{max-width:900px;margin:0 auto;padding:12px 12px 70px}
header{display:flex;align-items:center;justify-content:space-between;padding:4px 0 10px}
.logo{font-weight:700;font-size:1rem}.logo span{color:var(--acc)}
.lang{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.lang button{background:none;border:none;color:var(--dim);padding:5px 10px;font-size:.76rem;cursor:pointer;font-family:var(--f)}
.lang button.on{background:var(--card2);color:var(--tx);font-weight:600}
.jt{position:fixed;bottom:0;left:0;right:0;z-index:90;display:grid;grid-template-columns:repeat(4,1fr);gap:0;background:rgba(13,17,23,.97);border-top:1px solid var(--line);padding:6px 8px calc(8px + env(safe-area-inset-bottom))}
.jt button{background:none;border:none;color:var(--dim);padding:7px 2px;font-size:.68rem;cursor:pointer;font-family:var(--f);display:flex;flex-direction:column;align-items:center;gap:2px}
.jt button.on{color:var(--acc);font-weight:600}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.chips button{background:var(--bg);border:1px solid var(--line);color:var(--dim);border-radius:18px;padding:8px 14px;font-size:.78rem;cursor:pointer;font-family:var(--f)}
.chips button.on{border-color:var(--acc);color:var(--acc);background:var(--card2);font-weight:600}
.jt .ji{font-size:1.15rem}
.vd{background:linear-gradient(180deg,#12261a,#161b22);border:1px solid var(--acc);border-radius:12px;padding:15px;margin-bottom:12px}
.vd .vl{font-size:.62rem;color:var(--acc);letter-spacing:.14em;text-transform:uppercase;font-weight:700;margin-bottom:7px}
.vd .vb{font-size:1.05rem;font-weight:700;line-height:1.5}
.vd .vs{font-size:.78rem;color:var(--dim);margin-top:5px}
.hb{font-size:.63rem;border-radius:4px;padding:2px 7px;font-weight:600;background:#33240f;color:#f0a742}
.wb{font-size:.63rem;border-radius:4px;padding:2px 7px;font-weight:600;background:#0f2a33;color:#58a6ff}
/* search */
.sb{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px}
.tt{display:flex;gap:6px;margin-bottom:9px}
.tt button{flex:1;background:var(--bg);border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:8px;font-size:.78rem;cursor:pointer;font-family:var(--f)}
.tt button.on{border-color:var(--acc);color:var(--acc);background:var(--card2);font-weight:600}
.rw{display:grid;gap:8px;margin-bottom:8px}.c2{grid-template-columns:1fr 1fr}.c3{grid-template-columns:1fr 1fr 1fr}
label{display:block;font-size:.66rem;color:var(--dim);margin-bottom:4px}
input,select{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--tx);padding:10px;font-size:16px;font-family:var(--f);appearance:none}
input:focus,select:focus{outline:none;border-color:var(--acc)}
.ac{position:relative}
.acl{position:absolute;top:100%;left:0;right:0;z-index:50;background:var(--card2);border:1px solid var(--line);border-radius:8px;margin-top:4px;max-height:210px;overflow:auto;display:none}
.acl.on{display:block}
.aci{padding:9px 10px;cursor:pointer;font-size:.84rem;border-bottom:1px solid var(--line)}
.aci b{color:var(--acc)}.aci small{color:var(--dim);display:block;font-size:.7rem}
.opt{display:flex;gap:12px;margin:6px 0 10px;font-size:.78rem;color:var(--dim)}
.opt label{display:flex;align-items:center;gap:6px;margin:0;font-size:.78rem;cursor:pointer}
.opt input{width:auto;padding:0}
.go{width:100%;background:var(--acc);color:#04260d;border:none;border-radius:9px;padding:13px;font-size:.92rem;font-weight:700;cursor:pointer;font-family:var(--f)}
.go:disabled{opacity:.5}
.st{font-size:.8rem;color:var(--warm);margin:8px 2px;min-height:1.1em}.st.e{color:var(--hot)}
/* headings */
.h{font-size:.68rem;color:var(--dim);letter-spacing:.14em;text-transform:uppercase;margin:16px 0 8px;font-weight:600}
/* recommendation */
.rec{background:linear-gradient(180deg,#12261a,#161b22);border:1px solid var(--acc);border-radius:12px;padding:14px;margin-bottom:10px}
.rec .rl{font-size:.64rem;color:var(--acc);letter-spacing:.12em;text-transform:uppercase;font-weight:700;margin-bottom:8px}
.rec .why{font-size:.84rem;color:var(--dim);margin-top:9px;line-height:1.6}
.rec .why b{color:var(--tx);font-weight:500}
/* flight card */
.f{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:8px}
.f.top{border-color:var(--acc)}
.fh{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:9px}
.al{font-weight:600;font-size:.95rem}
.fn{font-size:.72rem;color:var(--dim);font-family:ui-monospace,monospace;margin-top:1px}
.pr{text-align:right;white-space:nowrap}
.pr .v{font-size:1.3rem;font-weight:700;letter-spacing:-.02em}
.pr .c{font-size:.66rem;color:var(--dim)}
.tl{display:flex;align-items:center;gap:8px;margin:10px 0}
.tl .t{font-size:1rem;font-weight:600;font-variant-numeric:tabular-nums}
.tl .ap{font-size:.68rem;color:var(--dim)}
.tl .mid{flex:1;text-align:center;position:relative}
.tl .mid .ln{height:1px;background:var(--line);position:relative;margin:6px 0}
.tl .mid .ln:after{content:'';position:absolute;right:0;top:-2px;width:5px;height:5px;border-radius:50%;background:var(--dim)}
.tl .mid .d{font-size:.68rem;color:var(--dim)}
.badges{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.bg{font-size:.64rem;border-radius:4px;padding:2px 7px;font-weight:600}
.bg.direct{background:#0f2f1a;color:#3fb950}.bg.stop{background:#2b2313;color:#d29922}
.bg.po{background:#2a1f33;color:#c08fe8}.bg.dt{background:#1a2733;color:#58a6ff}
.bg.cheap{background:#0f2f1a;color:#3fb950}
.dates{font-size:.76rem;color:var(--dim);margin-bottom:8px}
.bk{border-top:1px solid var(--line);padding-top:9px;margin-top:9px}
.bkl{font-size:.62rem;color:var(--dim);margin-bottom:6px}
.bw{display:flex;gap:5px;flex-wrap:wrap}
.b{text-decoration:none;border-radius:7px;padding:7px 12px;font-size:.75rem;font-weight:600;border:1px solid var(--line);color:var(--dim);background:var(--bg);display:inline-block}
.b.of{background:var(--acc);color:#04260d;border-color:var(--acc)}
.b.ota{border-color:#2c4a6e;color:var(--cool)}
.b.vf{opacity:.75;font-weight:500}
/* savings */
.sv{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warm);border-radius:0 10px 10px 0;padding:12px;margin-bottom:8px}
.sv .rt{font-weight:600;font-size:.92rem}
.sv .amt{font-size:1.05rem;font-weight:700;color:var(--acc);margin:5px 0}
.sv .br{font-size:.74rem;color:var(--dim);font-family:ui-monospace,monospace;line-height:1.7}
.sv .warn{color:var(--warm)}
/* context */
.ctx{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px;font-size:.84rem}
.ctx .v{font-weight:700}
.ctx .v.good_time{color:var(--acc)}.ctx .v.consider_waiting{color:var(--warm)}.ctx .v.typical{color:var(--dim)}
/* ai */
.ai{background:linear-gradient(180deg,#1a1430,#161b22);border:1px solid #2f2450;border-left:3px solid var(--vio);border-radius:0 10px 10px 0;padding:12px;margin-bottom:10px;font-size:.86rem;line-height:1.6}
.ai .l{font-size:.62rem;color:var(--vio);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:5px}
/* trust — collapsed, bottom */
details.tr{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-top:18px}
details.tr summary{padding:12px;cursor:pointer;font-size:.8rem;color:var(--dim);list-style:none}
details.tr summary::-webkit-details-marker{display:none}
details.tr summary:before{content:'▸ ';color:var(--dim)}
details.tr[open] summary:before{content:'▾ '}
.trb{padding:0 12px 12px;font-size:.76rem;color:var(--dim);line-height:1.8}
.trb .ok{color:var(--acc)}.trb .no{color:var(--hot)}
/* settings */
.set{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:10px}
.pf{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px}
.pf button{background:var(--bg);border:1px solid var(--line);color:var(--dim);border-radius:7px;padding:8px 3px;font-size:.72rem;cursor:pointer;font-family:var(--f)}
.pf button.on{border-color:var(--acc);color:var(--acc);font-weight:600}
.q{border-top:1px solid var(--line);padding-top:9px;margin-top:9px}
.qt{font-size:.82rem;margin-bottom:7px}
.qb{display:flex;gap:6px}
.qb button{flex:1;background:var(--bg);border:1px solid var(--line);color:var(--dim);border-radius:7px;padding:8px;font-size:.78rem;cursor:pointer;font-family:var(--f)}
.qb button.on{border-color:var(--acc);color:var(--acc);font-weight:600}
.empty{text-align:center;padding:28px 16px;color:var(--dim);font-size:.86rem}
.fbw{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:12px}
.hidden{display:none}
@media(max-width:560px){.c3{grid-template-columns:1fr}.fh{flex-direction:column}.pr{text-align:left}}
</style></head><body>
<div class="wrap">
<header><div class="logo">Flight<span>Deal</span></div>
<div class="lang"><button id="lz" class="on">繁中</button><button id="le">EN</button></div></header>

<div class="jt">
  <button class="on" data-j="j1"><span class="ji">🔥</span><span data-i="j1">發現</span></button>
  <button data-j="j2"><span class="ji">🎯</span><span data-i="j2">研究</span></button>
  <button data-j="j3"><span class="ji">🎲</span><span data-i="j3">靈感</span></button>
  <button data-j="j4"><span class="ji">⭐</span><span data-i="j4">關注</span></button>
</div>

<!-- ============ JOURNEY 1: DEAL DISCOVERY — zero input ============ -->
<section id="j1">
  <div class="rw c2" style="margin-bottom:8px">
    <div><label data-i="f_origin">出發地</label><input id="f-o" value="HKG" maxlength="3"></div>
    <div><label data-i="cur">貨幣</label><select id="f-cu"><option>HKD</option><option>TWD</option><option>USD</option><option>JPY</option><option>SGD</option></select></div>
  </div>
  <div class="st" id="f-st"></div>
  <div id="f-out"></div>
</section>

<!-- ============ JOURNEY 2: DESTINATION SEARCH ============ -->
<section id="j2" class="hidden">
<div class="sb">
  <div class="tt"><button class="on" data-t="return" data-i="ret">來回</button><button data-t="oneway" data-i="one">單程</button></div>
  <div class="rw c2">
    <div class="ac"><label data-i="from">出發</label><input id="o" placeholder="HKG" autocomplete="off"><div class="acl" id="ao"></div></div>
    <div class="ac"><label data-i="to">目的地</label><input id="d" placeholder="TPE" autocomplete="off"><div class="acl" id="ad"></div></div>
  </div>
  <div class="rw c2" id="dateRow">
    <div><label data-i="dep">去程</label><input id="dd" type="date"></div>
    <div id="rw"><label data-i="retd">回程</label><input id="rd" type="date"></div>
  </div>
  <div class="rw c3">
    <div><label data-i="cur">貨幣</label><select id="cu"><option>HKD</option><option>TWD</option><option>USD</option><option>JPY</option><option>SGD</option><option>EUR</option><option>GBP</option></select></div>
    <div><label data-i="pax">人數</label><select id="px"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
    <div><label data-i="rad">附近機場</label><select id="ds"><option value="0" data-i="off">唔使</option><option value="400">400 km</option><option value="600" selected>600 km</option><option value="1000">1000 km</option></select></div>
  </div>
  <div class="chips" id="dchips">
    <button data-dm="exact" class="on" data-i="c_exact">指定日期</button>
    <button data-dm="any" data-i="c_any">唔限日期</button>
    <button data-dm="month" data-i="c_month">今個月</button>
    <button data-dm="weekend" data-i="c_wknd">週末</button>
  </div>
  <input type="checkbox" id="ad" style="display:none">
  <div class="opt" id="dateOpts"><label><input type="checkbox" id="fx" checked> <span data-i="flex">前後 3 日都睇埋</span></label>
  <label><input type="checkbox" id="bg" checked> <span data-i="bag">要寄艙行李</span></label></div>
  <button class="go" id="go" data-i="search">搵機票</button>
</div>
<div class="st" id="st"></div>
<div id="out"></div>
</section>

<!-- ============ JOURNEY 3: TRAVEL INSPIRATION ============ -->
<section id="j3" class="hidden">
  <div class="sb">
    <div class="rw c2">
      <div><label data-i="f_origin">出發地</label><input id="i-o" value="HKG" maxlength="3"></div>
      <div><label data-i="i_budget">預算(來回機票)</label><input id="i-b" type="number" value="2000" min="100" step="100"></div>
    </div>
    <div class="rw c2">
      <div><label data-i="cur">貨幣</label><select id="i-cu"><option>HKD</option><option>TWD</option><option>USD</option><option>JPY</option><option>SGD</option></select></div>
      <div style="display:flex;align-items:flex-end;padding-bottom:2px"><label style="display:flex;align-items:center;gap:7px;margin:0;font-size:.8rem;cursor:pointer"><input type="checkbox" id="i-w" checked style="width:auto"> <span data-i="i_weekend">淨係睇週末 / 假期</span></label></div>
    </div>
    <button class="go" id="i-go" data-i="i_go">話我知去邊好</button>
  </div>
  <div class="st" id="i-st"></div>
  <div id="i-out"></div>
</section>

<section id="j4" class="hidden">
  <div class="st" id="w-st"></div>
  <div id="w-out"></div>
</section>

<details class="set" id="setbox"><summary style="cursor:pointer;font-size:.8rem;color:var(--dim);list-style:none" data-i="settings">⚙︎ 我嘅取向</summary>
<div style="padding-top:10px">
  <div class="pf">
    <button data-p="backpacker" data-i="p1">背包客</button>
    <button data-p="balanced" class="on" data-i="p2">平衡</button>
    <button data-p="family" data-i="p3">家庭</button>
    <button data-p="business" data-i="p4">公幹</button>
  </div>
  <div id="qz"></div>
  <div class="q"><div class="qt" data-i="gtitle">附近機場交通成本(自己填)</div>
    <div class="rw c3">
      <div><input id="gc" placeholder="SZX" maxlength="3"></div>
      <div><input id="gm" type="number" placeholder="HK$95"></div>
      <div><input id="gt" type="number" placeholder="150 min"></div>
    </div>
    <button class="go" style="padding:9px;font-size:.8rem" id="ga" data-i="gadd">加入</button>
    <div id="gl" style="margin-top:8px"></div>
  </div>
</div></details>
</div>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var UID=(function(){try{var k=localStorage.getItem('fd_uid');if(!k){k='u'+Math.random().toString(36).slice(2,9);localStorage.setItem('fd_uid',k)}return k}catch(e){return'anon'}})();
var L={zh:{
 j1:'今日筍盤',j2:'目的地研究',j3:'去邊好',
 f_origin:'出發地',i_budget:'預算(來回機票)',i_weekend:'淨係睇週末 / 假期',i_go:'話我知去邊好',
 f_loading:'搵緊今日最抵…',f_verdict:'🔥 今日必知',f_deals:'🌏 邊度最平',f_signals:'🎉 社群報料',
 f_drops:'📉 平過平時',f_direct:'✈ 直航筍盤',f_alt:'🚄 隔籬機場出發更平',f_alt_line:'由 {o} 出發平 {s}(HKG 價 {h})',f_from:'低至',
 f_sig_note:'以下係社群報料,唔係預測。冇 API 嘅平台(Google Flights / Trip.com 等)無法直接讀取,只能提供連結俾你自己核實。',
 f_none:'暫時未搵到快取平價。',
 i_verdict:'建議',i_ideas:'預算內嘅選擇',i_none:'預算內搵唔到合適嘅週末航班。試下加大預算,或者取消「淨係睇週末」。',
 i_line:'{d} · {p} · 仲剩 {left} 使',i_days:'{n} 日',
 i_stats:'掃描咗 {s} 條航線 · {w} 個喺預算內 · {e} 個唔啱週末被剔走',
 hol:'假期',wknd:'週末',
 a_title:'結論',a_go:'去邊最抵',a_buy:'點買最抵',a_when:'應唔應該買',
 a_exact:'照你指定日期',a_adjusted:'⚠️ 日期同你指定嘅唔同',a_altair:'⚠️ 建議改用另一個機場',
 a_est_line:'預計合理價 {t}(低見 {lo},根據 {n} 個數據)',
 a_est_only:'你指定嗰日冇快取價 — 唔等於冇航班。',
 a_plan:'呢條線今年冇任何快取數據。建議改用附近大機場,或者用國家代碼(如 JP)搵全國最平入口。',
 a_now:'✅ 而家買 — 喺你紀錄嘅第 {p} 百分位',a_wait:'⏳ 可以等 — 高過平時',a_nohist:'📊 未有足夠歷史,用估價做參考',
 a_verify:'落單前核實:',a_alts:'或者考慮:',
 c_exact:'指定日期',c_any:'唔限日期',c_month:'今個月',c_wknd:'週末',
 w_add:'關注呢條線',w_added:'已加入關注',w_none:'未有關注航線。喺研究結果撳「⭐ 關注」就會出現喺度。',w_reached:'到咗你目標價!',w_target:'目標價',w_now:'而家',j4:'關注',
 vd_go:'去研究呢條線 →',
 ret:'來回',one:'單程',from:'出發',to:'目的地',dep:'去程',retd:'回程',cur:'貨幣',pax:'人數',
 rad:'附近機場',off:'唔使',flex:'前後 3 日都睇埋',bag:'要寄艙行李',anyd:'唔限日期 · 搵全年最平',search:'搵機票',settings:'⚙︎ 我嘅取向',
 place_country:'國家',place_city:'城市',place_airport:'機場',any_date:'搵到嘅日期',
 p1:'背包客',p2:'平衡',p3:'家庭',p4:'公幹',gtitle:'附近機場交通成本(自己填)',gadd:'加入',
 searching:'搵緊…',
 h_rec:'建議',h_res:'航班選擇',h_sav:'仲有更平嘅方法',h_ctx:'價錢參考',h_trust:'資料來源',
 direct:'直航',stops:'轉 {n} 次',price_only:'只有票價',other_date:'另一日期',cheapest:'最平',lcc:'廉航',
 bagline:'連寄艙行李約 {n}(估計)',rec_bag:'包咗寄艙行李,廉航要另加約 {n}',
 book_official:'官網訂票',book_ota:'旅行社訂票',verify:'比價',
 dur:'{h}小時{m}分',
 rec_cheapest:'呢個亦都係最平嘅選擇。',
 rec_gap:'貴 {n} 蚊',
 rec_fewer:'少轉一次機',rec_direct_air:'可以直接喺 {a} 官網訂,改期取消都方便',rec_faster:'快 {n} 分鐘',
 sv_from:'{o} 出發',sv_to:'飛 {d}',sv_date:'改期去 {d}',
 sv_save:'平 {n}',sv_ground:'交通費 {n}',sv_net:'淨慳 {n}',
 sv_unknown:'⚠️ 未填交通費 — 去下面設定填一次先算得準',
 ctx_good_time:'而家買抵',ctx_consider_waiting:'可以再等等',ctx_typical:'價錢普通',
 ctx_line:'現價喺你過去 {n} 日紀錄嘅第 {p} 百分位(最低 {lo})',
 no_res:'呢條線暫時搵唔到快取票價。可以直接去下面呢幾個網搵:',
 not_exact:'⚠️ 搵唔到你指定日期嘅票價,以下係最接近嘅選擇。',
 t_sources:'查咗:',t_no:'查唔到:',t_age:'票價來自過去 48 小時嘅搜尋快取,唔係即時報價,落單前請自行核對。',
 t_counts:'合共 {n} 個結果 · {ms}ms',
 yes:'肯',no:'唔肯'
},en:{
 j1:"Today's deals",j2:'Research a trip',j3:'Where to go',
 f_origin:'From',i_budget:'Budget (round trip)',i_weekend:'Weekends / holidays only',i_go:'Tell me where to go',
 f_loading:'Finding today\u2019s best…',f_verdict:'🔥 Know today',f_deals:'🌏 Cheapest anywhere',f_signals:'🎉 Community signals',
 f_drops:'📉 Unusually cheap',f_direct:'✈ Direct-flight deals',f_alt:'🚄 Cheaper from a nearby airport',f_alt_line:'From {o}: {s} cheaper (HKG price {h})',f_from:'from',
 f_sig_note:'These are community reports, not forecasts. Platforms without APIs (Google Flights, Trip.com, etc.) cannot be read directly — links are provided so you can verify yourself.',
 f_none:'No cached deals found right now.',
 i_verdict:'Suggestion',i_ideas:'Options within budget',i_none:'Nothing fits this budget on a weekend. Raise the budget or untick weekends-only.',
 i_line:'{d} · {p} · {left} left over',i_days:'{n} days',
 i_stats:'Scanned {s} routes · {w} within budget · {e} filtered out by weekend rule',
 hol:'Holiday',wknd:'Weekend',
 a_title:'The answer',a_go:'Best option',a_buy:'How to book',a_when:'Buy now?',
 a_exact:'On your requested dates',a_adjusted:'⚠️ Dates differ from your request',a_altair:'⚠️ Different airport suggested',
 a_est_line:'Fair price about {t} (as low as {lo}, from {n} data points)',
 a_est_only:'No cached fare for your exact date — that does not mean no flights.',
 a_plan:'Zero cached data on this route this year. Try a nearby major airport, or a country code (e.g. JP) to find the cheapest gateway.',
 a_now:'✅ Buy now — {p}th percentile of your history',a_wait:'⏳ Can wait — above the usual range',a_nohist:'📊 Not enough history; using the estimate as reference',
 a_verify:'Verify before paying:',a_alts:'Or consider:',
 c_exact:'Exact dates',c_any:'Anytime',c_month:'This month',c_wknd:'Weekend',
 w_add:'Watch this route',w_added:'Watching',w_none:'No watched routes yet. Tap ⭐ Watch on any research result.',w_reached:'Hit your target!',w_target:'Target',w_now:'Now',j4:'Watchlist',
 vd_go:'Research this route →',
 ret:'Round trip',one:'One way',from:'From',to:'To',dep:'Depart',retd:'Return',cur:'Currency',pax:'Travellers',
 rad:'Nearby airports',off:'Off',flex:'Include ±3 days',bag:'Need checked bag',anyd:'Any date · find cheapest all year',search:'Find flights',settings:'⚙︎ My preferences',
 place_country:'Country',place_city:'City',place_airport:'Airport',any_date:'Found date',
 p1:'Backpacker',p2:'Balanced',p3:'Family',p4:'Business',gtitle:'Ground transport cost (your own)',gadd:'Add',
 searching:'Searching…',
 h_rec:'Recommended',h_res:'Flight options',h_sav:'Cheaper ways to do this',h_ctx:'Price context',h_trust:'Sources',
 direct:'Direct',stops:'{n} stop',price_only:'Price only',other_date:'Other date',cheapest:'Cheapest',lcc:'Low-cost',
 bagline:'about {n} with checked bag (estimate)',rec_bag:'baggage included; the LCC adds about {n}',
 book_official:'Book direct',book_ota:'Book via agency',verify:'Compare',
 dur:'{h}h {m}m',
 rec_cheapest:'This is also the cheapest option.',
 rec_gap:'{n} more',
 rec_fewer:'one fewer stop',rec_direct_air:'bookable direct with {a}, easier changes and refunds',rec_faster:'{n} min faster',
 sv_from:'Depart {o}',sv_to:'Arrive {d}',sv_date:'Move to {d}',
 sv_save:'Save {n}',sv_ground:'Transport {n}',sv_net:'Net saving {n}',
 sv_unknown:'⚠️ Your transport cost is not set — add it below for an accurate figure',
 ctx_good_time:'Good time to book',ctx_consider_waiting:'Consider waiting',ctx_typical:'Typical price',
 ctx_line:'At the {p}th percentile of your last {n} days (lowest {lo})',
 no_res:'No cached fares found for this route right now. Try these directly:',
 not_exact:'⚠️ No fares for your exact dates — showing the closest options.',
 t_sources:'Checked:',t_no:'Not available:',t_age:'Fares come from cached searches in the last 48h, not live quotes. Verify before paying.',
 t_counts:'{n} results total · {ms}ms',
 yes:'Yes',no:'No'
}};
var lang='zh',trip='return',prof='balanced',ans={},QZ=[],last=null;
function T(k,v){var s=(L[lang]&&L[lang][k])||k;if(v)for(var x in v)s=s.split('{'+x+'}').join(v[x]);return s}
function ap(){document.documentElement.lang=lang==='zh'?'zh-Hant':'en';
 var e=document.querySelectorAll('[data-i]');for(var i=0;i<e.length;i++){var k=e[i].getAttribute('data-i');if(L[lang][k])e[i].textContent=L[lang][k]}
 $('lz').className=lang==='zh'?'on':'';$('le').className=lang==='en'?'on':'';qz();if(last)render(last)}
$('lz').onclick=function(){lang='zh';ap()};$('le').onclick=function(){lang='en';ap()};
/* ---- journey switching ---- */
var jb=document.querySelectorAll('.jt button');
var curJ='j1';
for(var i=0;i<jb.length;i++)jb[i].onclick=function(){
 for(var j=0;j<jb.length;j++)jb[j].className='';this.className='on';
 curJ=this.getAttribute('data-j');
 $('j1').className=curJ==='j1'?'':'hidden';
 $('j2').className=curJ==='j2'?'':'hidden';
 $('j3').className=curJ==='j3'?'':'hidden';
 $('j4').className=curJ==='j4'?'':'hidden';
 if(curJ==='j1'&&!feedLoaded)loadFeed();
 if(curJ==='j4')loadWatch();
};

/* ---- JOURNEY 1: deal feed, loads itself ---- */
var feedLoaded=false;
function loadFeed(){
 $('f-st').textContent=T('f_loading');$('f-out').innerHTML='';
 var o=($('f-o').value||'HKG').trim().toUpperCase();
 fetch('/api/feed?origin='+o+'&currency='+$('f-cu').value)
 .then(function(r){return r.json()}).then(function(d){
  feedLoaded=true;$('f-st').textContent='';
  renderFeed(d);
 }).catch(function(e){$('f-st').textContent=e.message;$('f-st').className='st e'});
}
$('f-o').addEventListener('change',function(){feedLoaded=false;loadFeed()});
$('f-cu').addEventListener('change',function(){feedLoaded=false;loadFeed()});

function dealCard(o,d,emphasize){
 var e=document.createElement('div');e.className='f'+(emphasize?' top':'');
 var badge='';
 if(o.dealScore){
  var t=o.dealScore.tier;
  if(t==='hot')badge='<span class="bg cheap">🔥 P'+o.dealScore.percentile+'</span>';
  else if(t==='good')badge='<span class="bg direct">⭐ P'+o.dealScore.percentile+'</span>';
 }
 var cmp=(o.channels||[]).filter(function(c){return c.kind!=='book'});
 var links='';cmp.forEach(function(c){links+='<a class="b vf" href="'+c.url+'" target="_blank" rel="noopener">'+(lang==='zh'?c.zh:c.en)+'</a>'});
 e.innerHTML='<div class="fh"><div><div class="al">'+o.origin+' → '+o.destination+'</div>'+
  '<div class="fn">'+o.departDate+' → '+(o.returnDate||'')+' · '+(o.airlineName||'')+'</div></div>'+
  '<div class="pr"><div class="v"><span style="font-size:.66rem;color:var(--dim);font-weight:400">'+T('f_from')+'</span> '+M(o.price,d.currency)+'</div></div></div>'+
  '<div class="badges">'+(o.stops===0?'<span class="bg direct">'+T('direct')+'</span>':'')+badge+'</div>'+
  '<div class="bw">'+links+'</div>';
 /* tap anywhere on the card → research this route in Journey 2 */
 e.style.cursor='pointer';
 e.addEventListener('click',function(ev){
  if(ev.target.tagName==='A')return;
  $('o').value=o.origin;$('d').value=o.destination;
  document.querySelectorAll('.jt button')[1].click();
 });
 return e;
}
function renderFeed(d){
 var b=$('f-out');b.innerHTML='';
 function H(k){var e=document.createElement('div');e.className='h';e.textContent=T(k);b.appendChild(e)}
 if(d.verdict){
  var v=document.createElement('div');v.className='vd';
  v.innerHTML='<div class="vl">'+T('f_verdict')+'</div>'+
   '<div class="vb">'+d.origin+' → '+d.verdict.destination+' · '+M(d.verdict.price,d.currency)+'</div>'+
   '<div class="vs">'+d.verdict.departDate+' → '+(d.verdict.returnDate||'')+' · '+(d.verdict.airlineName||'')+'</div>';
  var go=document.createElement('button');go.className='go';go.style.marginTop='10px';go.textContent=T('vd_go');
  go.onclick=(function(dest){return function(){
   $('d').value=dest;$('o').value=d.origin;
   jb[1].click();
  }})(d.verdict.destination);
  v.appendChild(go);b.appendChild(v);
 }
 /* 📉 unusually cheap — deal-scored against own recorded history */
 var drops=(d.deals||[]).filter(function(o){return o.dealScore&&(o.dealScore.tier==='hot'||o.dealScore.tier==='good')});
 if(drops.length){
  H('f_drops');
  drops.forEach(function(o){b.appendChild(dealCard(o,d,true))});
 }
 /* 🚄 cheaper from a nearby airport — computed vs the home-airport fare */
 if(d.altDeals&&d.altDeals.length){
  H('f_alt');
  d.altDeals.forEach(function(o){
   var e=dealCard(o,d,false);
   var line=document.createElement('div');
   line.className='fn';line.style.cssText='color:var(--acc);margin-top:6px;font-weight:600';
   line.textContent=T('f_alt_line',{o:o.origin,s:M(o.saving,d.currency),h:M(o.homePrice,d.currency)});
   e.insertBefore(line,e.querySelector('.badges'));
   b.appendChild(e)});
 }
 /* ✈ direct-flight deals */
 var directs=(d.deals||[]).filter(function(o){return o.stops===0&&drops.indexOf(o)<0}).slice(0,6);
 if(directs.length){
  H('f_direct');
  directs.forEach(function(o){b.appendChild(dealCard(o,d,false))});
 }
 /* 🌏 everything else, cheapest per destination */
 var rest=(d.deals||[]).filter(function(o){return drops.indexOf(o)<0&&directs.indexOf(o)<0});
 if(rest.length){
  H('f_deals');
  rest.forEach(function(o){
   b.appendChild(dealCard(o,d,false))});
 }
 if(!(d.deals&&d.deals.length)){
  var em=document.createElement('div');em.className='empty';em.textContent=T('f_none');b.appendChild(em);
 }
 if(d.signals&&d.signals.length){
  H('f_signals');
  var n=document.createElement('div');n.className='note';n.textContent=T('f_sig_note');b.appendChild(n);
  d.signals.forEach(function(sg){
   var e=document.createElement('div');e.className='f';
   e.innerHTML='<a href="'+sg.url+'" target="_blank" rel="noopener" style="color:var(--tx);text-decoration:none;font-size:.86rem;line-height:1.45;display:block">'+String(sg.title).replace(/</g,'&lt;')+'</a>'+
    '<div class="fn" style="margin-top:5px">'+sg.source+(sg.alsoSeenIn&&sg.alsoSeenIn.length?' · +'+sg.alsoSeenIn.length:'')+'</div>';
   b.appendChild(e)});
 }
}

/* ---- JOURNEY 3: inspiration ---- */
$('i-go').onclick=function(){
 var o=($('i-o').value||'HKG').trim().toUpperCase();
 var budget=parseInt($('i-b').value||'2000',10);
 $('i-st').textContent=T('searching');$('i-st').className='st';$('i-out').innerHTML='';
 fetch('/api/inspire?origin='+o+'&currency='+$('i-cu').value+'&budget='+budget+'&weekend='+($('i-w').checked?'1':'0'))
 .then(function(r){return r.json()}).then(function(d){
  $('i-st').textContent='';
  if(d.error){$('i-st').textContent=d.error;$('i-st').className='st e';return}
  renderInspire(d);
 }).catch(function(e){$('i-st').textContent=e.message;$('i-st').className='st e'});
};

function renderInspire(d){
 var b=$('i-out');b.innerHTML='';
 function H(k){var e=document.createElement('div');e.className='h';e.textContent=T(k);b.appendChild(e)}
 if(!d.ideas||!d.ideas.length){
  var em=document.createElement('div');em.className='empty';em.textContent=T('i_none');b.appendChild(em);
  var st=document.createElement('div');st.className='note';
  st.textContent=T('i_stats',{s:d.stats.scanned,w:d.stats.withinBudget,e:d.stats.excludedByWeekendFilter});
  b.appendChild(st);return}
 var v=d.verdict;
 if(v){
  var e=document.createElement('div');e.className='vd';
  var tags='';
  if(v.weekendFit)tags+=' <span class="wb">'+T('wknd')+'</span>';
  if(v.holiday)tags+=' <span class="hb">'+T('hol')+' '+v.holiday+'</span>';
  e.innerHTML='<div class="vl">'+T('i_verdict')+'</div>'+
   '<div class="vb">'+d.origin+' → '+v.destination+tags+'</div>'+
   '<div class="vs">'+T('i_line',{d:v.departDate+' → '+v.returnDate+' ('+T('i_days',{n:v.days})+')',p:M(v.price,d.currency),left:M(v.budgetLeft,d.currency)})+'</div>';
  var go=document.createElement('button');go.className='go';go.style.marginTop='10px';go.textContent=T('vd_go');
  go.onclick=(function(dest,dd,rd){return function(){
   $('d').value=dest;$('o').value=d.origin;$('dd').value=dd;$('rd').value=rd;
   document.querySelectorAll('.jt button')[1].click();
  }})(v.destination,v.departDate,v.returnDate);
  e.appendChild(go);b.appendChild(e);
 }
 H('i_ideas');
 d.ideas.forEach(function(o){
  var e=document.createElement('div');e.className='f';
  var tags='';
  if(o.weekendFit)tags+='<span class="wb">'+T('wknd')+'</span> ';
  if(o.holiday)tags+='<span class="hb">'+T('hol')+'</span> ';
  var cmp=(o.channels||[]).filter(function(c){return c.kind!=='book'});
  var links='';cmp.forEach(function(c){links+='<a class="b vf" href="'+c.url+'" target="_blank" rel="noopener">'+(lang==='zh'?c.zh:c.en)+'</a>'});
  e.innerHTML='<div class="fh"><div><div class="al">'+o.destination+'</div>'+
   '<div class="fn">'+o.departDate+' → '+o.returnDate+' · '+T('i_days',{n:o.days})+' · '+(o.airlineName||'')+'</div></div>'+
   '<div class="pr"><div class="v">'+M(o.price,d.currency)+'</div></div></div>'+
   '<div class="badges">'+tags+(o.stops===0?'<span class="bg direct">'+T('direct')+'</span>':'')+'</div>'+
   '<div class="bw">'+links+'</div>';
  b.appendChild(e)});
 var st=document.createElement('div');st.className='note';
 st.textContent=T('i_stats',{s:d.stats.scanned,w:d.stats.withinBudget,e:d.stats.excludedByWeekendFilter});
 b.appendChild(st);
}

var tb=document.querySelectorAll('.tt button');
for(var i=0;i<tb.length;i++)tb[i].onclick=function(){for(var j=0;j<tb.length;j++)tb[j].className='';this.className='on';
 trip=this.getAttribute('data-t');$('rw').style.display=trip==='return'?'block':'none'};
var pb=document.querySelectorAll('.pf button');
for(var i=0;i<pb.length;i++)pb[i].onclick=function(){for(var j=0;j<pb.length;j++)pb[j].className='';this.className='on';prof=this.getAttribute('data-p');sp()};

function placeTypeLabel(t){if(t==='country')return T('place_country');if(t==='city')return T('place_city');return T('place_airport')}
function ac(inp,list){var I=$(inp),Ls=$(list),tm;
 I.addEventListener('input',function(){var v=I.value.trim();clearTimeout(tm);
  if(v.length<2){Ls.className='acl';return}
  tm=setTimeout(function(){fetch('/api/places?q='+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(x){
   if(!x.places||!x.places.length){Ls.className='acl';return}
   Ls.innerHTML='';x.places.forEach(function(p){var e=document.createElement('div');e.className='aci';
    e.innerHTML='<b>'+p.code+'</b> '+p.name+(p.type==='country'?' · '+placeTypeLabel('country'):'')+
     '<small>'+(p.type!=='country'?(p.country||''):(lang==='zh'?'包晒全國機場':'covers every airport in the country'))+'</small>';
    e.addEventListener('mousedown',function(ev){ev.preventDefault();I.value=p.name+' ('+p.code+')';Ls.className='acl'});
    Ls.appendChild(e)});Ls.className='acl on'})},250)});
 I.addEventListener('blur',function(){setTimeout(function(){Ls.className='acl'},170)})}
ac('o','ao');ac('d','ad');

fetch('/api/prefs?uid='+UID).then(function(r){return r.json()}).then(function(x){QZ=x.quiz||[];
 if(x.saved){prof=x.saved.profile||'balanced';ans=x.saved.answers||{};
  for(var i=0;i<pb.length;i++)pb[i].className=pb[i].getAttribute('data-p')===prof?'on':''}
 qz()});
function qz(){var b=$('qz');if(!b)return;b.innerHTML='';QZ.forEach(function(q){
 var e=document.createElement('div');e.className='q';var a=ans[q.id];
 e.innerHTML='<div class="qt">'+(lang==='zh'?q.zh:q.en)+'</div><div class="qb">'+
  '<button data-v="1" class="'+(a===true?'on':'')+'">'+T('yes')+'</button>'+
  '<button data-v="0" class="'+(a===false?'on':'')+'">'+T('no')+'</button></div>';
 var bs=e.querySelectorAll('.qb button');
 for(var i=0;i<bs.length;i++)bs[i].onclick=(function(v){return function(){ans[q.id]=(v==='1');qz();sp()}})(bs[i].getAttribute('data-v'));
 b.appendChild(e)})}
function sp(){fetch('/api/prefs?uid='+UID,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:prof,answers:ans})})}

gl();function gl(){fetch('/api/ground?uid='+UID).then(function(r){return r.json()}).then(function(x){
 var l=$('gl');l.innerHTML='';Object.keys(x.ground||{}).forEach(function(c){var g=x.ground[c];
  var e=document.createElement('div');e.style.cssText='display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);font-size:.78rem';
  e.innerHTML='<span>'+c+' · HK$'+g.costHKD+' · '+g.minutes+'min</span>';
  var b=document.createElement('button');b.textContent='×';b.style.cssText='background:none;border:none;color:var(--hot);cursor:pointer';
  b.onclick=function(){fetch('/api/ground?uid='+UID,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c,remove:true})}).then(gl)};
  e.appendChild(b);l.appendChild(e)})})}
$('ga').onclick=function(){var c=$('gc').value.trim().toUpperCase();if(c.length!==3)return;
 fetch('/api/ground?uid='+UID,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({code:c,costHKD:$('gm').value,minutes:$('gt').value})}).then(function(){
  $('gc').value='';$('gm').value='';$('gt').value='';gl()})};

function M(v,c){try{return new Intl.NumberFormat(lang==='zh'?'zh-HK':'en-US',{style:'currency',currency:c||'HKD',maximumFractionDigits:0}).format(v)}catch(e){return (c||'')+v}}
function hhmm(iso){if(!iso||iso.length<16)return null;return iso.slice(11,16)}
function dur(m){if(!m)return null;return T('dur',{h:Math.floor(m/60),m:m%60})}

$('go').onclick=function(){
 var o=parseCode($('o').value),d=parseCode($('d').value);
 if(!o||!d){setS(lang==='zh'?'請由下拉揀返個地方':'Pick a place from the dropdown',true);return}
 var anyD=(dateMode!=='exact');
 if(!anyD&&!$('dd').value){setS('date',true);return}
 var p=new URLSearchParams();p.set('uid',UID);p.set('origin',o);p.set('destination',d);p.set('trip',trip);
 if(anyD){p.set('anyDate','1');if(dateMode==='weekend')p.set('dateMode','weekend');if(dateMode==='month')p.set('dateMode','month')}
 else{p.set('departDate',$('dd').value);if(trip==='return'&&$('rd').value)p.set('returnDate',$('rd').value);
  if($('fx').checked)p.set('flexible','1')}
 p.set('currency',$('cu').value);p.set('pax',$('px').value);
 p.set('distance',$('ds').value);p.set('profile',prof);
 if(!$('bg').checked)p.set('nobag','1');
 setS(T('searching'));$('go').disabled=true;$('out').innerHTML='';
 fetch('/api/search?'+p.toString()).then(function(r){return r.json()}).then(function(x){
  $('go').disabled=false;if(x.error){setS(x.error,true);return}
  setS('');last=x;render(x);explain(x)}).catch(function(e){$('go').disabled=false;setS(e.message,true)})};
function setS(m,e){$('st').textContent=m||'';$('st').className='st'+(e?' e':'')}

function bagOf(o){var p=(o.parts||[]).find(function(x){return x.k==='baggage'});return p?p.v:0}
function flightCard(o,isTop,cur,showCheap){
 var e=document.createElement('div');e.className='f'+(isTop?' top':'');
 var dt=hhmm(o.departTime),du=dur(o.durationMin);
 var bg='<div class="badges">';
 bg+=o.stops===0?'<span class="bg direct">'+T('direct')+'</span>':(o.stops>0?'<span class="bg stop">'+T('stops',{n:o.stops})+'</span>':'');
 if(o.detail==='price_only')bg+='<span class="bg po">'+T('price_only')+'</span>';
 if(o.isLcc)bg+='<span class="bg stop">'+T('lcc')+'</span>';
 if(o.via==='other_date')bg+='<span class="bg dt">'+T('other_date')+'</span>';
 if(showCheap)bg+='<span class="bg cheap">'+T('cheapest')+'</span>';
 bg+='</div>';

 var tl='';
 if(dt){tl='<div class="tl"><div><div class="t">'+dt+'</div><div class="ap">'+o.origin+'</div></div>'+
  '<div class="mid"><div class="d">'+(du||'')+'</div><div class="ln"></div></div>'+
  '<div style="text-align:right"><div class="t">—</div><div class="ap">'+o.destination+'</div></div></div>'}
 else{tl='<div class="tl"><div><div class="t">'+o.origin+'</div></div><div class="mid"><div class="ln"></div></div>'+
  '<div style="text-align:right"><div class="t">'+o.destination+'</div></div></div>'}

 var bk=(o.channels||[]).filter(function(c){return c.kind==='book'});
 var vf=(o.channels||[]).filter(function(c){return c.kind!=='book'});
 var bh='<div class="bk"><div class="bkl">'+T('book_official')+'</div><div class="bw">';
 bk.forEach(function(c){bh+='<a class="b '+(c.id==='airline'?'of':'ota')+'" href="'+c.url+'" target="_blank" rel="noopener">'+(lang==='zh'?c.zh:c.en)+'</a>'});
 bh+='</div><div class="bkl" style="margin-top:8px">'+T('verify')+'</div><div class="bw">';
 vf.forEach(function(c){bh+='<a class="b vf" href="'+c.url+'" target="_blank" rel="noopener">'+(lang==='zh'?c.zh:c.en)+'</a>'});
 bh+='</div></div>';

 e.innerHTML='<div class="fh"><div><div class="al">'+(o.airlineName||'—')+'</div>'+
  (o.flightNumber?'<div class="fn">'+(o.airlineCode||'')+o.flightNumber+'</div>':'')+'</div>'+
  '<div class="pr"><div class="v">'+M(o.price,cur)+'</div><div class="c">'+(o.returnDate?(lang==='zh'?'來回':'round trip'):(lang==='zh'?'單程':'one way'))+'</div>'+
  (bagOf(o)?'<div class="c" style="color:var(--warm);margin-top:3px">'+T('bagline',{n:M(o.price+bagOf(o),cur)})+'</div>':'')+'</div></div>'+
  bg+'<div class="dates">'+o.departDate+(o.returnDate?(' → '+o.returnDate):'')+'</div>'+tl+bh;
 return e}

function render(x){
 var b=$('out');b.innerHTML='';
 var cur=x.query.currency;
 function H(k){var e=document.createElement('div');e.className='h';e.textContent=T(k);b.appendChild(e)}

 /* THE ANSWER — always rendered first, whatever the data situation */
 if(x.answer){
  var A=x.answer,e=document.createElement('div');e.className='vd';
  var h='<div class="vl">'+T('a_title')+'</div>';
  if(A.headline){
   var hd=A.headline;
   var situ=A.kind==='exact'?'<span class="bg direct">'+T('a_exact')+'</span>'
    :(A.kind==='alternative_airport'?'<span class="bg stop">'+T('a_altair')+'</span>'
    :'<span class="bg stop">'+T('a_adjusted')+'</span>');
   h+='<div class="vb">'+T('a_go')+':'+hd.origin+' → '+hd.destination+' · '+M(hd.price,hd.currency)+'</div>'+
    '<div class="vs">'+hd.departDate+(hd.returnDate?(' → '+hd.returnDate):'')+' · '+(hd.airlineName||'')+' · '+situ+'</div>';
   if(A.channel)h+='<div class="vs" style="margin-top:7px"><b>'+T('a_buy')+':</b> '+(lang==='zh'?A.channel.zh:A.channel.en)+'</div>';
   var tm=A.timing||{};
   var tline=tm.verdict==='good_time'?T('a_now',{p:tm.percentile})
    :(tm.verdict==='consider_waiting'?T('a_wait'):T('a_nohist'));
   h+='<div class="vs"><b>'+T('a_when')+':</b> '+tline+'</div>';
   if(A.estimate)h+='<div class="vs" style="color:var(--dim)">'+T('a_est_line',{t:M(A.estimate.typical,x.query.currency),lo:M(A.estimate.low,x.query.currency),n:A.estimate.samples})+'</div>';
  }else if(A.kind==='estimate_only'&&A.estimate){
   h+='<div class="vb">'+T('a_est_only')+'</div>'+
    '<div class="vs">'+T('a_est_line',{t:M(A.estimate.typical,x.query.currency),lo:M(A.estimate.low,x.query.currency),n:A.estimate.samples})+'</div>';
  }else{
   h+='<div class="vb">'+T('a_plan')+'</div>';
  }
  e.innerHTML=h;
  var wbtn=document.createElement('button');wbtn.className='b vf';wbtn.style.marginTop='10px';wbtn.style.marginRight='6px';
  wbtn.textContent='⭐ '+T('w_add');
  wbtn.onclick=function(){
   var tgt=A.estimate?A.estimate.low:(A.headline?Math.round(A.headline.price*0.9):null);
   fetch('/api/watch?uid='+UID,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({origin:x.query.origin,destination:x.query.destination,target:tgt})})
   .then(function(){wbtn.textContent='✓ '+T('w_added')});
  };
  e.appendChild(wbtn);
  /* alternative destinations on the empty tiers — the assistant never stops helping */
  if(A.alternatives&&A.alternatives.length){
   var alt=document.createElement('div');alt.className='vs';alt.style.marginTop='9px';
   var ah='<span style="color:var(--dim)">'+T('a_alts')+'</span> ';
   A.alternatives.forEach(function(al){
    ah+='<button class="b ota" style="margin:2px" data-dest="'+al.destination+'">'+al.destination+' '+M(al.price,x.query.currency)+'</button>'});
   alt.innerHTML=ah;
   alt.addEventListener('click',function(ev){
    var dd2=ev.target.getAttribute('data-dest');
    if(dd2){$('d').value=dd2;$('go').click()}});
   e.appendChild(alt);
  }
  if(A.channel&&A.channel.url){
   var cb=document.createElement('a');cb.className='b of';cb.style.marginTop='10px';cb.style.display='inline-block';
   cb.href=A.channel.url;cb.target='_blank';cb.rel='noopener';
   cb.textContent=(lang==='zh'?A.channel.zh:A.channel.en);
   e.appendChild(cb);
  }
  if(x.verifyLinks&&x.verifyLinks.length){
   var vf=document.createElement('div');vf.className='vs';vf.style.marginTop='9px';
   var vh='<span style="color:var(--dim)">'+T('a_verify')+'</span> ';
   x.verifyLinks.forEach(function(l){vh+='<a class="b vf" style="margin:2px" href="'+l.url+'" target="_blank" rel="noopener">'+(lang==='zh'?l.zh:l.en)+'</a>'});
   vf.innerHTML=vh;e.appendChild(vf);
  }
  b.appendChild(e);
 }

 if(!x.results||!x.results.length){trust(x,b);return}

 if(!x.resultsAreExactRoute){var w=document.createElement('div');w.className='sv';w.style.borderLeftColor='var(--warm)';
  w.innerHTML='<div style="font-size:.82rem">'+T('not_exact')+'</div>';b.appendChild(w)}

 // 1. RECOMMENDATION
 var rec=x.recommendation;
 if(rec&&rec.best){
  H('h_rec');
  var rc=document.createElement('div');rc.className='rec';
  rc.innerHTML='<div class="rl">'+T('h_rec')+'</div>';
  rc.appendChild(flightCard(rec.best,false,cur,rec.sameOption));
  var why='';
  if(rec.sameOption)why=T('rec_cheapest');
  else{
   var rs=[];
   (rec.reasons||[]).forEach(function(r){
    if(r.k==='fewer_stops')rs.push(T('rec_fewer'));
    if(r.k==='airline_direct')rs.push(T('rec_direct_air',{a:lang==='zh'?r.airlineZh:r.airline}));
    if(r.k==='faster')rs.push(T('rec_faster',{n:r.mins}));
    if(r.k==='baggage_included')rs.push(T('rec_bag',{n:M(r.bagCost,cur)}));});
   why='<b>'+T('rec_gap',{n:M(Math.abs(rec.priceGap),cur)})+'</b>'+(rs.length?' — '+rs.join('、'):'');
  }
  var wd=document.createElement('div');wd.className='why';wd.innerHTML=why;rc.appendChild(wd);
  b.appendChild(rc)}

 // 2. AI slot
 var ab=document.createElement('div');ab.id='aib';b.appendChild(ab);

 // 3. FLIGHTS
 H('h_res');
 x.results.forEach(function(o,i){b.appendChild(flightCard(o,i===0,cur,i===0&&(!rec||!rec.sameOption)))});

 // 4. SAVINGS
 if(x.savings&&x.savings.length){
  H('h_sav');
  x.savings.forEach(function(s){
   var e=document.createElement('div');e.className='sv';
   var ttl = s.type==='other_date' ? T('sv_date',{d:s.offer.departDate})
     : (s.type==='other_origin' ? T('sv_from',{o:s.offer.origin}) : T('sv_to',{d:s.offer.destination}));
   var br='<div>'+T('sv_save',{n:M(s.saving,cur)})+'</div>';
   if(s.groundCost!=null)br+='<div>− '+T('sv_ground',{n:M(s.groundCost,cur)})+'</div>';
   var head = s.netSaving!=null ? T('sv_net',{n:M(s.netSaving,cur)}) : T('sv_save',{n:M(s.saving,cur)});
   e.innerHTML='<div class="rt">'+ttl+'</div><div class="amt">'+head+'</div><div class="br">'+br+'</div>'+
    (s.groundKnown===false?'<div class="br warn">'+T('sv_unknown')+'</div>':'');
   e.appendChild(flightCard(s.offer,false,cur,false));
   b.appendChild(e)})}

 // 5. PRICE CONTEXT
 if(x.context){
  H('h_ctx');
  var c=document.createElement('div');c.className='ctx';
  c.innerHTML='<span class="v '+x.context.verdict+'">'+T('ctx_'+x.context.verdict)+'</span> · '+
   T('ctx_line',{p:x.context.percentile,n:x.context.samples,lo:M(x.context.lowest,cur)});
  b.appendChild(c)}

 // 6. TRUST — last, collapsed
 trust(x,b);
}

function trust(x,b){
 var t=x.trust||{};
 var d=document.createElement('details');d.className='tr';
 var ok=(t.sources||[]).filter(function(s){return s.ok});
 var body='<div class="trb"><b>'+T('t_sources')+'</b> '+ok.map(function(s){return '<span class="ok">✓</span> '+s.id+' ('+s.found+')'}).join(' &nbsp; ')+
  '<br><b>'+T('t_no')+'</b> '+(t.unavailable||[]).map(function(u){return '<span class="no">✕</span> '+(lang==='zh'?u.zh:u.en)}).join(' &nbsp; ')+
  '<br><br>'+T('t_age')+'<br>'+T('t_counts',{n:(t.counts&&t.counts.total)||0,ms:t.elapsedMs||0})+'</div>';
 d.innerHTML='<summary>'+T('h_trust')+'</summary>'+body;
 b.appendChild(d)}

function explain(x){
 var b=$('aib');if(!b)return;
 if(!x.recommendation&&!(x.answer&&(x.answer.kind==='estimate_only'||x.answer.kind==='action_plan')))return;
 fetch('/api/explain',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({recommendation:x.recommendation,savings:x.savings,context:x.context,answer:x.answer,lang:lang})})
 .then(function(r){return r.json()}).then(function(a){
  if(!a.text){b.innerHTML='';return}
  b.innerHTML='<div class="ai"><div class="l">AI</div>'+String(a.text).replace(/</g,'&lt;')+'</div>'})
 .catch(function(){b.innerHTML=''})}

(function(){var d=new Date();d.setDate(d.getDate()+14);var r=new Date(d);r.setDate(r.getDate()+4);
 $('dd').value=d.toISOString().slice(0,10);$('rd').value=r.toISOString().slice(0,10)})();
ap();
loadFeed();
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){})}
})();
</script></body></html>`;
