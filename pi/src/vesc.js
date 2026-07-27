"use strict";
/**
 * VESC-protocol over USB (CDC-ACM).
 *
 * Framing (bldc/comm/packet.c):
 *   0x02 len(1)            payload  crc16(2, big endian)  0x03
 *   0x03 len(2, big endian) payload  crc16(2)             0x03
 *   0x04 len(3, big endian) payload  crc16(2)             0x03
 *
 * De CRC is CRC16-CCITT (poly 0x1021, init 0x0000) over de payload.
 *
 * We vragen twee dingen op:
 *   COMM_GET_VALUES (4)        — temperaturen, stromen, spanning, Wh, storing
 *   COMM_GET_VALUES_SETUP (47) — snelheid in m/s, afstand in m, accuniveau
 *
 * Die tweede is de belangrijke: de VESC-firmware rekent snelheid, afstand en
 * accupercentage zélf uit op basis van de wielmaat, poolparen, overbrenging
 * en accugegevens die in de controller staan (de setup-wizard van VESC Tool
 * schrijft die). Zolang die wizard één keer gedraaid heeft, hoeft dit
 * dashboard geen enkele fysieke constante te kennen. Is dat niet zo, dan
 * rekenen we het zelf uit met de waarden uit config.json.
 */

const { EventEmitter } = require("events");
const { SerialPort, findPort } = require("./serial");

const COMM_FW_VERSION = 0;
const COMM_GET_VALUES = 4;
const COMM_GET_VALUES_SETUP = 47;

/* De enige antwoorden die we vragen — gebruikt om valse startbytes te herkennen. */
const EXPECTED = new Set([COMM_FW_VERSION, COMM_GET_VALUES, COMM_GET_VALUES_SETUP]);
const MAX_PAYLOAD = 512;   // ruim boven het grootste antwoord dat we vragen

/* ── CRC16-CCITT ────────────────────────────────────────────────────────── */
const CRC_TAB = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

function crc16(buf) {
  let c = 0;
  for (let i = 0; i < buf.length; i++) c = ((c << 8) ^ CRC_TAB[((c >> 8) ^ buf[i]) & 0xff]) & 0xffff;
  return c;
}

