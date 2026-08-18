"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   Ride Dash — het gedrag.

   Eén pagina, vijftien schermen. Het rijscherm staat er altijd; de rest zijn
   lagen die eroverheen schuiven (.sheet met .open). De volgorde van z-index
   staat in theme.css en niet hier — een scherm weet niet wat er boven hem ligt.

   Alles wat de gebruiker kiest — taal, eenheden, accentkleur, dag/nacht, de
   drie temperatuurlimieten met hun schakelaars — gaat naar POST /settings en
   staat er na een herstart weer. Het ontwerp bewaarde het in localStorage;
   dat werkt niet als de kiosk zijn profiel weggooit, en het is ook niet te
   lezen vanaf een andere kant.

   Wat de VESC niet meldt, liegt deze app niet bij elkaar: dan staat er n.v.t.
   De accutemperatuur is daar het duidelijkste geval van — de VESC heeft er
   geen sensor voor, dus de limiet staat er wel en de waarde niet.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── kleine helpers ──────────────────────────────────────────────────────── */
function $(id) { return document.getElementById(id); }
function txt(id, v) { var e = $(id); if (e && e.textContent !== v) e.textContent = v; }
function cls(id, name, on) { var e = $(id); if (e) e.classList.toggle(name, !!on); }
/* Welke lagen openstaan wordt bijgehouden, niet elke keer opgezocht: de
   tekenlus vraagt het zeven keer per seconde. */
var lagen = {};
function show(id, on) {
  var e = $(id);
  if (!e) return;
  var aan = on !== false;
  var was = !!lagen[id];
  e.classList.toggle("open", aan);
  if (aan) lagen[id] = 1; else delete lagen[id];
  /* Gaat het laatste afdekkende scherm dicht, dan staat het rijscherm nog op
     de waarden van voor het openen. Eén keer bijwerken, meteen. */
  if (was && !aan && DEKT_AF[id] && !bedekt()) paintRide();
}
function hide(id) { show(id, false); }

/* Schermen die het rijscherm helemaal afdekken. Staat er zo een open, dan
   hoeft eronder niets bijgewerkt te worden — dat scheelt op het stuur een
   hertekening per meting van iets wat je toch niet ziet. */
var DEKT_AF = {
  settings: 1, conn: 1, units: 1, lang: 1, accent: 1, limits: 1,
  release: 1, pw: 1, speedsheet: 1, setup: 1, off: 1, charge: 1, alarm: 1
};
function bedekt() {
  for (var k in lagen) if (DEKT_AF[k]) return true;
  return false;
}

/* Een stijl alleen schrijven als hij verandert. De browser merkt het element
   anders toch als vuil aan, ook bij dezelfde waarde. */
