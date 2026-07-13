// ============================================================
//  Supabase Edge Function: "fitbit"
//  Koppelt je Fitbit via de Google Health API (de opvolger van de
//  Fitbit Web API, die in september 2026 wordt uitgezet).
//
//  Verify JWT moet UIT staan: Google roept de callback aan zonder JWT.
//  Aanroepen vanuit de app worden zelf gecontroleerd op een geldige sessie.
//
//  Secrets:
//    GOOGLE_CLIENT_ID
//    GOOGLE_CLIENT_SECRET
//    APP_URL              (bv. https://sjoerdspil-coder.github.io/financien/)
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

  // nog geldig? dan hergebruiken
  if (rij.access_token && rij.expires_at && new Date(rij.expires_at) > new Date(Date.now() + 60_000)) {
    return rij.access_token as string;
  }

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: rij.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    // refresh token verlopen (gebeurt na 7 dagen als je Cloud-project op "Testing" staat)
    await db.from("google_health").update({ last_error: `Token vernieuwen mislukt: ${JSON.stringify(j).slice(0, 200)}` }).eq("user_id", uid);
    throw new Error("Je Google-koppeling is verlopen. Koppel opnieuw. (Staat je Cloud-project nog op Testing? Zet hem op In Production, anders verloopt de koppeling elke 7 dagen.)");
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
  if (!r.ok) throw new Error(`Google Health ${r.status} op ${pad.split("?")[0]}: ${(await r.text()).slice(0, 150)}`);
  return await r.json();
};
const ghPost = async (token: string, pad: string, body: unknown) => {
  const r = await fetch(`${API}/${pad}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Google Health ${r.status} op ${pad}: ${(await r.text()).slice(0, 150)}`);
  return await r.json();
};

const civil = (d: Date, eind = false) => ({
  date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
  time: eind ? { hours: 23, minutes: 59, seconds: 59 } : { hours: 0, minutes: 0, seconds: 0 },
});
const datum = (c: any) =>
  `${c.date.year}-${String(c.date.month).padStart(2, "0")}-${String(c.date.day).padStart(2, "0")}`;

/* Dagtotalen ophalen per datatype. Faalt er één, dan gaan de rest gewoon door. */
async function dagTotalen(token: string, type: string, van: Date, tot: Date) {
  const j = await ghPost(token, `dataTypes/${type}/dataPoints:dailyRollUp`, {
    range: { start: civil(van), end: civil(tot, true) },
    windowSizeDays: 1,
  });
  const uit: Record<string, any> = {};
  for (const p of j.rollupDataPoints ?? []) {
    const d = datum(p.civilStartTime);
    const veld = Object.keys(p).find((k) => !["civilStartTime", "civilEndTime", "startTime", "endTime"].includes(k));
    if (veld) uit[d] = p[veld];
  }
  return uit;
}

