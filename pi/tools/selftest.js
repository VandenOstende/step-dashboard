"use strict";
/**
 * Zelftest zonder hardware: bouwt VESC-pakketten na en controleert of de
 * parser, de framing en de omrekening naar het datacontract kloppen.
 *
 *   node tools/selftest.js
 */

const assert = require("assert");
const { crc16, frame, Vesc, faultName } = require("../src/vesc");
const { Telemetry, pctFromCellVoltage, guessCells } = require("../src/telemetry");

let passed = 0;

/** Async variant — de synchrone `test` hieronder slikt een afgewezen promise. */
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    console.error("  ✗ " + name + "\n    " + err.message);
    process.exitCode = 1;
  }
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    console.error("  ✗ " + name + "\n    " + err.message);
    process.exitCode = 1;
  }
}

/* ── CRC en framing ─────────────────────────────────────────────────────── */
console.log("protocol");

test("CRC16-CCITT komt overeen met de bekende testvector", () => {
  assert.strictEqual(crc16(Buffer.from("123456789")), 0x31c3);
});

test("korte frames krijgen startbyte 0x02 en een lengtebyte", () => {
  const f = frame(Buffer.from([4]));
  assert.strictEqual(f[0], 0x02);
  assert.strictEqual(f[1], 1);
  assert.strictEqual(f[f.length - 1], 0x03);
  assert.strictEqual((f[3] << 8) | f[4], crc16(Buffer.from([4])));
});

test("frames boven 255 bytes krijgen startbyte 0x03 en twee lengtebytes", () => {
  const f = frame(Buffer.alloc(300, 7));
  assert.strictEqual(f[0], 0x03);
  assert.strictEqual((f[1] << 8) | f[2], 300);
});

/* ── payload-opbouw zoals de VESC-firmware hem schrijft ─────────────────── */

function buildValues(v) {
  const b = [];
  const i16 = (x, s) => { const t = Buffer.alloc(2); t.writeInt16BE(Math.round(x * s)); b.push(t); };
  const i32 = (x, s) => { const t = Buffer.alloc(4); t.writeInt32BE(Math.round(x * s)); b.push(t); };
  const u8 = (x) => b.push(Buffer.from([x]));

  u8(4);                       // COMM_GET_VALUES
  i16(v.tempFet, 10);
  i16(v.tempMotor, 10);
  i32(v.currentMotor, 100);
  i32(v.currentIn, 100);
  i32(0, 100);                 // id
  i32(0, 100);                 // iq
  i16(v.duty, 1000);
  i32(v.erpm, 1);
  i16(v.vIn, 10);
  i32(v.ampHours, 1e4);
  i32(0, 1e4);                 // ampHoursCharged
  i32(v.wattHours, 1e4);
  i32(0, 1e4);                 // wattHoursCharged
  i32(v.tachometer, 1);
  i32(v.tachometer, 1);        // tachometerAbs
  u8(v.fault || 0);
  i32(0, 1e6);                 // pid_pos
  u8(0);                       // controller_id
  return Buffer.concat(b);
}

function buildValuesSetup(v) {
  const b = [];
  const i16 = (x, s) => { const t = Buffer.alloc(2); t.writeInt16BE(Math.round(x * s)); b.push(t); };
  const i32 = (x, s) => { const t = Buffer.alloc(4); t.writeInt32BE(Math.round(x * s)); b.push(t); };

  b.push(Buffer.from([47]));   // COMM_GET_VALUES_SETUP
  i16(v.tempFet, 10);
  i16(v.tempMotor, 10);
  i32(v.currentMotor, 100);
  i32(v.currentIn, 100);
  i16(v.duty, 1000);
  i32(v.erpm, 1);
  i32(v.speedMs, 1000);
  i16(v.vIn, 10);
  i32(v.batteryLevel, 1000);   // wordt als int16 gelezen; zie test hieronder
  return Buffer.concat(b);
}

/** Voedt bytes aan een Vesc-instantie zonder echte poort. */
function feed(vesc, buf) {
  vesc.port = { write: () => Promise.resolve(), close: () => {} };
  vesc._feed(buf);
}

console.log("\nCOMM_GET_VALUES");

