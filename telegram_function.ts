// ============================================================
//  Supabase Edge Function: "telegram"  — gespreksversie
//
//  Verschil met v1: de bot heeft nu geheugen (laatste berichten),
//  context (je doelen, dagtotalen, gewicht, weektrend) en gereedschap
//  (loggen, corrigeren, verwijderen) in plaats van een vast JSON-formaat.
//  Daardoor kan hij ook gewoon een vraag beantwoorden zonder iets te loggen.
//
//  Verify JWT moet UIT staan voor deze functie.
//  Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ANTHROPIC_API_KEY
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TG_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";
const HISTORIE = 16; // hoeveel eerdere berichten meegaan

const VELDEN = ["kcal", "prot", "carb", "sugar", "fiber", "fat", "satfat", "salt", "water", "caffeine", "alc", "vitA", "vitC", "vitD", "vitE", "vitK", "vitB1", "vitB2", "vitB3", "vitB6", "vitB9", "vitB12", "calcium", "iron", "magnesium", "zinc", "potassium", "phosphorus", "selenium", "iodine", "copper", "omega3", "cholesterol", "weight", "steps", "sleep", "minutes"];
const RI: Record<string, number> = {"kcal": 2000, "prot": 50, "carb": 260, "sugar": 90, "fiber": 25, "fat": 70, "satfat": 20, "salt": 6, "water": 2000, "caffeine": 400, "alc": 0, "vitA": 800, "vitC": 80, "vitD": 5, "vitE": 12, "vitK": 75, "vitB1": 1.1, "vitB2": 1.4, "vitB3": 16, "vitB6": 1.4, "vitB9": 200, "vitB12": 2.5, "calcium": 800, "iron": 14, "magnesium": 375, "zinc": 10, "potassium": 2000, "phosphorus": 700, "selenium": 55, "iodine": 150, "copper": 1, "omega3": 1, "cholesterol": 300};
const LABEL: Record<string, string> = {"kcal": "kcal", "prot": "eiwit (g)", "carb": "koolhydraten (g)", "sugar": "suikers (g)", "fiber": "vezels (g)", "fat": "vet (g)", "satfat": "verzadigd vet (g)", "salt": "zout (g)", "water": "water (ml)", "caffeine": "cafeine (mg)", "alc": "alcohol (glazen)", "vitA": "vitamine A (ug)", "vitC": "vitamine C (mg)", "vitD": "vitamine D (ug)", "vitE": "vitamine E (mg)", "vitK": "vitamine K (ug)", "vitB1": "vitamine B1 (mg)", "vitB2": "vitamine B2 (mg)", "vitB3": "niacine (mg)", "vitB6": "vitamine B6 (mg)", "vitB9": "foliumzuur (ug)", "vitB12": "vitamine B12 (ug)", "calcium": "calcium (mg)", "iron": "ijzer (mg)", "magnesium": "magnesium (mg)", "zinc": "zink (mg)", "potassium": "kalium (mg)", "phosphorus": "fosfor (mg)", "selenium": "selenium (ug)", "iodine": "jodium (ug)", "copper": "koper (mg)", "omega3": "omega-3 (g)", "cholesterol": "cholesterol (mg)"};
const EENHEID: Record<string, string> = {"kcal": "", "prot": " g", "carb": " g", "sugar": " g", "fiber": " g", "fat": " g", "satfat": " g", "salt": " g", "water": " ml", "caffeine": " mg", "alc": "", "vitA": " µg", "vitC": " mg", "vitD": " µg", "vitE": " mg", "vitK": " µg", "vitB1": " mg", "vitB2": " mg", "vitB3": " mg", "vitB6": " mg", "vitB9": " µg", "vitB12": " µg", "calcium": " mg", "iron": " mg", "magnesium": " mg", "zinc": " mg", "potassium": " mg", "phosphorus": " mg", "selenium": " µg", "iodine": " µg", "copper": " mg", "omega3": " g", "cholesterol": " mg", "weight": " kg", "steps": "", "sleep": " u", "minutes": " min"};

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const tg = (m: string, body: unknown) =>
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/${m}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const reply = (chat_id: number, text: string, markup?: unknown) =>
  tg("sendMessage", { chat_id, text, ...(markup ? { reply_markup: markup } : {}) });

