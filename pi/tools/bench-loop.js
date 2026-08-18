"use strict";
/**
 * Hoe duur is de serverkant?
 *
 *   node tools/bench-loop.js
 *
 * tools/bench.js meet de browser; dit meet de andere kant. Het bouwt de hele
 * meetketen op met een neppe staat en jaagt er synthetische snapshots
 * doorheen, en daarnaast net zoveel "verzoeken". Geen VESC nodig, geen Pi.
 *
 * De twee getallen die tellen:
 *
 *   meting   wat er per VESC-meting gebeurt   — 6,7×/s, altijd
 *   verzoek  wat er per GET /data gebeurt     — 6,7×/s, zolang er een browser kijkt
 *
 * Zolang die twee niet gescheiden zijn doet de tweede het werk van de eerste,
 * en dan hangt de kilometerstand ervan af of er iemand kijkt.
 */

const { Telemetry } = require("../src/telemetry");
const { Charge } = require("../src/charge");
const { SetupWatch } = require("../src/setup");
const { Cruise } = require("../src/cruise");

const N = Number(process.env.BENCH_N || 20000);

const cfg = {
  step: { batteryCells: 13, packWh: 1147, polePairs: 15,
          wheelDiameterM: 0.254, gearRatio: 1, source: null, learnedAt: null },
  cruise: { enabled: true, minCurrentA: 3, holdMs: 600 }
};

/* Een staat die niets naar schijf schrijft — we meten rekenwerk, geen SD-kaart. */
function nepStaat() {
  const data = {
    settings: {}, topSpeed: 0, setupSeen: false,
    odo: { meters: 0 }, trip: { distanceM: 0, wattHours: 0, valid: true, seconds: 0 }
  };
  return {
    data,
    patches: 0,
    get settings() { return data.settings; },
    get trip() { return data.trip; },
    patch(p) {
      this.patches++;
      Object.assign(data, p, { trip: Object.assign({}, data.trip, p.trip) });
    }
  };
}

/* Een rit die ergens op lijkt: de snelheid golft, de tellers lopen door. */
function snapshots(n) {
  const uit = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = 0.5 + 0.5 * Math.sin(i / 40);
    uit[i] = {
      tempFet: 41 + 4 * v, tempMotor: 48 + 9 * v,
      currentMotor: 30 * v, currentIn: 14 * v,
      duty: 0.6 * v, erpm: 6000 * v, vIn: 50.4 - v / 3,
      wattHours: 100 + i * 0.001, wattHoursCharged: 0, ampHours: 2,
      tachometer: i * 40, tachometerAbs: i * 40, fault: null,
      speedMs: 8 * v, distanceM: i * 0.11, batteryLevel: 0.68,
      setupWattHours: 100, throttle: 0.3, throttleVolt: 1.4
    };
  }
  return uit;
}

function meet(naam, n, fn) {
  fn(0);                                   // opwarmen, buiten de meting
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(i);
  const dt = Number(process.hrtime.bigint() - t0) / 1e3;   // µs
  return { naam, per: dt / n, totaal: dt / 1000 };
}

const snaps = snapshots(N);
const staat = nepStaat();
const telemetry = new Telemetry(cfg, staat);
const setup = new SetupWatch(cfg, false);
const charge = new Charge();
const cruise = new Cruise(cfg);

let nu = 1700000000000;
let laatste = telemetry.build(snaps[0]);

/* ── wat er per meting hoort te gebeuren ──────────────────────────────── */
const meting = meet("meting", N, (i) => {
  const s = snaps[i % N];
  nu += 150;
  cruise.update(s, nu);
  setup.observe(s);
  const d = telemetry.build(s);
  charge.update(d, nu);
  laatste = d;
});

/* ── en wat een verzoek daarna nog kost ───────────────────────────────── */
const verzoek = meet("verzoek", N, () => {
  const d = Object.assign({}, laatste);
  const c = cruise.state();
  d.cruise = c.active;
  d.cruise_supported = c.supported;
  Object.assign(d, charge.state(d.battery_pct));
  JSON.stringify(d);
});

/* ── de dure tak: laden ───────────────────────────────────────────────────
   Tijdens het rijden blijft charge.hist leeg (rijden wist hem). Pas aan de
   lader groeit hij naar 240 monsters, en dan loopt update() er per aanroep
   twee keer doorheen en berekent state() er een kleinste-kwadratenlijn
   overheen. Dat is de tak die telt, dus die meten we apart. */
const laadStaat = nepStaat();
const laadTel = new Telemetry(cfg, laadStaat);
const laden = new Charge();
let lnu = 1700000000000;
/* Eerst twintig minuten laden nabootsen zodat de historie echt vol staat. */
for (let i = 0; i < 260; i++) {
  lnu += 5000;
  laden.update({ connected: true, speed_kmh: 0, voltage: 50 + i * 0.01,
                 battery_pct: 40 + i * 0.2, battery_current: -8 }, lnu);
}
const laadD = { connected: true, speed_kmh: 0, voltage: 52.6,
                battery_pct: 92, battery_current: -8 };
const laadMeting = meet("laden", N, () => {
  lnu += 150;
  laden.update(laadD, lnu);
  laden.state(laadD.battery_pct);
});
console.log("");
console.log("  monsters in de historie:", laden.hist.length);

const bytes = Buffer.byteLength(JSON.stringify(laatste));

console.log("");
console.log("  " + String(N).padStart(6) + " rondes");
console.log("  " + "─".repeat(38));
for (const r of [meting, verzoek, laadMeting]) {
  console.log("  " + r.naam.padEnd(10)
    + r.per.toFixed(2).padStart(8) + " µs/stuk"
    + ("bij 6,7/s: " + (r.per * 6.7 / 1000).toFixed(2) + " ms/s").padStart(24));
}
console.log("  " + "─".repeat(38));
console.log("  antwoord  " + String(bytes).padStart(8) + " bytes"
  + ("bij 6,7/s: " + Math.round(bytes * 6.7 / 1024 * 10) / 10 + " kB/s").padStart(26));
console.log("  patches   " + String(staat.patches).padStart(8) + " stuks naar de staat");
console.log("");
