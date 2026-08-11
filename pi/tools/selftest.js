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

  /* ── laden ────────────────────────────────────────────────────────────── */
  console.log("\nladen");

  const { Charge } = require("../src/charge");

  /** Bouwt een /data-object; alleen de velden die Charge gebruikt doen ertoe. */
  const sample = (o) => Object.assign({
    connected: true, speed_kmh: 0, battery_pct: 50, voltage: 48, battery_current: 0
  }, o);

  /** Draait de klok vooruit en voedt Charge elke 5 s een monster. */
  function run(c, opts) {
    let t = opts.from;
    let out = null;
    while (t <= opts.from + opts.durationMs) {
      out = c.update(sample(opts.at(t)), t);
      t += 5000;
    }
    return out;
  }

  test("stilstaan met vlakke spanning is niet laden", () => {
    const c = new Charge();
    const r = run(c, { from: 0, durationMs: 10 * 60000, at: () => ({ voltage: 48, battery_pct: 50 }) });
    assert.strictEqual(r.charging, false);
  });

  test("langzaam stijgende spanning telt als laden", () => {
    const c = new Charge();
    // 0,04 V/min: een 13S-pak dat in een uur of vier vol is
    const r = run(c, {
      from: 0, durationMs: 12 * 60000,
      at: (t) => ({ voltage: 48 + t / 60000 * 0.04, battery_pct: 50 + t / 60000 * 0.2 })
    });
    assert.strictEqual(r.charging, true);
    assert.ok(r.since != null, "starttijd niet vastgelegd");
  });

  test("de spanningssprong bij het aansluiten wordt snel gezien", () => {
    const c = new Charge();
    // eerst een minuut rust, dan de lader erin: +0,3 V
    const r = run(c, {
      from: 0, durationMs: 3 * 60000,
      at: (t) => ({ voltage: t < 60000 ? 48 : 48.3, battery_pct: 50 })
    });
    assert.strictEqual(r.charging, true);
  });

  test("negatieve accustroom telt ook als laden", () => {
    const c = new Charge();
    const r = run(c, {
      from: 0, durationMs: 60000,
      at: () => ({ voltage: 48, battery_pct: 50, battery_current: -2.5 })
    });
    assert.strictEqual(r.charging, true);
  });

  test("rijden sluit laden uit", () => {
    const c = new Charge();
    run(c, {
      from: 0, durationMs: 12 * 60000,
      at: (t) => ({ voltage: 48 + t / 60000 * 0.04, battery_pct: 50 + t / 60000 * 0.2 })
    });
    assert.strictEqual(c.charging, true, "moet eerst laden");
    const r = c.update(sample({ speed_kmh: 25 }), 13 * 60000);
    assert.strictEqual(r.charging, false);
  });

  test("de resterende tijd klopt met het tempo", () => {
    const c = new Charge();
    // 1 % per minuut vanaf 50 %
    const r = run(c, {
      from: 0, durationMs: 12 * 60000,
      at: (t) => ({ voltage: 48 + t / 60000 * 0.04, battery_pct: 50 + t / 60000 })
    });
    assert.ok(r.etaMin != null, "geen schatting");
    // op t=12min staat hij op 62 %, dus nog 38 minuten
    assert.ok(Math.abs(r.etaMin - 38) <= 3, "geschat: " + r.etaMin + " min");
  });

  test("de eerste minuten geven nog geen schatting", () => {
    const c = new Charge();
    const r = run(c, {
      from: 0, durationMs: 90000,
      at: () => ({ voltage: 48, battery_pct: 50, battery_current: -3 })
    });
    assert.strictEqual(r.charging, true);
    assert.strictEqual(r.etaMin, null);
  });

  test("een volle accu geeft nul minuten", () => {
    const c = new Charge();
    const r = run(c, {
      from: 0, durationMs: 5 * 60000,
      at: () => ({ voltage: 54.6, battery_pct: 100, battery_current: -1 })
    });
    assert.strictEqual(r.full, true);
    assert.strictEqual(r.etaMin, 0);
  });

  test("zonder VESC-verbinding wordt alles vergeten", () => {
    const c = new Charge();
    run(c, {
      from: 0, durationMs: 5 * 60000,
      at: () => ({ voltage: 48, battery_pct: 50, battery_current: -3 })
    });
    assert.strictEqual(c.charging, true);
    const r = c.update({ connected: false }, 6 * 60000);
    assert.strictEqual(r.charging, false);
    assert.strictEqual(c.hist.length, 0);
  });

  test("elke nieuwe laadbeurt krijgt een eigen nummer", () => {
    const c = new Charge();
    const opts = {
      from: 0, durationMs: 5 * 60000,
      at: () => ({ voltage: 48, battery_pct: 50, battery_current: -3 })
    };
    const first = run(c, opts).session;
    c.update(sample({ speed_kmh: 25 }), 6 * 60000);          // ertussenuit rijden
    const second = run(c, Object.assign({}, opts, { from: 7 * 60000 })).session;
    assert.strictEqual(second, first + 1);
  });

  /* ── afsluiten en herstarten ──────────────────────────────────────────── */
  console.log("\naan/uit");

  const { powerCommand } = require("../src/system");

  test("reboot en shutdown worden vaste commando's", () => {
    assert.deepStrictEqual(powerCommand("reboot"),
      { cmd: "sudo", args: ["/usr/bin/systemctl", "reboot"] });
    assert.deepStrictEqual(powerCommand("shutdown"),
      { cmd: "sudo", args: ["/usr/bin/systemctl", "poweroff"] });
  });

  test("alles wat er niet in de tabel staat levert geen commando op", () => {
    ["", "halt", "reboot; rm -rf /", "REBOOT", null, undefined, 0, {}].forEach((a) => {
      assert.strictEqual(powerCommand(a), null, "mag niks opleveren: " + JSON.stringify(a));
    });
  });

  /* ── locatie voor het weer ────────────────────────────────────────────── */
  console.log("\nweer");

  const { Weather, parseIpLocation } = require("../src/weather");

  test("de IP-opzoeking levert coördinaten en een plaatsnaam", () => {
    const loc = parseIpLocation({ success: true, city: "Gent", latitude: 51.05, longitude: 3.72 });
    assert.deepStrictEqual(loc, { latitude: 51.05, longitude: 3.72, place: "Gent" });
  });

  test("een mislukte of lege opzoeking geeft niks terug", () => {
    assert.strictEqual(parseIpLocation({ success: false }), null);
    assert.strictEqual(parseIpLocation({ latitude: "?", longitude: "?" }), null);
    assert.strictEqual(parseIpLocation({ latitude: 0, longitude: 0 }), null);   // nulpunt = onbekend
    assert.strictEqual(parseIpLocation(null), null);
  });

  await atest("coördinaten uit config.json gaan voor op alles", async () => {
    const w = new Weather({ weather: { latitude: 51, longitude: 3.7 } });
    const loc = await w._location();
    assert.strictEqual(loc.latitude, 51);
    assert.strictEqual(loc.longitude, 3.7);
  });

  await atest("met ipFallback uit blijft het bij de modem", async () => {
    const w = new Weather({ weather: { ipFallback: false } });
    assert.strictEqual(await w._location(), null);   // geen modem in de testomgeving
  });

  /* ── de step herkennen ──────────────────────────────────────────────────
     Weet de VESC hoe de step in elkaar zit, dan hoeft er niets in config.json
     te staan. Weet hij het niet, dan moet de app dat merken — en het verschil
     is alleen te zien terwijl de motor draait. */
  console.log("\nstep herkennen");

  const { SetupWatch } = require("../src/setup");
  const { saveConfigStep } = require("../src/config");
  const fs3 = require("fs");
  const os3 = require("os");
  const path3 = require("path");

  const basis = () => ({
    step: { batteryCells: null, packWh: 1147, polePairs: 15,
            wheelDiameterM: 0.254, gearRatio: 1, source: null, learnedAt: null }
  });
  /* Een VESC die de wizard gedraaid heeft: snelheid volgens 10-inch wielen. */
  const rijdt = (erpm, wiel) => ({
    erpm: erpm, vIn: 50.4,
    speedMs: erpm / 15 / 60 * (wiel * Math.PI)
  });

  test("stilstaand valt er niets te zeggen", () => {
    const w = new SetupWatch(basis());
    w.observe({ erpm: 0, vIn: 50.4, speedMs: 0 });
    assert.strictEqual(w.status, "unknown");
  });

  test("snelheid nul terwijl de motor draait = wizard niet gedraaid", () => {
    const w = new SetupWatch(basis());
    w.observe({ erpm: 8100, vIn: 50.4, speedMs: 0 });
    assert.strictEqual(w.status, "missing");
  });

  test("geen setup-antwoord telt ook als niet ingesteld", () => {
    const w = new SetupWatch(basis());
    w.observe({ erpm: 0, vIn: 50.4 });          // speedMs ontbreekt
    assert.strictEqual(w.status, "missing");
  });

  test("een ingestelde VESC herkent hij, en leidt de wielmaat af", () => {
    const w = new SetupWatch(basis());
    for (let i = 0; i < 20; i++) w.observe(rijdt(6000 + i * 100, 0.2032));   // 8 inch
    assert.strictEqual(w.status, "ok");
    assert.ok(Math.abs(w.derived().wheelDiameterM - 0.2032) < 0.001,
      "wielmaat werd " + w.derived().wheelDiameterM);
  });

  test("één uitschieter trekt de wielmaat niet scheef", () => {
    const w = new SetupWatch(basis());
    for (let i = 0; i < 20; i++) w.observe(rijdt(6000 + i * 100, 0.2032));
    w.observe({ erpm: 6000, vIn: 50.4, speedMs: 30 });     // onmogelijk snel
    assert.ok(Math.abs(w.derived().wheelDiameterM - 0.2032) < 0.001);
  });

  test("klopt de wielmaat al, dan valt er niets te schrijven", () => {
    const cfg = basis();
    const w = new SetupWatch(cfg);
    for (let i = 0; i < 20; i++) w.observe(rijdt(6000 + i * 100, 0.254));
    cfg.step.batteryCells = 13;                  // anders wil hij die nog zetten
    assert.strictEqual(w.patch(), null);
  });

  test("een VESC die het niet weet levert nooit een patch", () => {
    const w = new SetupWatch(basis());
    w.observe({ erpm: 8100, vIn: 50.4, speedMs: 0 });
    assert.strictEqual(w.patch(), null);
  });

  test("saveConfigStep laat de rest van config.json met rust", () => {
    const dir = fs3.mkdtempSync(path3.join(os3.tmpdir(), "step-"));
    const file = path3.join(dir, "config.json");
    fs3.writeFileSync(file, JSON.stringify({ port: 9999, step: { polePairs: 15 } }, null, 2));
    const cfg = Object.assign(basis(), { __file: file });
    saveConfigStep(cfg, { wheelDiameterM: 0.2032, source: "vesc" });
    const na = JSON.parse(fs3.readFileSync(file, "utf8"));
    assert.strictEqual(na.port, 9999);              // niet aangeraakt
    assert.strictEqual(na.step.polePairs, 15);      // niet weggegooid
    assert.strictEqual(na.step.wheelDiameterM, 0.2032);
    assert.strictEqual(cfg.step.source, "vesc");    // en de draaiende server mee
    fs3.rmSync(dir, { recursive: true, force: true });
  });

  /* ── rijmodi ────────────────────────────────────────────────────────────
     Deze bytes gaan naar een motorcontroller. Er staat dus meer op het spel
     dan bij een verkeerd getekend vakje: één verkeerd veld en de step trekt
     niet meer op, of erger, hij schrijft naar flash. Vandaar byte voor byte. */
  console.log("\nrijmodi");

  const md = require("../src/modes");

  /* buffer_append_float32_auto uit bldc/util/buffer.c, letterlijk nagebouwd.
     De bewering is dat dit hetzelfde oplevert als IEEE-754 big endian; als dat
     ooit niet meer klopt, valt deze test om en niet de step. */
  function float32Auto(x) {
    if (Math.abs(x) < 1.5e-38) x = 0;
    let e = 0;
    if (x !== 0) { e = Math.ceil(Math.log2(Math.abs(x))); }
    /* frexp: sig in [0.5,1) met x = sig * 2^e */
    let sig = x === 0 ? 0 : x / Math.pow(2, e);
    while (Math.abs(sig) >= 1) { sig /= 2; e += 1; }
    while (sig !== 0 && Math.abs(sig) < 0.5) { sig *= 2; e -= 1; }
    const sigAbs = Math.abs(sig);
    let sigI = 0;
    if (sigAbs >= 0.5) { sigI = Math.floor((sigAbs - 0.5) * 2 * 8388608); e += 126; }
    else { e = 0; }
    let res = (((e & 0xff) << 23) | (sigI & 0x7fffff)) >>> 0;
    if (sig < 0) res = (res | 0x80000000) >>> 0;
    const b = Buffer.alloc(4);
    b.writeUInt32BE(res, 0);
    return b;
  }

  const cfgModes = (over) => ({
    step: { polePairs: 15, wheelDiameterM: 0.254, gearRatio: 1 },
    modes: Object.assign({
      enabled: true,
      list: [
        { name: "ECO", currentMaxScale: 0.55, currentMinScale: 0.8,
          speedMaxKmh: 20, dutyMax: 0.9, wattMax: 700, inCurrentMax: 20 },
        { name: "SPORT", currentMaxScale: 1, currentMinScale: 1,
          speedMaxKmh: null, dutyMax: 0.95, wattMax: null, inCurrentMax: null }
      ]
    }, over)
  });

  test("float32_auto van de firmware is gewoon IEEE-754 big endian", () => {
    for (const v of [0, 0.05, 0.55, -0.55, 1, 0.95, -0.95, 20, 5.5556, 700, -700, 1500, 1e6]) {
      const eigen = Buffer.alloc(4);
      eigen.writeFloatBE(Math.fround(v), 0);
      assert.deepStrictEqual(float32Auto(Math.fround(v)), eigen, "wijkt af bij " + v);
    }
  });

  /* Eén plek waar ze wél verschillen, en de reden dat writeFloatBE mag: de
     firmware zet subnormale getallen op nul ("as they are not handled properly
     using this method"). Zolang wij er nooit een sturen maakt het niet uit —
     en dat is precies wat de tweede helft hier vastlegt. */
  test("subnormale getallen zijn het enige verschil, en die sturen we nooit", () => {
    const eigen = Buffer.alloc(4);
    eigen.writeFloatBE(Math.fround(1e-39), 0);
    assert.notDeepStrictEqual(float32Auto(1e-39), eigen);
    assert.deepStrictEqual(float32Auto(1e-39), Buffer.alloc(4));   // de firmware: nul

    const pak = md.buildProfilePacket(cfgModes(), "ECO", true);
    for (let i = 0; i < 10; i++) {
      const v = Math.abs(pak.extra.readFloatBE(4 + i * 4));
      assert.ok(v === 0 || v >= 1.5e-38, "veld " + i + " is subnormaal: " + v);
    }
  });


  test("ECO levert het pakket dat de firmware verwacht, veld voor veld", () => {
    const pak = md.buildProfilePacket(cfgModes(), "ECO", true);
    assert.strictEqual(pak.cmd, md.COMM_SET_MCCONF_TEMP_SETUP);
    assert.strictEqual(pak.extra.length, 4 + 10 * 4);
    assert.strictEqual(pak.extra[0], 0, "store moet nul blijven — nooit naar flash");
    assert.strictEqual(pak.extra[1], 0, "forward_can");
    assert.strictEqual(pak.extra[2], 1, "ack");
    assert.strictEqual(pak.extra[3], 0, "divide_by_controllers");
    const f = (i) => pak.extra.readFloatBE(4 + i * 4);
    assert.ok(Math.abs(f(0) - 0.8) < 1e-6, "current_min_scale");
    assert.ok(Math.abs(f(1) - 0.55) < 1e-6, "current_max_scale");
    assert.ok(Math.abs(f(3) - 20 / 3.6) < 1e-4, "max in m/s");
    assert.ok(Math.abs(f(2) + 20 / 3.6) < 1e-4, "min is de negatieve max");
    assert.ok(Math.abs(f(5) - 0.9) < 1e-6, "duty max");
    assert.ok(Math.abs(f(7) - 700) < 1e-3, "watt max");
    assert.ok(Math.abs(f(9) - 20) < 1e-3, "accustroom max");
  });

  test("de bytes zijn precies wat float32_auto zou maken", () => {
    const pak = md.buildProfilePacket(cfgModes(), "ECO", true);
    const verwacht = [0.8, 0.55, -(20 / 3.6), 20 / 3.6, -0.9, 0.9, -700, 700, -20, 20];
    verwacht.forEach((v, i) => {
      assert.deepStrictEqual(pak.extra.subarray(4 + i * 4, 8 + i * 4),
        float32Auto(Math.fround(v)), "veld " + i);
    });
  });

  test("zonder setup-wizard gaat het in erpm, met commando 48", () => {
    const pak = md.buildProfilePacket(cfgModes(), "ECO", false);
    assert.strictEqual(pak.cmd, md.COMM_SET_MCCONF_TEMP);
    /* 20 km/u op een 10"-wiel met 15 poolparen */
    const verwacht = 20 / 3.6 / (0.254 * Math.PI) * 60 * 15;
    assert.ok(Math.abs(pak.extra.readFloatBE(4 + 3 * 4) - verwacht) < 1,
      "erpm werd " + pak.extra.readFloatBE(4 + 3 * 4) + ", verwacht " + verwacht);
  });

  test("een schaal boven 1 wordt afgeklemd, want zo werkt de firmware ook", () => {
    const c = cfgModes();
    c.modes.list[0].currentMaxScale = 2;
    c.modes.list[0].dutyMax = -3;
    const pak = md.buildProfilePacket(c, "ECO", true);
    assert.strictEqual(pak.extra.readFloatBE(4 + 1 * 4), 1);
    assert.ok(pak.extra.readFloatBE(4 + 5 * 4) > 0, "duty mag nooit negatief worden");
  });

  test("een vergeten veld betekent 'niet begrenzen', niet 'nul'", () => {
    const c = cfgModes();
    c.modes.list[0] = { name: "ECO", currentMaxScale: 0.5 };
    const pak = md.buildProfilePacket(c, "ECO", true);
    assert.ok(pak.extra.readFloatBE(4 + 3 * 4) > 100, "snelheid onbegrensd");
    assert.ok(pak.extra.readFloatBE(4 + 7 * 4) > 1e5, "watt onbegrensd");
    assert.ok(Math.abs(pak.extra.readFloatBE(4 + 5 * 4) - md.DUTY_MAX) < 1e-6);
  });

  test("uitgeschakeld levert nooit een pakket op", () => {
    assert.strictEqual(md.buildProfilePacket(cfgModes({ enabled: false }), "ECO", true), null);
  });

  test("een onbekende modus levert nooit een pakket op", () => {
    assert.strictEqual(md.buildProfilePacket(cfgModes(), "TURBO", true), null);
    assert.strictEqual(md.buildProfilePacket(cfgModes(), "", true), null);
  });

  test("dubbele en naamloze regels vallen uit de lijst", () => {
    const c = cfgModes();
    c.modes.list.push({ name: "ECO", currentMaxScale: 0.1 }, { currentMaxScale: 0.2 });
    assert.deepStrictEqual(md.profiles(c).map((p) => p.name), ["ECO", "SPORT"]);
    assert.ok(Math.abs(md.findProfile(c, "ECO").currentMaxScale - 0.55) < 1e-6,
      "de eerste ECO telt, niet de latere");
  });

  /* ── cruisecontrol herkennen ────────────────────────────────────────────
     De VESC meldt het niet, dus dit is een gevolgtrekking. Die mag falen naar
     "weet ik niet", nooit naar "ja hoor" — vandaar dat de helft van deze
     tests over dingen gaat die er níet uit moeten komen. */
  console.log("\ncruisecontrol");

  const { Cruise } = require("../src/cruise");
  const { parseDecodedAdc } = require("../src/vesc");

  test("het hendelpakket wordt goed gelezen", () => {
    const p = Buffer.alloc(17);
    p[0] = 32;
    p.writeInt32BE(Math.round(0.42 * 1e6), 1);
    p.writeInt32BE(Math.round(1.85 * 1e6), 5);
    p.writeInt32BE(0, 9);
    p.writeInt32BE(Math.round(0.83 * 1e6), 13);
    const v = parseDecodedAdc(p);
    assert.ok(Math.abs(v.level - 0.42) < 1e-6);
    assert.ok(Math.abs(v.voltage - 1.85) < 1e-6);
    assert.ok(Math.abs(v.voltage2 - 0.83) < 1e-6);
    assert.strictEqual(parseDecodedAdc(Buffer.from([32, 0, 0])), null);
  });

  /* Een ritje afspelen: elke stap is 150 ms, net als de echte pollronde. */
  function speel(c, stappen, start) {
    let t = start || 10000;
    let uit = c.state();
    for (const s of stappen) {
      for (let i = 0; i < (s.n || 1); i++) {
        t += 150;
        uit = c.update({
          throttle: s.gas, throttleVolt: s.volt === undefined ? 0.85 : s.volt,
          erpm: s.erpm, currentMotor: s.stroom
        }, t);
      }
    }
    return uit;
  }

  const RIJDT = { gas: 0.55, erpm: 8100, stroom: 22, n: 10 };
  const CRUISE = { gas: 0, erpm: 8100, stroom: 12, n: 10 };

  test("gas open is geen cruisecontrol", () => {
    assert.strictEqual(speel(new Cruise({}), [RIJDT]).active, false);
  });

  test("uitrollen is geen cruisecontrol", () => {
    /* Gas los, nauwelijks stroom, snelheid zakt. */
    const c = new Cruise({});
    const stappen = [RIJDT];
    for (let i = 0; i < 12; i++) stappen.push({ gas: 0, erpm: 8100 - i * 150, stroom: 0.4 });
    assert.strictEqual(speel(c, stappen).active, false);
  });

  test("remmen is geen cruisecontrol", () => {
    const c = new Cruise({});
    assert.strictEqual(speel(c, [RIJDT, { gas: 0, erpm: 8100, stroom: -30, n: 10 }]).active, false);
  });

  test("bergaf met nul gas is geen cruisecontrol", () => {
    /* Snelheid blijft vlak, maar de motor doet niets. Dat is precies waar
       minCurrentA voor is. */
    const c = new Cruise({});
    assert.strictEqual(speel(c, [RIJDT, { gas: 0, erpm: 8100, stroom: 1.2, n: 12 }]).active, false);
  });

  test("het patroon van cruisecontrol wordt herkend", () => {
    const c = new Cruise({});
    assert.strictEqual(speel(c, [RIJDT, CRUISE]).active, true);
  });

  test("maar pas na de wachttijd, niet meteen", () => {
    const c = new Cruise({});
    /* Twee stappen is 300 ms; holdMs staat op 600. */
    assert.strictEqual(speel(c, [RIJDT, { gas: 0, erpm: 8100, stroom: 12, n: 2 }]).active, false);
  });

  test("versnellen met nul gas telt niet — de snelheid wordt niet vastgehouden", () => {
    const c = new Cruise({});
    const stappen = [RIJDT];
    for (let i = 0; i < 14; i++) stappen.push({ gas: 0, erpm: 6000 + i * 400, stroom: 25 });
    assert.strictEqual(speel(c, stappen).active, false);
  });

  test("zonder hendelspanning wordt er niets beweerd", () => {
    /* Geen ADC-app: het gedecodeerde niveau blijft nul en zou anders altijd
       als "gas los" gelden. */
    const c = new Cruise({});
    const uit = speel(c, [{ gas: 0, volt: 0, erpm: 8100, stroom: 22, n: 20 }]);
    assert.strictEqual(uit.supported, false);
    assert.strictEqual(uit.active, false);
  });

  test("zonder antwoord op het hendelpakket ook niet", () => {
    const c = new Cruise({});
    const uit = c.update({ erpm: 8100, currentMotor: 22 }, 10000);
    assert.strictEqual(uit.supported, false);
    assert.strictEqual(uit.active, false);
  });

  test("één rare meting midden in cruise zet het niet uit", () => {
    const c = new Cruise({});
    speel(c, [RIJDT, CRUISE]);
    assert.strictEqual(c.state().active, true);
    speel(c, [{ gas: 0, erpm: 8100, stroom: 0.2, n: 1 }], 20000);   // 150 ms < LOS_MS
    assert.strictEqual(c.state().active, true);
  });

  test("gas geven zet het wel uit", () => {
    const c = new Cruise({});
    speel(c, [RIJDT, CRUISE]);
    assert.strictEqual(c.state().active, true);
    speel(c, [{ gas: 0.4, erpm: 8100, stroom: 30, n: 4 }], 20000);
    assert.strictEqual(c.state().active, false);
  });

  test("uitgeschakeld in config.json levert nooit iets op", () => {
    const c = new Cruise({ cruise: { enabled: false } });
    assert.strictEqual(speel(c, [RIJDT, CRUISE]).active, false);
  });

  test("de verbinding kwijt betekent weer niets weten", () => {
    const c = new Cruise({});
    speel(c, [RIJDT, CRUISE]);
    c.reset();
    assert.deepStrictEqual(c.state(), { active: false, supported: false });
  });

  console.log("\n" + passed + " tests geslaagd" + (process.exitCode ? " — er zijn fouten" : ""));
})();