const sample = {
  tempFet: 41.3, tempMotor: 58.7, currentMotor: 23.45, currentIn: 12.34,
  duty: 0.734, erpm: 12750, vIn: 48.6, ampHours: 3.2, wattHours: 154.7,
  tachometer: 123456, fault: 5
};

test("een volledig pakket wordt correct uitgelezen", () => {
  const v = new Vesc({ pollMs: 150 });
  let snap = null;
  v.on("values", (s) => { snap = s; });
  feed(v, frame(buildValues(sample)));

  assert.ok(snap, "geen values-event");
  assert.strictEqual(snap.tempFet, 41.3);
  assert.strictEqual(snap.tempMotor, 58.7);
  assert.strictEqual(snap.currentMotor, 23.45);
  assert.strictEqual(snap.currentIn, 12.34);
  assert.strictEqual(snap.duty, 0.734);
  assert.strictEqual(snap.erpm, 12750);
  assert.strictEqual(snap.vIn, 48.6);
  assert.strictEqual(snap.wattHours, 154.7);
  assert.strictEqual(snap.tachometer, 123456);
  assert.strictEqual(snap.fault, "OVER_TEMP_FET");
});

test("een pakket dat in stukjes binnenkomt wordt samengevoegd", () => {
  const v = new Vesc({ pollMs: 150 });
  let snap = null;
  v.on("values", (s) => { snap = s; });
  const f = frame(buildValues(sample));
  for (let i = 0; i < f.length; i += 3) feed(v, f.subarray(i, Math.min(i + 3, f.length)));
  assert.ok(snap, "gefragmenteerd pakket niet herkend");
  assert.strictEqual(snap.erpm, 12750);
});

test("ruis vóór het startbyte wordt overgeslagen", () => {
  const v = new Vesc({ pollMs: 150 });
  let snap = null;
  v.on("values", (s) => { snap = s; });
  feed(v, Buffer.concat([Buffer.from([0xff, 0x00, 0xaa]), frame(buildValues(sample))]));
  assert.ok(snap, "pakket na ruis niet herkend");
});

test("een pakket met een kapotte CRC wordt genegeerd", () => {
  const v = new Vesc({ pollMs: 150 });
  let got = 0;
  v.on("values", () => { got++; });
  const f = frame(buildValues(sample));
  f[f.length - 3] ^= 0xff;                       // CRC verminken
  feed(v, f);
  assert.strictEqual(got, 0);
});

test("na een kapot pakket wordt het volgende weer opgepikt", () => {
  const v = new Vesc({ pollMs: 150 });
  let got = 0;
  v.on("values", () => { got++; });
  const bad = frame(buildValues(sample));
  bad[bad.length - 3] ^= 0xff;
  feed(v, Buffer.concat([bad, frame(buildValues(sample))]));
  assert.strictEqual(got, 1);
});

test("twee pakketten in één chunk worden allebei gelezen", () => {
  const v = new Vesc({ pollMs: 150 });
  let got = 0;
  v.on("values", () => { got++; });
  feed(v, Buffer.concat([frame(buildValues(sample)), frame(buildValues(sample))]));
  assert.strictEqual(got, 2);
});

console.log("\nCOMM_GET_VALUES_SETUP");

test("snelheid, afstand en accuniveau komen uit het setup-pakket", () => {
  const v = new Vesc({ pollMs: 150 });
  // Volledige setup-payload, inclusief de velden na batteryLevel.
  const b = [Buffer.from([47])];
  const i16 = (x, s) => { const t = Buffer.alloc(2); t.writeInt16BE(Math.round(x * s)); b.push(t); };
  const i32 = (x, s) => { const t = Buffer.alloc(4); t.writeInt32BE(Math.round(x * s)); b.push(t); };
  i16(40, 10); i16(55, 10);          // temps
  i32(20, 100); i32(10, 100);        // stromen
  i16(0.5, 1000);                    // duty
  i32(12750, 1);                     // erpm
  i32(7.5, 1000);                    // 7,5 m/s = 27 km/u
  i16(48.6, 10);                     // vIn
  i16(0.62, 1000);                   // battery level
  i32(3.2, 1e4); i32(0, 1e4);        // Ah
  i32(154.7, 1e4); i32(0, 1e4);      // Wh
  i32(8420, 1000); i32(8420, 1000);  // afstand 8,42 km
  feed(v, frame(Buffer.concat(b)));
  feed(v, frame(buildValues(sample)));

  const snap = v.snapshot();
  assert.ok(Math.abs(snap.speedMs - 7.5) < 0.01, "snelheid: " + snap.speedMs);
  assert.ok(Math.abs(snap.batteryLevel - 0.62) < 0.002, "accuniveau: " + snap.batteryLevel);
  assert.ok(Math.abs(snap.distanceM - 8420) < 1, "afstand: " + snap.distanceM);
});

