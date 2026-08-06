"use strict";
/**
 * Designomgeving — de echte UI, nagemaakte hardware.
 *
 *   node tools/design.js            → http://localhost:8081/design
 *
 * Serveert `public/` precies zoals de echte server dat doet, maar alle
 * endpoints komen uit een scenario dat je vanaf het bedieningspaneel bijstelt.
 * Geen VESC, geen nmcli, geen bluetoothctl: je kunt hieraan werken op een
 * laptop zonder step in de gang.
 *
 * Het paneel zet de UI in een frame op ware grootte — liggend 480 × 320 of
 * staand 320 × 480, dezelfde maten als het schermpje op het stuur — met de
 * schuiven ernaast. Sla een bestand in `public/` op en het frame herlaadt
 * zichzelf.
 *
 * Dit hoort niet op de Pi thuis en wordt niet meegeïnstalleerd; het is
 * gereedschap voor op je eigen machine.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
/* Ontwerpen die nog geen productie zijn. Ze laden wel het echte /app.js, dus
   je klikt door een volwaardige UI en niet door een plaatje. */
const CONCEPTS = path.join(__dirname, "concepts");
const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || "0.0.0.0";

/* ── het scenario ───────────────────────────────────────────────────────── */

function base() {
  return {
    animate: true,          // laat de snelheid golven, zodat je de tekenlus ziet
    connected: true,
    speed: 24,
    battery: 68,
    duty: 42,
    tempMotor: 48,
    tempFet: 41,
    motorCurrent: 32,
    batteryCurrent: 14,
    tripKm: 7.4,
    whUsed: 132,
    fault: null,
    charging: false,
    chargeEta: 95,
    theme: "Auto",
    layout: "Liggend",      // welke pagina het frame toont

    wifi: { connected: true, ssid: "Huisnet", level: 3 },
    bt: { connected: true, name: "Sena 50S" },
    modem: { present: false, bars: 3, tech: "5G" },
    weather: { ok: true, temp_c: 14 },
    update: { available: false, message: "Bluetooth zoekt nu naar apparaten" }
  };
}

/* Kant-en-klare situaties. Het zijn er bewust weinig: net genoeg om elk scherm
   in één klik te pakken te krijgen.
 *
 * Elke situatie zet ook de waarden die er níet over gaan terug naar iets
 * normaals. Anders blijft het temperatuuralarm van "motor heet" over het
 * laadscherm heen staan als je daarna op "laden" klikt — de UI reageert
 * immers op de data, niet op de knop die je indrukte. */
const KOEL = { tempMotor: 46, tempFet: 40, fault: null };

const PRESETS = {
  "stilstaand": Object.assign({}, KOEL, { connected: true, speed: 0, duty: 0, motorCurrent: 0, batteryCurrent: 0, animate: false, charging: false }),
  "rijden": Object.assign({}, KOEL, { connected: true, speed: 34, duty: 62, motorCurrent: 48, batteryCurrent: 22, animate: true, charging: false, battery: 68 }),
  "motor heet": { connected: true, speed: 18, tempMotor: 96, tempFet: 71, fault: null, animate: false, charging: false },
  "fets warm": { connected: true, speed: 22, tempMotor: 62, tempFet: 74, fault: null, animate: false, charging: false },
  "lage accu": Object.assign({}, KOEL, { connected: true, battery: 6, speed: 12, animate: false, charging: false }),
  "storing": Object.assign({}, KOEL, { connected: true, speed: 0, fault: "OVER_TEMP_FET", animate: false, charging: false }),
  "laden": Object.assign({}, KOEL, { connected: true, speed: 0, battery: 43, charging: true, chargeEta: 78, animate: false }),
  "bijna vol": Object.assign({}, KOEL, { connected: true, speed: 0, battery: 97, charging: true, chargeEta: 6, animate: false }),
  "geen vesc": Object.assign({}, KOEL, { connected: false, animate: false, charging: false })
};

let S = base();
const t0 = Date.now();

/* ── het datacontract, uit het scenario ─────────────────────────────────── */

const CELLS = 13;
const WHEEL_M = 0.254 * Math.PI;   // omtrek van een 10"-wiel
const POLE_PAIRS = 15;