const KNOPPEN = (pid: number) => ({
  inline_keyboard: [[
    { text: "✅ Klopt", callback_data: `ok:${pid}` },
    { text: "✏️ Aanpassen", callback_data: `ed:${pid}` },
    { text: "🗑 Weg", callback_data: `rm:${pid}` },
  ]],
});

const bewerk = (chat_id: number, message_id: number, text: string) =>
  tg("editMessageText", { chat_id, message_id, text });

/* Volledig voedingsprofiel van een logregel, met percentage van de dagelijkse referentie. */
function profielTekst(rows: any[]) {
  const uit: string[] = [];
  for (const r of rows) {
    const d = r.data ?? {};
    uit.push(r.title);
    const macro = ["kcal", "prot", "carb", "sugar", "fiber", "fat", "satfat", "salt", "alc"]
      .filter((k) => d[k])
      .map((k) => `${LABEL[k].replace(/ \(.*/, "")} ${Math.round(d[k] * 10) / 10}${EENHEID[k]}`);
    if (macro.length) uit.push("  " + macro.join(" · "));
    const micro = VELDEN
      .filter((k) => RI[k] && !["kcal", "prot", "carb", "sugar", "fiber", "fat", "satfat", "salt", "alc", "water"].includes(k))
      .filter((k) => d[k])
      .map((k) => `${LABEL[k].replace(/ \(.*/, "")} ${Math.round(d[k] * 10) / 10}${EENHEID[k]} (${Math.round((d[k] / RI[k]) * 100)}%)`);
    if (micro.length) uit.push("  " + micro.join(" · "));
    if (d.weight) uit.push(`  ${d.weight} kg`);
    if (d.sleep) uit.push(`  ${d.sleep} uur slaap`);
    if (d.steps || d.minutes) uit.push(`  ${d.steps ? d.steps + " stappen " : ""}${d.minutes ? d.minutes + " min" : ""}`);
  }
  return uit.join("\n");
}