test("een te kort setup-pakket wordt genegeerd in plaats van fout gelezen", () => {
  const v = new Vesc({ pollMs: 150 });
  feed(v, frame(buildValuesSetup({
    tempFet: 40, tempMotor: 55, currentMotor: 20, currentIn: 10,
    duty: 0.5, erpm: 1000, speedMs: 5, vIn: 48, batteryLevel: 0.6
  })));
  assert.strictEqual(v.setup, null);
});

/* ── omrekening naar het datacontract ───────────────────────────────────── */
console.log("\ntelemetrie");

function fakeState(trip) {
  const data = { settings: {}, topSpeed: 0, trip: trip || { distanceM: 0, wattHours: 0, valid: true } };
  return {
    data,
    get settings() { return data.settings; },
    get trip() { return data.trip; },
    patch(p) { Object.assign(data, p, { trip: Object.assign({}, data.trip, p.trip) }); }
  };
}

const cfg = {
  step: { batteryCells: 13, packWh: 1147, polePairs: 15, wheelDiameterM: 0.254, gearRatio: 1 }
};

test("snelheid uit de VESC wordt overgenomen (m/s → km/u)", () => {
  const t = new Telemetry(cfg, fakeState());
  const d = t.build({ vIn: 48.6, erpm: 12750, speedMs: 7.5, distanceM: 8420, batteryLevel: 0.62, wattHours: 154.7 });
  assert.ok(Math.abs(d.speed_kmh - 27) < 0.01, "km/u: " + d.speed_kmh);
  assert.ok(Math.abs(d.battery_pct - 62) < 0.01, "%: " + d.battery_pct);
  assert.ok(Math.abs(d.trip_km - 8.42) < 0.001, "km: " + d.trip_km);
});

test("zonder setup-waarden wordt de snelheid uit erpm berekend", () => {
  const t = new Telemetry(cfg, fakeState());
  // 12750 erpm / 15 poolparen = 850 motor-rpm = 850 wiel-rpm
  // 850/60 × π × 0,254 m × 3,6 = 40,7 km/u
  const d = t.build({ vIn: 48.6, erpm: 12750, wattHours: 0, tachometer: 0 });
  const expect = 12750 / 15 / 60 * Math.PI * 0.254 * 3.6;
  assert.ok(Math.abs(d.speed_kmh - expect) < 0.01, "km/u: " + d.speed_kmh);
  assert.strictEqual(d.rpm, 850);
});

test("zonder setup-waarden komt de afstand uit de tachometer", () => {
  const t = new Telemetry(cfg, fakeState());
  // afstand = tacho × (D·π) / (3 · 2·poolparen · overbrenging)
  const tacho = 3 * 2 * 15 * 1000;              // 1000 wielomwentelingen
  const d = t.build({ vIn: 48.6, erpm: 0, wattHours: 0, tachometer: tacho });
  const expect = 1000 * Math.PI * 0.254 / 1000; // km
  assert.ok(Math.abs(d.trip_km - expect) < 0.001, "km: " + d.trip_km);
});

test("het rit-nulpunt wordt van de tellerstand afgetrokken", () => {
  const t = new Telemetry(cfg, fakeState({ distanceM: 5000, wattHours: 100, valid: true }));
  const d = t.build({ vIn: 48.6, erpm: 0, speedMs: 0, distanceM: 8420, wattHours: 154.7 });
  assert.ok(Math.abs(d.trip_km - 3.42) < 0.001, "km: " + d.trip_km);
  assert.ok(Math.abs(d.wh_used - 54.7) < 0.01, "Wh: " + d.wh_used);
});

test("een herstart van de VESC zet het nulpunt terug", () => {
  const st = fakeState({ distanceM: 5000, wattHours: 100, valid: true });
  const t = new Telemetry(cfg, st);
  // De VESC start opnieuw op: zijn tellers staan weer op nul.
  const d = t.build({ vIn: 48.6, erpm: 0, speedMs: 0, distanceM: 12, wattHours: 0.4 });
  assert.strictEqual(st.trip.distanceM, 0);
  assert.ok(Math.abs(d.trip_km - 0.012) < 0.0001, "km: " + d.trip_km);
});

