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
    market: env.DEFAULT_MARKET||"hk",
  };
  if (!env.TRAVELPAYOUTS_TOKEN) return json({ error:"TRAVELPAYOUTS_TOKEN not configured" },500);
  if (!q.origin || !q.destination) return json({ error:"origin and destination required" },400);
  if (!q.departDate) return json({ error:"departDate required" },400);

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

  // --- 1. exact dates (richest itinerary data)
  try { const r = await searchExact(env,q,nm); pool=pool.concat(r); mark("exact_dates",true,r.length); }
  catch(e){ mark("exact_dates",false,0,e.message); }

  // --- 2. ±3 days around the requested date
  if (q.flexible || pool.length < 4) {
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

  // --- 3. month calendar
  if (pool.length < 8) {
    try { const r = await searchMonth(env,q,nm,q.departDate.slice(0,7)); pool=pool.concat(r); mark("month_calendar",true,r.length); }
    catch(e){ mark("month_calendar",false,0,e.message); }
  }

  // --- 4. nearby airports
  try { const r = await searchNearby(env,q,nm); pool=pool.concat(r); mark("nearby_airports",true,r.filter(o=>o.via!=="requested").length); }
  catch(e){ mark("nearby_airports",false,0,e.message); }

  // --- 5. last resort: anything cached on this route at all
  if (!pool.length) {
    try { const r = await searchLatest(env,q,nm); pool=pool.concat(r); mark("recent_cache",true,r.length); }
    catch(e){ mark("recent_cache",false,0,e.message); }
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

  // search links so the user is never stranded
  const fallbackLinks = [];
  if (!primary.length) {
    const a = null;
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
    results: primary.slice(0,25),
    resultsAreExactRoute: main.length>0,
    recommendation,
    savings: savings.slice(0,6),
    otherDates: onRouteOtherDates.slice(0,8),
    context,
    fallbackLinks,
    trust: {
      sources,
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

async function handlePlaces(request) {
  const t=new URL(request.url).searchParams.get("q")||"";
  if (t.length<2) return json({ places:[] });
  try {
    const r=await fetch("https://autocomplete.travelpayouts.com/places2?locale=en&types[]=city&types[]=airport&term="+encodeURIComponent(t));
    const l=await r.json();
    return json({ places:(l||[]).slice(0,8).map(x=>({ code:x.code,name:x.name,country:x.country_name })) });
  } catch(e){ return json({ places:[] }); }
}

async function handleExplain(request, env) {
  const b = await request.json().catch(()=>({}));
  const { recommendation:rec, savings, context, lang } = b;
  const zh = lang==="zh";
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
    };
    const prompt =
      "You are a flight booking advisor. Use ONLY the numbers in this JSON — never invent a price, " +
      "a flight number, or a departure time. Never predict a future sale. " +
      "If topSaving.groundKnown is false, note the traveller must add their own transport cost. " +
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

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    try {
      if (p==="/api/search") return await handleSearch(request, env);
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

<div class="sb">
  <div class="tt"><button class="on" data-t="return" data-i="ret">來回</button><button data-t="oneway" data-i="one">單程</button></div>
  <div class="rw c2">
    <div class="ac"><label data-i="from">出發</label><input id="o" placeholder="HKG" autocomplete="off"><div class="acl" id="ao"></div></div>
    <div class="ac"><label data-i="to">目的地</label><input id="d" placeholder="TPE" autocomplete="off"><div class="acl" id="ad"></div></div>
  </div>
  <div class="rw c2">
    <div><label data-i="dep">去程</label><input id="dd" type="date"></div>
    <div id="rw"><label data-i="retd">回程</label><input id="rd" type="date"></div>
  </div>
  <div class="rw c3">
    <div><label data-i="cur">貨幣</label><select id="cu"><option>HKD</option><option>TWD</option><option>USD</option><option>JPY</option><option>SGD</option><option>EUR</option><option>GBP</option></select></div>
    <div><label data-i="pax">人數</label><select id="px"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
    <div><label data-i="rad">附近機場</label><select id="ds"><option value="0" data-i="off">唔使</option><option value="400">400 km</option><option value="600" selected>600 km</option><option value="1000">1000 km</option></select></div>
  </div>
  <div class="opt"><label><input type="checkbox" id="fx" checked> <span data-i="flex">前後 3 日都睇埋</span></label>
  <label><input type="checkbox" id="bg" checked> <span data-i="bag">要寄艙行李</span></label></div>
  <button class="go" id="go" data-i="search">搵機票</button>
</div>
<div class="st" id="st"></div>
<div id="out"></div>

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
 ret:'來回',one:'單程',from:'出發',to:'目的地',dep:'去程',retd:'回程',cur:'貨幣',pax:'人數',
 rad:'附近機場',off:'唔使',flex:'前後 3 日都睇埋',bag:'要寄艙行李',search:'搵機票',settings:'⚙︎ 我嘅取向',
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
 ret:'Round trip',one:'One way',from:'From',to:'To',dep:'Depart',retd:'Return',cur:'Currency',pax:'Travellers',
 rad:'Nearby airports',off:'Off',flex:'Include ±3 days',bag:'Need checked bag',search:'Find flights',settings:'⚙︎ My preferences',
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
var tb=document.querySelectorAll('.tt button');
for(var i=0;i<tb.length;i++)tb[i].onclick=function(){for(var j=0;j<tb.length;j++)tb[j].className='';this.className='on';
 trip=this.getAttribute('data-t');$('rw').style.display=trip==='return'?'block':'none'};
var pb=document.querySelectorAll('.pf button');
for(var i=0;i<pb.length;i++)pb[i].onclick=function(){for(var j=0;j<pb.length;j++)pb[j].className='';this.className='on';prof=this.getAttribute('data-p');sp()};

function ac(inp,list){var I=$(inp),Ls=$(list),tm;
 I.addEventListener('input',function(){var v=I.value.trim();clearTimeout(tm);
  if(v.length<2){Ls.className='acl';return}
  tm=setTimeout(function(){fetch('/api/places?q='+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(x){
   if(!x.places||!x.places.length){Ls.className='acl';return}
   Ls.innerHTML='';x.places.forEach(function(p){var e=document.createElement('div');e.className='aci';
    e.innerHTML='<b>'+p.code+'</b> '+p.name+'<small>'+(p.country||'')+'</small>';
    e.addEventListener('mousedown',function(ev){ev.preventDefault();I.value=p.code;Ls.className='acl'});
    Ls.appendChild(e)});Ls.className='acl on'})},250)});
 I.addEventListener('blur',function(){setTimeout(function(){Ls.className='acl'},170})}
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
 var o=$('o').value.trim().toUpperCase(),d=$('d').value.trim().toUpperCase();
 if(o.length!==3||d.length!==3){setS('IATA',true);return}
 if(!$('dd').value){setS('date',true);return}
 var p=new URLSearchParams();p.set('uid',UID);p.set('origin',o);p.set('destination',d);
 p.set('trip',trip);p.set('departDate',$('dd').value);
 if(trip==='return'&&$('rd').value)p.set('returnDate',$('rd').value);
 p.set('currency',$('cu').value);p.set('pax',$('px').value);
 p.set('distance',$('ds').value);p.set('profile',prof);
 if($('fx').checked)p.set('flexible','1');
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

 if(!x.results||!x.results.length){
  var em=document.createElement('div');em.className='empty';
  em.innerHTML=T('no_res')+'<div class="fbw">'+(x.fallbackLinks||[]).map(function(l){
   return '<a class="b ota" href="'+l.url+'" target="_blank" rel="noopener">'+(lang==='zh'?l.zh:l.en)+'</a>'}).join('')+'</div>';
  b.appendChild(em);trust(x,b);return}

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
 var b=$('aib');if(!b||!x.recommendation)return;
 fetch('/api/explain',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({recommendation:x.recommendation,savings:x.savings,context:x.context,lang:lang})})
 .then(function(r){return r.json()}).then(function(a){
  if(!a.text){b.innerHTML='';return}
  b.innerHTML='<div class="ai"><div class="l">AI</div>'+String(a.text).replace(/</g,'&lt;')+'</div>'})
 .catch(function(){b.innerHTML=''})}

(function(){var d=new Date();d.setDate(d.getDate()+14);var r=new Date(d);r.setDate(r.getDate()+4);
 $('dd').value=d.toISOString().slice(0,10);$('rd').value=r.toISOString().slice(0,10)})();
ap();
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){})}
})();
</script></body></html>`;
