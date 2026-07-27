"use strict";
/**
 * Configuratie en persistente staat.
 *
 * config.json  — door jou beheerd, wordt alleen gelezen.
 * state.json   — door de service beheerd: UI-instellingen, rit-nulpunten en
 *                de topsnelheid. De UI zelf slaat niets op (geen localStorage,
 *                zoals de briefing vroeg); de Pi doet dat.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 8080,
  vesc: {
    port: null,          // bv. "/dev/ttyACM0"; null = automatisch zoeken
    baud: 115200,        // betekenisloos voor CDC-ACM, maar stty wil een waarde
    pollMs: 150
  },
  step: {
    // Alleen nodig als de setup-wizard van VESC Tool nooit gedraaid heeft.
    // Draait die wél, dan levert de VESC snelheid, afstand en accuniveau zelf
    // en wordt dit blok genegeerd.
    batteryCells: null,      // null = afleiden uit de gemeten pakspanning
    packWh: 1147,            // capaciteit voor de bereikschatting
    polePairs: 15,
    wheelDiameterM: 0.254,   // 10 inch
    gearRatio: 1             // motoromwentelingen per wielomwenteling
  },
  weather: {
    latitude: null,          // null = proberen via de modem (mmcli --location-get)
    longitude: null,
    place: ""                // vaste plaatsnaam; leeg = via reverse geocoding
  },
  system: {
    wifiInterface: null,     // null = eerste wifi-interface die nmcli meldt
    backlightPath: null,     // null = eerste map in /sys/class/backlight
    backlightCommand: null,  // alternatief commando, {level} wordt vervangen
    desktopCommand: "sudo systemctl stop step-kiosk.service"
  }
};

const DEFAULT_STATE = {
  settings: {
    theme: "Auto",
    tempWarn: 70,
    tempCrit: 90,
    packWh: 1147,
    whPerKm: 18,
    speedMax: 35,
    bright: 80,
    start: 0
  },
  topSpeed: 0,
  trip: { distanceM: 0, wattHours: 0, valid: false }
};

function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    const b = base ? base[k] : undefined;
    const o = over[k];
    out[k] = (b && typeof b === "object" && !Array.isArray(b)) ? deepMerge(b, o) : o;
  }
  return out;
}

function loadConfig() {
  const file = process.env.STEP_CONFIG || path.join(ROOT, "config.json");
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[config] " + file + " is ongeldig: " + err.message);
  }
  const cfg = deepMerge(DEFAULT_CONFIG, raw);
  cfg.__file = file;
  return cfg;
}

class State {
  constructor(file) {
    this.file = file;
    this.data = DEFAULT_STATE;
    try {
      this.data = deepMerge(DEFAULT_STATE, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (err) {
      if (err.code !== "ENOENT") console.error("[state] " + file + " is ongeldig: " + err.message);
    }
    this.timer = null;
  }

  get settings() { return this.data.settings; }
  get trip() { return this.data.trip; }

  /** Samenvoegen en (ontdubbeld) wegschrijven — de UI stuurt bij elke tik. */
  patch(part) {
    this.data = deepMerge(this.data, part);
    this.save();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = this.file + ".tmp";
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error("[state] opslaan mislukt: " + err.message);
      }
    }, 500);
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch { /* afsluiten mag hier niet op stuklopen */ }
  }
}

function loadState() {
  const file = process.env.STEP_STATE || path.join(ROOT, "state.json");
  return new State(file);
}

module.exports = { loadConfig, loadState, DEFAULT_CONFIG, DEFAULT_STATE, ROOT };