test("zonder accuniveau van de VESC volgt het percentage de celspanning", () => {
  const t = new Telemetry(cfg, fakeState());
  const d = t.build({ vIn: 3.8 * 13, erpm: 0, wattHours: 0, tachometer: 0 });
  assert.ok(Math.abs(d.cell_voltage - 3.8) < 0.001);
  assert.ok(Math.abs(d.battery_pct - 52) < 0.5, "%: " + d.battery_pct);
});

test("celaantal wordt geraden als het niet is ingesteld", () => {
  assert.strictEqual(guessCells(48.1), 13);
  assert.strictEqual(guessCells(45.6), 12);
  assert.strictEqual(guessCells(null), null);
});

test("de ontlaadcurve loopt monotoon van 0 naar 100", () => {
  assert.strictEqual(pctFromCellVoltage(2.5), 0);
  assert.strictEqual(pctFromCellVoltage(4.3), 100);
  let prev = -1;
  for (let v = 3.0; v <= 4.2; v += 0.05) {
    const p = pctFromCellVoltage(v);
    assert.ok(p >= prev, "niet monotoon bij " + v.toFixed(2) + " V");
    prev = p;
  }
});

test("zonder VESC is het contract volledig en op nul", () => {
  const t = new Telemetry(cfg, fakeState());
  const d = t.offline();
  for (const k of ["connected", "speed_kmh", "rpm", "erpm", "duty", "battery_pct", "voltage",
    "cell_voltage", "motor_current", "battery_current", "power_w", "temp_motor", "temp_fet",
    "wh_used", "trip_km"]) {
    assert.ok(k in d, "veld ontbreekt: " + k);
  }
  assert.strictEqual(d.connected, false);
});

test("faultcodes krijgen een leesbare naam", () => {
  assert.strictEqual(faultName(0), null);
  assert.strictEqual(faultName(1), "OVER_VOLTAGE");
  assert.strictEqual(faultName(6), "OVER_TEMP_MOTOR");
  assert.strictEqual(faultName(200), "FAULT_200");
});

/* ── wifi verbinden ─────────────────────────────────────────────────────── */
console.log("\nwifi");

const { wifiConnectPlan, wifiConnectPlanFallback } = require("../src/system");

const flat = (steps) => steps.map((s) => s.args.join(" ")).join(" | ");

test("zonder wachtwoord: bekend netwerk wordt gewoon geactiveerd", () => {
  assert.strictEqual(flat(wifiConnectPlan("Stepnet", null, true)), "connection up id Stepnet");
});

test("zonder wachtwoord: onbekend netwerk via device wifi connect", () => {
  assert.strictEqual(flat(wifiConnectPlan("Stepnet", null, false)), "device wifi connect Stepnet");
});

test("met wachtwoord op een onbekend netwerk gaat het geheim via stdin", () => {
  const steps = wifiConnectPlan("Stepnet", "geheim123", false);
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(flat(steps), "--ask device wifi connect Stepnet");
  assert.strictEqual(steps[0].input, "geheim123\n");
});

test("met wachtwoord op een bekend netwerk wordt het profiel bijgewerkt", () => {
  const steps = wifiConnectPlan("Stepnet", "geheim123", true);
  assert.strictEqual(steps.length, 2);
  assert.ok(steps[0].args.includes("modify"), "eerste stap moet het profiel aanpassen");
  assert.strictEqual(steps[0].input, "geheim123\n");
  assert.strictEqual(steps[1].args.join(" "), "connection up id Stepnet");
});

test("het wachtwoord staat nooit in de argumenten", () => {
  for (const known of [true, false]) {
    for (const step of wifiConnectPlan("Stepnet", "geheim123", known)) {
      assert.ok(!step.args.includes("geheim123"),
        "wachtwoord lekt naar argv (known=" + known + "): " + step.args.join(" "));
    }
  }
});

