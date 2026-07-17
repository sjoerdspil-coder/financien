// ============================================================
//  Supabase Edge Function: "fitbit"  (v10 — alles wat Google Health geeft, blokgrootte per datatype)
//  Scopes: activity_and_fitness · health_metrics_and_measurements · sleep
//  Verify JWT: UIT.  Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL
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

async function versToken(uid: string) {
  const { data: rij } = await db.from("google_health").select("*").eq("user_id", uid).maybeSingle();
  if (!rij?.refresh_token) throw new Error("Nog niet gekoppeld met Google Health.");
  if (rij.access_token && rij.expires_at && new Date(rij.expires_at) > new Date(Date.now() + 60_000)) return rij.access_token as string;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: rij.refresh_token, grant_type: "refresh_token" }),
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
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).replace(/\s+/g," ").slice(0, 400)}`);
  return await r.json();
};

const civil = (d: Date, eind = false) => ({
  date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
  time: eind ? { hours: 23, minutes: 59, seconds: 59 } : { hours: 0, minutes: 0, seconds: 0 },
});
const datum = (c: any) => `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
const dagStr = (d: Date) => d.toISOString().slice(0, 10);
const sec = (v: any) => Number(String(v ?? "0").replace(/s$/, "")) || 0;   // "27180s" -> 27180
const num = (v: any) => Number(v ?? 0) || 0;

// Hoeveel dagen mag je per verzoek opvragen? Google verschilt per datatype;
// deze drie staan op 14, de rest op 30. Bij een fout halveren we vanzelf.
const BLOK: Record<string, number> = {
  "total-calories": 14, "active-minutes": 14, "calories-in-heart-rate-zone": 14,
};

// Interval-types: dagtotalen, opgevraagd in blokken.
async function rollup(token: string, type: string, van: Date, tot: Date) {
  const uit: Record<string, any> = {};
  const dagen = BLOK[type] ?? 30;
  let start = new Date(van);
  while (start < tot) {
    const eind = new Date(start); eind.setDate(eind.getDate() + dagen - 1);
    if (eind > tot) eind.setTime(tot.getTime());
    const j = await ghPost(token, `dataTypes/${type}/dataPoints:dailyRollUp`, {
      range: { start: civil(start), end: civil(eind, true) }, windowSizeDays: 1,
    });
    for (const p of j.rollupDataPoints ?? []) {
      const d = p.civilStartTime?.date ? datum(p.civilStartTime.date) : null;
      if (!d) continue;
      const veld = Object.keys(p).find((k) => !["civilStartTime", "civilEndTime", "startTime", "endTime"].includes(k));
      if (veld) uit[d] = p[veld];
    }
    start = new Date(eind); start.setDate(start.getDate() + 1);
  }
  return uit;
}

// Daily-types
async function dagelijks(token: string, type: string, filterVeld: string, van: Date) {
  const j = await ghGet(token, `dataTypes/${type}/dataPoints?pageSize=200&filter=${encodeURIComponent(`${filterVeld}.date >= "${dagStr(van)}"`)}`);
  const uit: Record<string, any> = {};
  for (const p of j.dataPoints ?? []) {
    const veld = Object.keys(p).find((k) => !["dataOrigin", "metadata", "dataSource", "name"].includes(k));
    const v = veld ? p[veld] : null;
    if (v?.date) uit[datum(v.date)] = v;
  }
  return uit;
}

// Sample-types
async function samples(token: string, type: string, filterVeld: string, van: Date, pageSize = 1000) {
  const j = await ghGet(token, `dataTypes/${type}/dataPoints?pageSize=${pageSize}&filter=${encodeURIComponent(`${filterVeld}.sample_time.physical_time >= "${van.toISOString()}"`)}`);
  return (j.dataPoints ?? []) as any[];
}