// ---------- gereedschap dat het model mag gebruiken ----------
const TOOLS = [
  {
    name: "log",
    description:
      "Zet één of meer regels in het logboek. Gebruik dit zodra iemand vertelt wat hij gegeten, gedronken, gewogen, gesport of geslapen heeft. Laat velden weg die niet van toepassing zijn.",
    input_schema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["food", "drink", "weight", "activity", "sleep", "note"] },
              title: { type: "string", description: "Korte omschrijving, bv. '2x bier' of 'Bruine boterham met kaas'" },
              kcal: { type: "number", description: "kcal" },
              prot: { type: "number", description: "g eiwit" },
              carb: { type: "number", description: "g koolhydraten" },
              sugar: { type: "number", description: "g suikers" },
              fiber: { type: "number", description: "g vezels" },
              fat: { type: "number", description: "g vet" },
              satfat: { type: "number", description: "g verzadigd vet" },
              salt: { type: "number", description: "g zout" },
              water: { type: "number", description: "ml water" },
              caffeine: { type: "number", description: "mg cafeine" },
              alc: { type: "number", description: "standaardglazen alcohol" },
              vitA: { type: "number", description: "ug vitamine A" },
              vitC: { type: "number", description: "mg vitamine C" },
              vitD: { type: "number", description: "ug vitamine D" },
              vitE: { type: "number", description: "mg vitamine E" },
              vitK: { type: "number", description: "ug vitamine K" },
              vitB1: { type: "number", description: "mg vitamine B1" },
              vitB2: { type: "number", description: "mg vitamine B2" },
              vitB3: { type: "number", description: "mg niacine" },
              vitB6: { type: "number", description: "mg vitamine B6" },
              vitB9: { type: "number", description: "ug foliumzuur" },
              vitB12: { type: "number", description: "ug vitamine B12" },
              calcium: { type: "number", description: "mg calcium" },
              iron: { type: "number", description: "mg ijzer" },
              magnesium: { type: "number", description: "mg magnesium" },
              zinc: { type: "number", description: "mg zink" },
              potassium: { type: "number", description: "mg kalium" },
              phosphorus: { type: "number", description: "mg fosfor" },
              selenium: { type: "number", description: "ug selenium" },
              iodine: { type: "number", description: "ug jodium" },
              copper: { type: "number", description: "mg koper" },
              omega3: { type: "number", description: "g omega-3" },
              cholesterol: { type: "number", description: "mg cholesterol" },
              weight: { type: "number", description: "lichaamsgewicht in kg" },
              steps: { type: "number" },
              sleep: { type: "number", description: "uren geslapen" },
              minutes: { type: "number", description: "duur van de activiteit" },
              hours_ago: { type: "number", description: "als het langer geleden was, hoeveel uur terug" },
            },
            required: ["kind", "title"],
          },
        },
      },
      required: ["entries"],
    },
  },
  {
    name: "corrigeer",
    description:
      "Pas een bestaande logregel aan. Gebruik dit als iemand een correctie geeft ('nee, het waren er twee', 'dat was geen 500 maar 300 kcal'). Het id staat in de context bij 'Vandaag gelogd'.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
              kcal: { type: "number", description: "kcal" },
              prot: { type: "number", description: "g eiwit" },
              carb: { type: "number", description: "g koolhydraten" },
              sugar: { type: "number", description: "g suikers" },
              fiber: { type: "number", description: "g vezels" },
              fat: { type: "number", description: "g vet" },
              satfat: { type: "number", description: "g verzadigd vet" },
              salt: { type: "number", description: "g zout" },
              water: { type: "number", description: "ml water" },
              caffeine: { type: "number", description: "mg cafeine" },
              alc: { type: "number", description: "standaardglazen alcohol" },
              vitA: { type: "number", description: "ug vitamine A" },
              vitC: { type: "number", description: "mg vitamine C" },
              vitD: { type: "number", description: "ug vitamine D" },
              vitE: { type: "number", description: "mg vitamine E" },
              vitK: { type: "number", description: "ug vitamine K" },
              vitB1: { type: "number", description: "mg vitamine B1" },
              vitB2: { type: "number", description: "mg vitamine B2" },
              vitB3: { type: "number", description: "mg niacine" },
              vitB6: { type: "number", description: "mg vitamine B6" },
              vitB9: { type: "number", description: "ug foliumzuur" },
              vitB12: { type: "number", description: "ug vitamine B12" },
              calcium: { type: "number", description: "mg calcium" },
              iron: { type: "number", description: "mg ijzer" },
              magnesium: { type: "number", description: "mg magnesium" },
              zinc: { type: "number", description: "mg zink" },
              potassium: { type: "number", description: "mg kalium" },
              phosphorus: { type: "number", description: "mg fosfor" },
              selenium: { type: "number", description: "ug selenium" },
              iodine: { type: "number", description: "ug jodium" },
              copper: { type: "number", description: "mg koper" },
              omega3: { type: "number", description: "g omega-3" },
              cholesterol: { type: "number", description: "mg cholesterol" },
        weight: { type: "number" }, steps: { type: "number" }, sleep: { type: "number" }, minutes: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "verwijder",
    description: "Verwijder een logregel. Gebruik dit bij 'haal dat weg' of 'dat klopt niet, wis het'.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

// ---------- context opbouwen ----------
async function bouwContext(user_id: string) {
  const nu = new Date();
  const start = new Date(nu); start.setHours(0, 0, 0, 0);
  const week = new Date(nu); week.setDate(week.getDate() - 7);

  const [{ data: goals }, { data: vandaag }, { data: recent }, { data: weging }] = await Promise.all([
    db.from("health_settings").select("data").eq("user_id", user_id).maybeSingle(),
    db.from("health_entries").select("id,ts,kind,title,data").eq("user_id", user_id).gte("ts", start.toISOString()).order("ts"),
    db.from("health_entries").select("ts,data").eq("user_id", user_id).gte("ts", week.toISOString()),
    db.from("health_entries").select("ts,data").eq("user_id", user_id).eq("kind", "weight").order("ts", { ascending: false }).limit(2),
  ]);

  const g = (goals?.data ?? {}) as any;
  const som = (rows: any[]) => {
    const a: Record<string, number> = {};
    for (const r of rows) for (const k of VELDEN) {
      const v = Number((r.data as any)?.[k] ?? 0);
      if (v) a[k] = (a[k] ?? 0) + v;
    }
    return a;
  };

  const dagTot = som(vandaag ?? []);
  const weekTot = som(recent ?? []);
  const dagen = new Set((recent ?? []).map((r: any) => String(r.ts).slice(0, 10))).size || 1;

  const regels: string[] = [];
  regels.push(`Nu: ${nu.toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`);

  if (g.kcal || g.prot || g.weight || g.alc) {
    const d: string[] = [];
    if (g.kcal) d.push(`${g.kcal} kcal/dag`);
    if (g.prot) d.push(`${g.prot} g eiwit/dag`);
    if (g.carb) d.push(`${g.carb} g koolhydraten/dag`);
    if (g.fat) d.push(`${g.fat} g vet/dag`);
    if (g.weight) d.push(`streefgewicht ${g.weight} kg`);
    if (g.alc) d.push(`max ${g.alc} alcoholeenheden per week`);
    regels.push(`Doelen: ${d.join(" · ")}`);
  } else {
    regels.push("Doelen: nog geen ingesteld.");
  }

  // volledig voedingsprofiel van vandaag, met percentage van de dagelijkse referentie
  const profiel = VELDEN
    .filter((k) => LABEL[k] && (dagTot[k] ?? 0) > 0)
    .map((k) => {
      const v = dagTot[k];
      const ri = RI[k];
      const pct = ri ? ` (${Math.round((v / ri) * 100)}% RI)` : "";
      return `  ${LABEL[k]}: ${Math.round(v * 10) / 10}${pct}`;
    });
  regels.push("Vandaag binnengekregen:");
  regels.push(profiel.length ? profiel.join("\n") : "  (nog niets)");

  // waar hij vandaag ver achterloopt — alleen als er al iets gelogd is
  if ((dagTot.kcal ?? 0) > 300) {
    const tekort = VELDEN
      .filter((k) => RI[k] && !["alc", "cholesterol", "salt", "satfat", "sugar"].includes(k))
      .filter((k) => ((dagTot[k] ?? 0) / RI[k]) < 0.4)
      .map((k) => `${LABEL[k]} (${Math.round(((dagTot[k] ?? 0) / RI[k]) * 100)}%)`);
    if (tekort.length) regels.push(`Loopt vandaag achter op: ${tekort.join(", ")}`);
    const teveel = ["salt", "satfat", "sugar"].filter((k) => ((dagTot[k] ?? 0) / RI[k]) > 1);
    if (teveel.length) regels.push(`Zit vandaag boven de referentie voor: ${teveel.map((k) => LABEL[k]).join(", ")}`);
  }

  if (g.kcal) regels.push(`Nog te gaan vandaag: ${Math.round(g.kcal - (dagTot.kcal ?? 0))} kcal${g.prot ? `, ${Math.round(g.prot - (dagTot.prot ?? 0))} g eiwit` : ""}`);

  if (vandaag?.length) {
    regels.push("Vandaag gelogd (met id, voor corrigeren of verwijderen):");
    for (const e of vandaag) {
      const d = e.data as any;
      const w = [];
      if (d.kcal) w.push(`${Math.round(d.kcal)} kcal`);
      if (d.prot) w.push(`${Math.round(d.prot)}g eiwit`);
      if (d.alc) w.push(`${d.alc} eenh`);
      if (d.weight) w.push(`${d.weight} kg`);
      if (d.sleep) w.push(`${d.sleep} u`);
      if (d.minutes) w.push(`${d.minutes} min`);
      regels.push(`  - [${e.id}] ${String(e.ts).slice(11, 16)} ${e.title}${w.length ? ` (${w.join(", ")})` : ""}`);
    }
  } else {
    regels.push("Vandaag nog niets gelogd.");
  }

  regels.push(`Afgelopen 7 dagen: gemiddeld ${Math.round((weekTot.kcal ?? 0) / dagen)} kcal, ${Math.round((weekTot.prot ?? 0) / dagen)} g eiwit, ${Math.round((weekTot.fiber ?? 0) / dagen)} g vezels per dag. ${weekTot.alc ?? 0} alcoholeenheden totaal.`);
  const structureel = VELDEN
    .filter((k) => RI[k] && !["alc", "cholesterol", "salt", "satfat", "sugar", "kcal"].includes(k))
    .filter((k) => (((weekTot[k] ?? 0) / dagen) / RI[k]) < 0.5)
    .map((k) => LABEL[k]);
  if (structureel.length && dagen >= 3) regels.push(`Structureel laag deze week (onder de helft van de referentie): ${structureel.join(", ")}`);

  if (weging?.length) {
    const laatste = weging[0] as any;
    let t = `Laatste weging: ${laatste.data?.weight} kg (${String(laatste.ts).slice(0, 10)})`;
    if (weging[1]) {
      const v = Number(laatste.data?.weight) - Number((weging[1] as any).data?.weight);
      t += `, ${v >= 0 ? "+" : ""}${v.toFixed(1)} kg t.o.v. de weging daarvoor`;
    }
    regels.push(t);
  }

  return regels.join("\n");
}

const SYSTEM = (ctx: string) => `Je bent de persoonlijke gezondheidscoach van Sjoerd, via Telegram. Je houdt zijn voeding, gewicht, beweging en slaap bij, en je praat met hem als een normaal mens: kort, concreet, Nederlands, geen opsommingen tenzij het echt helpt.

Je hebt gereedschap om te loggen, te corrigeren en te verwijderen. Gebruik dat wanneer het nodig is — maar niet elk bericht is een logregel. Stelt hij een vraag ("wat kan ik vanavond eten?", "hoeveel eiwit heb ik nog nodig?"), beantwoord die dan gewoon met de context hieronder, zonder iets te loggen.

Voedingswaarden — dit is het belangrijkste deel van je werk:
- Vul bij elke maaltijd of drank ZOVEEL MOGELIJK velden in, niet alleen calorieen en eiwit. Dus ook koolhydraten, suikers, vezels, vet, verzadigd vet en zout.
- Vul ook de vitamines en mineralen in waar het voedingsmiddel een noemenswaardige bron van is. Een sinaasappel: vitamine C, foliumzuur, kalium. Een biefstuk: ijzer, zink, B12, B6, fosfor, selenium. Een ei: vitamine D, B12, B2, selenium, cholesterol. Volkorenbrood: vezels, magnesium, ijzer, B1, B3.
- Verzin geen nullen: laat een veld gewoon weg als het voedingsmiddel er geen relevante bron van is. Maar wees niet karig - schat liever een realistische waarde dan hem over te slaan.
- Gebruik de juiste eenheid per veld (staat in de beschrijving): gram, milligram of microgram.
- Je schattingen zijn gebaseerd op standaard voedingswaardetabellen. Dat is nauwkeurig genoeg voor trends; je hoeft niet te slagen op de milligram.

Hoe je werkt:
- Vertelt hij wat hij at of dronk: schat porties realistisch en log het, met een zo compleet mogelijk voedingsprofiel. Vraag niet door over grammen tenzij het echt niet te schatten is.
- Geeft hij een correctie ("nee, het waren er twee", "dat was een kleine portie"): gebruik 'corrigeer' op de bestaande regel. Niet nog een regel erbij loggen.
- Praat hij gewoon ("ben moe vandaag", "hoe sta ik ervoor?"): antwoord als mens, log niets, tenzij er feitelijk iets in staat dat de moeite van vastleggen waard is.
- Bevestig kort wat je gelogd hebt, met het dagtotaal erbij. Eén of twee zinnen, geen rapport. Som de voedingswaarden NIET op in je tekst: die worden automatisch onder je bericht getoond, met knoppen om te bevestigen of aan te passen.
- Twijfel je over wat je op een foto ziet of over de portie: zeg dat er eerlijk bij ("ziet eruit als een Granny Smith, ongeveer 150 g"). De gebruiker kan het dan corrigeren met de knop.

Toon:
- Nuchter en behulpzaam. Geen uitroeptekens, geen peptalk, geen emoji-regens.
- Geen oordeel over wat hij eet of drinkt. Bier is bier. Je noteert het en rekent het door, meer niet.
- Advies geef je alleen als hij erom vraagt, of als het echt relevant is bij wat hij net stuurde.
- Je stuurt niet aan op extreem weinig eten of extreem sporten. Merk je signalen van een ongezonde relatie met eten, benoem dat rustig en stel voor om er met een huisarts of diëtist over te praten.
- Je bent geen arts. Bij medische vragen verwijs je door.

Context van dit moment:
${ctx}`;

// ---------- geheugen ----------
async function historie(user_id: string) {
  const { data } = await db.from("telegram_messages")
    .select("role,content").eq("user_id", user_id)
    .order("created_at", { ascending: false }).limit(HISTORIE);
  return (data ?? []).reverse().map((m: any) => ({ role: m.role, content: m.content }));
}
const onthoud = (user_id: string, role: string, content: string) =>
  db.from("telegram_messages").insert({ user_id, role, content: content.slice(0, 4000) });

// ---------- foto ----------
async function foto64(file_id: string) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${file_id}`);
  const j = await r.json();
  const path = j?.result?.file_path;
  if (!path) return null;
  const img = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${path}`);
  const buf = new Uint8Array(await img.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return { data: btoa(bin), type: path.endsWith(".png") ? "image/png" : "image/jpeg" };
}