function stijl(el, naam, waarde) {
  if (!el) return;
  if (el["_" + naam] === waarde) return;
  el["_" + naam] = waarde;
  el.style[naam] = waarde;
}
var wortelWaarden = {};
function wortel(naam, waarde) {
  if (wortelWaarden[naam] === waarde) return;
  wortelWaarden[naam] = waarde;
  document.documentElement.style.setProperty(naam, waarde);
}
function icon(id, naam) {
  var e = $(id); if (!e) return;
  var u = e.querySelector("use");
  if (u && u.getAttribute("href") !== "#" + naam) u.setAttribute("href", "#" + naam);
}
function svg(naam, klasse) {
  return '<svg class="' + (klasse || "ico") + '"><use href="#' + naam + '"></use></svg>';
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function num(v, dec) {
  return typeof v === "number" && isFinite(v) ? v.toFixed(dec || 0) : null;
}

/* Hex → rgba en hex → donkerder. Uit het ontwerp overgenomen; ze maken van
   één accentkleur de drie tinten die de opmaak nodig heeft. */
function rgba(hex, a) {
  var h = hex.replace("#", "");
  var n = parseInt(h.length === 3 ? h.split("").map(function (c) { return c + c; }).join("") : h, 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}
function shade(hex, f) {
  var h = hex.replace("#", "");
  var n = parseInt(h.length === 3 ? h.split("").map(function (c) { return c + c; }).join("") : h, 16);
  var p = function (v) { return Math.round(v * f).toString(16).padStart(2, "0"); };
  return "#" + p((n >> 16) & 255) + p((n >> 8) & 255) + p(n & 255);
}

/* ── instellingen ────────────────────────────────────────────────────────── */
/* Dezelfde namen als in state.settings op de server. Deze waarden zijn de
   noodgreep voor als /settings niet antwoordt; normaal komen ze daarvandaan. */
var cfg = {
  rotate: 90,
  theme: "day",
  lang: "nl",
  units: "metric",
  accent: "#4f9e63",
  limMotor: 120, limEsc: 110, limBatt: 70,
  warnMotor: true, warnEsc: true, warnBatt: true,
  packWh: 1147,
  whPerKm: 18,
  speedMax: 35,
  mode: null
};
var LIMGRENZEN = {
  limMotor: { min: 60, max: 140, warn: "warnMotor", lbl: "motor", ico: "i-fan" },
  limEsc: { min: 50, max: 120, warn: "warnEsc", lbl: "controller", ico: "i-cpu" },
  limBatt: { min: 30, max: 80, warn: "warnBatt", lbl: "battery", ico: "i-battery-charging" }
};
var DESIGN = { w: 320, h: 480 };
var POLL_MS = 150;

var data = { connected: false };
var t = T.nl;

/* ── taal en eenheden ────────────────────────────────────────────────────── */
function isImp() { return cfg.units === "imperial"; }
function d2(v) { return isImp() ? v * 0.621371 : v; }          // km → mi
function tp(v) { return isImp() ? v * 9 / 5 + 32 : v; }        // °C → °F
function uSpeed() { return isImp() ? "mph" : "km/h"; }
function uDist() { return isImp() ? "mi" : "km"; }
function uTemp() { return isImp() ? "°F" : "°C"; }

function applyLang() {
  t = T[cfg.lang] || T.nl;
  document.documentElement.lang = cfg.lang;
  var nodes = document.querySelectorAll("[data-t]");
  for (var i = 0; i < nodes.length; i++) {
    var k = nodes[i].getAttribute("data-t");
    if (t[k]) nodes[i].textContent = t[k];
  }
}

function applyTheme() {
  document.body.dataset.theme = cfg.theme === "night" ? "night" : "day";
  var night = cfg.theme === "night";
  var s = document.documentElement.style;
  s.setProperty("--accent", cfg.accent);
  s.setProperty("--accent-soft", rgba(cfg.accent, night ? 0.18 : 0.12));
  s.setProperty("--accent-ink", night ? cfg.accent : shade(cfg.accent, 0.72));
  icon("themeicon", night ? "i-moon" : "i-sun");
  txt("themelabel", night ? t.night : t.day);
  cls("themeswitch", "on", night);
}

/* ── schermen ────────────────────────────────────────────────────────────── */
/* Elk scherm dat opengaat, sluit het vorige niet: ze stapelen. Terug sluit er
   één. Dat is waarom Instellingen → Taal → terug weer bij Instellingen komt. */
function openSheet(id) { show(id, true); }

document.addEventListener("pointerdown", function (e) {
  var c = e.target.closest("[data-close]");
  if (c) { e.preventDefault(); hide(c.getAttribute("data-close")); }
});

/* ── rijscherm ───────────────────────────────────────────────────────────── */
var tripView = 0;                 // 0 = afstand, 1 = verbruik

function battKleur(p) {
  return p < 10 ? "#c2453f" : p < 20 ? "#d9622f" : p < 35 ? "#c9911f" : p < 60 ? "#8ca33a" : "#3f8b52";
}

function hms(sec) {
  if (typeof sec !== "number" || !isFinite(sec)) return null;
  var m = Math.floor(sec / 60), h = Math.floor(m / 60);
  return (h ? h + "h " : "") + (m % 60) + "m";
}
function mmss(sec) {
  if (typeof sec !== "number" || !isFinite(sec)) return "--";
  var m = Math.floor(sec / 60), h = Math.floor(m / 60);
  return (h ? h + ":" : "") + String(m % 60).padStart(2, "0")
    + ":" + String(Math.floor(sec) % 60).padStart(2, "0");
}

function paintRide() {
  if (bedekt()) return;
  var d = data;

  /* Snelheid. De VESC uit? Dan 0 en niet n.v.t. — nul is hier de waarheid. */
  txt("speed", num(d2(d.speed_kmh || 0), 0));
  txt("speedunit", uSpeed());
  cls("speed", "sport", (cfg.mode || "").toUpperCase() === "SPORT");

  /* Accu. */
  var pct = Math.max(0, Math.min(100, d.battery_pct || 0));
  wortel("--batt", battKleur(pct));
  txt("battpct", num(pct, 0));
  txt("battva", (num(d.voltage, 1) || "--") + " V · " + (num(Math.abs(d.battery_current || 0), 0) || "--") + " A");
  stijl($("battfill"), "transform", "scaleX(" + (Math.max(2, pct) / 100).toFixed(3) + ")");
  cls("battrow", "low", pct <= 20);

  /* Bereik: wat er nog in het pak zit, gedeeld door het verbruik per km.
     Beide staan in de instellingen; de VESC weet ze niet. */
  var whLeft = pct / 100 * cfg.packWh;
  txt("range", (d2(whLeft / cfg.whPerKm)).toFixed(1));
  txt("rangeunit", uDist());

  /* Trip-kaart. Tikken wisselt tussen afstand en verbruik. */
  txt("triplbl", tripView ? t.avgUse : t.trip);
  if (tripView) {
    var km = d.trip_km || 0;
    txt("tripval", km > 0.2 ? num((d.wh_used || 0) / d2(km), 0) : "—");
    txt("tripsub", "Wh/" + uDist());
  } else {
    txt("tripval", num(d2(d.trip_km || 0), 1));
    txt("tripsub", hms(d.trip_s) || "0m");
  }

  txt("odo", typeof d.odo_km === "number" ? num(d2(d.odo_km), 0) : t.na);
  txt("odounit", uDist());

  var tm = typeof d.temp_motor === "number" && d.temp_motor > 0 ? d.temp_motor : null;
  var te = typeof d.temp_fet === "number" && d.temp_fet > 0 ? d.temp_fet : null;
  txt("motortemp", tm === null ? t.na : num(tp(tm), 0) + "°");
  txt("esctemp", te === null ? t.na : num(tp(te), 0));
  cls("motortemp", "warn", tm !== null && tm > cfg.limMotor - 35 && tm <= cfg.limMotor - 20);
  cls("motortemp", "crit", tm !== null && tm > cfg.limMotor - 20);

  /* Cruisecontrol. Het element verschijnt alleen als de afleiding hem ziet;
     kan de step het niet (geen ADC-hendel), dan blijft het weg. */
  var cr = $("cruise");
  if (cr) {
    var aan = !!d.cruise;
    if (cr.hidden === aan) cr.hidden = !aan;
  }
}

/* ── titelbalk ───────────────────────────────────────────────────────────── */
var net = { wifi: null, bt: null, modem: null };

function paintTop() {
  wortel("--link", data.connected ? "#2f9e5f" : "#c2453f");

  var w = net.wifi && net.wifi.connected;
  icon("wifiico", w ? "i-wifi-high-f" : "i-wifi-slash");
  cls("wifiico", "on", w);

  var b = net.bt && net.bt.connected;
  icon("btico", b ? "i-bluetooth-connected-f" : "i-bluetooth-slash");
  cls("btico", "on", b);

  var m = net.modem && net.modem.present && net.modem.bars > 0;
  icon("cellico", m ? "i-cell-signal-high-f" : "i-cell-signal-slash");
  cls("cellgrp", "on", m);
  txt("celltxt", m ? (net.modem.tech || "") : "--");
}

function tikKlok() {
  var d = new Date();
  txt("clock", d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"));
}

/* Knipperen. Vroeger deed CSS dit met @keyframes, maar een oneindige animatie
   laat de browser elke frame de stijl van dat element opnieuw uitrekenen, ook
   als er niets verandert. Alleen het stipje in de bovenbalk kostte zo negentien
   stijlherberekeningen per seconde.

   Nu doet één timer het, en alleen als er iets te melden valt. Is er niets aan
   de hand, dan gebeurt er letterlijk niets meer op het scherm zolang de step
   stilstaat — en heeft knipperen zijn betekenis terug: het gebeurt alleen als
   het je aandacht wil.

   Het stipje van de VESC knippert daarom niet meer. Het staat vast groen als de
   verbinding er is en rood als hij weg is; dat zegt hetzelfde, en de klok en het
   snelheidscijfer laten wel zien dat de pagina nog leeft. */
var KNIPPERT = ["bell", "battrow", "updrow", "chargeico"];
var dimAan = false;

function ietsTeMelden() {
  var b = $("bell"), r = $("battrow"), u = $("updrow");
  return !!(b && b.dataset.lvl)
    || !!(r && r.classList.contains("low"))
    || !!(u && u.classList.contains("avail"))
    || !!lagen.charge;
}

function knipper() {
  var aan = ietsTeMelden();
  /* Niets aan de hand en niets gedimd: dan hoeft er ook niets geschreven te
     worden. Dit is de stille toestand waarin de UI helemaal stilvalt. */
  if (!aan && !dimAan) return;
  dimAan = aan ? !dimAan : false;
  for (var i = 0; i < KNIPPERT.length; i++) cls(KNIPPERT[i], "dim", dimAan);
}

/* ── meldingen ───────────────────────────────────────────────────────────── */
/* Meldingen zijn afgeleid, niet bewaard: ze staan er zolang de oorzaak er is.
   Wegtikken zet ze op de negeerlijst, en die loopt leeg zodra de oorzaak weg
   is — anders zou één tik een storing voorgoed onzichtbaar maken. */
var negeer = {};
var alerts = [];

function bouwAlerts() {
  var d = data, nu = [];
  var tijd = new Date();
  var klok = tijd.getHours() + ":" + String(tijd.getMinutes()).padStart(2, "0");
  function add(key, kind, ico, titel, detail) {
    nu.push({ key: key, kind: kind, ico: ico, titel: titel, detail: detail, tijd: klok });
  }
  if (d.fault) add("fault", "err", "i-plugs", t.faultLbl, String(d.fault));
  if (d.connected && d.battery_pct < 10) {
    add("batt", "err", "i-battery-charging", t.lowBatt, num(d.battery_pct, 0) + " %");
  }
  var tm = d.temp_motor, te = d.temp_fet;
  if (cfg.warnMotor && tm > 0 && tm >= cfg.limMotor - 10 && tm < cfg.limMotor) {
    add("motor", "warn", "i-thermometer-hot", t.motorHot, num(tp(tm), 0) + " " + uTemp());
  }
  if (cfg.warnEsc && te > 0 && te >= cfg.limEsc - 10 && te < cfg.limEsc) {
    add("esc", "warn", "i-thermometer-hot", t.escHot, num(tp(te), 0) + " " + uTemp());
  }

  /* Negeerlijst opschonen: wat er niet meer is, mag straks weer verschijnen. */
  Object.keys(negeer).forEach(function (k) {
    if (!nu.some(function (a) { return a.key === k; })) delete negeer[k];
  });
  var zicht = nu.filter(function (a) { return !negeer[a.key]; });

  /* Alleen hertekenen als er iets veranderd is — dit draait 7× per seconde. */
  var vinger = zicht.map(function (a) { return a.key + a.detail; }).join("|");
  if (vinger !== bouwAlerts.vorige) {
    bouwAlerts.vorige = vinger;
    alerts = zicht;
    tekenAlerts();
  }

  var ernst = zicht.length ? (zicht.some(function (a) { return a.kind === "err"; }) ? "err" : "warn") : "";
  var bell = $("bell");
  if (bell && bell.dataset.lvl !== ernst) {
    if (ernst) bell.dataset.lvl = ernst; else delete bell.dataset.lvl;
    icon("bellico", ernst ? "i-warning-f" : "i-bell");
  }
}

function tekenAlerts() {
  var h = "";
  if (!alerts.length) h = '<div class="empty">' + esc(t.noAlerts) + "</div>";
  alerts.forEach(function (a) {
    h += '<div class="alert ' + a.kind + '">' + svg(a.ico)
      + '<div class="body"><div class="t">' + esc(a.titel) + "</div>"
      + '<div class="d">' + esc(a.detail) + " · " + esc(a.tijd) + "</div></div>"
      + '<button class="x" data-drop="' + esc(a.key) + '">' + svg("i-x") + "</button></div>";
  });
  $("alertlist").innerHTML = h;
}

$("bell").addEventListener("pointerdown", function (e) { e.preventDefault(); openSheet("alerts"); });
$("alertclose").addEventListener("pointerdown", function (e) { e.preventDefault(); hide("alerts"); });
$("alertclear").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  alerts.forEach(function (a) { negeer[a.key] = true; });
  bouwAlerts.vorige = null;
  bouwAlerts();
});
$("alertlist").addEventListener("pointerdown", function (e) {
  var x = e.target.closest("[data-drop]");
  if (!x) return;
  e.preventDefault();
  negeer[x.getAttribute("data-drop")] = true;
  bouwAlerts.vorige = null;
  bouwAlerts();
});
$("alerts").addEventListener("pointerdown", function (e) {
  if (e.target === this) { e.preventDefault(); hide("alerts"); }
});

/* ── temperatuuralarm ────────────────────────────────────────────────────── */
/* Vol scherm, rood, knipperend. Bevestigen laat het weggaan; het komt pas
   terug als alles vijf graden onder de limiet is geweest. Zonder die
   hysterese zou het bij precies-op-de-limiet blijven knipperen. */
var alarmAck = false;

function paintAlarm() {
  var d = data;
  var paren = [
    ["limMotor", "warnMotor", d.temp_motor, "motorTemp"],
    ["limEsc", "warnEsc", d.temp_fet, "escTemp"],
    ["limBatt", "warnBatt", d.temp_batt, "battTemp"]
  ];
  var raak = null, allesKoel = true;
  paren.forEach(function (p) {
    var waarde = p[2];
    if (typeof waarde !== "number" || waarde <= 0) return;   // geen sensor = geen oordeel
    if (!cfg[p[1]]) return;
    if (waarde >= cfg[p[0]] && !raak) raak = p;
    if (waarde >= cfg[p[0]] - 5) allesKoel = false;
  });
  if (allesKoel) alarmAck = false;
  if (!raak || alarmAck) { hide("alarm"); return; }
  txt("alarmmsg", t[raak[3]] + " " + num(tp(raak[2]), 0) + uTemp() + " " + t.coolDown);
  show("alarm", true);
}
$("alarmack").addEventListener("pointerdown", function (e) {
  e.preventDefault(); alarmAck = true; hide("alarm");
});

/* ── laden ───────────────────────────────────────────────────────────────── */
/* Het laadscherm komt vanzelf op zodra de server ziet dat de spanning stijgt
   terwijl de step stilstaat, en gaat weg als dat stopt. Wegtikken mag ook. */
var laadWeg = false;
var laadEenheden = null;

function paintCharge() {
  var d = data;
  if (!d.charging) { laadWeg = false; hide("charge"); return; }
  if (laadWeg) return;

  var pct = Math.max(0, Math.min(100, d.battery_pct || 0));
  var vol = !!d.charge_full;
  document.documentElement.style.setProperty("--charge", vol ? "#3f8b52" : cfg.accent);
  txt("chargetitle", vol ? t.chargeFull : t.charging);
  txt("chargeval", num(pct, 0));
  stijl($("chargefill"), "transform", "scaleX(" + (Math.max(2, pct) / 100).toFixed(3) + ")");
  txt("chargevolts", num(d.voltage, 1) || "--");

  var whLeft = pct / 100 * cfg.packWh;
  txt("chargerange", d2(whLeft / cfg.whPerKm).toFixed(1));

  var a = typeof d.charge_a === "number" ? Math.abs(d.charge_a) : null;
  txt("chargeamps", a === null ? t.na : a.toFixed(1));
  txt("chargeeta", vol ? "—" : (hms((d.charge_eta_min || 0) * 60) || t.na));
  /* Winst per minuut: laadvermogen omgerekend naar afstand. Zonder gemeten
     laadstroom valt er niets te rekenen, dan staat er n.v.t. */
  txt("chargegain", vol ? "0.0"
    : a === null ? t.na
      : (a * (d.voltage || 0) / 60 / cfg.whPerKm * (isImp() ? 0.621371 : 1)).toFixed(2));

  if (!laadEenheden) laadEenheden = document.querySelectorAll(".chargeunit");
  var eenheid = uDist();
  for (var i = 0; i < laadEenheden.length; i++) {
    if (laadEenheden[i].textContent !== eenheid) laadEenheden[i].textContent = eenheid;
  }
  show("charge", true);
}
$("charge").addEventListener("pointerdown", function (e) {
  e.preventDefault(); laadWeg = true; hide("charge");
});

/* ── snelheidsmeting ─────────────────────────────────────────────────────── */
$("speedbtn").addEventListener("pointerdown", function (e) {
  e.preventDefault(); tekenSpeedStats(); openSheet("speedsheet");
});
$("tripcard").addEventListener("pointerdown", function (e) {
  e.preventDefault(); tripView = tripView ? 0 : 1; paintRide();
});

/* De vier regels worden één keer opgebouwd en daarna alleen nog bijgevuld.
   Dit scherm staat open terwijl je rijdt, dus de cijfers moeten meelopen —
   maar de HTML zeven keer per seconde opnieuw samenstellen zou hier het
   duurste van de hele app zijn. */
var STATS = [
  ["i-gauge", "current", "var(--ink)"],
  ["i-arrow-line-up", "topSpeed", "#c2453f"],
  ["i-chart-line", "avgSpeed", "var(--accent)"],
  ["i-timer", null, "var(--ink)"]
];
var statsGebouwd = false;

function bouwSpeedStats() {
  $("speedstats").innerHTML = STATS.map(function (r, i) {
    return '<div class="stat"><span style="color:' + r[2] + '">' + svg(r[0]) + "</span>"
      + '<span class="lbl" id="stl' + i + '"></span>'
      + '<span class="num"><b style="color:' + r[2] + '" id="stv' + i + '"></b>'
      + '<span id="stu' + i + '"></span></span></div>';
  }).join("");
  statsGebouwd = true;
}

function tekenSpeedStats() {
  if (!statsGebouwd) bouwSpeedStats();
  var d = data, e = uSpeed();
  txt("stl0", t.current); txt("stv0", num(d2(d.speed_kmh || 0), 0)); txt("stu0", e);
  txt("stl1", t.topSpeed); txt("stv1", num(d2(d.top_kmh || 0), 0)); txt("stu1", e);
  txt("stl2", t.avgSpeed); txt("stv2", num(d2(d.avg_kmh || 0), 0)); txt("stu2", e);
  txt("stl3", "Timer A"); txt("stv3", mmss(d.trip_s)); txt("stu3", "");
}
$("speedreset").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  fetch("/reset-top", { method: "POST" })["catch"](function () {});
  fetch("/reset-trip", { method: "POST" })["catch"](function () {});
  setTimeout(tekenSpeedStats, 300);
});