test("de terugval zonder --ask gebruikt wel argumenten", () => {
  // Alleen voor oude nmcli-versies; dan is argv het enige dat werkt.
  assert.ok(wifiConnectPlanFallback("Stepnet", "geheim123", false)[0].args.includes("geheim123"));
  assert.ok(wifiConnectPlanFallback("Stepnet", "geheim123", true)[0].args.includes("geheim123"));
});

test("een SSID met spaties blijft één argument", () => {
  const steps = wifiConnectPlan("Hotspot Ruben", "geheim123", false);
  assert.ok(steps[0].args.includes("Hotspot Ruben"));
});

(async () => {
/* ── bijwerken ──────────────────────────────────────────────────────────── */
console.log("\nupdate");

const { Updater, apiUrlFor } = require("../src/update");

test("de GitHub-API-url wordt uit de repo-url afgeleid", () => {
  assert.strictEqual(apiUrlFor("https://github.com/VandenOstende/step-dashboard.git", "main"),
    "https://api.github.com/repos/VandenOstende/step-dashboard/commits/main");
  assert.strictEqual(apiUrlFor("https://github.com/VandenOstende/step-dashboard", "main"),
    "https://api.github.com/repos/VandenOstende/step-dashboard/commits/main");
});

test("een ssh- of onzin-url levert geen api-url op", () => {
  assert.strictEqual(apiUrlFor("git@github.com:x/y.git", "main"), null);
  assert.strictEqual(apiUrlFor("", "main"), null);
  assert.strictEqual(apiUrlFor(null, "main"), null);
});

test("de tak wordt veilig in de url gezet", () => {
  assert.ok(apiUrlFor("https://github.com/a/b", "feature/x").endsWith("/commits/feature%2Fx"));
});

await atest("zonder netwerk meldt status een fout in plaats van te crashen", async () => {
  const u = new Updater({ update: { repo: "https://github.com/a/b", branch: "main" } });
  u.remote = () => Promise.reject(new Error("geen netwerk"));
  const st = await u.status(true);
  assert.strictEqual(st.error, "geen netwerk");
  assert.strictEqual(st.available, false);
});

await atest("een nieuwere commit op GitHub geeft available", async () => {
  const u = new Updater({ update: { repo: "https://github.com/a/b", branch: "main" } });
  u.installed = () => ({ commit: "a".repeat(40), at: 1 });
  u.remote = () => Promise.resolve({ commit: "b".repeat(40), message: "iets nieuws" });
  const st = await u.status(true);
  assert.strictEqual(st.available, true);
  assert.strictEqual(st.currentShort, "aaaaaaa");
  assert.strictEqual(st.latestShort, "bbbbbbb");
  assert.strictEqual(st.message, "iets nieuws");
});

await atest("dezelfde commit geeft geen update", async () => {
  const u = new Updater({ update: { repo: "https://github.com/a/b", branch: "main" } });
  u.installed = () => ({ commit: "c".repeat(40), at: 1 });
  u.remote = () => Promise.resolve({ commit: "c".repeat(40), message: "" });
  const st = await u.status(true);
  assert.strictEqual(st.available, false);
});

await atest("zonder bekende versie beweren we niet dat er een update is", async () => {
  // Bijvoorbeeld bij een handmatige kopie zonder version.json.
  const u = new Updater({ update: { repo: "https://github.com/a/b", branch: "main" } });
  u.installed = () => null;
  u.remote = () => Promise.resolve({ commit: "d".repeat(40), message: "" });
  const st = await u.status(true);
  assert.strictEqual(st.available, false);
  assert.strictEqual(st.current, null);
});

await atest("start weigert als er al een installatie loopt", async () => {
  const u = new Updater({ update: { repo: "https://github.com/a/b" } });
  u.progress = () => ({ state: "bezig", message: "ophalen" });
  const r = await u.start();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "al bezig");
});

await atest("status meldt dat er een installatie loopt", async () => {
  const u = new Updater({ update: { repo: "https://github.com/a/b" } });
  u.installed = () => ({ commit: "e".repeat(40), at: 1 });
  u.remote = () => Promise.resolve({ commit: "e".repeat(40), message: "" });
  u.progress = () => ({ state: "bezig", message: "installeren" });
  const st = await u.status(true);
  assert.strictEqual(st.running, true);
  assert.strictEqual(st.runMessage, "installeren");
});

  console.log("\n" + passed + " tests geslaagd" + (process.exitCode ? " — er zijn fouten" : ""));
})();