async function claude(system: string, messages: unknown[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools: TOOLS, messages }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// ---------- gereedschap uitvoeren ----------

async function voerUit(naam: string, input: any, user_id: string, raw: string, gelogd: any[]) {
  if (naam === "log") {
    const rows = (input.entries ?? []).map((e: any) => {
      const data: Record<string, number> = {};
      for (const k of VELDEN) {
        const v = Number(e[k]);
        if (v && !isNaN(v)) data[k] = v;
      }
      const ts = e.hours_ago ? new Date(Date.now() - Number(e.hours_ago) * 3600e3).toISOString() : undefined;
      return {
        user_id,
        kind: ["food", "drink", "weight", "activity", "sleep", "note"].includes(e.kind) ? e.kind : "note",
        title: String(e.title ?? "").slice(0, 200),
        raw_text: raw.slice(0, 1000),
        source: "telegram",
        data,
        ...(ts ? { ts } : {}),
      };
    });
    if (!rows.length) return "geen regels";
    const { data, error } = await db.from("health_entries").insert(rows).select("id,title,data");
    if (error) return `fout: ${error.message}`;
    for (const r of (data ?? [])) gelogd.push(r);
    return `gelogd: ${(data ?? []).map((r: any) => `${r.title} [${r.id}]`).join(", ")}`;
  }

  if (naam === "corrigeer") {
    const { data: bestaand } = await db.from("health_entries")
      .select("data,title").eq("id", input.id).eq("user_id", user_id).maybeSingle();
    if (!bestaand) return "die regel bestaat niet";
    const data = { ...(bestaand.data as any) };
    for (const k of VELDEN) if (input[k] != null) data[k] = Number(input[k]);
    const patch: any = { data };
    if (input.title) patch.title = String(input.title).slice(0, 200);
    const { error } = await db.from("health_entries").update(patch).eq("id", input.id).eq("user_id", user_id);
    return error ? `fout: ${error.message}` : "aangepast";
  }

  if (naam === "verwijder") {
    const { error } = await db.from("health_entries").delete().eq("id", input.id).eq("user_id", user_id);
    return error ? `fout: ${error.message}` : "verwijderd";
  }
  return "onbekend gereedschap";
}

// ---------- webhook ----------
Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== TG_SECRET) {
    return new Response("nope", { status: 401 });
  }

  let update: any;
  try { update = await req.json(); } catch { return new Response("ok"); }

  // ---------- knop ingedrukt ----------
  if (update.callback_query) {
    const cq = update.callback_query;
    const [actie, pidStr] = String(cq.data ?? "").split(":");
    const pid = Number(pidStr);
    const chat = cq.message?.chat?.id;
    const mid = cq.message?.message_id;
    const oudeTekst: string = cq.message?.text ?? "";

    const antwoordKnop = (t: string) =>
      tg("answerCallbackQuery", { callback_query_id: cq.id, text: t });

    try {
      const { data: pend } = await db.from("telegram_pending").select("*").eq("id", pid).maybeSingle();
      if (!pend) {
        await antwoordKnop("Deze is al afgehandeld.");
        return new Response("ok");
      }

      if (actie === "ok") {
        await antwoordKnop("Bevestigd");
        await bewerk(chat, mid, `✅ ${oudeTekst}`);
        await db.from("telegram_pending").delete().eq("id", pid);

      } else if (actie === "rm") {
        await db.from("health_entries").delete().in("id", pend.entry_ids).eq("user_id", pend.user_id);
        await antwoordKnop("Verwijderd");
        await bewerk(chat, mid, `🗑 Verwijderd\n\n${oudeTekst}`);
        await db.from("telegram_pending").delete().eq("id", pid);

      } else if (actie === "ed") {
        await antwoordKnop("Zeg maar wat er anders moet");
        await bewerk(chat, mid, `✏️ Wordt aangepast\n\n${oudeTekst}`);
        await reply(chat, "Wat klopt er niet? Bijvoorbeeld: 'het was een kleine appel', 'geen 3 maar 2', of 'er zat ook kaas op'.");
        await db.from("telegram_pending").delete().eq("id", pid);
      }
    } catch (e) {
      console.error(e);
      await antwoordKnop("Er ging iets mis");
    }
    return new Response("ok");
  }

  const msg = update.message ?? update.edited_message;
  if (!msg) return new Response("ok");
  const chat_id = msg.chat?.id;
  const tekst: string = (msg.text ?? msg.caption ?? "").trim();

  try {
    // ---- koppelen ----
    if (tekst.toLowerCase().startsWith("/start")) {
      const code = tekst.split(/\s+/)[1];
      if (!code) {
        await reply(chat_id, "Maak een koppelcode aan in je dashboard bij Health → Doelen, en stuur die naar mij met /start.");
        return new Response("ok");
      }
      const { data: link } = await db.from("telegram_links").select("user_id").eq("code", code.toUpperCase()).maybeSingle();
      if (!link) {
        await reply(chat_id, "Die code ken ik niet. Maak een nieuwe aan in je dashboard.");
        return new Response("ok");
      }
      await db.from("telegram_links").update({ chat_id, linked_at: new Date().toISOString(), code: null }).eq("user_id", link.user_id);
      await reply(chat_id, "Gekoppeld. Vertel maar wat je eet of doet — of stel me gewoon een vraag over hoe je ervoor staat.");
      return new Response("ok");
    }

    const { data: link } = await db.from("telegram_links").select("user_id").eq("chat_id", chat_id).maybeSingle();
    if (!link) {
      await reply(chat_id, "Ik weet nog niet wie je bent. Maak een koppelcode aan in je dashboard bij Health → Doelen en stuur /start met die code.");
      return new Response("ok");
    }
    const uid = link.user_id;

    // ---- /reset: gesprek vergeten ----
    if (tekst.toLowerCase().startsWith("/reset")) {
      await db.from("telegram_messages").delete().eq("user_id", uid);
      await reply(chat_id, "Gesprek gewist. Ik begin met een schone lei.");
      return new Response("ok");
    }

    // ---- bericht samenstellen ----
    const inhoud: any[] = [];
    const f = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
    if (f) {
      const img = await foto64(f.file_id);
      if (img) inhoud.push({ type: "image", source: { type: "base64", media_type: img.type, data: img.data } });
    }
    if (tekst) inhoud.push({ type: "text", text: tekst });
    else if (f) inhoud.push({ type: "text", text: "(foto zonder tekst)" });
    if (!inhoud.length) return new Response("ok");

    await tg("sendChatAction", { chat_id, action: "typing" });

    const ctx = await bouwContext(uid);
    const system = SYSTEM(ctx);
    const messages: any[] = [...(await historie(uid)), { role: "user", content: inhoud }];

    // ---- gesprek met gereedschap, max 4 rondes ----
    const gelogd: any[] = [];
    let antwoord = "";
    for (let ronde = 0; ronde < 4; ronde++) {
      const res = await claude(system, messages);
      const tools = (res.content ?? []).filter((c: any) => c.type === "tool_use");
      const tekstDelen = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (tekstDelen) antwoord = tekstDelen;

      if (!tools.length) break;

      messages.push({ role: "assistant", content: res.content });
      const resultaten = [];
      for (const t of tools) {
        const uit = await voerUit(t.name, t.input, uid, tekst || "(foto)", gelogd);
        resultaten.push({ type: "tool_result", tool_use_id: t.id, content: String(uit) });
      }
      messages.push({ role: "user", content: resultaten });
    }

    if (!antwoord) antwoord = "Genoteerd.";

    if (gelogd.length) {
      // volledig profiel + knoppen om te bevestigen, aan te passen of te verwijderen
      const { data: pend } = await db.from("telegram_pending")
        .insert({ user_id: uid, chat_id, entry_ids: gelogd.map((r) => r.id) })
        .select("id").single();
      const tekstUit = `${antwoord}\n\n${profielTekst(gelogd)}`;
      const r = await reply(chat_id, tekstUit, pend ? KNOPPEN(pend.id) : undefined);
      const j = await r.json().catch(() => null);
      if (pend && j?.result?.message_id) {
        await db.from("telegram_pending").update({ message_id: j.result.message_id }).eq("id", pend.id);
      }
    } else {
      await reply(chat_id, antwoord);
    }

    // ---- geheugen bijwerken (foto's slaan we op als beschrijving) ----
    await onthoud(uid, "user", tekst || "(stuurde een foto)");
    await onthoud(uid, "assistant", antwoord);

    // oude berichten opruimen
    const { data: oud } = await db.from("telegram_messages")
      .select("id").eq("user_id", uid).order("created_at", { ascending: false }).range(HISTORIE * 2, HISTORIE * 2 + 200);
    if (oud?.length) await db.from("telegram_messages").delete().in("id", oud.map((r: any) => r.id));

  } catch (e) {
    console.error(e);
    await reply(chat_id, "Er ging iets mis: " + String((e as Error).message).slice(0, 150));
  }

  return new Response("ok");
});