function data() {
  const secs = (Date.now() - t0) / 1000;
  if (!S.connected) {
    return Object.assign({
      connected: false, speed_kmh: 0, rpm: 0, erpm: 0, duty: 0,
      battery_pct: 0, voltage: 0, cell_voltage: 0,
      motor_current: 0, battery_current: 0, power_w: 0,
      temp_motor: 0, temp_fet: 0, wh_used: 0, trip_km: 0, fault: null
    }, charge());
  }

  // Golven rond de ingestelde snelheid: stilstand blijft stilstand.
  const wave = S.animate && S.speed > 0 ? 0.82 + 0.18 * Math.sin(secs / 2.4) : 1;
  const speed = Math.max(0, S.speed * wave);
  const cellV = 3.30 + 0.85 * (S.battery / 100);
  const voltage = cellV * CELLS;
  const erpm = (speed / 3.6) / WHEEL_M * 60 * POLE_PAIRS;
  const batteryCurrent = S.charging ? -Math.abs(S.batteryCurrent) : S.batteryCurrent * wave;

  return Object.assign({
    connected: true,
    speed_kmh: speed,
    rpm: erpm / POLE_PAIRS,
    erpm: erpm,
    duty: (S.duty / 100) * wave,
    battery_pct: S.battery,
    voltage: voltage,
    cell_voltage: cellV,
    motor_current: S.motorCurrent * wave,
    battery_current: batteryCurrent,
    power_w: batteryCurrent * voltage,
    temp_motor: S.tempMotor,
    temp_fet: S.tempFet,
    wh_used: S.whUsed,
    trip_km: S.tripKm,
    fault: S.fault || null
  }, charge());
}

function charge() {
  if (!S.charging) return { charging: false, charge_eta_min: null, charge_full: false, charge_session: 0 };
  return {
    charging: true,
    charge_eta_min: S.battery >= 99 ? 0 : S.chargeEta,
    charge_full: S.battery >= 99,
    charge_session: 1
  };
}

/* ── nagemaakte netwerken ───────────────────────────────────────────────── */

const WIFI = [
  { id: "Huisnet", name: "Huisnet", level: 3, signal: 88, known: true, secured: true },
  { id: "Huisnet-5G", name: "Huisnet-5G", level: 3, signal: 74, known: true, secured: true },
  { id: "Buren", name: "Buren", level: 2, signal: 52, known: false, secured: true },
  { id: "KPN Fon", name: "KPN Fon", level: 1, signal: 31, known: false, secured: false },
  { id: "Garage", name: "Garage", level: 1, signal: 24, known: false, secured: true },
  { id: "Telenet-4F2A9", name: "Telenet-4F2A9", level: 2, signal: 47, known: false, secured: true },
  { id: "iPhone van Kevin", name: "iPhone van Kevin", level: 3, signal: 81, known: false, secured: true }
];

const BT_PAIRED = [
  { id: "AA:BB:CC:DD:EE:01", name: "Sena 50S", known: true },
  { id: "AA:BB:CC:DD:EE:02", name: "Garmin Varia", known: true }
];
const BT_FOUND = [
  { id: "11:22:33:44:55:66", name: "JBL Go 3", known: false },
  { id: "11:22:33:44:55:77", name: "Mi Band 8", known: false },
  { id: "11:22:33:44:55:88", name: "11:22:33:44:55:88", known: false }
];

/* Zoeken duurt zes seconden en de vondsten komen na twee — kort genoeg om mee
   te werken, lang genoeg om de tussenstand te zien. */
let scanUntil = 0;
const scanning = () => Date.now() < scanUntil;

function netList(kind) {
  if (kind === "wifi") {
    return WIFI.map((w) => Object.assign({}, w, { active: S.wifi.connected && w.id === S.wifi.ssid }));
  }
  const found = Date.now() > scanUntil - 4000 && scanUntil > 0 ? BT_FOUND : [];
  return BT_PAIRED.concat(found).map((d) =>
    Object.assign({}, d, { active: S.bt.connected && d.name === S.bt.name }));
}

/* ── server ─────────────────────────────────────────────────────────────── */

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"
};

function send(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(buf);
}

function file(res, abs) {
  fs.readFile(abs, (err, buf) => {
    if (err) return send(res, 404, { error: "niet gevonden" });
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(abs)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(buf);
  });
}

function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { resolve({}); }
    });
  });
}

