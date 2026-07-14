// ============================================================
//  Supabase Edge Function: "fitbit"  (v6 — alles wat Google Health geeft)
//
//  Haalt ALLE datatypes op die binnen de drie gevraagde scopes vallen:
//    activity_and_fitness · health_metrics_and_measurements · sleep
//
//  Verify JWT moet UIT staan.
//  Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://sjoerdspil-coder.github.io/financien/";
const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const REDIRECT = `${SUPA_URL}/functions/v1/fitbit`;

const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
].join(" ");

const db = createClient(SUPA_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const API = "https://health.googleapis.com/v4/users/me";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- tokens ----------
async function versToken(uid: string) {
  const { data: rij } = await db.from("google_health").select("*").eq("user_id", uid).maybeSingle();
  if (!rij?.refresh_token) throw new Error("Nog niet gekoppeld met Google Health.");
  if (rij.access_token && rij.expires_at && new Date(rij.expires_at) > new Date(Date.now() + 60_000)) {
    return rij.access_token as string;
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: rij.refresh_token, grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    await db.from("google_health").update({ last_error: `Token vernieuwen mislukt: ${JSON.stringify(j).slice(0, 200)}` }).eq("user_id", uid);
    throw new Error("Je Google-koppeling is verlopen. Koppel opnieuw.");
  }
  await db.from("google_health").update({
    access_token: j.access_token,
    expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString(),
    ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}),
    last_error: null,
  }).eq("user_id", uid);
  return j.access_token as string;
}

