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
  /* Cruisecontrol herkennen. De VESC meldt niet of hij aanstaat; dit wordt
     afgeleid uit "gas los terwijl de motor stroom trekt en de snelheid vlak
     blijft". Werkt alleen bij een ADC-gashendel, en alleen als de VESC het
     gedecodeerde hendelniveau meldt.

     minCurrentA is de knop om aan te draaien: hij moet boven je rolweerstand
     liggen en onder wat cruise nodig heeft om de snelheid te houden. Zie
     `node tools/vesc-probe.js` voor wat jouw hendel doet. */
  cruise: {
    enabled: true,
    minCurrentA: 3,          // hieronder heet het uitrollen
    holdMs: 600              // zo lang moet het patroon standhouden
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
    rotate: 90,            // kwartslag als de UI niet bij het paneel past
    theme: "day",          // "day" of "night"
    lang: "nl",            // nl, en, fr, de
    units: "metric",       // "metric" of "imperial"
    accent: "#4f9e63",     // een van de acht uit public/i18n.js
    mode: null,            // gekozen rijmodus; null = niets gestuurd
    /* Temperatuurlimieten in °C, elk met een schakelaar. Uit betekent: wel
       tonen, geen waarschuwingsscherm — bruikbaar bij een kapotte sensor. */
    limMotor: 120, limEsc: 110, limBatt: 70,
    warnMotor: true, warnEsc: true, warnBatt: true,
    packWh: 1147,
    whPerKm: 18,
    speedMax: 35,
    bright: 80
  },
  topSpeed: 0,
  setupSeen: false,        // één keer rijdend "ok" gezien — overleeft een herstart
  odo: { meters: 0 },      // kilometerstand; de VESC houdt die zelf niet bij
  trip: { distanceM: 0, wattHours: 0, valid: false, seconds: 0 }
};


/* ── de instellingen die de UI bewaart ──────────────────────────────────── */
const getal = (v, lo, hi, fallback) => {
  const n = Number(v);
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const TALEN = ["nl", "en", "fr", "de"];
/* De acht kleuren uit public/i18n.js. Ze staan hier nog een keer omdat de
   server niets van de browserbestanden leest en een vrije kleurwaarde uit een
   POST anders zo in de opmaak terechtkomt. */
const ACCENTEN = ["#9184d9", "#4fa3a0", "#d98f52", "#3f7fd9",
                  "#c25a8f", "#e0a92b", "#4f9e63", "#d95f4a"];

const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);
const uit = (lijst, v, fallback) => (lijst.includes(v) ? v : fallback);

