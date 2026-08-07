"use strict";
/**
 * Step Dashboard — service op de Raspberry Pi.
 *
 * Serveert de kiosk-UI en de endpoints die die UI aanroept:
 *
 *   GET  /data          het datacontract (VESC via USB)
 *   GET  /settings      opgeslagen UI-instellingen
 *   POST /settings      instellingen bewaren
 *   POST /reset-trip    rit-teller op nul
 *   POST /reset-top     topsnelheid op nul
 *   POST /backlight     {level: 20..100}
 *   POST /power        {action: "reboot"|"shutdown"}
 *   GET  /setup         weet de VESC hoe de step in elkaar zit?
 *   POST /setup         de stepgegevens zelf invullen
 *   GET  /wifi          {connected, ssid, level}
 *   GET  /bt            {connected, name, mac}
 *   GET  /modem         {bars, tech}
 *   GET  /weather       {temp_c, place}
 *   GET  /net?kind=…    scanlijst wifi of bluetooth (&scan=1 zoekt actief)
 *   POST /net           {kind, id, connect}
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { loadConfig, loadState, saveConfigStep, ROOT } = require("./config");
const { Vesc } = require("./vesc");
const { Telemetry } = require("./telemetry");
const { Weather } = require("./weather");
const { Updater } = require("./update");
const { Charge } = require("./charge");
const { SetupWatch } = require("./setup");
const sys = require("./system");

const cfg = loadConfig();
const state = loadState();
const telemetry = new Telemetry(cfg, state);
const weather = new Weather(cfg);
const updater = new Updater(cfg);
const charge = new Charge();
const setup = new SetupWatch(cfg);

const log = (...a) => console.log("[step]", ...a);

/* ── VESC ───────────────────────────────────────────────────────────────── */
const vesc = new Vesc(cfg.vesc);
vesc.on("log", (m) => log(m));
vesc.on("status", (up) => log(up ? "VESC verbonden" : "VESC weg"));
vesc.start();

/* ── statische bestanden ────────────────────────────────────────────────── */
const PUBLIC = path.join(ROOT, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2"
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "verboden" });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: "niet gevonden" });
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(buf);
  });
}

