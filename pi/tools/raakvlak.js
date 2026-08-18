"use strict";
/**
 * Raakvlak-audit: loopt elk scherm langs en meet van elk tikbaar element hoe
 * groot het vlak is dat werkelijk op een tik reageert.
 *
 *   node tools/design.js &
 *   node tools/raakvlak.js
 *
 * Niet getBoundingClientRect maar elementFromPoint: vanuit het midden van het
 * element naar buiten stappen tot een tik ergens anders landt. Dat vangt drie
 * dingen tegelijk — knoppen die te klein zijn, knoppen die door een andere
 * laag worden afgedekt, en dode spleten tussen knoppen. Zo is gevonden dat de
 * terugknop 20 x 20 was en dat een tik tussen twee toetsen in het niets viel.
 *
 * De grens van 40 px is bewust nét onder de vuistregel van 44: alles wat
 * kleiner meet is óf echt te klein, óf fysiek begrensd — en dat laatste hoort
 * dan hier in een opmerking te staan. Bekende, geaccepteerde gevallen:
 *
 *   - de toetsen: tien kolommen op 296 px is 25-28 px per toets; breder kan
 *     niet, en de spleten ertussen tellen sinds .key::after gewoon mee
 *   - de schakelaars en Scan-knopjes: hun ::after wordt afgeknipt door het
 *     scrollvak of eindigt waar het raakvlak van de buurknop begint — er is
 *     daar geen dode pixel, de ruimte is alleen op
 *
 * Playwright staat niet in package.json: dit is gereedschap voor op je eigen
 * machine en hoort niet op de Pi.
 */
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const BASIS = "http://localhost:8081";

const zet = (b) => fetch(BASIS + "/design/state", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b)
});

/* Per scherm: welke lagen open moeten en welke elementen daar tikbaar zijn.
   De selectors pakken ook rijen die app.js pas bij het openen opbouwt. */
const SCHERMEN = [
  { naam: "rijscherm", open: [], sel: ["#bell", "#speedbtn", "#tripcard", "#topright", "#modes .mode"] },
  { naam: "instellingen", open: ["settings"], sel: ["#updrow", "#opensetup", "#openconn", "#openpower", "#openaccent", "#thememode", "#openunits", "#openlang", "#openlimits", "#settings .iconbtn", "#settings .switch"] },
  { naam: "eenheden", open: ["settings", "units"], voor: "tekenUnits()", sel: ["#units .back", "#unitlist .pick"] },
  { naam: "taal", open: ["settings", "lang"], voor: "tekenLangs()", sel: ["#lang .back", "#langlist .pick"] },
  { naam: "accent", open: ["settings", "accent"], voor: "tekenAccents()", sel: ["#accent .back", "#accentlist .pick"] },
  { naam: "limieten", open: ["settings", "limits"], voor: "tekenLimits()", sel: ["#limits .back", "#limlist .step", "#limlist .switch"] },
  { naam: "verbindingen", open: ["settings", "conn"], voor: "scan('wifi'); scan('bt')", wacht: 900, sel: ["#conn .back", "#wifiscan", "#btscan", "#wifilist .net", "#btlist .net"] },
  { naam: "wachtwoord", open: ["settings", "conn", "pw"], voor: "openPw('wifi', 'x', 'Buren')", sel: ["#pw .back", "#pweye", "#keyrows .key", "#pwcancel"] },
  { naam: "snelheidsmeting", open: ["speedsheet"], voor: "tekenSpeedStats()", sel: ["#speedsheet .back", "#speedreset"] },
  { naam: "meldingen", open: ["alerts"], sel: ["#alertclose", "#alertclear", "#alertlist .alert"] },
  { naam: "stepgegevens", open: ["settings", "setup"], sel: ["#setup .back", "#steplist .step", "#stepsave"] },
  { naam: "release", open: ["settings", "release"], sel: ["#release .back", "#reldo"] },
  { naam: "aanuit", open: ["settings", "powermenu"], sel: ["#doreboot", "#doshutdown", "#powermenu .row.mid"] },
  { naam: "laden", open: ["charge"], sel: ["#charge"] },
];

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 320, height: 480 } });
  await zet({ reset: true });
  await zet({ preset: "lage accu" });
  await p.goto(BASIS, { waitUntil: "load" });
  await p.waitForTimeout(900);

  const rijen = [];
  for (const s of SCHERMEN) {
    await p.evaluate((cfg) => {
      document.querySelectorAll(".sheet.open,.scrim.open").forEach(e => e.classList.remove("open"));
      for (const k in lagen) delete lagen[k];
      cfg.open.forEach(id => show(id, true));
    }, s);
    if (s.voor) await p.evaluate((code) => { try { eval(code); } catch (e) {} }, s.voor);
    await p.waitForTimeout(s.wacht || 250);

    const uit = await p.evaluate((sels) => {
      const klaar = [];
      const gezien = new Set();
      for (const sel of sels) {
        const els = document.querySelectorAll(sel);
        if (!els.length) { klaar.push({ sel, ontbreekt: true }); continue; }
        let i = 0;
        for (const el of els) {
          if (gezien.has(el)) continue;
          gezien.add(el);
          if (el.hidden || el.offsetParent === null) continue;
          /* eerst in beeld halen — onder de vouw van een scrollvak meet
             elementFromPoint anders alleen maar "niet raakbaar" */
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          const mx = r.x + r.width / 2, my = r.y + r.height / 2;
          const van = (x, y) => {
            const t = document.elementFromPoint(x, y);
            return !!(t && (t === el || el.contains(t)));
          };
          /* effectief raakvlak: vanuit het midden naar buiten stappen */
          const rek = (dx, dy) => {
            let n = 0;
            while (n < 40 && van(mx + dx * (Math.abs(dx ? r.width : r.height) / 2 + n + 1), my + dy * (Math.abs(dy ? r.height : r.width) / 2 + n + 1))) n++;
            return n;
          };
          const li = rek(-1, 0), re = rek(1, 0), bo = rek(0, -1), on = rek(0, 1);
          klaar.push({
            sel: sel + (els.length > 1 ? "[" + i + "]" : ""),
            w: Math.round(r.width), h: Math.round(r.height),
            effW: Math.round(r.width) + li + re, effH: Math.round(r.height) + bo + on,
            middenRaakt: van(mx, my)
          });
          i++;
        }
      }
      return klaar;
    }, s.sel);
    for (const r of uit) rijen.push({ scherm: s.naam, ...r });
  }

  /* rapport: alles, met een vlag op wat te klein of afgedekt is */
  const MIN = 40;
  let slecht = 0;
  for (const r of rijen) {
    if (r.ontbreekt) { console.log("LEEG      " + r.scherm.padEnd(15) + r.sel); continue; }
    const klein = Math.min(r.effW, r.effH) < MIN;
    const dood = !r.middenRaakt;
    const vlag = dood ? "AFGEDEKT " : klein ? "TE KLEIN " : "ok       ";
    if (dood || klein) slecht++;
    console.log(vlag + r.scherm.padEnd(15) + r.sel.padEnd(28)
      + ("zichtbaar " + r.w + "x" + r.h).padEnd(20) + "raakvlak " + r.effW + "x" + r.effH);
  }
  console.log("\n" + rijen.filter(r => !r.ontbreekt).length + " elementen, " + slecht + " met een probleem");
  await b.close();
})();