// Sessies (sleep/exercise): meerdere filtervarianten proberen
async function sessies(token: string, type: string, veld: string, van: Date) {
  const varianten = [
    `${veld}.interval.civil_end_time >= "${dagStr(van)}"`,
    `${veld}.interval.end_time >= "${van.toISOString()}"`,
    `${veld}.interval.civil_start_time >= "${dagStr(van)}"`,
  ];
  let laatste = "";
  for (const f of varianten) {
    try {
      const j = await ghGet(token, `dataTypes/${type}/dataPoints?pageSize=200&filter=${encodeURIComponent(f)}`);
      return (j.dataPoints ?? []) as any[];
    } catch (e) { laatste = (e as Error).message; }
  }
  try {
    const j = await ghGet(token, `dataTypes/${type}/dataPoints?pageSize=200`);
    return (j.dataPoints ?? []) as any[];
  } catch { throw new Error(laatste); }
}

// ---------- synchroniseren ----------
async function sync(uid: string, dagen = 90) {
  const token = await versToken(uid);
  const tot = new Date();
  const van = new Date(); van.setDate(van.getDate() - dagen);

  const fouten: string[] = [];
  const veilig = async <T>(naam: string, f: () => Promise<T>): Promise<T | null> => {
    try { return await f(); } catch (e) { fouten.push(`${naam}: ${(e as Error).message}`); return null; }
  };

  const R: Record<string, Record<string, any>> = {};
  const rollupTypes: [string, string][] = [
    ["steps", "stappen"], ["active-energy-burned", "actieve calorieën"], ["total-calories", "totaal verbrand"],
    ["active-minutes", "actieve minuten"], ["active-zone-minutes", "zone-minuten"],
    ["distance", "afstand"], ["floors", "trappen"], ["sedentary-period", "zitten"],
    ["calories-in-heart-rate-zone", "calorieën per hartzone"],
    ["time-in-heart-rate-zone", "tijd per hartzone"], ["swim-lengths-data", "zwemmen"], ["altitude", "hoogte"],
  ];
  for (const [t, naam] of rollupTypes) R[t] = await veilig(naam, () => rollup(token, t, van, tot)) ?? {};

  const D: Record<string, Record<string, any>> = {};
  const dailyTypes: [string, string, string][] = [
    ["daily-resting-heart-rate", "daily_resting_heart_rate", "rusthartslag"],
    ["daily-heart-rate-variability", "daily_heart_rate_variability", "hrv (dag)"],
    ["daily-oxygen-saturation", "daily_oxygen_saturation", "spo2 (dag)"],
    ["daily-respiratory-rate", "daily_respiratory_rate", "ademhaling (dag)"],
    ["daily-vo2-max", "daily_vo2_max", "vo2max"],
    ["daily-heart-rate-zones", "daily_heart_rate_zones", "hartzones"],
    ["daily-sleep-temperature-derivations", "daily_sleep_temperature_derivations", "huidtemperatuur"],
  ];
  for (const [t, f, naam] of dailyTypes) D[t] = await veilig(naam, () => dagelijks(token, t, f, van)) ?? {};

  const weging = await veilig("gewicht", () => samples(token, "weight", "weight", van)) ?? [];
  const vet = await veilig("vetpercentage", () => samples(token, "body-fat", "body_fat", van)) ?? [];
  const lengte = await veilig("lengte", () => samples(token, "height", "height", van, 5)) ?? [];
  const hrvS = await veilig("hartslagvariabiliteit", () => samples(token, "heart-rate-variability", "heart_rate_variability", van)) ?? [];
  const spo2S = await veilig("zuurstofsaturatie", () => samples(token, "oxygen-saturation", "oxygen_saturation", van)) ?? [];
  const rrS = await veilig("ademhaling in slaap", () => samples(token, "respiratory-rate-sleep-summary", "respiratory_rate_sleep_summary", van)) ?? [];
  const tempS = await veilig("lichaamstemperatuur", () => samples(token, "core-body-temperature", "core_body_temperature", van)) ?? [];
  const glucS = await veilig("bloedglucose", () => samples(token, "blood-glucose", "blood_glucose", van)) ?? [];

  const slaap = await veilig("slaap", () => sessies(token, "sleep", "sleep", van)) ?? [];
  const training = await veilig("trainingen", () => sessies(token, "exercise", "exercise", van)) ?? [];

  // per dag groeperen: samples -> dag
  const perDag = (lijst: any[], veld: string, f: (v: any) => number) => {
    const m: Record<string, number[]> = {};
    for (const p of lijst) {
      const t = p[veld]?.sampleTime?.physicalTime;
      const w = f(p[veld]);
      if (!t || !w) continue;
      const d = String(t).slice(0, 10);
      (m[d] = m[d] ?? []).push(w);
    }
    return m;
  };
  const hrvD = perDag(hrvS, "heartRateVariability", (v) => num(v.rootMeanSquareOfSuccessiveDifferencesMilliseconds));
  const spo2D = perDag(spo2S, "oxygenSaturation", (v) => num(v.percentage));
  const rrD = perDag(rrS, "respiratoryRateSleepSummary", (v) => num(v.fullSleepSummary?.breathsPerMinute ?? v.deepSleepStats?.breathsPerMinute));
  const tempD = perDag(tempS, "coreBodyTemperature", (v) => num(v.celsius ?? v.degreesCelsius));
  const glucD = perDag(glucS, "bloodGlucose", (v) => num(v.milligramsPerDeciliter ?? v.value));
  const gem = (a?: number[]) => (a && a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : 0);

  const rijen: any[] = [];
  const alleDagen = new Set<string>();
  for (const t of Object.keys(R)) Object.keys(R[t]).forEach((d) => alleDagen.add(d));
  for (const t of Object.keys(D)) Object.keys(D[t]).forEach((d) => alleDagen.add(d));
  for (const m of [hrvD, spo2D, rrD, tempD, glucD]) Object.keys(m).forEach((d) => alleDagen.add(d));

  for (const d of alleDagen) {
    const data: Record<string, number> = {};
    const st = R["steps"]?.[d] ?? {};
    const ae = R["active-energy-burned"]?.[d] ?? {};
    const az = R["active-zone-minutes"]?.[d] ?? {};
    const di = R["distance"]?.[d] ?? {};
    const fl = R["floors"]?.[d] ?? {};
    const sd = R["sedentary-period"]?.[d] ?? {};
    const zw = R["swim-lengths-data"]?.[d] ?? {};
    const al = R["altitude"]?.[d] ?? {};

    const tc = R["total-calories"]?.[d] ?? {};
    const am = R["active-minutes"]?.[d] ?? {};
    const s = num(st.countSum);
    const kcal = num(ae.kcalSum);
    const totKcal = num(tc.kcalSum);
    const km = num(di.millimetersSum) / 1e6;
    const azmFat = num(az.sumInFatBurnHeartZone);
    const azmCar = num(az.sumInCardioHeartZone);
    const azmPeak = num(az.sumInPeakHeartZone);
    const azm = azmFat + azmCar * 2 + azmPeak * 2;

    if (s) data.steps = Math.round(s);
    if (kcal) data.burn = Math.round(kcal);
    if (totKcal) {
      data.kcal_totaal = Math.round(totKcal);
      // wat je verbrandt zonder te bewegen: totaal min actief
      if (kcal) data.kcal_rust = Math.round(totKcal - kcal);
    }
    if (num(am.minutesSum ?? am.durationSum)) data.actmin = Math.round(sec(am.durationSum) / 60) || Math.round(num(am.minutesSum));
    if (km) data.km = Math.round(km * 100) / 100;
    if (azm) { data.azm = Math.round(azm); data.azm_fatburn = azmFat; data.azm_cardio = azmCar; data.azm_peak = azmPeak; }
    if (num(fl.countSum)) data.floors = Math.round(num(fl.countSum));
    if (sd.durationSum) data.sedentary = Math.round(sec(sd.durationSum) / 60);
    if (zw.strokeCountSum) data.zwemslagen = Math.round(num(zw.strokeCountSum));
    if (al.metersSum || al.millimetersSum) data.hoogtemeters = Math.round(num(al.metersSum) || num(al.millimetersSum) / 1000);

    // tijd per hartslagzone (minuten)
    for (const z of R["time-in-heart-rate-zone"]?.[d]?.timeInHeartRateZones ?? []) {
      const min = Math.round(sec(z.duration) / 60);
      if (min) data[`zone_${String(z.heartRateZone).toLowerCase()}`] = min;
    }
    // calorieën per hartslagzone
    const kz = R["calories-in-heart-rate-zone"]?.[d] ?? {};
    for (const z of kz.caloriesInHeartRateZones ?? kz.caloriesInHeartRateZone ?? []) {
      const k = Math.round(num(z.kcal ?? z.calories));
      if (k) data[`zonekcal_${String(z.heartRateZone).toLowerCase()}`] = k;
    }

    const rhr = D["daily-resting-heart-rate"]?.[d];
    if (rhr) data.rhr = Math.round(num(rhr.beatsPerMinute ?? rhr.bpm));
    const vo2 = D["daily-vo2-max"]?.[d];
    if (vo2) data.vo2max = Math.round(num(vo2.vo2Max ?? vo2.value ?? vo2.millilitersPerMinutePerKilogram) * 10) / 10;
    const hut = D["daily-sleep-temperature-derivations"]?.[d];
    if (hut) data.huidtemp = Math.round(num(hut.temperatureDeltaCelsius ?? hut.deltaCelsius) * 100) / 100;

    if (gem(hrvD[d])) data.hrv = gem(hrvD[d]);
    if (gem(spo2D[d])) data.spo2 = gem(spo2D[d]);
    if (gem(rrD[d])) data.ademhaling = gem(rrD[d]);
    if (gem(tempD[d])) data.temp = gem(tempD[d]);
    if (gem(glucD[d])) data.glucose = gem(glucD[d]);

    for (const k of Object.keys(data)) if (!isFinite(data[k]) || !data[k]) delete data[k];
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

  // ----- slaap: stages optellen (er is geen summary) -----
  for (const p of slaap) {
    const sl = p.sleep ?? {};
    const start = sl.interval?.startTime;
    const eind = sl.interval?.endTime;
    if (!start || !eind) continue;
    const d = String(eind).slice(0, 10);
    const min: Record<string, number> = { deep: 0, rem: 0, light: 0, awake: 0, unknown: 0 };
    for (const st of sl.stages ?? []) {
      const m = (new Date(st.endTime).getTime() - new Date(st.startTime).getTime()) / 60000;
      const t = String(st.type ?? "").toLowerCase().replace(/^sleep_stage_/, "");
      if (m > 0) min[t in min ? t : "unknown"] += m;
    }
    const inbed = (new Date(eind).getTime() - new Date(start).getTime()) / 60000;
    const asleep = min.deep + min.rem + min.light;
    if (!asleep) continue;
    const rrN = rrS.find((x: any) => String(x.respiratoryRateSleepSummary?.sampleTime?.physicalTime ?? "").slice(0, 10) === d);
    const rrV = rrN?.respiratoryRateSleepSummary ?? {};
    rijen.push({
      user_id: uid, kind: "sleep", source: "fitbit", ts: String(eind),
      title: `Fitbit · ${Math.floor(asleep / 60)}u ${Math.round(asleep % 60)}m slaap`,
      ext_id: `fitbit:sleep:${d}`,
      data: {
        sleep: Math.round((asleep / 60) * 100) / 100,
        deep: Math.round(min.deep), rem: Math.round(min.rem), light: Math.round(min.light), awake: Math.round(min.awake),
        inbed: Math.round(inbed),
        efficiency: inbed ? Math.round((asleep / inbed) * 100) : 0,
        bedtijd: new Date(start).getUTCHours() * 60 + new Date(start).getUTCMinutes(),
        ...(num(rrV.fullSleepSummary?.breathsPerMinute) ? { ademhaling: num(rrV.fullSleepSummary.breathsPerMinute) } : {}),
        ...(num(rrV.deepSleepStats?.breathsPerMinute) ? { ademhaling_diep: num(rrV.deepSleepStats.breathsPerMinute) } : {}),
        ...(num(rrV.remSleepStats?.breathsPerMinute) ? { ademhaling_rem: num(rrV.remSleepStats.breathsPerMinute) } : {}),
      },
    });
  }

  // ----- trainingen -----
  for (const p of training) {
    const ex = p.exercise ?? {};
    const start = ex.interval?.startTime;
    if (!start) continue;
    const eind = ex.interval?.endTime ?? start;
    const minuten = Math.round((new Date(eind).getTime() - new Date(start).getTime()) / 60000);
    const soort = String(ex.exerciseType ?? ex.type ?? "training").toLowerCase().replace(/_/g, " ");
    rijen.push({
      user_id: uid, kind: "exercise", source: "fitbit", ts: String(start),
      title: `Fitbit · ${soort}${minuten ? " · " + minuten + " min" : ""}`,
      ext_id: `fitbit:exercise:${String(start)}`,
      data: {
        soort, minuten,
        ...(num(ex.calories?.kcal ?? ex.energyBurned?.kcal) ? { burn: Math.round(num(ex.calories?.kcal ?? ex.energyBurned?.kcal)) } : {}),
        ...(num(ex.distance?.millimeters) ? { km: Math.round(num(ex.distance.millimeters) / 1e6 * 100) / 100 } : {}),
        ...(num(ex.steps?.count) ? { steps: Math.round(num(ex.steps.count)) } : {}),
      },
    });
  }

  // ----- gewicht / vet / lengte -----
  const vetOp: Record<string, number> = {};
  for (const p of vet) {
    const t = p.bodyFat?.sampleTime?.physicalTime;
    if (t) vetOp[String(t).slice(0, 10)] = num(p.bodyFat.percentage);
  }
  for (const p of weging) {
    const t = p.weight?.sampleTime?.physicalTime;
    const kg = num(p.weight?.weightGrams) / 1000 || num(p.weight?.kilograms);
    if (!t || !kg) continue;
    const d = String(t).slice(0, 10);
    rijen.push({
      user_id: uid, kind: "weight", source: "fitbit", ts: t,
      title: `Fitbit · ${Math.round(kg * 10) / 10} kg`, ext_id: `fitbit:weight:${d}`,
      data: { weight: Math.round(kg * 10) / 10, ...(vetOp[d] ? { bodyfat: vetOp[d] } : {}) },
    });
  }
  for (const p of lengte) {
    const t = p.height?.sampleTime?.physicalTime;
    const cm = num(p.height?.heightMillimeters) / 10 || num(p.height?.centimeters);
    if (!t || !cm) continue;
    rijen.push({
      user_id: uid, kind: "meting", source: "fitbit", ts: t,
      title: `Fitbit · ${Math.round(cm)} cm lang`, ext_id: `fitbit:height:${String(t).slice(0, 10)}`,
      data: { lengte: Math.round(cm) },
    });
  }

  if (rijen.length) {
    const { error } = await db.from("health_entries").upsert(rijen, { onConflict: "user_id,ext_id" });
    if (error) throw error;
  }
  await db.from("google_health").update({
    last_sync: new Date().toISOString(),
    last_error: fouten.length ? fouten.join(" | ").slice(0, 500) : null,
  }).eq("user_id", uid);

  return {
    rijen: rijen.length, dagen: alleDagen.size, slaap: slaap.length, trainingen: training.length,
    wegingen: weging.length, hrv: hrvS.length, spo2: spo2S.length, ademhaling: rrS.length, fouten,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) {
    const state = url.searchParams.get("state") ?? "";
    if (url.searchParams.get("error")) return Response.redirect(`${APP_URL}#hfit`, 302);
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
    if (!r.ok || !j.refresh_token) return new Response(`Koppelen mislukt: ${JSON.stringify(j).slice(0, 300)}`, { status: 400 });

    await db.from("google_health").update({
      refresh_token: j.refresh_token, access_token: j.access_token,
      expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString(),
      state: null, last_error: null,
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
    if (body.action === "sync") return json(await sync(uid, Number(body.dagen ?? 90)));
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
