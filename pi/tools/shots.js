"use strict";
/**
 * Schermafdrukken van de UI, voor de README.
 *
 *   node tools/design.js &            (of laat hem al draaien)
 *   node tools/shots.js               → docs/ui/*.png
 *
 * Draait de echte pagina in Chromium op 320 × 480 en klikt de schermen af die
 * in de README staan. De data komt uit de designomgeving, dus er hoeft geen
 * step aan te hangen — en de afdrukken zijn reproduceerbaar in plaats van
 * "wat er toevallig op het stuur stond".
 *
 * Playwright staat niet in package.json: dit is gereedschap voor op je eigen
 * machine en hoort niet op de Pi. Installeer het los (npm i -D playwright) of
 * wijs PLAYWRIGHT naar een bestaande installatie.
 */

const fs = require("fs");
const path = require("path");

const BASIS = process.env.DESIGN_URL || "http://localhost:8081";
const UIT = path.resolve(__dirname, "..", "docs", "ui");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

/* De instellingen waarmee elke afdruk begint. Zonder dit hangt de kleur van
   de vorige keer er nog in en verschilt elke reeks. */
const SCHOON = {
  rotate: 90, theme: "day", lang: "nl", units: "metric", accent: "#4f9e63",
  mode: "SPORT", limMotor: 120, limEsc: 110, limBatt: 70,
  warnMotor: true, warnEsc: true, warnBatt: true,
  packWh: 1147, whPerKm: 18, speedMax: 35, bright: 80
};

(async () => {
  fs.mkdirSync(UIT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 320, height: 480 },
    deviceScaleFactor: 2
  });

  const fouten = [];
  page.on("pageerror", (e) => fouten.push("PAGEERROR " + e.message));
  page.on("console", (m) => { if (m.type() === "error") fouten.push("CONSOLE " + m.text()); });

  const patch = (p) => page.request.post(BASIS + "/design/state", { data: { patch: p } });
  const preset = (n) => page.request.post(BASIS + "/design/state", { data: { preset: n } });
  const herlaad = async () => {
    await page.goto(BASIS + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
  };
  /* force: de app vangt de tik met closest() op een voorouder, dus
     een treffer op een kind is prima — Playwright weigert die anders. */
  const tik = (sel) => page.click(sel, { force: true });
  const foto = async (naam) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(UIT, naam + ".png") });
    console.log("·", naam);
  };

  async function begin(extra) {
    /* Ook de verbindingen terugzetten: een eerdere afdruk kan het wachtwoord-
       scherm hebben doorlopen en dan hangt de step aan een ander netwerk. */
    await patch(Object.assign({
      theme: "day",
      settings: Object.assign({}, SCHOON),
      wifi: { connected: true, ssid: "Huisnet", level: 3 },
      bt: { connected: true, name: "Sena 50S" }
    }, extra || {}));
    await herlaad();
  }

  /* ── rijden ─────────────────────────────────────────────────────────── */
  await preset("rijden");
  await begin();
  await foto("01-rijden");

  await patch({ settings: Object.assign({}, SCHOON, { theme: "night" }) });
  await herlaad();
  await foto("02-rijden-nacht");

  /* ── instellingen en de schermen eronder ────────────────────────────── */
  await begin();
  await tik("#topright");
  await foto("03-instellingen");
  await tik("#openlimits");
  await foto("04-limieten");
  await tik('[data-close="limits"]');
  await tik("#openaccent");
  await foto("05-accentkleur");
  await tik('[data-close="accent"]');
  await tik("#openlang");
  await foto("06-taal");
  await tik('[data-close="lang"]');
  await tik("#openconn");
  await page.waitForTimeout(900);
  await foto("07-verbindingen");

  /* Een beveiligd netwerk aantikken geeft het schermtoetsenbord. */
  await tik('.net[data-id="Buren"] .nm');
  await tik('.key[data-k="g"]');
  await tik('.key[data-k="e"]');
  await tik('.key[data-k="h"]');
  await tik('.key[data-k="e"]');
  await tik('.key[data-k="i"]');
  await tik('.key[data-k="m"]');
  await foto("08-wachtwoord");

  /* ── snelheidsmeting ────────────────────────────────────────────────── */
  await begin();
  await tik("#speedbtn");
  await foto("09-snelheidsmeting");

  /* ── meldingen ──────────────────────────────────────────────────────── */
  await preset("storing");
  await begin();
  await tik("#bell");
  await foto("10-meldingen");

  /* ── laden ──────────────────────────────────────────────────────────── */
  await preset("laden");
  await begin();
  await foto("11-laden");

  /* ── temperatuuralarm ───────────────────────────────────────────────── */
  await preset("motor heet");
  await begin({ tempMotor: 126 });
  /* Het alarm knippert zeven keer en de bevestigknop verschijnt na 2,9 s.
     Eerder afdrukken levert een half beeld of een lege rode plaat. */
  await page.waitForTimeout(3600);
  await foto("12-waarschuwing");

  /* ── update en release-notities ─────────────────────────────────────── */
  await preset("stilstaand");
  await begin({ update: { available: true, message: "Het nieuwe ontwerp Ride Dash" } });
  await tik("#topright");
  await page.waitForTimeout(600);
  await tik("#updrow");
  await foto("13-release");

  /* ── stepgegevens ───────────────────────────────────────────────────── */
  await begin({
    setup: { known: false, batteryCells: null, polePairs: 15,
             wheelDiameterM: 0.254, gearRatio: 1, source: "config" }
  });
  await tik("#topright");
  await page.waitForTimeout(600);
  await tik("#opensetup");
  await foto("14-stepgegevens");

  /* ── zoals het op het stuur hangt ───────────────────────────────────── */
  await preset("rijden");
  await begin();
  await page.setViewportSize({ width: 480, height: 320 });
  await page.waitForTimeout(600);
  await foto("15-op-het-paneel");

  console.log(fouten.length ? "\nfouten:\n" + fouten.slice(0, 20).join("\n") : "\ngeen fouten");
  await browser.close();
  process.exitCode = fouten.length ? 1 : 0;
})();