/* ── rijmodi ─────────────────────────────────────────────────────────────── */
/* /modes zegt of ze aanstaan en welke er zijn. Staat het uit in config.json,
   dan is er geen knop — dit stuurt commando's naar de motorcontroller en dat
   hoort een bewuste keuze te zijn. */
var modi = { enabled: false, list: [], active: null };

function tekenModi() {
  var doos = $("modes");
  if (!doos) return;
  var namen = modi.enabled ? modi.list : [];
  var huidig = [].slice.call(doos.querySelectorAll(".mode")).map(function (b) { return b.dataset.mode; });
  if (namen.join("|") !== huidig.join("|")) {
    /* Alleen de eigen knoppen vervangen: er kan iets anders in deze doos
       staan dat niet van ons is. */
    [].slice.call(doos.querySelectorAll(".mode")).forEach(function (b) { doos.removeChild(b); });
    namen.forEach(function (n) {
      var b = document.createElement("button");
      b.className = "mode";
      b.dataset.mode = n.toLowerCase();
      b.textContent = n;
      doos.appendChild(b);
    });
  }
  [].slice.call(doos.querySelectorAll(".mode")).forEach(function (b) {
    b.classList.toggle("on", b.textContent === (cfg.mode || modi.active));
  });
  /* Niets actief maar er zijn wel standen: toon de eerste, anders is er niets
     om op te tikken. */
  if (namen.length && !doos.querySelector(".mode.on")) {
    doos.querySelector(".mode").classList.add("on");
  }
}

