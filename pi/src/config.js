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
    gearRatio: 1,            // motoromwentelingen per wielomwenteling
    /* Door wie ingevuld: null = de standaardwaarden hierboven, "vesc" = de
       app heeft ze van de VESC afgekeken, "hand" = jij hebt ze ingevuld in het
       scherm Step instellen. De app overschrijft "hand" niet. */
    source: null,
    learnedAt: null          // tijdstip waarop dat gebeurde, in ms
  },
  /* Rijmodi. Standaard uit: dit stuurt commando's naar je motorcontroller, en
     dat hoort een bewuste zet te zijn en niet iets wat gebeurt omdat je je
     dashboard hebt bijgewerkt.

     Let op wat "SPORT" betekent. De app kan de huidige grenzen niet uit de
     VESC lezen — dat zou het hele mcconf-blok vergen, dat per firmwareversie
     verschilt. De regels hieronder zijn dus absolute waarden, en SPORT hoort
     te staan op wat jij in VESC Tool hebt ingesteld. currentMaxScale is het
     enige veld dat de firmware zelf op 0..1 afklemt: daarmee kan er nooit méér
     vermogen uit komen dan er in de controller staat.

     Weglaten of op null zetten betekent "niet begrenzen". */
  modes: {
    enabled: false,
    list: [
      { name: "ECO", currentMaxScale: 0.55, currentMinScale: 0.8,
        speedMaxKmh: 20, dutyMax: 0.9, wattMax: 700, inCurrentMax: 20 },
      { name: "SPORT", currentMaxScale: 1, currentMinScale: 1,
        speedMaxKmh: null, dutyMax: 0.95, wattMax: null, inCurrentMax: null }
    ]
  },
  update: {
    // Waar de Pi zijn eigen updates vandaan haalt.
    repo: "https://github.com/VandenOstende/step-dashboard.git",
    branch: "main",
    checkOnStart: true,     // bij het opstarten kijken of er iets nieuws is
    autoInstall: false      // en dat dan ook meteen installeren
  },
  weather: {
    latitude: null,          // null = modem-gps, en anders het IP-adres
    longitude: null,
    ipFallback: true         // false = alleen de coördinaten hierboven gebruiken
  },
  system: {
    wifiInterface: null,     // null = eerste wifi-interface die nmcli meldt
    backlightPath: null,     // null = eerste map in /sys/class/backlight
    backlightCommand: null   // alternatief commando, {level} wordt vervangen
  }
};

const DEFAULT_STATE = {
  settings: {
    layout: "Liggend",     // "Liggend" = index.html, "Staand" = portrait.html
    rotate: 90,            // kwartslag als de UI niet bij het paneel past
    theme: "Auto",
    mode: null,            // gekozen rijmodus; null = niets gestuurd
    tempWarn: 70,
    tempCrit: 90,
    motorTempWarn: true,   // motortemperatuur-meldingen; uit bij een kapotte sensor
    packWh: 1147,
    whPerKm: 18,
    speedMax: 35,
    bright: 80,
    start: 0
  },
  topSpeed: 0,
  setupSeen: false,        // één keer rijdend "ok" gezien — overleeft een herstart
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

/**
 * Het blok `step` in config.json bijwerken.
 *
 * config.json is verder van jou: we lezen het alleen. Dit is de uitzondering,
 * en alleen voor dit ene blok — de app kan van een ingestelde VESC afkijken
 * hoe de step in elkaar zit, en dan hoort dat ergens te blijven staan.
 *
 * Lezen-samenvoegen-schrijven, zodat alles wat er verder in het bestand staat
 * blijft staan; en eerst naar een tijdelijk bestand, zodat een stroomstoring
 * halverwege geen kapotte config.json achterlaat.
 */
function saveConfigStep(cfg, patch) {
  const file = cfg.__file || path.join(ROOT, "config.json");
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) { if (err.code !== "ENOENT") throw err; }

  raw.step = Object.assign({}, raw.step, patch);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
  fs.renameSync(tmp, file);

  Object.assign(cfg.step, patch);      // de draaiende server meteen mee
  return cfg.step;
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

module.exports = { loadConfig, loadState, saveConfigStep, DEFAULT_CONFIG, DEFAULT_STATE, ROOT };
