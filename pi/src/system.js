"use strict";
/**
 * Systeemkoppelingen voor de topbalk en het verbindingsscherm.
 *
 *   wifi       → nmcli
 *   bluetooth  → bluetoothctl
 *   mobiel     → mmcli (ModemManager)
 *   helderheid → /sys/class/backlight
 *   desktop    → het commando uit config.json
 *
 * Alles draait via execFile met een argumentenlijst — nooit via een shell —
 * zodat een SSID of apparaatnaam nooit als commando kan eindigen. Ontbreekt
 * een tool, dan geeft de functie netjes een leeg/onbekend resultaat terug en
 * toont de UI "niet verbonden" of "geen bereik".
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function run(cmd, args, timeout, input) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeout || 4000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, out: (stdout || "").toString(), err: (stderr || "").toString().trim(), code: err ? err.code : 0 });
      });
    // Stdin altijd sluiten, ook als er niets in gaat: blijft de pijp open, dan
    // wacht een tool die stdin leest — bluetoothctl doet dat — tot de timeout
    // in plaats van meteen te antwoorden. Geheimen gaan hierlangs naar nmcli
    // en niet via de argumenten, want die staan in `ps` en /proc te lezen.
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input == null ? "" : input);
    }
  });
}

/** nmcli -t ontsnapt een letterlijke dubbelepunt als "\:" — splits daarop. */
function splitTerse(line) {
  const out = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ":") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/* ── wifi ───────────────────────────────────────────────────────────────── */

/** nmcli-signaal (0..100) naar de drie bogen van het wifi-icoon. */
const wifiLevel = (signal) => (signal >= 67 ? 3 : signal >= 34 ? 2 : signal > 0 ? 1 : 0);

async function wifiStatus() {
  const r = await run("nmcli", ["-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi", "list", "--rescan", "no"]);
  if (!r.ok) return { connected: false, ssid: "", level: 0 };
  for (const line of lines(r.out)) {
    const [active, ssid, signal] = splitTerse(line);
    if (active === "yes") {
      return { connected: true, ssid: ssid || "", level: wifiLevel(parseInt(signal, 10) || 0) };
    }
  }
  return { connected: false, ssid: "", level: 0 };
}

async function knownConnections() {
  const r = await run("nmcli", ["-t", "-f", "NAME,TYPE", "connection", "show"]);
  const set = new Set();
  if (r.ok) {
    for (const line of lines(r.out)) {
      const [name, type] = splitTerse(line);
      if (/wireless/.test(type || "")) set.add(name);
    }
  }
  return set;
}

async function wifiList() {
  const [r, known] = await Promise.all([
    run("nmcli", ["-t", "-f", "ACTIVE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto"], 12000),
    knownConnections()
  ]);
  if (!r.ok) return [];
  const best = new Map();
  for (const line of lines(r.out)) {
    const [active, ssid, signal, security] = splitTerse(line);
    if (!ssid) continue;                          // verborgen netwerk
    const sig = parseInt(signal, 10) || 0;
    const prev = best.get(ssid);
    if (prev && prev.signal >= sig && !(active === "yes")) continue;
    best.set(ssid, {
      id: ssid,
      name: ssid,
      active: active === "yes",
      level: wifiLevel(sig),
      signal: sig,
      known: known.has(ssid),
      secured: !!(security && security !== "--")
    });
  }
  return [...best.values()]
    .sort((a, b) => (b.active - a.active) || (b.known - a.known) || (b.signal - a.signal))
    .slice(0, 40);
}

/**
 * Stel de nmcli-aanroep samen. Apart gehouden van het uitvoeren zodat de
 * zelftest kan controleren wát er gebeurt zonder nmcli aan te roepen.
 *
 * Levert een lijst stappen; elke stap is {args, input}. `input` gaat naar
 * stdin, zodat een wachtwoord nooit in de argumenten belandt.
 */
