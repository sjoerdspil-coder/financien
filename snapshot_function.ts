// ============================================================
//  Supabase Edge Function: "snapshot"
//  Draait elke nacht om 00:00 (via pg_cron) en legt de waarde van je
//  prijsgevoelige beleggingen vast. Het rendement van die dag is het
//  verschil met de vorige momentopname.
//
//  Voor posten met een vast rendement (spaarrekening, obligatie) wordt
//  de dagopbrengst gewoon gerekend: bedrag × rente / 365.
//
//  Verify JWT staat UIT; de cron authenticeert met een eigen secret.
//
//  Secrets:
//    CRON_SECRET        (verzin zelf een lange willekeurige string)
//    T212_API_KEY / T212_API_SECRET   (bestaan al)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const T212_KEY = Deno.env.get("T212_API_KEY") ?? "";
const T212_SECRET = Deno.env.get("T212_API_SECRET") ?? "";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const vandaag = () => new Date().toISOString().slice(0, 10);

// ---------- prijzen ophalen ----------
async function cryptoWaarde(munten: any[]) {
  if (!munten?.length) return null;
  const ids = munten.map((c) => c.id).join(",");
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=eur`,
  );
  if (!r.ok) throw new Error(`CoinGecko gaf ${r.status}`);
  const p = await r.json();
  return munten.reduce(
    (a: number, c: any) => a + (Number(c.amount) || 0) * (Number(p[c.id]?.eur) || 0),
    0,
  );
}

async function t212Waarde() {
  if (!T212_KEY || !T212_SECRET) throw new Error("Trading 212-sleutels ontbreken");
  const auth = "Basic " + btoa(`${T212_KEY}:${T212_SECRET}`);
  const r = await fetch("https://live.trading212.com/api/v0/equity/account/summary", {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Trading 212 gaf ${r.status}: ${(await r.text()).slice(0, 80)}`);
  const j = await r.json();
  const v = Number(j?.totalValue ?? j?.total ?? 0);
  if (!v) throw new Error("Trading 212 gaf geen waarde terug");
  return v;
}

// ---------- momentopname voor één gebruiker ----------
async function snapshotUser(uid: string) {
  const d = vandaag();
  const fouten: string[] = [];
  const gedaan: string[] = [];

  const { data: assets } = await db.from("assets").select("*").eq("user_id", uid);
  if (!assets?.length) return { gedaan, fouten };

  // gisteren, om het rendement te kunnen berekenen
  const { data: vorige } = await db.from("asset_history")
    .select("asset_id, amount, d").eq("user_id", uid).lt("d", d).order("d", { ascending: false });
  const laatste: Record<string, number> = {};
  for (const r of vorige ?? []) if (!(r.asset_id in laatste)) laatste[r.asset_id] = Number(r.amount);

  // cryptoposities staan in de instellingen, niet in assets
  const { data: inst } = await db.from("tax_inputs").select("data").eq("user_id", uid).maybeSingle();
  const munten = (inst?.data as any)?.crypto ?? [];

  const rijen: any[] = [];

  for (const a of assets) {
    let bedrag: number | null = null;
    let winst = 0;

    try {
      if (a.price_source === "crypto") {
        bedrag = await cryptoWaarde(munten);
      } else if (a.price_source === "t212") {
        bedrag = await t212Waarde();
      } else if (a.rate_pct) {
        // vast rendement: de waarde blijft, de opbrengst telt op
        bedrag = Number(a.amount);
        winst = (bedrag * Number(a.rate_pct)) / 100 / 365;
      } else {
        continue; // niet prijsgevoelig en geen rente: overslaan
      }
    } catch (e) {
      fouten.push(`${a.name}: ${(e as Error).message}`);
      continue;
    }

    if (bedrag == null) continue;
    bedrag = Math.round(bedrag * 100) / 100;

    if (a.price_source === "crypto" || a.price_source === "t212") {
      const vorig = laatste[a.id];
      winst = vorig != null ? Math.round((bedrag - vorig) * 100) / 100 : 0;
      // de post zelf bijwerken naar de actuele waarde
      await db.from("assets").update({ amount: bedrag, last_price_at: new Date().toISOString() }).eq("id", a.id);
    }

    rijen.push({
      user_id: uid,
      asset_id: a.id,
      d,
      amount: bedrag,
      gain: Math.round(winst * 100) / 100,
    });
    gedaan.push(`${a.name}: €${bedrag} (${winst >= 0 ? "+" : ""}${Math.round(winst * 100) / 100})`);
  }

  if (rijen.length) {
    const { error } = await db.from("asset_history").upsert(rijen, { onConflict: "user_id,asset_id,d" });
    if (error) fouten.push(error.message);
  }
  return { gedaan, fouten };
}

// ---------- ingang ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Twee manieren binnen: de nachtelijke cron met een secret,
  // of jijzelf vanuit de app met een geldige sessie.
  const cron = req.headers.get("x-cron-secret");
  let uids: string[] = [];

  if (cron && CRON_SECRET && cron === CRON_SECRET) {
    const { data } = await db.from("assets").select("user_id");
    uids = [...new Set((data ?? []).map((r: any) => r.user_id))];
  } else {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user?.id) return json({ error: "Niet ingelogd." }, 401);
    uids = [u.user.id];
  }

  const uit: Record<string, unknown> = {};
  for (const uid of uids) {
    try { uit[uid] = await snapshotUser(uid); }
    catch (e) { uit[uid] = { fouten: [String((e as Error).message)] }; }
  }
  return json({ datum: vandaag(), resultaat: uit });
});