$("modes").addEventListener("pointerdown", function (e) {
  var b = e.target.closest(".mode");
  if (!b || !modi.list.length) return;
  e.preventDefault();
  var i = modi.list.indexOf(b.textContent);
  var volgende = modi.list[(i + 1) % modi.list.length];
  cfg.mode = volgende;
  modi.active = volgende;
  tekenModi();
  paintRide();
  fetch("/mode", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: volgende })
  })["catch"](function () {});
});

function haalModi() {
  return fetch("/modes", { cache: "no-store" }).then(function (r) { return r.json(); })
    .then(function (j) {
      modi.enabled = !!j.enabled;
      modi.list = j.list || [];
      modi.active = j.active || null;
      if (!cfg.mode) cfg.mode = modi.active;
      tekenModi();
    })["catch"](function () {});
}

/* ── instellingen bewaren ────────────────────────────────────────────────── */
var bewaarTimer = null;

function bewaar() {
  clearTimeout(bewaarTimer);
  bewaarTimer = setTimeout(function () {
    fetch("/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg)
    })["catch"](function () {});
  }, 250);
}

/* ── keuzeschermen: eenheden, taal, accentkleur ──────────────────────────── */
function vink(aan) { return svg(aan ? "i-check-circle-f" : "i-circle"); }