function wifiConnectPlan(ssid, password, known) {
  if (!password) {
    return known
      ? [{ args: ["connection", "up", "id", ssid] }]
      : [{ args: ["device", "wifi", "connect", ssid] }];
  }
  if (known) {
    // Het profiel bestaat al met een ander wachtwoord: bijwerken en opnieuw
    // verbinden. nmcli leest de nieuwe waarde van stdin dankzij --ask.
    return [
      { args: ["--ask", "connection", "modify", "id", ssid,
        "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk"], input: password + "\n" },
      { args: ["connection", "up", "id", ssid] }
    ];
  }
  return [{ args: ["--ask", "device", "wifi", "connect", ssid], input: password + "\n" }];
}

/** Terugval als --ask niet werkt: het wachtwoord tóch als argument. */
function wifiConnectPlanFallback(ssid, password, known) {
  if (known) {
    return [
      { args: ["connection", "modify", "id", ssid,
        "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password] },
      { args: ["connection", "up", "id", ssid] }
    ];
  }
  return [{ args: ["device", "wifi", "connect", ssid, "password", password] }];
}

const SECRET_RE = /secret|password|psk|802-11-wireless-security|not provided|invalid/i;

async function runPlan(steps) {
  let last = { ok: true, err: "" };
  for (const s of steps) {
    last = await run("nmcli", s.args, 30000, s.input);
    if (!last.ok) return last;
  }
  return last;
}

async function wifiConnect(ssid, password) {
  const known = (await knownConnections()).has(ssid);
  let r = await runPlan(wifiConnectPlan(ssid, password, known));

  // Oudere nmcli-versies kennen --ask niet op elk subcommando; dan alsnog de
  // argumentvorm proberen.
  if (!r.ok && password && /unknown option|--ask|usage:/i.test(r.err || "")) {
    r = await runPlan(wifiConnectPlanFallback(ssid, password, known));
  }
  if (r.ok) return { ok: true };

  if (SECRET_RE.test(r.err || "")) {
    return password
      ? { ok: false, error: "wachtwoord onjuist", needsPassword: true }
      : { ok: false, error: "wachtwoord nodig", needsPassword: true };
  }
  return { ok: false, error: "verbinden mislukt" };
}

async function wifiDisconnect(ssid) {
  const r = await run("nmcli", ["connection", "down", "id", ssid], 15000);
  return r.ok ? { ok: true } : { ok: false, error: "verbreken mislukt" };
}

/* ── bluetooth ──────────────────────────────────────────────────────────── */

const BT_LINE = /^Device\s+([0-9A-F:]{17})\s+(.*)$/i;

async function btDevices(filter) {
  const args = filter ? ["devices", filter] : ["devices"];
  const r = await run("bluetoothctl", args, 6000);
  if (!r.ok) return null;
  const out = [];
  for (const line of lines(r.out)) {
    const m = BT_LINE.exec(line);
    if (m) out.push({ mac: m[1].toUpperCase(), name: m[2].trim() || m[1] });
  }
  return out;
}

/** `bluetoothctl devices Connected` bestaat pas vanaf bluez 5.62. */
async function btConnected() {
  const direct = await btDevices("Connected");
  if (direct) return direct;
  const all = (await btDevices(null)) || [];
  const out = [];
  for (const d of all) {
    const info = await run("bluetoothctl", ["info", d.mac], 4000);
    if (info.ok && /Connected:\s*yes/i.test(info.out)) out.push(d);
  }
  return out;
}

async function btStatus() {
  const conn = await btConnected();
  if (!conn.length) return { connected: false, name: "", mac: "" };
  return { connected: true, name: conn[0].name, mac: conn[0].mac };
}

async function btList() {
  const paired = (await btDevices("Paired")) || (await btDevices(null)) || [];
  const conn = await btConnected();
  const live = new Set(conn.map((d) => d.mac));
  for (const d of conn) if (!paired.some((p) => p.mac === d.mac)) paired.push(d);
  return paired
    .map((d) => ({ id: d.mac, name: d.name, active: live.has(d.mac) }))
    .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
}

async function btConnect(mac) {
  const r = await run("bluetoothctl", ["connect", mac], 25000);
  if (r.ok && !/Failed/i.test(r.out)) return { ok: true };
  return { ok: false, error: "koppelen mislukt" };
}

async function btDisconnect(mac) {
  const r = await run("bluetoothctl", ["disconnect", mac], 15000);
  return r.ok ? { ok: true } : { ok: false, error: "verbreken mislukt" };
}

/* ── mobiel bereik ──────────────────────────────────────────────────────── */

const TECH = [
  [/5gnr|nr5g/, "5G"],
  [/\blte\b|4g/, "4G"],
  [/umts|hsdpa|hsupa|hspa|3g/, "3G"],
  [/edge/, "EDGE"],
  [/gprs|gsm|2g/, "2G"]
];

function techName(list) {
  const s = (Array.isArray(list) ? list.join(" ") : String(list || "")).toLowerCase();
  for (const [re, name] of TECH) if (re.test(s)) return name;
  return null;
}

async function modem() {
  const r = await run("mmcli", ["-J", "-m", "any"], 6000);
  if (!r.ok) return { bars: 0, tech: null };
  let j;
  try {
    j = JSON.parse(r.out);
  } catch {
    return { bars: 0, tech: null };
  }
  const g = (j.modem && j.modem.generic) || {};
  const quality = parseInt((g["signal-quality"] || {}).value, 10);
  const state = String(g.state || "");
  const tech = techName(g["access-technologies"]);
  if (!/registered|connected/i.test(state) && !tech) return { bars: 0, tech: null };
  const bars = isFinite(quality) ? Math.max(quality > 0 ? 1 : 0, Math.round(quality / 20)) : 0;
  return { bars: Math.max(0, Math.min(5, bars)), tech };
}

/** Locatie van de modem, als die uitgelezen mag worden. */
async function modemLocation() {
  const r = await run("mmcli", ["-J", "-m", "any", "--location-get"], 8000);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out);
    const gps = ((j.modem || {}).location || {}).gps || {};
    const lat = parseFloat(gps.latitude);
    const lon = parseFloat(gps.longitude);
    if (isFinite(lat) && isFinite(lon)) return { latitude: lat, longitude: lon };
  } catch { /* geen locatie */ }
  return null;
}