function merge(dst, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object") merge(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}

function mtime(dir) {
  let newest = 0;
  for (const f of fs.readdirSync(dir || PUBLIC, { withFileTypes: true })) {
    const abs = path.join(dir || PUBLIC, f.name);
    /* Ook een map eronder telt mee, mocht public/ er ooit een krijgen. */
    try { newest = Math.max(newest, f.isDirectory() ? mtime(abs) : fs.statSync(abs).mtimeMs); }
    catch { /* weg */ }
  }
  return Math.round(newest);
}

const log = [];
function note(m) {
  log.unshift(new Date().toTimeString().slice(0, 8) + "  " + m);
  log.length = Math.min(log.length, 40);
  console.log("[design] " + m);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = req.method;

  /* het paneel zelf */
  if (p === "/design" || p === "/design/") return file(res, path.join(__dirname, "design.html"));
  if (p === "/design/concepts") {
    let namen = [];
    try {
      namen = fs.readdirSync(CONCEPTS).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5));
    } catch { /* nog geen concepten */ }
    return send(res, 200, { concepts: namen });
  }
  if (p.startsWith("/concept/")) {
    const naam = path.basename(p.slice(9)).replace(/[^a-z0-9_-]/gi, "");
    if (!naam) return send(res, 404, { error: "niet gevonden" });
    return file(res, path.join(CONCEPTS, naam + ".html"));
  }
  if (p === "/design/state" && m === "GET") return send(res, 200, { state: S, presets: Object.keys(PRESETS), log: log });
  if (p === "/design/state" && m === "POST") {
    const b = await body(req);
    if (b.preset && PRESETS[b.preset]) { merge(S, PRESETS[b.preset]); note("scenario: " + b.preset); }
    if (b.reset) { S = base(); note("scenario terug naar de beginstand"); }
    if (b.patch) merge(S, b.patch);
    return send(res, 200, { state: S });
  }
  if (p === "/design/mtime") return send(res, 200, { mtime: mtime() });

  /* de endpoints die de UI verwacht */
  if (p === "/data") return send(res, 200, data());
  if (p === "/settings" && m === "GET") {
    return send(res, 200, {
      layout: S.layout, theme: S.theme, tempWarn: 70, tempCrit: 90,
      packWh: 1147, whPerKm: 18, speedMax: 35, bright: 80, start: 0,
      topSpeed: 41.2, pollMs: 150
    });
  }
  if (p === "/settings" && m === "POST") {
    const b = await body(req);
    if (b.theme) S.theme = b.theme;
    // Wisselt de UI zelf van indeling, dan volgt het paneel mee.
    if (b.layout === "Liggend" || b.layout === "Staand") S.layout = b.layout;
    note("instellingen: " + JSON.stringify(b));
    return send(res, 200, b);
  }
  if (p === "/reset-trip") { S.tripKm = 0; S.whUsed = 0; note("ritteller op nul"); return send(res, 200, { ok: true }); }
  if (p === "/reset-top") { note("topsnelheid op nul"); return send(res, 200, { ok: true }); }
  if (p === "/backlight") { const b = await body(req); note("helderheid " + b.level + "%"); return send(res, 200, { ok: true }); }
  if (p === "/power") { const b = await body(req); note("AAN/UIT: " + b.action); return send(res, 200, { ok: true }); }

  if (p === "/wifi") {
    return send(res, 200, S.wifi.connected
      ? { connected: true, ssid: S.wifi.ssid, level: S.wifi.level }
      : { connected: false, ssid: "", level: 0 });
  }
  if (p === "/bt") {
    return send(res, 200, S.bt.connected
      ? { connected: true, name: S.bt.name, mac: "AA:BB:CC:DD:EE:01" }
      : { connected: false, name: "", mac: "" });
  }
  if (p === "/modem") {
    return send(res, 200, S.modem.present
      ? { present: true, bars: S.modem.bars, tech: S.modem.tech }
      : { present: false, bars: 0, tech: null });
  }
  if (p === "/weather") {
    if (!S.weather.ok) return send(res, 503, { error: "geen locatie" });
    return send(res, 200, { temp_c: S.weather.temp_c, place: "Gent" });
  }

  if (p === "/net" && m === "GET") {
    const kind = url.searchParams.get("kind") === "bt" ? "bt" : "wifi";
    if (kind === "bt" && url.searchParams.get("scan") === "1" && !scanning()) {
      scanUntil = Date.now() + 6000;
      note("bluetooth: zoeken gestart");
    }
    const out = { kind, items: netList(kind) };
    if (kind === "bt") out.scanning = scanning();
    return send(res, 200, out);
  }
  if (p === "/net" && m === "POST") {
    const b = await body(req);
    const connect = b.connect !== false;
    if (b.kind === "bt") {
      S.bt.connected = connect;
      if (connect) S.bt.name = (netList("bt").find((d) => d.id === b.id) || {}).name || b.id;
    } else {
      S.wifi.connected = connect;
      if (connect) S.wifi.ssid = b.id;
    }
    note((b.kind || "wifi") + ": " + (connect ? "verbinden met " : "verbreken ") + b.id
      + (b.password ? " (wachtwoord van " + b.password.length + " tekens)" : ""));
    return send(res, 200, { ok: true });
  }

  if (p === "/update" && m === "GET") {
    return send(res, 200, {
      current: "0000000design0000000", currentShort: "design",
      available: S.update.available,
      latestShort: "abc1234", message: S.update.message,
      state: "klaar"
    });
  }
  if (p === "/update" && m === "POST") { note("bijwerken gestart (doet hier niks)"); return send(res, 200, { ok: true }); }

  /* en verder de echte UI */
  if (m === "GET" || m === "HEAD") {
    const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    const abs = path.join(PUBLIC, rel);
    if (!abs.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "verboden" });
    return file(res, abs);
  }
  send(res, 404, { error: "niet gevonden" });
});

server.listen(PORT, HOST, () => {
  console.log("[design] paneel:    http://localhost:" + PORT + "/design");
  console.log("[design] alleen UI: http://localhost:" + PORT + "/");
  console.log("[design] scenario's: " + Object.keys(PRESETS).join(", "));
});