function frame(payload) {
  const len = payload.length;
  let head;
  if (len <= 255) head = Buffer.from([0x02, len]);
  else if (len <= 0xffff) head = Buffer.from([0x03, (len >> 8) & 0xff, len & 0xff]);
  else head = Buffer.from([0x04, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  const c = crc16(payload);
  return Buffer.concat([head, payload, Buffer.from([(c >> 8) & 0xff, c & 0xff, 0x03])]);
}

/* ── payload-lezer ──────────────────────────────────────────────────────── */
class Reader {
  constructor(buf, start) {
    this.b = buf;
    this.i = start || 0;
  }
  get left() { return this.b.length - this.i; }
  has(n) { return this.left >= n; }
  u8() { return this.b[this.i++]; }
  i16(scale) { const v = this.b.readInt16BE(this.i); this.i += 2; return v / (scale || 1); }
  i32(scale) { const v = this.b.readInt32BE(this.i); this.i += 4; return v / (scale || 1); }
  u32() { const v = this.b.readUInt32BE(this.i); this.i += 4; return v; }
}

/* Faultcodes uit bldc/datatypes.h (mc_fault_code). */
const FAULTS = [
  null,
  "OVER_VOLTAGE", "UNDER_VOLTAGE", "DRV", "ABS_OVER_CURRENT",
  "OVER_TEMP_FET", "OVER_TEMP_MOTOR",
  "GATE_DRIVER_OVER_VOLTAGE", "GATE_DRIVER_UNDER_VOLTAGE",
  "MCU_UNDER_VOLTAGE", "BOOTING_FROM_WATCHDOG_RESET",
  "ENCODER_SPI", "ENCODER_SINCOS_BELOW_MIN_AMPLITUDE",
  "ENCODER_SINCOS_ABOVE_MAX_AMPLITUDE", "FLASH_CORRUPTION",
  "HIGH_OFFSET_CURRENT_SENSOR_1", "HIGH_OFFSET_CURRENT_SENSOR_2",
  "HIGH_OFFSET_CURRENT_SENSOR_3", "UNBALANCED_CURRENTS",
  "BRK", "RESOLVER_LOT", "RESOLVER_DOS", "RESOLVER_LOS",
  "FLASH_CORRUPTION_APP_CFG", "FLASH_CORRUPTION_MC_CFG",
  "ENCODER_NO_MAGNET", "ENCODER_MAGNET_TOO_STRONG", "PHASE_FILTER",
  "ENCODER_FAULT", "LV_OUTPUT_FAULT"
];
const faultName = (c) => (c > 0 ? (FAULTS[c] || "FAULT_" + c) : null);

/** COMM_GET_VALUES — alles behalve pid_pos is stabiel over fw 3.x…6.x. */
function parseValues(p) {
  const r = new Reader(p, 1);
  const v = {};
  if (!r.has(2 + 2 + 4 + 4 + 4 + 4 + 2 + 4 + 2 + 4 * 4 + 4 + 4 + 1)) return null;
  v.tempFet = r.i16(10);
  v.tempMotor = r.i16(10);
  v.currentMotor = r.i32(100);
  v.currentIn = r.i32(100);
  v.id = r.i32(100);
  v.iq = r.i32(100);
  v.duty = r.i16(1000);
  v.erpm = r.i32(1);
  v.vIn = r.i16(10);
  v.ampHours = r.i32(1e4);
  v.ampHoursCharged = r.i32(1e4);
  v.wattHours = r.i32(1e4);
  v.wattHoursCharged = r.i32(1e4);
  v.tachometer = r.i32(1);
  v.tachometerAbs = r.i32(1);
  v.fault = r.u8();
  return v;
}

/**
 * COMM_GET_VALUES_SETUP — snelheid, afstand en accuniveau zoals de VESC ze
 * zelf berekent. Alles ná tachometerAbs varieert per firmwareversie en wordt
 * daarom niet gelezen.
 */
function parseValuesSetup(p) {
  const r = new Reader(p, 1);
  const need = 2 + 2 + 4 + 4 + 2 + 4 + 4 + 2 + 2 + 4 * 4 + 4 + 4;
  if (!r.has(need)) return null;
  const v = {};
  v.tempFet = r.i16(10);
  v.tempMotor = r.i16(10);
  v.currentMotor = r.i32(100);
  v.currentIn = r.i32(100);
  v.duty = r.i16(1000);
  v.erpm = r.i32(1);
  v.speedMs = r.i32(1000);
  v.vIn = r.i16(10);
  v.batteryLevel = r.i16(1000);      // 0..1
  v.ampHours = r.i32(1e4);
  v.ampHoursCharged = r.i32(1e4);
  v.wattHours = r.i32(1e4);
  v.wattHoursCharged = r.i32(1e4);
  v.distanceM = r.i32(1000);
  v.distanceAbsM = r.i32(1000);
  return v;
}

function parseFwVersion(p) {
  if (p.length < 3) return null;
  const major = p[1];
  const minor = p[2];
  let name = "";
  for (let i = 3; i < p.length && p[i] !== 0; i++) name += String.fromCharCode(p[i]);
  return { major, minor, name };
}

/* ── verbinding ─────────────────────────────────────────────────────────── */

/**
 * Houdt de USB-verbinding met de VESC in stand: opent de poort, pollt, en
 * opent opnieuw als de kabel eruit gaat. Emit "values" met een genormaliseerde
 * momentopname en "status" als connected verandert.
 */
class Vesc extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.port = null;
    this.rx = Buffer.alloc(0);
    this.connected = false;
    this.useSetup = true;
    this.setupMisses = 0;
    this.fw = null;
    this.lastPacketAt = 0;
    this.values = null;
    this.setup = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._open();
    this.pollTimer = setInterval(() => this._poll(), this.opts.pollMs);
    this.watchTimer = setInterval(() => this._watchdog(), 500);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.watchTimer);
    clearTimeout(this.reopenTimer);
    if (this.port) this.port.close();
  }

  async _open() {
    if (this.stopped || this.port) return;
    const path = findPort(this.opts.port);
    if (!path) {
      this._scheduleReopen();
      return;
    }
    try {
      const port = await SerialPort.open(path, this.opts.baud);
      if (this.stopped) { port.close(); return; }
      this.port = port;
      this.rx = Buffer.alloc(0);
      this.useSetup = true;
      this.setupMisses = 0;
      port.on("data", (chunk) => this._feed(chunk));
      port.on("error", (err) => this.emit("log", "seriële fout op " + path + ": " + err.message));
      port.on("close", () => {
        this.port = null;
        this._setConnected(false);
        this._scheduleReopen();
      });
      this.emit("log", "VESC-poort geopend: " + path);
      this._send(COMM_FW_VERSION);
    } catch (err) {
      this.emit("log", "kan " + path + " niet openen: " + err.message);
      this._scheduleReopen();
    }
  }

  _scheduleReopen() {
    if (this.stopped) return;
    clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => this._open(), 1500);
  }

  _send(cmd, extra) {
    if (!this.port) return;
    const payload = extra ? Buffer.concat([Buffer.from([cmd]), extra]) : Buffer.from([cmd]);
    this.port.write(frame(payload)).catch(() => {
      if (this.port) this.port.close();
    });
  }

  _poll() {
    if (!this.port) return;
    this._send(COMM_GET_VALUES);
    if (this.useSetup) this._send(COMM_GET_VALUES_SETUP);
  }

  _watchdog() {
    const stale = Date.now() - this.lastPacketAt > Math.max(1000, this.opts.pollMs * 8);
    if (stale && this.connected) this._setConnected(false);
    // Firmware zonder GET_VALUES_SETUP: na een paar loze rondes niet meer vragen.
    if (this.connected && this.useSetup && !this.setup) {
      if (++this.setupMisses > 6) {
        this.useSetup = false;
        this.emit("log", "VESC beantwoordt COMM_GET_VALUES_SETUP niet — "
          + "snelheid/afstand/accu worden uit config.json berekend");
      }
    }
  }

  _setConnected(v) {
    if (this.connected === v) return;
    this.connected = v;
    if (!v) { this.values = null; this.setup = null; }
    this.emit("status", v);
  }

  /**
   * Zoek het eerste pakket dat volledig klopt: startbyte, verwacht commando,
   * kloppende CRC én het afsluitende 0x03.
   *
   * Een startbyte is niet te vertrouwen — een payload-byte kan er toevallig
   * net zo uitzien. Daarom controleren we een kandidaat volledig voordat we
   * hem accepteren, en zoeken we bij twijfel gewoon verder in de buffer in
   * plaats van te wachten op bytes die nooit komen. Alleen als er niets
   * compleets in staat, onthouden we het eerste onvolledige begin en wachten
   * we op meer data.
   */
  _scan() {
    const rx = this.rx;
    let incomplete = -1;
    for (let s = 0; s < rx.length; s++) {
      const type = rx[s];
      if (type !== 0x02 && type !== 0x03 && type !== 0x04) continue;
      const lenBytes = type - 1;                 // 0x02 → 1, 0x03 → 2, 0x04 → 3
      if (rx.length < s + 1 + lenBytes + 1) { if (incomplete < 0) incomplete = s; continue; }

      let len = 0;
      for (let i = 0; i < lenBytes; i++) len = (len << 8) | rx[s + 1 + i];
      if (len === 0 || len > MAX_PAYLOAD) continue;
      if (!EXPECTED.has(rx[s + 1 + lenBytes])) continue;

      const total = 1 + lenBytes + len + 3;
      if (rx.length < s + total) { if (incomplete < 0) incomplete = s; continue; }

      const body = rx.subarray(s + 1 + lenBytes, s + 1 + lenBytes + len);
      if (rx[s + total - 1] !== 0x03) continue;
      const gotCrc = (rx[s + 1 + lenBytes + len] << 8) | rx[s + 1 + lenBytes + len + 1];
      if (gotCrc !== crc16(body)) continue;

      return { end: s + total, payload: Buffer.from(body) };
    }
    return { incomplete };
  }

  _feed(chunk) {
    this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
    if (this.rx.length > 16384) this.rx = this.rx.subarray(this.rx.length - 4096);

    for (;;) {
      const r = this._scan();
      if (r.payload) {
        this.rx = this.rx.subarray(r.end);
        this._packet(r.payload);
        continue;
      }
      // Niets compleets: alles vóór het eerste onvolledige begin is ruis.
      this.rx = r.incomplete >= 0 ? this.rx.subarray(r.incomplete) : Buffer.alloc(0);
      return;
    }
  }

  _packet(p) {
    this.lastPacketAt = Date.now();
    switch (p[0]) {
      case COMM_FW_VERSION: {
        this.fw = parseFwVersion(p);
        if (this.fw) this.emit("log", "VESC firmware " + this.fw.major + "." + this.fw.minor
          + (this.fw.name ? " (" + this.fw.name + ")" : ""));
        this._setConnected(true);
        break;
      }
      case COMM_GET_VALUES: {
        const v = parseValues(p);
        if (v) { this.values = v; this._setConnected(true); this.emit("values", this.snapshot()); }
        break;
      }
      case COMM_GET_VALUES_SETUP: {
        const v = parseValuesSetup(p);
        if (v) { this.setup = v; this.setupMisses = 0; this._setConnected(true); }
        break;
      }
      default:
        break;
    }
  }

  /** Ruwe meetwaarden, nog zonder de rit-nulpunten en de %-afleidingen. */
  snapshot() {
    if (!this.values) return null;
    const v = this.values;
    const s = this.setup;
    return {
      tempFet: v.tempFet,
      tempMotor: v.tempMotor,
      currentMotor: v.currentMotor,
      currentIn: v.currentIn,
      duty: v.duty,
      erpm: v.erpm,
      vIn: v.vIn,
      wattHours: v.wattHours,
      wattHoursCharged: v.wattHoursCharged,
      ampHours: v.ampHours,
      tachometer: v.tachometer,
      fault: faultName(v.fault),
      // uit COMM_GET_VALUES_SETUP, als de firmware die ondersteunt
      speedMs: s ? s.speedMs : null,
      distanceM: s ? s.distanceM : null,
      batteryLevel: s ? s.batteryLevel : null,
      setupWattHours: s ? s.wattHours : null
    };
  }
}

module.exports = { Vesc, crc16, frame, parseValues, parseValuesSetup, faultName, COMM_GET_VALUES, COMM_GET_VALUES_SETUP, COMM_FW_VERSION };