/* ── helpers ────────────────────────────────────────────────────────────── */
function send(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store"
  });
  res.end(buf);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > (limit || 8192)) { reject(new Error("te groot")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const url_force = (req) => /[?&]check=1/.test(req.url || "");

/* Alleen wat de UI mag zien; __file en de rest van cfg horen daar niet bij. */
const stepUit = () => ({
  batteryCells: cfg.step.batteryCells,
  polePairs: cfg.step.polePairs,
  wheelDiameterM: cfg.step.wheelDiameterM,
  gearRatio: cfg.step.gearRatio,
  source: cfg.step.source,
  learnedAt: cfg.step.learnedAt
});

/* Weet de VESC het zelf, dan schrijven we het op — één keer, en nooit over een
   waarde heen die jij met de hand hebt gezet. */
let leerFout = false;
function leerVanVesc() {
  if (cfg.step.source === "hand" || leerFout) return;
  const patch = setup.patch();
  if (!patch) return;
  patch.source = "vesc";
  patch.learnedAt = Date.now();
  try {
    saveConfigStep(cfg, patch);
    telemetry.cells = cfg.step.batteryCells;
    log("stepgegevens van de VESC overgenomen:", JSON.stringify(patch));
  } catch (err) {
    /* Staat config.json op alleen-lezen, dan is dat geen reden om het elke
       150 ms opnieuw te proberen. */
    leerFout = true;
    log("kon config.json niet bijwerken: " + err.message);
  }
}

const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

/* ── routes ─────────────────────────────────────────────────────────────── */
const routes = {
  "GET /data": (req, res) => {
    const snap = vesc.connected ? vesc.snapshot() : null;
    /* Meekijken of de VESC zelf weet hoe de step in elkaar zit. Dat is alleen
       te zien terwijl de motor draait, dus het moet in de lus mee. */
    setup.observe(snap);
    leerVanVesc();
    const data = telemetry.build(snap);
    if (data.connected && data.speed_kmh > state.data.topSpeed) {
      state.patch({ topSpeed: data.speed_kmh });
    }
    /* Laden herkennen we aan de spanning die stijgt terwijl de step stilstaat;
       een gewone lader hangt rechtstreeks aan de accu en loopt niet via de
       VESC, dus stroom meten alleen is niet genoeg. */
    const ch = charge.update(data, Date.now());
    data.charging = ch.charging;
    data.charge_eta_min = ch.etaMin;
    data.charge_full = ch.full;
    data.charge_session = ch.session;
    send(res, 200, data);
  },

  "GET /setup": (req, res) => {
    send(res, 200, {
      status: setup.status,
      step: stepUit(),
      derived: setup.derived()
    });
  },

  /* Zelf invullen. Wat hier binnenkomt gaat naar config.json en wordt met
     source "hand" gemarkeerd, zodat een VESC die het later alsnog weet er niet
     overheen schrijft. */
  "POST /setup": async (req, res) => {
    const body = await readJson(req);
    const s = cfg.step;
    const patch = {
      polePairs: Math.round(num(body.polePairs, 1, 40, s.polePairs)),
      wheelDiameterM: Math.round(num(body.wheelDiameterM, 0.08, 0.8, s.wheelDiameterM) * 10000) / 10000,
      gearRatio: Math.round(num(body.gearRatio, 0.5, 30, s.gearRatio) * 100) / 100,
      source: "hand",
      learnedAt: Date.now()
    };
    /* batteryCells mag uitdrukkelijk null zijn: dan raadt telemetry.js het uit
       de pakspanning, en dat is meestal beter dan een fout getal. */
    patch.batteryCells = body.batteryCells === null || body.batteryCells === "auto"
      ? null : Math.round(num(body.batteryCells, 3, 30, s.batteryCells || 13));
    try {
      saveConfigStep(cfg, patch);
      telemetry.cells = patch.batteryCells;      // meteen opnieuw laten raden
      log("stepgegevens met de hand ingesteld:", JSON.stringify(patch));
      send(res, 200, { ok: true, step: stepUit() });
    } catch (err) {
      send(res, 500, { ok: false, error: String(err.message || err) });
    }
  },

  "GET /settings": (req, res) => {
    send(res, 200, Object.assign({}, state.settings, {
      topSpeed: state.data.topSpeed,
      pollMs: cfg.vesc.pollMs
    }));
  },

  "POST /settings": async (req, res) => {
    const body = await readJson(req);
    const s = state.settings;
    const next = {
      layout: ["Liggend", "Staand"].includes(body.layout) ? body.layout : s.layout,
      rotate: [90, 270].includes(Number(body.rotate)) ? Number(body.rotate) : s.rotate,
      theme: ["Auto", "Licht", "Donker"].includes(body.theme) ? body.theme : s.theme,
      tempWarn: num(body.tempWarn, 40, 120, s.tempWarn),
      tempCrit: num(body.tempCrit, 50, 130, s.tempCrit),
      packWh: num(body.packWh, 200, 4000, s.packWh),
      whPerKm: num(body.whPerKm, 5, 100, s.whPerKm),
      speedMax: num(body.speedMax, 10, 120, s.speedMax),
      bright: num(body.bright, 20, 100, s.bright),
      start: num(body.start, 0, 2, s.start)
    };
    state.patch({ settings: next });
    send(res, 200, next);
  },

  "POST /reset-trip": (req, res) => {
    telemetry.resetTrip(vesc.connected ? vesc.snapshot() : null);
    send(res, 200, { ok: true });
  },

  "POST /reset-top": (req, res) => {
    state.patch({ topSpeed: 0 });
    send(res, 200, { ok: true });
  },

  "POST /backlight": async (req, res) => {
    const body = await readJson(req);
    const level = num(body.level, 20, 100, 80);
    const r = await sys.setBacklight(level, cfg.system);
    if (r.ok) state.patch({ settings: { bright: level } });
    send(res, r.ok ? 200 : 503, r);
  },

  "POST /power": async (req, res) => {
    const body = await readJson(req);
    const action = body.action === "reboot" || body.action === "shutdown" ? body.action : null;
    if (!action) return send(res, 400, { ok: false, error: "onbekende actie" });
    // Wat nog in de wachtrij staat gaat mee voordat de stroom eraf gaat.
    state.flush();
    const r = await sys.power(action);
    send(res, r.ok ? 200 : 502, r);
  },

  "GET /wifi": async (req, res) => send(res, 200, await sys.wifiStatus()),

  "GET /bt": async (req, res) => send(res, 200, await sys.btStatus()),

  "GET /modem": async (req, res) => send(res, 200, await sys.modem()),

  "GET /update": async (req, res) => {
    // ?check=1 gaat langs de cache heen; de knop in de instellingen doet dat.
    send(res, 200, await updater.status(url_force(req)));
  },

  "POST /update": async (req, res) => {
    const r = await updater.start();
    send(res, r.ok ? 200 : 409, r);
  },

  "GET /weather": async (req, res) => {
    try {
      send(res, 200, await weather.get());
    } catch (err) {
      send(res, 503, { error: err.message });
    }
  },

  "GET /net": async (req, res, url) => {
    const kind = url.searchParams.get("kind") === "bt" ? "bt" : "wifi";
    if (kind === "wifi") return send(res, 200, { kind, items: await sys.wifiList() });
    /* Wifi laat nmcli zelf opnieuw scannen; bij bluetooth moeten we het vragen.
       De UI doet dat bij het openen van het tabblad en bij "opnieuw zoeken",
       en blijft ondertussen de lijst ophalen — zoeken duurt seconden en de
       gekoppelde apparaten mogen daar niet op wachten. */
    if (url.searchParams.get("scan") === "1") await sys.btStartScan();
    send(res, 200, Object.assign({ kind, items: await sys.btList() }, sys.btScanState()));
  },

  "POST /net": async (req, res) => {
    const body = await readJson(req);
    const kind = body.kind === "bt" ? "bt" : "wifi";
    const id = String(body.id || body.name || "");
    if (!id) return send(res, 400, { error: "geen doel" });
    if (kind === "bt" && !/^[0-9A-F:]{17}$/i.test(id)) return send(res, 400, { error: "ongeldig adres" });

    const connect = body.connect !== false;

    /* Het wachtwoord van het schermtoetsenbord. 8–63 tekens is het bereik dat
       WPA toestaat. Het wordt doorgegeven en verder nergens bewaard of
       gelogd — NetworkManager onthoudt het, wij niet. */
    let password = null;
    if (kind === "wifi" && connect && typeof body.password === "string" && body.password) {
      if (body.password.length < 8 || body.password.length > 63) {
        return send(res, 400, { error: "wachtwoord 8–63 tekens", needsPassword: true });
      }
      password = body.password;
    }

    let r;
    if (kind === "wifi") r = connect ? await sys.wifiConnect(id, password) : await sys.wifiDisconnect(id);
    else r = connect ? await sys.btConnect(id) : await sys.btDisconnect(id);
    send(res, r.ok ? 200 : 502, r);
  }
};

/* ── server ─────────────────────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return send(res, 400, { error: "ongeldige url" });
  }
  const key = req.method + " " + url.pathname;
  const handler = routes[key];

  if (handler) {
    Promise.resolve(handler(req, res, url)).catch((err) => {
      log("fout in " + key + ": " + err.message);
      if (!res.headersSent) send(res, 500, { error: "interne fout" });
    });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url.pathname);
  send(res, 405, { error: "niet toegestaan" });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("[step] poort " + cfg.port + " is al in gebruik — draait de service al?");
  } else {
    console.error("[step] serverfout: " + err.message);
  }
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  log("luistert op http://" + cfg.host + ":" + cfg.port);
  log("VESC-poort: " + (cfg.vesc.port || "automatisch zoeken"));
});

/* Bij het opstarten kijken of er een nieuwe versie klaarstaat. Alleen kijken;
   installeren is een bewuste tik in de instellingen — tenzij je in config.json
   update.autoInstall aanzet. Een kapotte commit die zichzelf ongevraagd op je
   stuur installeert is geen prettig vooruitzicht. */
if (cfg.update && cfg.update.checkOnStart) {
  setTimeout(() => {
    updater.status(true).then((st) => {
      if (st.error) return log("update-controle mislukt: " + st.error);
      if (!st.available) return log("versie is actueel (" + (st.currentShort || "onbekend") + ")");
      log("nieuwe versie beschikbaar: " + st.latestShort + " — " + (st.message || ""));
      if (cfg.update.autoInstall) {
        log("autoInstall staat aan, bijwerken");
        updater.start().then((r) => { if (!r.ok) log("bijwerken mislukt: " + r.error); });
      }
    }).catch((e) => log("update-controle mislukt: " + e.message));
  }, 5000);   // even wachten tot het netwerk er is
}

function shutdown() {
  log("afsluiten");
  vesc.stop();
  state.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
