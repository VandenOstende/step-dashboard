"use strict";
/**
 * Hoe zwaar is de UI?
 *
 *   node tools/design.js &
 *   node tools/bench.js
 *
 * Draait de echte pagina in Chromium en leest via het devtools-protocol af
 * hoeveel werk de browser doet: stijlherberekeningen, layouts, en de tijd die
 * daarin gaat zitten. Per situatie tien seconden, want het gaat om wat er
 * gebeurt terwijl je rijdt en niet om het opstarten.
 *
 * De getallen zijn niet die van de Pi — deze machine is sneller. Ze zijn
 * bruikbaar om te vergelijken: dezelfde meting voor en na een wijziging zegt
 * of het lichter geworden is. Het schermpje op het stuur hangt aan SPI, en
 * daar is elke hertekening duur; de tellers hieronder zijn de beste
 * voorspeller die je zonder step hebt.
 *
 * Playwright staat niet in package.json; wijs PLAYWRIGHT naar een bestaande
 * installatie of installeer het los.
 */

const BASIS = process.env.DESIGN_URL || "http://localhost:8081";
const SECONDEN = Number(process.env.BENCH_SEC || 10);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

const SITUATIES = [
  { naam: "rijden", preset: "rijden", open: null },
  { naam: "rijden + melding", preset: "storing", open: null },
  { naam: "laden", preset: "laden", open: null },
  { naam: "instellingen open", preset: "rijden", open: "#topright" },
  { naam: "stilstaand", preset: "stilstaand", open: null }
];

const TEL = ["RecalcStyleCount", "LayoutCount", "RecalcStyleDuration",
             "LayoutDuration", "ScriptDuration", "TaskDuration"];

/* Van een schone stand vertrekken. Zonder dit meet je restjes van de vorige
   proef mee — een blijven staan "update beschikbaar" laat de UI knipperen en
   dat verdubbelt de uitslag. */
const SCHOON = {
  rotate: 90, theme: "day", lang: "nl", units: "metric", accent: "#4f9e63",
  mode: "SPORT", limMotor: 120, limEsc: 110, limBatt: 70,
  warnMotor: true, warnEsc: true, warnBatt: true,
  packWh: 1147, whPerKm: 18, speedMax: 35, bright: 80
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 320, height: 480 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  const lees = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const uit = {};
    for (const m of metrics) if (TEL.includes(m.name)) uit[m.name] = m.value;
    return uit;
  };

  const rijen = [];
  for (const s of SITUATIES) {
    await page.request.post(BASIS + "/design/state", { data: { preset: s.preset } });
    await page.request.post(BASIS + "/design/state", {
      data: { patch: { settings: SCHOON, update: { available: false, message: "" } } }
    });
    await page.goto(BASIS + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    if (s.open) await page.click(s.open, { force: true });
    await page.waitForTimeout(500);

    const voor = await lees();
    const t0 = Date.now();
    await page.waitForTimeout(SECONDEN * 1000);
    const na = await lees();
    const dt = (Date.now() - t0) / 1000;

    /* Geen frames tellen met requestAnimationFrame: die lus houdt de browser
       zelf wakker en meet dan zijn eigen aanwezigheid. */
    rijen.push({
      naam: s.naam,
      stijl: Math.round((na.RecalcStyleCount - voor.RecalcStyleCount) / dt),
      layout: Math.round((na.LayoutCount - voor.LayoutCount) / dt),
      ms: +(((na.TaskDuration - voor.TaskDuration) / dt) * 1000).toFixed(1)
    });
  }

  const kolom = (s, n) => String(s).padEnd(n);
  const rechts = (s, n) => String(s).padStart(n);
  console.log("");
  console.log(kolom("situatie", 20) + rechts("stijl/s", 9) + rechts("layout/s", 10)
    + rechts("ms werk/s", 11));
  console.log("─".repeat(50));
  for (const r of rijen) {
    console.log(kolom(r.naam, 20) + rechts(r.stijl, 9) + rechts(r.layout, 10)
      + rechts(r.ms, 11));
  }
  console.log("");
  console.log("stijl/s en layout/s zijn wat je omlaag wilt: elke layout raakt");
  console.log("de hele boom en elke hertekening moet over SPI naar het paneel.");

  await browser.close();
})();