const ghGet = async (token: string, pad: string) => {
  const r = await fetch(`${API}/${pad}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
  return await r.json();
};
const ghPost = async (token: string, pad: string, body: unknown) => {
  const r = await fetch(`${API}/${pad}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
  return await r.json();
};

const civil = (d: Date, eind = false) => ({
  date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
  time: eind ? { hours: 23, minutes: 59, seconds: 59 } : { hours: 0, minutes: 0, seconds: 0 },
});
const datum = (c: any) => `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
const dagStr = (d: Date) => d.toISOString().slice(0, 10);

/* Alle getallen uit een genest object plat slaan: {a:{b:3}} -> {a_b:3} */
function plat(o: any, prefix = "", uit: Record<string, number> = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (["startTime", "endTime", "civilStartTime", "civilEndTime", "sampleTime", "date", "metadata", "dataOrigin", "id", "name"].includes(k)) continue;
    const naam = prefix ? `${prefix}_${k}` : k;
    if (typeof v === "number") uit[naam] = v;
    else if (typeof v === "string" && v !== "" && !isNaN(Number(v))) uit[naam] = Number(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) plat(v, naam, uit);
  }
  return uit;
}

/* ---- de drie manieren waarop Google Health data teruggeeft ---- */

// Interval-types: dagtotaal per datum
async function rollup(token: string, type: string, van: Date, tot: Date) {
  const j = await ghPost(token, `dataTypes/${type}/dataPoints:dailyRollUp`, {
    range: { start: civil(van), end: civil(tot, true) },
    windowSizeDays: 1,
  });
  const uit: Record<string, any> = {};
  for (const p of j.rollupDataPoints ?? []) {
    const d = p.civilStartTime?.date ? datum(p.civilStartTime.date) : null;
    if (!d) continue;
    const veld = Object.keys(p).find((k) => !["civilStartTime", "civilEndTime", "startTime", "endTime"].includes(k));
    if (veld) uit[d] = p[veld];
  }
  return uit;
}

// Daily-types: één punt per dag, veld heet bv. dailyRestingHeartRate
async function dagelijks(token: string, type: string, filterVeld: string, van: Date) {
  const j = await ghGet(token, `dataTypes/${type}/dataPoints?pageSize=200&filter=${encodeURIComponent(`${filterVeld}.date >= "${dagStr(van)}"`)}`);
  const uit: Record<string, any> = {};
  for (const p of j.dataPoints ?? []) {
    const veld = Object.keys(p).find((k) => k !== "dataOrigin" && k !== "metadata");
    const v = veld ? p[veld] : null;
    if (v?.date) uit[datum(v.date)] = v;
  }
  return uit;
}

// Sample-types: losse metingen met een tijdstip
async function samples(token: string, type: string, filterVeld: string, van: Date, pageSize = 500) {
  const j = await ghGet(token, `dataTypes/${type}/dataPoints?pageSize=${pageSize}&filter=${encodeURIComponent(`${filterVeld}.sample_time.physical_time >= "${van.toISOString()}"`)}`);
  return (j.dataPoints ?? []) as any[];
}

// ---------- synchroniseren ----------
async function sync(uid: string, dagen = 30) {
  const token = await versToken(uid);
  const tot = new Date();
  const van = new Date(); van.setDate(van.getDate() - dagen);

  const fouten: string[] = [];
  const veilig = async <T>(naam: string, f: () => Promise<T>): Promise<T | null> => {
    try { return await f(); } catch (e) { fouten.push(`${naam}: ${(e as Error).message}`); return null; }
  };

  // --- 1. dagtotalen (interval-types) ---
  const R: Record<string, Record<string, any>> = {};
  const rollupTypes: [string, string][] = [
    ["steps", "stappen"],
    ["active-energy-burned", "actieve calorieën"],
    ["active-minutes", "actieve minuten"],
    ["active-zone-minutes", "zone-minuten"],
    ["distance", "afstand"],
    ["floors", "trappen"],
    ["sedentary-period", "zitten"],
    ["calories-in-heart-rate-zone", "calorieën per hartzone"],
    ["time-in-heart-rate-zone", "tijd per hartzone"],
    ["heart-rate", "hartslag"],
    ["swim-lengths-data", "zwemmen"],
    ["altitude", "hoogte"],
    ["run-vo2-max", "vo2max hardlopen"],
  ];
  for (const [t, naam] of rollupTypes) {
    R[t] = await veilig(naam, () => rollup(token, t, van, tot)) ?? {};
  }

  // --- 2. dagwaarden (daily-types) ---
  const D: Record<string, Record<string, any>> = {};
  const dailyTypes: [string, string, string][] = [
    ["daily-resting-heart-rate", "daily_resting_heart_rate", "rusthartslag"],
    ["daily-heart-rate-variability", "daily_heart_rate_variability", "hartslagvariabiliteit"],
    ["daily-oxygen-saturation", "daily_oxygen_saturation", "zuurstofsaturatie"],
    ["daily-respiratory-rate", "daily_respiratory_rate", "ademhaling"],
    ["daily-vo2-max", "daily_vo2_max", "vo2max"],
    ["daily-heart-rate-zones", "daily_heart_rate_zones", "hartzones"],
    ["daily-sleep-temperature-derivations", "daily_sleep_temperature_derivations", "huidtemperatuur"],
  ];
  for (const [t, f, naam] of dailyTypes) {
    D[t] = await veilig(naam, () => dagelijks(token, t, f, van)) ?? {};
  }

  // --- 3. losse metingen ---
  const weging = await veilig("gewicht", () => samples(token, "weight", "weight", van)) ?? [];
  const vet = await veilig("vetpercentage", () => samples(token, "body-fat", "body_fat", van)) ?? [];
  const lengte = await veilig("lengte", () => samples(token, "height", "height", van)) ?? [];
  const glucose = await veilig("bloedglucose", () => samples(token, "blood-glucose", "blood_glucose", van)) ?? [];
  const temp = await veilig("lichaamstemperatuur", () => samples(token, "core-body-temperature", "core_body_temperature", van)) ?? [];
  const spo2 = await veilig("spo2-metingen", () => samples(token, "oxygen-saturation", "oxygen_saturation", van)) ?? [];
  const rrSlaap = await veilig("ademhaling in slaap", () => samples(token, "respiratory-rate-sleep-summary", "respiratory_rate_sleep_summary", van)) ?? [];

  // --- 4. sessies ---
  const slaap = await veilig("slaap", async () => {
    const j = await ghGet(token, `dataTypes/sleep/dataPoints?pageSize=200&filter=${encodeURIComponent(`sleep.interval.civil_end_time >= "${dagStr(van)}"`)}`);
    return (j.dataPoints ?? []) as any[];
  }) ?? [];

  const training = await veilig("trainingen", async () => {
    const j = await ghGet(token, `dataTypes/exercise/dataPoints?pageSize=200&filter=${encodeURIComponent(`exercise.interval.civil_end_time >= "${dagStr(van)}"`)}`);
    return (j.dataPoints ?? []) as any[];
  }) ?? [];

  const rijen: any[] = [];

  // ===== één beweeg/gezondheidsregel per dag =====
  const alleDagen = new Set<string>();
  for (const t of Object.keys(R)) Object.keys(R[t]).forEach((d) => alleDagen.add(d));
  for (const t of Object.keys(D)) Object.keys(D[t]).forEach((d) => alleDagen.add(d));

  for (const d of alleDagen) {
    const data: Record<string, number> = {};

    const st = R["steps"]?.[d] ?? {};
    const ae = R["active-energy-burned"]?.[d] ?? {};
    const am = R["active-minutes"]?.[d] ?? {};
    const az = R["active-zone-minutes"]?.[d] ?? {};
    const di = R["distance"]?.[d] ?? {};
    const fl = R["floors"]?.[d] ?? {};
    const sed = R["sedentary-period"]?.[d] ?? {};
    const hr = R["heart-rate"]?.[d] ?? {};

    const s = Number(st.countSum ?? 0);
    const kcal = Number(ae.kcalSum ?? 0);
    const km = Number(di.millimetersSum ?? 0) / 1e6;
    const azm = Number(az.sumInFatBurnHeartZone ?? 0)
      + Number(az.sumInCardioHeartZone ?? 0) * 2
      + Number(az.sumInPeakHeartZone ?? 0) * 2;

    if (s) data.steps = s;
    if (kcal) data.burn = Math.round(kcal);
    if (km) data.km = Math.round(km * 100) / 100;
    if (azm) data.azm = Math.round(azm);
    if (Number(am.minutesSum ?? 0)) data.actmin = Math.round(Number(am.minutesSum));
    if (Number(fl.countSum ?? fl.floorsSum ?? 0)) data.floors = Math.round(Number(fl.countSum ?? fl.floorsSum));
    if (Number(sed.minutesSum ?? 0)) data.sedentary = Math.round(Number(sed.minutesSum));

    // hartslag: min/gemiddeld/max uit de rollup, hoe die velden ook heten
    const hrp = plat(hr);
    for (const [k, v] of Object.entries(hrp)) {
      if (/min/i.test(k)) data.hr_min = v;
      else if (/max/i.test(k)) data.hr_max = v;
      else if (/(avg|mean|average)/i.test(k)) data.hr_avg = Math.round(v);
    }

    // zones (tijd + calorieën per hartzone)
    Object.assign(data, plat(R["time-in-heart-rate-zone"]?.[d], "zonemin"));
    Object.assign(data, plat(R["calories-in-heart-rate-zone"]?.[d], "zonekcal"));
    Object.assign(data, plat(R["swim-lengths-data"]?.[d], "zwem"));

    // dagwaarden
    const rhr = D["daily-resting-heart-rate"]?.[d];
    if (rhr) data.rhr = Math.round(Number(rhr.beatsPerMinute ?? rhr.bpm ?? 0)) || 0;
    const hrv = D["daily-heart-rate-variability"]?.[d];
    if (hrv) Object.assign(data, plat(hrv, "hrv"));
    const ox = D["daily-oxygen-saturation"]?.[d];
    if (ox) Object.assign(data, plat(ox, "spo2"));
    const rr = D["daily-respiratory-rate"]?.[d];
    if (rr) Object.assign(data, plat(rr, "rr"));
    const vo2 = D["daily-vo2-max"]?.[d];
    if (vo2) Object.assign(data, plat(vo2, "vo2"));
    const hz = D["daily-heart-rate-zones"]?.[d];
    if (hz) Object.assign(data, plat(hz, "hz"));
    const hut = D["daily-sleep-temperature-derivations"]?.[d];
    if (hut) Object.assign(data, plat(hut, "temp"));

    for (const k of Object.keys(data)) if (!isFinite(data[k]) || data[k] === 0) delete data[k];
    if (!Object.keys(data).length) continue;

    rijen.push({
      user_id: uid, kind: "activity", source: "fitbit",
      ts: new Date(`${d}T12:00:00Z`).toISOString(),
      title: `Fitbit · ${[
        data.steps ? data.steps.toLocaleString("nl-NL") + " stappen" : "",
        data.km ? data.km + " km" : "",
        data.burn ? data.burn + " kcal" : "",
        data.rhr ? data.rhr + " bpm rust" : "",
      ].filter(Boolean).join(" · ") || "meting"}`,
      ext_id: `fitbit:activity:${d}`, data,
    });
  }

  // ===== slaap =====
  for (const p of slaap) {
    const sl = p.sleep ?? {};
    const sm = sl.summary ?? {};
    const eind = sl.interval?.endTime ?? sl.interval?.civilEndTime;
    if (!eind) continue;
    const d = String(eind).slice(0, 10);
    const uren = Number(sm.minutesAsleep ?? 0) / 60;
    if (!uren) continue;
    const stages: Record<string, number> = {};
    for (const st of sm.stagesSummary ?? []) stages[String(st.type).toLowerCase().replace(/^sleep_stage_/, "")] = Number(st.minutes ?? 0);
    const rrN = rrSlaap.find((x: any) => String(x.respiratoryRateSleepSummary?.sampleTime?.physicalTime ?? "").slice(0, 10) === d);
    rijen.push({
      user_id: uid, kind: "sleep", source: "fitbit", ts: String(eind),
      title: `Fitbit · ${Math.floor(uren)}u ${Math.round((uren % 1) * 60)}m slaap`,
      ext_id: `fitbit:sleep:${d}`,
      data: {
        sleep: Math.round(uren * 100) / 100,
        deep: stages.deep ?? 0, rem: stages.rem ?? 0, light: stages.light ?? 0, awake: stages.awake ?? stages.wake ?? 0,
        inbed: Math.round(Number(sm.minutesInBed ?? sm.timeInBedMinutes ?? 0)),
        efficiency: Number(sm.efficiency ?? 0),
        ...(rrN ? plat(rrN.respiratoryRateSleepSummary, "rr") : {}),
      },
    });
  }

  // ===== trainingen =====
  for (const p of training) {
    const ex = p.exercise ?? {};
    const start = ex.interval?.startTime ?? ex.interval?.civilStartTime;
    if (!start) continue;
    const id = p.metadata?.id ?? p.id ?? String(start);
    const d = plat(ex);
    rijen.push({
      user_id: uid, kind: "exercise", source: "fitbit", ts: String(start),
      title: `Fitbit · ${ex.exerciseType ?? ex.type ?? "training"}${d.activeDurationMillis ? " · " + Math.round(d.activeDurationMillis / 60000) + " min" : ""}`,
      ext_id: `fitbit:exercise:${id}`,
      data: { soort: String(ex.exerciseType ?? ex.type ?? ""), ...d } as any,
    });
  }

  // ===== metingen =====
  const vetOp: Record<string, number> = {};
  for (const p of vet) {
    const t = p.bodyFat?.sampleTime?.physicalTime;
    if (t) vetOp[String(t).slice(0, 10)] = Number(p.bodyFat.percentage ?? 0);
  }
  for (const p of weging) {
    const t = p.weight?.sampleTime?.physicalTime;
    const kg = Number(p.weight?.weightGrams ?? 0) / 1000 || Number(p.weight?.kilograms ?? 0);
    if (!t || !kg) continue;
    const d = String(t).slice(0, 10);
    rijen.push({
      user_id: uid, kind: "weight", source: "fitbit", ts: t,
      title: `Fitbit · ${Math.round(kg * 10) / 10} kg`, ext_id: `fitbit:weight:${d}`,
      data: { weight: Math.round(kg * 10) / 10, ...(vetOp[d] ? { bodyfat: vetOp[d] } : {}) },
    });
  }

  const meting = (lijst: any[], veld: string, kind: string, label: (v: any) => string) => {
    for (const p of lijst) {
      const v = p[veld];
      const t = v?.sampleTime?.physicalTime;
      if (!t) continue;
      rijen.push({
        user_id: uid, kind, source: "fitbit", ts: t,
        title: `Fitbit · ${label(v)}`,
        ext_id: `fitbit:${kind}:${String(t)}`,
        data: plat(v),
      });
    }
  };
  meting(lengte, "height", "meting", (v) => `${Math.round(Number(v.heightMillimeters ?? 0) / 10)} cm lang`);
  meting(glucose, "bloodGlucose", "meting", (v) => `glucose ${Number(v.milligramsPerDeciliter ?? v.value ?? 0)}`);
  meting(temp, "coreBodyTemperature", "meting", (v) => `temperatuur ${Number(v.celsius ?? 0).toFixed(1)}°C`);
  meting(spo2, "oxygenSaturation", "meting", (v) => `SpO₂ ${Number(v.percentage ?? 0).toFixed(0)}%`);

  if (rijen.length) {
    const { error } = await db.from("health_entries").upsert(rijen, { onConflict: "user_id,ext_id" });
    if (error) throw error;
  }
  await db.from("google_health").update({
    last_sync: new Date().toISOString(),
    last_error: fouten.length ? fouten.join(" | ").slice(0, 500) : null,
  }).eq("user_id", uid);

  return {
    rijen: rijen.length,
    dagen: alleDagen.size,
    slaap: slaap.length,
    trainingen: training.length,
    wegingen: weging.length,
    metingen: lengte.length + glucose.length + temp.length + spo2.length,
    fouten,
  };
}

// ---------- probe: wat geeft Google écht terug? ----------
async function probe(uid: string, dagen = 14) {
  const token = await versToken(uid);
  const tot = new Date();
  const van = new Date(); van.setDate(van.getDate() - dagen);
  const uit: Record<string, unknown> = {};

  const rollupTypes = ["steps", "active-energy-burned", "active-minutes", "active-zone-minutes", "distance", "floors",
    "sedentary-period", "calories-in-heart-rate-zone", "time-in-heart-rate-zone", "heart-rate", "altitude", "swim-lengths-data"];
  for (const t of rollupTypes) {
    try {
      const r = await rollup(token, t, van, tot);
      const k = Object.keys(r)[0];
      uit[t] = k ? { dagen: Object.keys(r).length, voorbeeld: r[k] } : "geen data";
    } catch (e) { uit[t] = "FOUT " + (e as Error).message; }
  }

  const dailyTypes: [string, string][] = [
    ["daily-resting-heart-rate", "daily_resting_heart_rate"],
    ["daily-heart-rate-variability", "daily_heart_rate_variability"],
    ["daily-oxygen-saturation", "daily_oxygen_saturation"],
    ["daily-respiratory-rate", "daily_respiratory_rate"],
    ["daily-vo2-max", "daily_vo2_max"],
    ["daily-heart-rate-zones", "daily_heart_rate_zones"],
    ["daily-sleep-temperature-derivations", "daily_sleep_temperature_derivations"],
  ];
  for (const [t, f] of dailyTypes) {
    try {
      const r = await dagelijks(token, t, f, van);
      const k = Object.keys(r)[0];
      uit[t] = k ? { dagen: Object.keys(r).length, voorbeeld: r[k] } : "geen data";
    } catch (e) { uit[t] = "FOUT " + (e as Error).message; }
  }

  const sampleTypes: [string, string][] = [
    ["weight", "weight"], ["body-fat", "body_fat"], ["height", "height"],
    ["blood-glucose", "blood_glucose"], ["core-body-temperature", "core_body_temperature"],
    ["oxygen-saturation", "oxygen_saturation"], ["respiratory-rate-sleep-summary", "respiratory_rate_sleep_summary"],
    ["heart-rate-variability", "heart_rate_variability"], ["vo2-max", "vo2_max"], ["run-vo2-max", "run_vo2_max"],
  ];
  for (const [t, f] of sampleTypes) {
    try {
      const r = await samples(token, t, f, van, 3);
      uit[t] = r.length ? { punten: r.length, voorbeeld: r[0] } : "geen data";
    } catch (e) { uit[t] = "FOUT " + (e as Error).message; }
  }

  for (const [t, f] of [["sleep", "sleep.interval.civil_end_time"], ["exercise", "exercise.interval.civil_end_time"]]) {
    try {
      const j = await ghGet(token, `dataTypes/${t}/dataPoints?pageSize=2&filter=${encodeURIComponent(`${f} >= "${dagStr(van)}"`)}`);
      uit[t] = (j.dataPoints ?? []).length ? { punten: j.dataPoints.length, voorbeeld: j.dataPoints[0] } : "geen data";
    } catch (e) { uit[t] = "FOUT " + (e as Error).message; }
  }

  try { uit["_profiel"] = await ghGet(token, "profile"); } catch (e) { uit["_profiel"] = "FOUT " + (e as Error).message; }

  return uit;
}

// ---------- webhook ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) {
    const fout = url.searchParams.get("error");
    const state = url.searchParams.get("state") ?? "";
    if (fout) return Response.redirect(`${APP_URL}#hgoals`, 302);

    const { data: rij } = await db.from("google_health").select("user_id").eq("state", state).maybeSingle();
    if (!rij) return new Response("Onbekende state. Start de koppeling opnieuw vanuit de app.", { status: 400 });

    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code")!, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT, grant_type: "authorization_code",
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) {
      return new Response(`Koppelen mislukt: ${JSON.stringify(j).slice(0, 300)}`, { status: 400 });
    }

    let hid: string | null = null;
    try {
      const ident = await fetch(`${API}/identity`, { headers: { Authorization: `Bearer ${j.access_token}` } });
      if (ident.ok) hid = (await ident.json()).healthUserId ?? null;
    } catch { /* niet fataal */ }

    await db.from("google_health").update({
      refresh_token: j.refresh_token,
      access_token: j.access_token,
      expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString(),
      health_user_id: hid, state: null, last_error: null,
    }).eq("user_id", rij.user_id);

    try { await sync(rij.user_id, 90); } catch { /* eerste sync mag falen */ }
    return Response.redirect(`${APP_URL}#hfit`, 302);
  }

  const auth = req.headers.get("Authorization") ?? "";
  const { data: u } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  const uid = u?.user?.id;
  if (!uid) return json({ error: "Niet ingelogd." }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* leeg is ok */ }

  try {
    if (body.action === "authurl") {
      const state = crypto.randomUUID();
      await db.from("google_health").upsert({ user_id: uid, state }, { onConflict: "user_id" });
      const p = new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code",
        scope: SCOPES, access_type: "offline", prompt: "consent", state,
      });
      return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${p}` });
    }
    if (body.action === "sync") return json(await sync(uid, Number(body.dagen ?? 30)));
    if (body.action === "probe") return json(await probe(uid, Number(body.dagen ?? 14)));
    if (body.action === "status") {
      const { data } = await db.from("google_health").select("last_sync,last_error,refresh_token").eq("user_id", uid).maybeSingle();
      return json({ gekoppeld: !!data?.refresh_token, last_sync: data?.last_sync ?? null, last_error: data?.last_error ?? null });
    }
    if (body.action === "unlink") {
      await db.from("google_health").delete().eq("user_id", uid);
      return json({ ok: true });
    }
    return json({ error: "Onbekende actie." }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
});