function tekenUnits() {
  var rij = [
    { id: "metric", nm: t.metric + " — km/h, km, °C" },
    { id: "imperial", nm: t.imperial + " — mph, mi, °F" }
  ];
  $("unitlist").innerHTML = rij.map(function (u) {
    var aan = cfg.units === u.id;
    return '<button class="pick' + (aan ? " on" : "") + '" data-unit="' + u.id + '">'
      + '<span class="nm">' + esc(u.nm) + "</span>" + vink(aan) + "</button>";
  }).join("");
}
$("unitlist").addEventListener("pointerdown", function (e) {
  var b = e.target.closest("[data-unit]");
  if (!b) return;
  e.preventDefault();
  cfg.units = b.getAttribute("data-unit");
  tekenUnits(); paintAlles(); bewaar();
});

var TALEN = [
  { id: "en", abbr: "EN", nm: "English" },
  { id: "nl", abbr: "NL", nm: "Nederlands" },
  { id: "fr", abbr: "FR", nm: "Français" },
  { id: "de", abbr: "DE", nm: "Deutsch" }
];
function tekenLangs() {
  $("langlist").innerHTML = TALEN.map(function (l) {
    var aan = cfg.lang === l.id;
    return '<button class="pick' + (aan ? " on" : "") + '" data-lang="' + l.id + '">'
      + '<span class="abbr">' + l.abbr + "</span>"
      + '<span class="nm">' + esc(l.nm) + "</span>" + vink(aan) + "</button>";
  }).join("");
}
$("langlist").addEventListener("pointerdown", function (e) {
  var b = e.target.closest("[data-lang]");
  if (!b) return;
  e.preventDefault();
  cfg.lang = b.getAttribute("data-lang");
  applyLang(); tekenLangs(); paintAlles(); bewaar();
});

function tekenAccents() {
  $("accentlist").innerHTML = ACCENTS.map(function (a) {
    var aan = cfg.accent === a.hex;
    return '<button class="pick' + (aan ? " on" : "") + '" data-accent="' + a.hex + '"'
      + ' style="--swatch:' + a.hex + '">'
      + '<span class="sw" style="background:' + a.hex + '"></span>'
      + '<span class="nm">' + esc(a[cfg.lang] || a.en) + "</span>" + vink(aan) + "</button>";
  }).join("");
}
$("accentlist").addEventListener("pointerdown", function (e) {
  var b = e.target.closest("[data-accent]");
  if (!b) return;
  e.preventDefault();
  cfg.accent = b.getAttribute("data-accent");
  applyTheme(); tekenAccents(); paintAlles(); bewaar();
});

/* ── temperatuurlimieten ─────────────────────────────────────────────────── */
function nuTemp(sleutel) {
  var d = data;
  var v = sleutel === "limMotor" ? d.temp_motor : sleutel === "limEsc" ? d.temp_fet : d.temp_batt;
  return typeof v === "number" && v > 0 ? v : null;
}

function tekenLimits() {
  $("limlist").innerHTML = Object.keys(LIMGRENZEN).map(function (k) {
    var g = LIMGRENZEN[k], v = cfg[k], aan = cfg[g.warn];
    var nu = nuTemp(k);
    var raak = nu !== null && nu >= v;
    return '<div class="lim' + (aan ? "" : " off") + '">'
      + '<div class="limhead"><span class="left">' + svg(g.ico)
      + '<span class="lbl">' + esc(t[g.lbl]) + "</span></span>"
      + '<span class="right"><span class="limval' + (raak ? " hit" : "") + '">'
      + "<b>" + num(tp(v), 0) + "</b><span>" + uTemp() + "</span></span>"
      + '<span class="switch' + (aan ? " on" : "") + '" data-warn="' + k + '"><i></i></span>'
      + "</span></div>"
      + '<div class="limrow">'
      + '<button class="step" data-lim="' + k + '" data-d="-1">' + svg("i-minus") + "</button>"
      + '<span class="limbar"><i style="width:'
      + ((v - g.min) / (g.max - g.min) * 100) + '%"></i></span>'
      + '<button class="step" data-lim="' + k + '" data-d="1">' + svg("i-plus") + "</button>"
      + "</div>"
      + '<div class="limnow">' + esc(t.now) + ": "
      + (nu === null ? esc(t.na) : num(tp(nu), 0) + " " + uTemp()) + "</div></div>";
  }).join("");
  txt("limsummary", t.motor + " " + num(tp(cfg.limMotor), 0) + "° · VESC "
    + num(tp(cfg.limEsc), 0) + "° · " + t.battery + " " + num(tp(cfg.limBatt), 0) + "°");
}
$("limlist").addEventListener("pointerdown", function (e) {
  var s = e.target.closest("[data-lim]");
  if (s) {
    e.preventDefault();
    var k = s.getAttribute("data-lim"), g = LIMGRENZEN[k];
    cfg[k] = Math.max(g.min, Math.min(g.max, cfg[k] + 5 * Number(s.getAttribute("data-d"))));
    tekenLimits(); bewaar();
    return;
  }
  var w = e.target.closest("[data-warn]");
  if (w) {
    e.preventDefault();
    var wk = LIMGRENZEN[w.getAttribute("data-warn")].warn;
    cfg[wk] = !cfg[wk];
    tekenLimits(); bewaar();
  }
});

/* ── stepgegevens ────────────────────────────────────────────────────────── */
/* De VESC weet poolparen, wieldiameter en overbrenging als de setup-wizard in
   VESC Tool gedraaid is. Zo niet, dan rekent de app met de waarden uit
   config.json — en die moet je dan wel kunnen zetten. */
var stp = { status: "unknown", step: null, vuil: false, bezig: false };
var STAPGRENZEN = {
  polePairs: { min: 1, max: 40, d: 1, dec: 0 },
  wheelDiameterM: { min: 0.08, max: 0.8, d: 0.0025, dec: 4 },
  gearRatio: { min: 0.5, max: 30, d: 0.1, dec: 2 },
  batteryCells: { min: 3, max: 30, d: 1, dec: 0 }
};

function stapStatusTekst() {
  if (stp.step && stp.step.source === "hand") return { s: t.stepHand, c: "" };
  if (stp.status === "ok") return { s: t.stepOk, c: "ok" };
  if (stp.status === "missing") return { s: t.stepMissing, c: "bad" };
  return { s: t.stepUnknown, c: "" };
}