/** Wat er ook binnenkomt, hier komt een geldig instellingenblok uit. */
function schoneSettings(body, s) {
  return {
    rotate: [90, 270].includes(Number(body.rotate)) ? Number(body.rotate) : (s.rotate || 90),
    theme: uit(["day", "night"], body.theme, uit(["day", "night"], s.theme, "day")),
    lang: uit(TALEN, body.lang, uit(TALEN, s.lang, "nl")),
    units: uit(["metric", "imperial"], body.units,
      uit(["metric", "imperial"], s.units, "metric")),
    accent: uit(ACCENTEN, body.accent, uit(ACCENTEN, s.accent, "#4f9e63")),
    mode: typeof body.mode === "string" || body.mode === null ? body.mode : (s.mode || null),
    limMotor: getal(body.limMotor, 60, 140, s.limMotor || 120),
    limEsc: getal(body.limEsc, 50, 120, s.limEsc || 110),
    limBatt: getal(body.limBatt, 30, 80, s.limBatt || 70),
    warnMotor: bool(body.warnMotor, s.warnMotor !== false),
    warnEsc: bool(body.warnEsc, s.warnEsc !== false),
    warnBatt: bool(body.warnBatt, s.warnBatt !== false),
    packWh: getal(body.packWh, 200, 4000, s.packWh || 1147),
    whPerKm: getal(body.whPerKm, 5, 100, s.whPerKm || 18),
    speedMax: getal(body.speedMax, 10, 120, s.speedMax || 35),
    bright: getal(body.bright, 20, 100, s.bright || 80)
  };
}

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
    this.bezig = false;      // er loopt een schrijfactie
    this.vuil = false;       // er is iets veranderd sinds de laatste
    this.rev = 0;            // hoogt op bij elke patch
    this.gedaan = -1;        // hoogste rev die op schijf staat
  }

  get settings() { return this.data.settings; }
  get trip() { return this.data.trip; }

  /** Samenvoegen en (ontdubbeld) wegschrijven — de UI stuurt bij elke tik. */
  patch(part) {
    this.data = deepMerge(this.data, part);
    this.rev++;
    this.save();
  }

  /* Wegschrijven gebeurt asynchroon. De oude versie deed writeFileSync in een
     timer, en dat legt de eventloop stil zolang de SD-kaart erover doet —
     inclusief het lezen van de VESC. Op een kaart die even nadenkt is dat een
     hapering van tientallen milliseconden, elke keer.

     De vertraging staat op twee seconden en wordt niet opnieuw gestart bij een
     volgende patch. De oude debounce van 500 ms herstartte wél, en omdat de
     telemetrie sowieso elke tien seconden patcht kwam hij nooit toe aan
     schrijven zolang je reed. */
  save() {
    this.vuil = true;
    if (this.timer || this.bezig) return;
    this.timer = setTimeout(() => { this.timer = null; this._schrijf(); }, 2000);
  }

  _schrijf() {
    if (this.bezig) return;
    this.bezig = true;
    this.vuil = false;

    /* De tekst wordt hier gemaakt, synchroon. Dat is de kern van het hele
       ontwerp: alles wat hierna aan this.data verandert kan niet meer in het
       bestand terechtkomen dat nu wordt weggeschreven. Zonder dit zou een
       asynchrone schrijver een object serialiseren dat onder hem verandert. */
    const rev = this.rev;
    const tekst = JSON.stringify(this.data);
    const tmp = this.file + ".tmp";

    const klaar = (err) => {
      if (err) console.error("[state] opslaan mislukt: " + err.message);
      else this.gedaan = Math.max(this.gedaan, rev);
      this.bezig = false;
      if (this.vuil) this.save();
    };

    fs.mkdir(path.dirname(this.file), { recursive: true }, (err) => {
      if (err && err.code !== "EEXIST") return klaar(err);
      fs.writeFile(tmp, tekst, (err2) => {
        if (err2) return klaar(err2);
        /* flush() kan er tijdens het schrijven tussen zijn gekomen en iets
           nieuwers hebben neergezet. Dan dit oudere bestand niet eroverheen
           hernoemen. */
        if (this.gedaan > rev) return fs.unlink(tmp, () => klaar(null));
        fs.rename(tmp, this.file, klaar);
      });
    });
  }

  /* Bij het afsluiten synchroon: daar valt niet op te wachten. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.vuil && this.gedaan >= this.rev) return;
    const rev = this.rev;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
      this.gedaan = Math.max(this.gedaan, rev);
      this.vuil = false;
    } catch { /* afsluiten mag hier niet op stuklopen */ }
  }

  /** Alleen voor de test: wacht tot er niets meer gepland of bezig is. */
  klaar() {
    return new Promise((k) => {
      const kijk = () => {
        if (!this.timer && !this.bezig && !this.vuil) return k();
        setTimeout(kijk, 5);
      };
      kijk();
    });
  }
}

function loadState() {
  const file = process.env.STEP_STATE || path.join(ROOT, "state.json");
  return new State(file);
}

module.exports = {
  loadConfig, loadState, saveConfigStep, schoneSettings, State,
  DEFAULT_CONFIG, DEFAULT_STATE, ROOT
};