// ---------- synchroniseren ----------
async function sync(uid: string, dagen = 14) {
  const token = await versToken(uid);
  const tot = new Date();
  const van = new Date(); van.setDate(van.getDate() - dagen);

  const fouten: string[] = [];
  const veilig = async <T>(naam: string, f: () => Promise<T>): Promise<T | null> => {
    try { return await f(); } catch (e) { fouten.push(`${naam}: ${(e as Error).message}`); return null; }
  };

  const stappen = await veilig("stappen", () => dagTotalen(token, "steps", van, tot)) ?? {};
  const actKcal = await veilig("actieve calorieën", () => dagTotalen(token, "active-energy-burned", van, tot)) ?? {};
  const totKcal = await veilig("totale calorieën", () => dagTotalen(token, "total-calories", van, tot)) ?? {};
  const azm = await veilig("actieve zone-minuten", () => dagTotalen(token, "active-zone-minutes", van, tot)) ?? {};
  const afstand = await veilig("afstand", () => dagTotalen(token, "distance", van, tot)) ?? {};

  const rust = await veilig("rusthartslag", async () => {
    const j = await ghGet(token, `dataTypes/daily-resting-heart-rate/dataPoints?filter=${encodeURIComponent(`daily_resting_heart_rate.date >= "${van.toISOString().slice(0, 10)}"`)}`);
    const m: Record<string, number> = {};
    for (const p of j.dataPoints ?? []) {
      const v = p.dailyRestingHeartRate;
      if (v?.date) m[datum({ date: v.date })] = Number(v.beatsPerMinute ?? v.bpm ?? 0);
    }
    return m;
  }) ?? {};

  const slaap = await veilig("slaap", async () => {
    const j = await ghGet(token, `dataTypes/sleep/dataPoints?filter=${encodeURIComponent(`sleep.interval.civil_end_time >= "${van.toISOString().slice(0, 10)}"`)}`);
    return (j.dataPoints ?? []).filter((p: any) => p.sleep?.metadata?.main !== false);
  }) ?? [];

  const weging = await veilig("gewicht", async () => {
    const j = await ghGet(token, `dataTypes/weight/dataPoints?filter=${encodeURIComponent(`weight.sample_time.physical_time >= "${van.toISOString()}"`)}`);
    return j.dataPoints ?? [];
  }) ?? [];

  const vet = await veilig("vetpercentage", async () => {
    const j = await ghGet(token, `dataTypes/body-fat/dataPoints?filter=${encodeURIComponent(`body_fat.sample_time.physical_time >= "${van.toISOString()}"`)}`);
    return j.dataPoints ?? [];
  }) ?? [];

  const rijen: any[] = [];

  // één beweegregel per dag
  const alleDagen = new Set([...Object.keys(stappen), ...Object.keys(actKcal), ...Object.keys(azm)]);
  for (const d of alleDagen) {
    const data: Record<string, number> = {};
    const s = Number(stappen[d]?.countSum ?? 0);
    const ak = Number(actKcal[d]?.energyKilocaloriesSum ?? actKcal[d]?.kilocaloriesSum ?? 0);
    const tk = Number(totKcal[d]?.energyKilocaloriesSum ?? totKcal[d]?.kilocaloriesSum ?? 0);
    const az = Number(azm[d]?.minutesSum ?? azm[d]?.countSum ?? 0);
    const km = Number(afstand[d]?.distanceMillimetersSum ?? 0) / 1e6;
    const hr = Number(rust[d] ?? 0);
    if (s) data.steps = s;
    if (az) data.minutes = az;
    if (ak || tk) data.burn = ak || tk;
    if (km) data.km = Math.round(km * 100) / 100;
    if (hr) data.rhr = hr;
    if (!Object.keys(data).length) continue;
    rijen.push({
      user_id: uid, kind: "activity", source: "fitbit",
      ts: new Date(`${d}T12:00:00Z`).toISOString(),
      title: `Fitbit · ${s ? s.toLocaleString("nl-NL") + " stappen" : "beweging"}`,
      ext_id: `fitbit:activity:${d}`, data,
    });
  }

  for (const p of slaap) {
    const sm = p.sleep?.summary ?? {};
    const eind = p.sleep?.interval?.endTime;
    if (!eind) continue;
    const d = eind.slice(0, 10);
    const uren = Number(sm.minutesAsleep ?? 0) / 60;
    if (!uren) continue;
    const stages: Record<string, number> = {};
    for (const st of sm.stagesSummary ?? []) stages[String(st.type).toLowerCase()] = Number(st.minutes ?? 0);
    rijen.push({
      user_id: uid, kind: "sleep", source: "fitbit", ts: eind,
      title: `Fitbit · ${Math.floor(uren)}u ${Math.round((uren % 1) * 60)}m slaap`,
      ext_id: `fitbit:sleep:${d}`,
      data: {
        sleep: Math.round(uren * 100) / 100,
        deep: stages.deep ?? 0, rem: stages.rem ?? 0, light: stages.light ?? 0, awake: stages.awake ?? 0,
      },
    });
  }

  const vetOp: Record<string, number> = {};
  for (const p of vet) {
    const t = p.bodyFat?.sampleTime?.physicalTime;
    if (t) vetOp[t.slice(0, 10)] = Number(p.bodyFat.percentage ?? 0);
  }
  for (const p of weging) {
    const t = p.weight?.sampleTime?.physicalTime;
    const kg = Number(p.weight?.kilograms ?? p.weight?.weightKilograms ?? 0);
    if (!t || !kg) continue;
    const d = t.slice(0, 10);
    rijen.push({
      user_id: uid, kind: "weight", source: "fitbit", ts: t,
      title: `Fitbit · ${kg} kg`, ext_id: `fitbit:weight:${d}`,
      data: { weight: kg, ...(vetOp[d] ? { bodyfat: vetOp[d] } : {}) },
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

  return { rijen: rijen.length, dagen: alleDagen.size, slaap: slaap.length, wegingen: weging.length, fouten };
}

// ---------- webhook ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // --- Google stuurt de gebruiker hier terug na toestemming ---
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
        code: url.searchParams.get("code")!,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) {
      return new Response(
        `Koppelen mislukt: ${JSON.stringify(j).slice(0, 300)}\n\n` +
        `Krijg je geen refresh_token? Trek de toegang in op https://myaccount.google.com/permissions en probeer opnieuw.`,
        { status: 400 },
      );
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
      health_user_id: hid,
      state: null,
      last_error: null,
    }).eq("user_id", rij.user_id);

    try { await sync(rij.user_id, 30); } catch { /* eerste sync mag falen */ }
    return Response.redirect(`${APP_URL}#hgoals`, 302);
  }

  // --- aanroepen vanuit de app: eigen sessiecontrole ---
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(jwt);
  const uid = u?.user?.id;
  if (!uid) return json({ error: "Niet ingelogd." }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* leeg is ok */ }

  try {
    if (body.action === "authurl") {
      const state = crypto.randomUUID();
      await db.from("google_health").upsert({ user_id: uid, state }, { onConflict: "user_id" });
      const p = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        state,
      });
      return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${p}` });
    }

    if (body.action === "sync") {
      return json(await sync(uid, Number(body.dagen ?? 14)));
    }

    if (body.action === "status") {
      const { data } = await db.from("google_health").select("last_sync,last_error,health_user_id,refresh_token").eq("user_id", uid).maybeSingle();
      return json({
        gekoppeld: !!data?.refresh_token,
        last_sync: data?.last_sync ?? null,
        last_error: data?.last_error ?? null,
      });
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