function paintSetup() {
  var st = stapStatusTekst();
  var rij = $("opensetup");
  if (rij) rij.hidden = stp.status === "ok" && (!stp.step || stp.step.source !== "hand");
  txt("setupsub", st.s);
  var p = $("setupstat");
  if (p) { p.textContent = st.s; p.className = "hint" + (st.c ? " " + st.c : ""); }

  if (!stp.step) return;
  var d = stp.step;
  var rijen = [
    ["polePairs", t.polePairs, String(d.polePairs)],
    ["wheelDiameterM", t.wheel, (d.wheelDiameterM / 0.0254).toFixed(1) + "″"],
    ["gearRatio", t.gear, d.gearRatio.toFixed(1) + "×"],
    ["batteryCells", t.cells, d.batteryCells ? String(d.batteryCells) : t.auto]
  ];
  $("steplist").innerHTML = rijen.map(function (r) {
    return '<div class="stepitem"><span class="lbl">' + esc(r[1]) + "</span>"
      + '<span class="num">' + esc(r[2]) + "</span>"
      + '<button class="step" data-s="' + r[0] + '" data-d="-1">' + svg("i-minus") + "</button>"
      + '<button class="step" data-s="' + r[0] + '" data-d="1">' + svg("i-plus") + "</button></div>";
  }).join("");

  txt("stepsavelbl", stp.bezig ? t.saving : (stp.vuil ? t.save : t.saved));
  cls("stepsave", "idle", stp.bezig || !stp.vuil);
}

function haalSetup() {
  return fetch("/setup", { cache: "no-store" }).then(function (r) { return r.json(); })
    .then(function (j) {
      stp.status = j.status || "unknown";
      if (!stp.vuil && j.step) stp.step = j.step;
      paintSetup();
    })["catch"](function () {});
}

$("steplist").addEventListener("pointerdown", function (e) {
  var b = e.target.closest("[data-s]");
  if (!b || !stp.step) return;
  e.preventDefault();
  var k = b.getAttribute("data-s"), dir = Number(b.getAttribute("data-d")), g = STAPGRENZEN[k];
  if (k === "batteryCells") {
    /* Onder de ondergrens staat "auto": dan raadt de server het uit de
       pakspanning, en dat is beter dan een getal waarvan je niet zeker bent. */
    var n = (stp.step.batteryCells || g.min) + dir;
    stp.step.batteryCells = n <= g.min ? null : Math.min(g.max, n);
  } else {
    var v = stp.step[k] + dir * g.d;
    stp.step[k] = Math.max(g.min, Math.min(g.max, Number(v.toFixed(g.dec))));
  }
  stp.vuil = true;
  paintSetup();
});
$("stepsave").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  if (stp.bezig || !stp.vuil) return;
  stp.bezig = true;
  paintSetup();
  fetch("/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stp.step)
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.step) stp.step = j.step;
    stp.vuil = false;
  })["catch"](function () {})["then"](function () {
    stp.bezig = false;
    paintSetup();
  });
});
$("opensetup").addEventListener("pointerdown", function (e) {
  e.preventDefault(); paintSetup(); openSheet("setup");
});

/* ── bijwerken ───────────────────────────────────────────────────────────── */
/* De service kijkt bij het opstarten of er iets nieuws op GitHub staat.
   Installeren blijft een bewuste tik: een kapotte versie die zichzelf tijdens
   het opstarten op je stuur zet, wil je niet. */
var upd = { available: false, running: false, error: null, notes: [], repo: "", version: "", date: "" };

function paintUpd() {
  var label, ico, klasse = "";
  if (upd.running) { label = t.updInstalling; ico = "i-arrows-clockwise"; }
  else if (upd.zoeken) { label = t.updSearching; ico = "i-arrows-clockwise"; }
  else if (upd.error) { label = t.updFailed; ico = "i-git-branch"; }
  else if (upd.available) { label = t.updAvailable; ico = "i-download-simple-f"; klasse = "avail"; }
  else { label = t.updOk; ico = "i-check-circle-f"; klasse = "ok"; }
  txt("updlabel", label);
  icon("updicon", ico);
  cls("updrow", "avail", klasse === "avail");
  cls("updrow", "ok", klasse === "ok");
  txt("updmeta", upd.available
    ? upd.repo + " · " + upd.version
    : (upd.error ? upd.error : t.updCurrent + ": " + (upd.current || "—") + " · GitHub"));

  txt("relrepo", upd.repo);
  txt("relversion", upd.version);
  txt("reldate", upd.date);
  txt("rellabel", upd.running ? t.updInstalling : t.updNow + " " + upd.version);
  icon("relicon", upd.running ? "i-arrows-clockwise" : "i-download-simple");
  $("relnotes").innerHTML = upd.notes.length
    ? upd.notes.map(function (c) {
      return '<div class="note"><span class="sha">' + esc(c.sha) + "</span>"
        + '<span class="msg">' + esc(c.msg) + "</span></div>";
    }).join("")
    : '<div class="empty">' + esc(t.noNotes) + "</div>";
}

function datumKort(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d)) return "";
  return ("0" + d.getDate()).slice(-2) + "-" + ("0" + (d.getMonth() + 1)).slice(-2)
    + "-" + d.getFullYear();
}

function haalUpdate(force) {
  return fetch("/update" + (force ? "?check=1" : ""), { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (u) {
      upd.running = !!u.running;
      upd.available = !!u.available;
      upd.error = u.error || (u.runState === "fout" ? u.runMessage : null);
      upd.repo = u.repo || "";
      upd.current = u.currentShort || null;
      upd.version = u.latestShort || u.currentShort || "—";
      upd.date = datumKort(u.latestDate);
      upd.notes = u.notes || [];
      upd.zoeken = false;
      paintUpd();
      /* Tijdens een installatie blijven kijken: de rij moet meelopen. */
      if (upd.running) setTimeout(function () { haalUpdate(false); }, 2000);
    })["catch"](function () { upd.zoeken = false; paintUpd(); });
}

$("updrow").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  if (upd.available) { paintUpd(); openSheet("release"); return; }
  upd.zoeken = true;
  paintUpd();
  haalUpdate(true);
});
$("reldo").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  if (upd.running) return;
  upd.running = true;
  paintUpd();
  fetch("/update", { method: "POST" })["catch"](function () {})
    ["then"](function () { setTimeout(function () { haalUpdate(false); }, 800); });
});

/* ── verbindingen ────────────────────────────────────────────────────────── */
var lijst = { wifi: [], bt: [] };
var zoekt = { wifi: false, bt: false };