/* ── schermhelderheid ───────────────────────────────────────────────────── */

function backlightDir(configured) {
  if (configured) return configured;
  try {
    const base = "/sys/class/backlight";
    const entries = fs.readdirSync(base);
    if (entries.length) return path.join(base, entries[0]);
  } catch { /* geen backlight-klasse op dit scherm */ }
  return null;
}

async function setBacklight(level, sysCfg) {
  const pct = Math.max(1, Math.min(100, Math.round(level)));
  if (sysCfg.backlightCommand) {
    const parts = sysCfg.backlightCommand.split(/\s+/).map((a) => a.replace("{level}", String(pct)));
    const r = await run(parts[0], parts.slice(1), 6000);
    return r.ok ? { ok: true } : { ok: false, error: "commando mislukt" };
  }
  const dir = backlightDir(sysCfg.backlightPath);
  if (!dir) return { ok: false, error: "geen backlight gevonden" };
  try {
    const max = parseInt(fs.readFileSync(path.join(dir, "max_brightness"), "utf8").trim(), 10) || 255;
    const value = Math.max(1, Math.round(max * pct / 100));
    fs.writeFileSync(path.join(dir, "brightness"), String(value));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.code === "EACCES" ? "geen schrijfrechten" : err.message };
  }
}

/* ── kiosk verlaten ─────────────────────────────────────────────────────── */

async function toDesktop(command) {
  if (!command) return { ok: false, error: "niet ingesteld" };
  const parts = command.split(/\s+/);
  const r = await run(parts[0], parts.slice(1), 10000);
  return r.ok ? { ok: true } : { ok: false, error: r.err || "commando mislukt" };
}

module.exports = {
  wifiStatus, wifiList, wifiConnect, wifiDisconnect,
  wifiConnectPlan, wifiConnectPlanFallback,
  btStatus, btList, btConnect, btDisconnect,
  modem, modemLocation,
  setBacklight, toDesktop
};