function tekenNet(soort) {
  var items = lijst[soort];
  var doel = soort === "wifi" ? "wifilist" : "btlist";
  var h = items.map(function (n) {
    var meta = n.active ? t.connected
      : soort === "wifi"
        ? (n.secured ? "WPA" : "Open") + " · " + (t[n.level >= 4 ? "strong" : n.level >= 2 ? "medium" : "weak"] || "")
        : (n.known ? t.paired : t.nearby);
    return '<button class="net' + (n.active ? " on" : "") + '" data-kind="' + soort
      + '" data-id="' + esc(n.id) + '" data-sec="' + (n.secured ? "1" : "") + '"'
      + ' data-on="' + (n.active ? "1" : "") + '">'
      + svg(soort === "wifi" ? "i-wifi-high" : "i-bluetooth")
      + '<span class="body"><span class="nm">' + esc(n.name) + "</span>"
      + '<span class="meta">' + esc(meta) + "</span></span>"
      + '<span class="state">' + svg(n.active ? "i-check-circle-f" : "i-caret-right") + "</span>"
      + "</button>";
  }).join("");
  $(doel).innerHTML = h || '<div class="empty">' + esc(zoekt[soort] ? t.scanning : "—") + "</div>";
  txt(soort === "wifi" ? "wifiscan" : "btscan", zoekt[soort] ? t.scanning : t.scan);
}

function scan(soort) {
  zoekt[soort] = true;
  tekenNet(soort);
  var u = "/net?kind=" + soort + (soort === "bt" ? "&scan=1" : "");
  fetch(u, { cache: "no-store" }).then(function (r) { return r.json(); })
    .then(function (j) { lijst[soort] = j.items || []; })
    ["catch"](function () {})
    ["then"](function () { zoekt[soort] = false; tekenNet(soort); });
}

$("openconn").addEventListener("pointerdown", function (e) {
  e.preventDefault(); openSheet("conn"); scan("wifi"); scan("bt");
});
$("wifiscan").addEventListener("pointerdown", function (e) { e.preventDefault(); scan("wifi"); });
$("btscan").addEventListener("pointerdown", function (e) { e.preventDefault(); scan("bt"); });

function verbind(soort, id, connect, wachtwoord) {
  return fetch("/net", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: soort, id: id, connect: connect, password: wachtwoord || undefined })
  }).then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); });
}

function netTik(e) {
  var b = e.target.closest(".net");
  if (!b) return;
  e.preventDefault();
  var soort = b.getAttribute("data-kind"), id = b.getAttribute("data-id");
  if (b.getAttribute("data-on")) {
    verbind(soort, id, false)["then"](function () { scan(soort); })["catch"](function () {});
    return;
  }
  if (soort === "wifi" && b.getAttribute("data-sec")) return openPw("wifi", id, b.querySelector(".nm").textContent);
  verbind(soort, id, true).then(function (r) {
    if (r.code === 400 && r.j && r.j.needsPassword) return openPw(soort, id, b.querySelector(".nm").textContent);
    scan(soort);
  })["catch"](function () {});
}
$("wifilist").addEventListener("pointerdown", netTik);
$("btlist").addEventListener("pointerdown", netTik);

/* ── wachtwoord met schermtoetsenbord ────────────────────────────────────── */
var pw = { soort: null, id: "", naam: "", tekst: "", shift: false, sym: false, toon: false, fout: false };

var LETTERS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"]
];
var TEKENS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "/", ":", ";", "(", ")", "€", "&", "@", "\""],
  [".", ",", "?", "!", "'", "+", "=", "#", "%"]
];

function tekenKeys() {
  var rijen = (pw.sym ? TEKENS : LETTERS).map(function (r) {
    return '<div class="keyrow">' + r.map(function (ch) {
      var lab = pw.shift && !pw.sym ? ch.toUpperCase() : ch;
      return '<button class="key" data-k="' + esc(lab) + '">' + esc(lab) + "</button>";
    }).join("") + "</div>";
  });
  rijen.push('<div class="keyrow">'
    + '<button class="key small grey" data-k="sym" style="flex:1.6 1 0">' + (pw.sym ? "abc" : "?123") + "</button>"
    + '<button class="key grey' + (pw.shift ? " on" : "") + '" data-k="shift">⇧</button>'
    + '<button class="key small" data-k=" " style="flex:3 1 0">' + esc(t.space) + "</button>"
    + '<button class="key grey" data-k="back">⌫</button>'
    + '<button class="key ok" data-k="ok" style="flex:1.4 1 0">✓</button>'
    + "</div>");
  $("keyrows").innerHTML = rijen.join("");
}

function paintPw() {
  txt("pwkind", pw.soort === "wifi" ? t.wifiPw : t.btPin);
  txt("pwname", pw.naam);
  txt("pwmasked", pw.toon ? pw.tekst : "•".repeat(pw.tekst.length));
  icon("pweye", pw.toon ? "i-eye-slash" : "i-eye");
  var h = $("pwhint");
  if (h) { h.textContent = pw.fout ? t.pwErr : t.pwHint; h.className = "hint" + (pw.fout ? " err" : ""); }
}

function openPw(soort, id, naam) {
  pw.soort = soort; pw.id = id; pw.naam = naam;
  pw.tekst = ""; pw.shift = false; pw.sym = false; pw.toon = false; pw.fout = false;
  tekenKeys(); paintPw(); openSheet("pw");
}

$("keyrows").addEventListener("pointerdown", function (e) {
  var b = e.target.closest("[data-k]");
  if (!b) return;
  e.preventDefault();
  var k = b.getAttribute("data-k");
  if (k === "sym") { pw.sym = !pw.sym; return tekenKeys(); }
  if (k === "shift") { pw.shift = !pw.shift; return tekenKeys(); }
  if (k === "back") { pw.tekst = pw.tekst.slice(0, -1); return paintPw(); }
  if (k === "ok") {
    /* WPA wil er minstens acht; korter accepteert NetworkManager niet en dan
       krijg je een foutmelding die nergens op slaat. */
    if (pw.tekst.length < (pw.soort === "wifi" ? 8 : 4)) { pw.fout = true; return paintPw(); }
    var w = pw.tekst;
    hide("pw");
    verbind(pw.soort, pw.id, true, w).then(function () { scan(pw.soort); })["catch"](function () {});
    return;
  }
  pw.tekst = (pw.tekst + k).slice(0, 63);
  if (pw.shift && !pw.sym) { pw.shift = false; tekenKeys(); }
  pw.fout = false;
  paintPw();
});
$("pweye").addEventListener("pointerdown", function (e) {
  e.preventDefault(); pw.toon = !pw.toon; paintPw();
});
$("pwcancel").addEventListener("pointerdown", function (e) { e.preventDefault(); hide("pw"); });

/* ── aan/uit ─────────────────────────────────────────────────────────────── */
$("openpower").addEventListener("pointerdown", function (e) { e.preventDefault(); openSheet("powermenu"); });
$("powermenu").addEventListener("pointerdown", function (e) {
  if (e.target === this) { e.preventDefault(); hide("powermenu"); }
});
function stroom(actie) {
  hide("powermenu");
  txt("offlabel", actie === "reboot" ? t.rebooting : t.tapToWake);
  icon("officon", actie === "reboot" ? "i-arrows-clockwise" : "i-power");
  show("off", true);
  fetch("/power", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: actie })
  })["catch"](function () {});
}
$("doreboot").addEventListener("pointerdown", function (e) { e.preventDefault(); stroom("reboot"); });
$("doshutdown").addEventListener("pointerdown", function (e) { e.preventDefault(); stroom("shutdown"); });
$("off").addEventListener("pointerdown", function (e) { e.preventDefault(); hide("off"); });

/* ── instellingen ────────────────────────────────────────────────────────── */
$("topright").addEventListener("pointerdown", function (e) { e.preventDefault(); openSheet("settings"); });
$("openunits").addEventListener("pointerdown", function (e) { e.preventDefault(); tekenUnits(); openSheet("units"); });
$("openlang").addEventListener("pointerdown", function (e) { e.preventDefault(); tekenLangs(); openSheet("lang"); });
$("openaccent").addEventListener("pointerdown", function (e) { e.preventDefault(); tekenAccents(); openSheet("accent"); });
$("openlimits").addEventListener("pointerdown", function (e) { e.preventDefault(); tekenLimits(); openSheet("limits"); });
$("thememode").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  cfg.theme = cfg.theme === "night" ? "day" : "night";
  applyTheme(); bewaar();
});

function paintSettings() {
  txt("unitslabel", isImp() ? "mph · mi · °F" : "km/h · km · °C");
  txt("langlabel", cfg.lang.toUpperCase());
  var dot = $("accentdot");
  if (dot) dot.style.background = cfg.accent;
}

/* ── alles opnieuw tekenen ───────────────────────────────────────────────── */
function paintAlles() {
  applyTheme();
  paintRide();
  paintTop();
  paintSettings();
  tekenLimits();
  paintSetup();
  paintUpd();
  tekenModi();
  tekenAlerts();
}

/* ── draaien ─────────────────────────────────────────────────────────────── */
/* Het ontwerp is staand, het paneeltje hangt liggend in de step. Deze functie
   vergelijkt waarvoor de pagina getekend is met wat ze krijgt, en zet er een
   kwartslag op als die twee niet overeenkomen. Aanraken blijft gewoon werken:
   de browser rekent tikken door de transform heen terug. */
function fitRotation() {
  var root = $("root");
  var paneelLiggend = window.innerWidth >= window.innerHeight;
  var deg = paneelLiggend ? (cfg.rotate === 270 ? 270 : 90) : 0;
  if (!deg) {
    root.style.position = "relative";
    root.style.left = "";
    root.style.top = "";
    root.style.transform = "";
    return;
  }
  root.style.position = "absolute";
  /* Ankeren aan wat er echt te zien is, niet aan het venster: Chromium heeft
     een minimumbreedte en zonder window manager doet fullscreen niets, dus
     het venster kan breder zijn dan het paneel. */
  var sw = Math.min(window.innerWidth, (window.screen && screen.width) || window.innerWidth);
  var sh = Math.min(window.innerHeight, (window.screen && screen.height) || window.innerHeight);
  root.style.left = Math.round((sw - DESIGN.w) / 2) + "px";
  root.style.top = Math.round((sh - DESIGN.h) / 2) + "px";
  root.style.transform = "rotate(" + deg + "deg)";
}
window.addEventListener("resize", fitRotation);

/* ── de lus ──────────────────────────────────────────────────────────────── */
function poll() {
  fetch("/data", { cache: "no-store" }).then(function (r) { return r.json(); })
    .then(function (j) {
      data = j;
      paintRide();
      paintTop();
      bouwAlerts();
      paintAlarm();
      paintCharge();
      /* De snelheidsmeting dekt het rijscherm af, maar de cijfers erin lopen
         wel mee zolang hij openstaat. */
      if (lagen.speedsheet) tekenSpeedStats();
    })["catch"](function () {
      data.connected = false;
      paintTop();
    })["then"](function () { setTimeout(poll, POLL_MS); });
}

function pollNet() {
  Promise.all([
    fetch("/wifi", { cache: "no-store" }).then(function (r) { return r.json(); })["catch"](function () { return null; }),
    fetch("/bt", { cache: "no-store" }).then(function (r) { return r.json(); })["catch"](function () { return null; }),
    fetch("/modem", { cache: "no-store" }).then(function (r) { return r.json(); })["catch"](function () { return null; })
  ]).then(function (r) {
    if (r[0]) net.wifi = r[0];
    if (r[1]) net.bt = r[1];
    if (r[2]) net.modem = r[2];
    paintTop();
  });
}

/* ── starten ─────────────────────────────────────────────────────────────── */
fetch("/settings", { cache: "no-store" }).then(function (r) { return r.json(); })
  .then(function (s) { Object.keys(cfg).forEach(function (k) { if (s[k] != null) cfg[k] = s[k]; }); })
  ["catch"](function () {})
  ["then"](function () {
    applyLang();
    applyTheme();
    fitRotation();
    tekenKeys();
    paintAlles();
    tikKlok();
    setInterval(tikKlok, 1000);
    setInterval(knipper, 550);
    poll();
    pollNet();
    /* Elke 30 seconden, niet elke vijf. Wifi, bluetooth en de modem opvragen
       start op de Pi drie processen, en dat is veruit het duurste wat het
       apparaat doet — voor drie icoontjes die bijna nooit veranderen. De
       server houdt de uitkomst 25 seconden vast en gooit die weg zodra jij
       zelf iets verbindt of verbreekt, dus het verbindingsscherm blijft even
       snel aanvoelen als het was. */
    setInterval(pollNet, 30000);
    haalModi();
    haalSetup();
    setInterval(haalSetup, 30000);
    haalUpdate(false);
    setInterval(function () { if (!upd.running) haalUpdate(false); }, 300000);
  });
