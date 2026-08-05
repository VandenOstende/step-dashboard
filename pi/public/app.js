"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   Step Dashboard — het gedrag, gedeeld door beide indelingen.

   index.html is liggend (480 × 320), portrait.html staand (320 × 480). Ze
   verschillen alleen in opmaak: dezelfde element-id's, hetzelfde script. Eén
   los bestand dus, want twee kopieën van negenhonderd regels lopen bij de
   eerste wijziging al uit elkaar.

   Welke van de twee je voor je hebt staat op de body:
       <body data-layout="Liggend">   of   "Staand"
   ═══════════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════
   Step Dashboard — 480 × 320, Chromium kiosk op een Raspberry Pi 4.
   Alles vanilla: geen libraries, geen externe requests behalve de eigen
   endpoints op dezelfde origin. Rendert ~6×/s en raakt alleen gewijzigde
   nodes aan, want de SPI-display is traag.
   ═══════════════════════════════════════════════════════════════════════ */

var $ = function (id) { return document.getElementById(id); };

/* ── instellingen ───────────────────────────────────────────────────────
   Defaults uit de tweaks van het component (data-props). tempWarn staat op
   70 in plaats van de 100 die in het component stond: 100 lag boven
   tempCrit, waardoor de waarschuwing pas ná kritiek zou komen. */
/* Welke indeling deze pagina ís. index.html is de liggende, portrait.html de
   staande; de instelling bepaalt naar welke van de twee de kiosk gaat. Als
   beginwaarde nemen we de eigen indeling, zodat een pagina die je los opent
   niet meteen naar de andere springt als er geen server is. */
var PAGE_LAYOUT = document.body.getAttribute("data-layout") === "Staand" ? "Staand" : "Liggend";

/* Waar deze pagina voor getekend is. Past dat niet op het paneel waar hij op
   staat, dan draait hij zichzelf een kwartslag — zie fitRotation(). */
var DESIGN = PAGE_LAYOUT === "Staand" ? { w: 320, h: 480 } : { w: 480, h: 320 };

var cfg = {
  layout: PAGE_LAYOUT,
  rotate: 90,
  theme: "Auto",
  tempWarn: 70,
  tempCrit: 90,
  packWh: 1147,
  whPerKm: 18,
  speedMax: 35,
  bright: 80,
  start: 0
};
var POLL_MS = 150;
var RENDER_MS = 165;
var LIMITS = { tempWarn: [40, 120], tempCrit: [50, 130] };

/* ── panes ─────────────────────────────────────────────────────────────── */
var panes = [$("p0"), $("p1"), $("p2")];
var dots = [].slice.call($("dots").children);
var view = 0;

function show(i) {
  i = i < 0 ? 0 : (i > 2 ? 2 : i);
  panes[view].classList.remove("on");
  dots[view].classList.remove("on");
  view = i;
  panes[i].classList.add("on");
  dots[i].classList.add("on");
  $("net").classList.remove("on");
  cacheT = {}; cacheS = {};
  paint();
}

/* Een tik op de pagina gaat naar het volgende scherm; bewegen is geen tik. */
var tp = null;
var pn = $("panes");
pn.addEventListener("pointerdown", function (e) { tp = { x: e.clientX, y: e.clientY }; });
pn.addEventListener("pointerup", function (e) {
  var t = tp; tp = null;
  if (!t || Math.abs(e.clientX - t.x) > 12 || Math.abs(e.clientY - t.y) > 12) return;
  show((view + 1) % 3);
});
pn.addEventListener("pointercancel", function () { tp = null; });
document.addEventListener("contextmenu", function (e) { e.preventDefault(); });
document.addEventListener("gesturestart", function (e) { e.preventDefault(); });

/* ── thema — automatisch op de klok: 07:30–18:00 licht ──────────────────── */
function wantLight() {
  if (cfg.theme === "Licht") return true;
  if (cfg.theme === "Donker") return false;
  var d = new Date(), m = d.getHours() * 60 + d.getMinutes();
  return m >= 450 && m < 1080;
}
function applyTheme(force) {
  var light = wantLight();
  if (!force && light === document.body.classList.contains("light")) return;
  document.body.classList.toggle("light", light);
  cacheT = {}; cacheS = {};
}

/* ── data ──────────────────────────────────────────────────────────────── */
var MODE = "demo";           // "live" | "demo" | "off"
var prevMode = "demo";
var liveFails = 0;
var topSpeed = 0;
var bootTopSpeed = 0;      // laatst bewaarde echte topsnelheid van de Pi
var dm = { t: 0, spd: 0, tgt: 14, bat: 87, wh: 120, trip: 6.4, tm: 42, tf: 38 };
var last = demoTick();

function poll() {
  fetch("/data", { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw 0;
    return r.json();
  }).then(function (d) {
    liveFails = 0;
    MODE = d && d.connected === false ? "off" : "live";
    last = d;
  })["catch"](function () {
    if (++liveFails > 2) MODE = "demo";
  });
}

/* Demo-rit zodat het ontwerp ook standalone te bekijken is. */
function demoTick() {
  dm.t += 0.15;
  if (Math.random() < 0.02) dm.tgt = Math.random() < 0.25 ? 0 : 6 + Math.random() * 32;
  dm.spd += (dm.tgt - dm.spd) * 0.06;
  var spd = Math.max(0, dm.spd + Math.sin(dm.t * 1.7) * 0.35);
  var pw = Math.max(0, spd * 26 + (dm.tgt - dm.spd) * 95 + Math.sin(dm.t) * 30);
  var v = 50.4 - (100 - dm.bat) * 0.062 - pw / 900;
  dm.bat -= pw * 0.0000045 + 0.0006;
  if (dm.bat < 4) dm.bat = 96;
  dm.wh += pw * 0.0000417;
  dm.trip += spd * 0.0000417;
  dm.tm += (30 + pw * 0.055 - dm.tm) * 0.0022;
  dm.tf += (28 + pw * 0.040 - dm.tf) * 0.0025;
  return {
    connected: true, speed_kmh: spd, rpm: spd * 118, erpm: spd * 118 * 15,
    duty: Math.min(0.97, spd / 42 + pw / 6000), battery_pct: dm.bat, voltage: v,
    cell_voltage: v / 13, motor_current: pw / Math.max(20, v) * 1.6,
    battery_current: pw / Math.max(20, v), power_w: pw,
    temp_motor: dm.tm, temp_fet: dm.tf, wh_used: dm.wh, trip_km: dm.trip
  };
}

/* ── meldingen ─────────────────────────────────────────────────────────── */
var noticeList = [];
var ni = 0;

function notices(d) {
  var out = [];
  if (MODE === "off") out.push({ lv: 2, t: "Geen VESC-verbinding" });
  if (d.fault) out.push({ lv: 2, t: "VESC-storing — " + d.fault });
  var tm = d.temp_motor || 0, tf = d.temp_fet || 0, bp = d.battery_pct || 0;
  if (tm >= cfg.tempCrit) out.push({ lv: 2, t: "Motor " + tm.toFixed(0) + "°C — stop en laat afkoelen" });
  else if (tm >= cfg.tempWarn) out.push({ lv: 1, t: "Motor " + tm.toFixed(0) + "°C — verminder belasting" });
  if (tf >= cfg.tempCrit) out.push({ lv: 2, t: "FET " + tf.toFixed(0) + "°C — stop en laat afkoelen" });
  else if (tf >= cfg.tempWarn) out.push({ lv: 1, t: "FET " + tf.toFixed(0) + "°C — verminder belasting" });
  if (bp < 10) out.push({ lv: 2, t: "Accu " + bp.toFixed(0) + "% — bijna leeg" });
  else if (bp < 20) out.push({ lv: 1, t: "Accu " + bp.toFixed(0) + "% — laag" });
  if (upd.available) out.push({ lv: 0, t: "Nieuwe versie beschikbaar — zie Instellingen" });
  out.sort(function (a, b) { return b.lv - a.lv; });
  return out;
}

function paintNotice(d) {
  noticeList = notices(d);
  var b = $("notice");
  if (!noticeList.length) {
    ni = 0;
    if (cacheS.nz !== "0") { cacheS.nz = "0"; b.className = ""; $("notices").classList.remove("on"); }
    return;
  }
  var sig = noticeList.map(function (x) { return x.lv + x.t; }).join("|");
  if ($("notices").classList.contains("on") && cacheS.nsig !== sig) { cacheS.nsig = sig; renderNotices(); }
  var cur = noticeList[ni % noticeList.length];
  var key = cur.lv + "|" + cur.t;
  if (cacheS.nz === key) return;
  cacheS.nz = key;
  b.className = "on" + (cur.lv === 2 ? " crit" : cur.lv === 0 ? " info" : "");
  $("noticetxt").textContent = cur.t;
}

function renderNotices() {
  $("noticelist").innerHTML = noticeList.map(function (nt) {
    var cls = nt.lv === 2 ? " crit" : nt.lv === 0 ? " info" : "";
    var label = nt.lv === 2 ? "fout" : nt.lv === 0 ? "info" : "let op";
    return '<div class="row' + cls + '">'
      + '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3.5L1.8 21h20.4L12 3.5z"/><path d="M12 9.5v5.2M12 17.6v.1"/></svg>'
      + '<div class="msg"></div>'
      + '<div class="lv">' + label + '</div></div>';
  }).join("");
  /* tekst apart zetten: melding-tekst kan servertekst bevatten */
  [].slice.call($("noticelist").querySelectorAll(".msg")).forEach(function (el, i) {
    el.textContent = noticeList[i].t;
  });
  syncNav("noticelist");
}

/* Meldingen wisselen elke 3 s door de actieve lijst. */
setInterval(function () {
  if (noticeList.length > 1) { ni++; paintNotice(last); }
}, 3000);

$("notice").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  if (!noticeList.length) return;
  renderNotices();
  $("notices").classList.add("on");
  syncNav("noticelist");
});
$("noticesclose").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  $("notices").classList.remove("on");
});

/* ── volledig-scherm temperatuuralarm ───────────────────────────────────
   Knippert 3× (0,5 s aan / 0,5 s uit) en blijft daarna staan tot de
   gebruiker bevestigt. Amber en rood alarmeren elk apart. */
var alarm = { level: null, acked: {} };
var blink = null;

function checkAlarm(d) {
  var tm = d.temp_motor || 0, tf = d.temp_fet || 0, hot = Math.max(tm, tf);
  var level = hot >= cfg.tempCrit ? "crit" : (hot >= cfg.tempWarn ? "warn" : null);
  var el = $("alarm");
  if (!level) {
    if (alarm.level) {
      alarm.level = null; alarm.acked = {};
      clearTimeout(blink); blink = null;
      el.classList.remove("on");
    }
    return;
  }
  if (level === alarm.level) return;
  alarm.level = level;
  var crit = level === "crit";
  el.style.background = crit ? "var(--color-crit-fill)" : "var(--color-warn-fill)";
  el.style.color = crit ? "#f3f5fe" : "#161826";
  $("alarmclose").style.color = crit ? "#f3f5fe" : "#161826";
  $("alarmclose").style.borderColor = crit ? "#f3f5fe" : "#161826";
  $("alarmmsg").textContent =
    (tm >= tf ? "Motortemperatuur " + tm.toFixed(0) : "FET-temperatuur " + tf.toFixed(0))
    + "°C — " + (crit ? "stop en laat afkoelen" : "verminder belasting");
  if (alarm.acked[level]) return;

  clearTimeout(blink);
  var step = 0;
  el.classList.add("on");
  var next = function () {
    step++;
    if (step >= 6) { blink = null; el.classList.add("on"); return; }
    el.classList.toggle("on", step % 2 === 0);
    blink = setTimeout(next, 500);
  };
  blink = setTimeout(next, 500);
}

$("alarmclose").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  clearTimeout(blink); blink = null;
  alarm.acked[alarm.level] = true;
  $("alarm").classList.remove("on");
});

/* ── topbalk rechts: wifi, bluetooth, mobiel bereik ─────────────────────── */
var wifiLevel = null;
var cell = { bars: 0, tech: null, present: false };
var net = {
  tab: "wifi", wifiOn: false, ssid: "", btOn: false, dev: "", devMac: "",
  items: { wifi: [], bt: [] }, busy: "", error: null,
  scanning: false, scanErr: "", scanTimer: null
};

function paintWifi() {
  $("btico").style.display = net.btOn ? "block" : "none";
  $("wifiico").style.display = net.wifiOn ? "block" : "none";
  if (!net.wifiOn) return;
  var lv = Math.max(1, Math.min(3, wifiLevel == null ? 3 : wifiLevel));
  var c = lv === 1 ? "var(--color-warn)" : "var(--color-accent)";
  $("wadot").setAttribute("fill", c);
  [].slice.call(document.querySelectorAll("#wifiico .wa")).forEach(function (p) {
    p.setAttribute("stroke", +p.dataset.lv <= lv ? c : "var(--color-neutral-800)");
  });
}

function fetchWifi() {
  fetch("/wifi", { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw 0;
    return r.json();
  }).then(function (w) {
    net.wifiOn = !!w.connected;
    net.ssid = w.ssid || "";
    wifiLevel = w.level;
    paintWifi();
  })["catch"](function () { paintWifi(); });
}

function fetchBt() {
  fetch("/bt", { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw 0;
    return r.json();
  }).then(function (b) {
    net.btOn = !!b.connected;
    net.dev = b.name || "";
    net.devMac = b.mac || "";
    paintWifi();
  })["catch"](function () { paintWifi(); });
}

var sigbars = [].slice.call(document.querySelectorAll("#sig span"));
/* Verschijnen mag meteen, verdwijnen pas na drie keer op rij niks. ModemManager
   is even stil als hij herstart, en een balkjesmeter die daarbij in en uit
   springt is onrustiger dan een halve minuut wachten. */
var cellSeen = false, cellMiss = 0;

function paintSignal(bars, tech, present) {
  var b = Math.max(0, Math.min(5, bars || 0));
  cell.bars = b; cell.tech = tech;

  if (present) { cellSeen = true; cellMiss = 0; }
  else { cellMiss++; }
  cell.present = present || (cellSeen && cellMiss < 3);
  $("cellgrp").classList[cell.present ? "add" : "remove"]("on");
  var row = $("syscellrow");
  if (row) row.style.display = cell.present ? "" : "none";
  if (!cell.present) return;

  var weak = b <= 1;
  sigbars.forEach(function (s, k) { s.className = k < b ? (weak ? "weak" : "on") : ""; });
  var t = $("tech");
  t.textContent = b === 0 ? "GEEN" : (tech || "--");
  t.style.color = b === 0 ? "var(--color-neutral-500)" : "var(--color-text)";
}

function fetchModem() {
  fetch("/modem", { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw 0;
    return r.json();
  }).then(function (m) { paintSignal(m.bars, m.tech, !!m.present); })
  ["catch"](function () { paintSignal(0, null, false); });
}

function fetchWeather() {
  fetch("/weather", { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw 0;
    return r.json();
  }).then(function (w) {
    if (typeof w.temp_c === "number") $("outtemp").textContent = w.temp_c.toFixed(0) + "°";
  })["catch"](function () {
    $("outtemp").textContent = "--°";
  });
}

/* ── systeemvenster ────────────────────────────────────────────────────── */
function openSys() {
  var lv = wifiLevel == null ? 3 : wifiLevel;
  $("syswifi").textContent = net.wifiOn
    ? net.ssid + "  ·  " + (lv >= 3 ? "sterk" : lv === 2 ? "matig" : "zwak")
    : "niet verbonden";
  $("syscell").textContent = cell.bars
    ? (cell.tech || "?") + "  ·  " + cell.bars + "/5"
    : "geen bereik";
  $("sys").classList.add("on");
}
$("status").addEventListener("pointerdown", function (e) { e.preventDefault(); openSys(); });
$("sysclose").addEventListener("pointerdown", function (e) { e.preventDefault(); $("sys").classList.remove("on"); });
$("sysnet").addEventListener("pointerdown", function (e) { e.preventDefault(); $("sys").classList.remove("on"); openNet("wifi"); });
$("sysset").addEventListener("pointerdown", function (e) {
  e.preventDefault(); $("sys").classList.remove("on"); renderSettings(); $("settings").classList.add("on");
  syncNav("setlist");            // pas meten als het scherm zichtbaar is
});
$("setclose").addEventListener("pointerdown", function (e) {
  e.preventDefault(); $("settings").classList.remove("on"); openSys();
});

/* ── aan/uit ───────────────────────────────────────────────────────────── */
/* Twee tikken van het rijscherm naar uitschakelen: eerst de topbalk, dan
   Power. Ver genoeg weg om er onderweg niet per ongeluk op te komen, en dit
   scherm is zelf de bevestiging — nog een "weet je het zeker" erbij maakt het
   op een aanraakscherm alleen maar irritanter, niet veiliger. */
function openPower() {
  $("powermsg").textContent = "";
  $("powermsg").className = "";
  powbtns.forEach(function (b) { b.disabled = false; b.classList.remove("hit"); });
  $("powerclose").disabled = false;
  $("power").classList.add("on");
}

function doPower(action, label) {
  powbtns.forEach(function (b) { b.disabled = true; });
  $("powerclose").disabled = true;
  $("powermsg").className = "";
  $("powermsg").textContent = label + "…";
  fetch("/power", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: action })
  }).then(function (r) {
    return r.json()["catch"](function () { return {}; }).then(function (j) {
      if (!r.ok || !j.ok) throw new Error(j.error || (r.status === 404 ? "server te oud — werk bij" : "mislukt"));
      /* Vanaf hier gaat de Pi eruit. Niets meer te doen: de melding blijft
         staan tot het scherm zwart wordt. */
    });
  })["catch"](function (err) {
    $("powermsg").className = "bad";
    $("powermsg").textContent = err.message;
    powbtns.forEach(function (b) { b.disabled = false; });
    $("powerclose").disabled = false;
  });
}

var powbtns = [$("powreboot"), $("powshutdown")];
powbtns.forEach(function (b) {
  b.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    if (b.disabled) return;
    b.classList.add("hit");
    setTimeout(function () { b.classList.remove("hit"); }, 120);
    if (b.id === "powreboot") doPower("reboot", "Opnieuw opstarten");
    else doPower("shutdown", "Uitschakelen");
  });
});

$("syspower").addEventListener("pointerdown", function (e) {
  e.preventDefault(); $("sys").classList.remove("on"); openPower();
});
$("powerclose").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  if ($("powerclose").disabled) return;
  $("power").classList.remove("on");
  openSys();
});

/* ── instellingen ──────────────────────────────────────────────────────── */
function renderSettings() {
  $("setbright").textContent = cfg.bright + " %";
  $("setwarn").textContent = cfg.tempWarn + "°";
  $("setcrit").textContent = cfg.tempCrit + "°";
  [].slice.call(document.querySelectorAll(".seg.start")).forEach(function (b) {
    b.classList.toggle("on", +b.dataset.i === cfg.start);
  });
  [].slice.call(document.querySelectorAll(".seg[data-theme]")).forEach(function (b) {
    b.classList.toggle("on", b.dataset.theme === cfg.theme);
  });
  [].slice.call(document.querySelectorAll(".seg.lay")).forEach(function (b) {
    b.classList.toggle("on", b.dataset.lay === cfg.layout);
  });
  [].slice.call(document.querySelectorAll(".seg.rot")).forEach(function (b) {
    b.classList.toggle("on", +b.dataset.rot === cfg.rotate);
  });
}

function bump(key, step) {
  var lim = LIMITS[key];
  cfg[key] = Math.max(lim[0], Math.min(lim[1], cfg[key] + step));
  if (key === "tempWarn" && cfg.tempWarn > cfg.tempCrit) cfg.tempCrit = cfg.tempWarn;
  if (key === "tempCrit" && cfg.tempCrit < cfg.tempWarn) cfg.tempWarn = cfg.tempCrit;
  cacheT = {}; cacheS = {};
  renderSettings();
  saveSettings();
}

/* De UI mag zelf niets opslaan (geen localStorage) — de Pi bewaart het. */
var saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettingsNow, 400);
}

/* Zonder wachten wegschrijven. Nodig bij het wisselen van indeling: dan
   herlaadt de pagina, en een POST die nog in de wachtrij staat gaat mee het
   graf in — waarna de andere pagina je meteen terugstuurt. */
function saveSettingsNow() {
  clearTimeout(saveTimer);
  return fetch("/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg)
  })["catch"](function () {});
}

function layoutFile(name) { return name === "Staand" ? "portrait.html" : "index.html"; }

/* ── het scherm draaien ────────────────────────────────────────────────────
   Het schermpje op het stuur zit in één stand vastgeschroefd: het paneel is
   480 × 320, ook als je de staande indeling kiest. Het besturingssysteem laten
   draaien (display_rotate, xrandr, wlr-randr) verschilt per driver en per
   Pi-OS, en een verkeerde regel in config.txt levert een zwart scherm op
   zonder dat je er nog bij kunt. Daarom draait de pagina zichzelf: hij
   vergelijkt waarvoor hij getekend is met wat hij krijgt, en zet er een
   kwartslag op als die twee niet overeenkomen.

   Aanraken blijft gewoon werken: de browser rekent tikken door de transform
   heen terug, dus we hoeven zelf geen coördinaten om te klappen. */
function fitRotation() {
  var root = $("root");
  var paneelLiggend = window.innerWidth >= window.innerHeight;
  var ontwerpLiggend = DESIGN.w >= DESIGN.h;
  var deg = paneelLiggend === ontwerpLiggend ? 0 : (cfg.rotate === 270 ? 270 : 90);

  root.style.width = DESIGN.w + "px";
  root.style.height = DESIGN.h + "px";
  if (!deg) {
    root.style.position = "relative";
    root.style.left = "";
    root.style.top = "";
    root.style.transform = "";
    return;
  }
  root.style.position = "absolute";
  root.style.left = "50%";
  root.style.top = "50%";
  root.style.transform = "translate(-50%, -50%) rotate(" + deg + "deg)";
}

function gotoLayout(name) {
  if (name === PAGE_LAYOUT) return;
  location.replace(layoutFile(name));
}

$("setlist").addEventListener("pointerdown", function (e) {
  var br = e.target.closest(".step.bright");
  if (br) {
    e.preventDefault();
    cfg.bright = Math.max(20, Math.min(100, cfg.bright + (+br.dataset.d)));
    fetch("/backlight", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: cfg.bright })
    })["catch"](function () {});
    renderSettings();
    saveSettings();
    return;
  }
  var s = e.target.closest(".step");
  if (s) { e.preventDefault(); bump(s.dataset.k, +s.dataset.d); return; }
  var t = e.target.closest(".seg[data-theme]");
  if (t) { e.preventDefault(); cfg.theme = t.dataset.theme; applyTheme(true); renderSettings(); saveSettings(); return; }
  var rt = e.target.closest(".seg.rot");
  if (rt) {
    e.preventDefault();
    cfg.rotate = +rt.dataset.rot;
    renderSettings();
    saveSettings();
    fitRotation();
    return;
  }
  var ly = e.target.closest(".seg.lay");
  if (ly) {
    e.preventDefault();
    if (ly.dataset.lay === cfg.layout) return;
    cfg.layout = ly.dataset.lay;
    renderSettings();
    // pas springen als de instelling echt weg is
    saveSettingsNow().then(function () { gotoLayout(cfg.layout); });
    return;
  }
  var st = e.target.closest(".seg.start");
  if (st) {
    e.preventDefault();
    cfg.start = +st.dataset.i;
    renderSettings();
    saveSettings();
    $("settings").classList.remove("on");
    show(cfg.start);
  }
});

$("toprst").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  topSpeed = bootTopSpeed = 0;
  fetch("/reset-top", { method: "POST" })["catch"](function () {});
  cacheT = {}; cacheS = {};
  paint();
});
$("triprst").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  dm.trip = 0; dm.wh = 0;
  fetch("/reset-trip", { method: "POST" })["catch"](function () {});
  cacheT = {}; cacheS = {};
  paint();
});

/* ── laden ─────────────────────────────────────────────────────────────────
   De server herkent dat de lader eraan hangt en schat hoe lang het nog duurt.
   Het scherm verschijnt vanzelf en verdwijnt met een tik; bij de volgende
   laadbeurt komt het terug. */

var chg = { shown: false, dismissed: 0, session: 0 };

function etaText(min) {
  if (min === 0) return "vol";
  if (min == null) return "tijd nog onbekend";
  if (min < 60) return "nog \u00b1 " + min + " min";
  var u = Math.floor(min / 60), m = min % 60;
  return "nog \u00b1 " + u + " u" + (m ? " " + ("0" + m).slice(-2) : "");
}

function paintCharge(d) {
  var el = $("charge");
  if (!d || !d.charging) {
    if (chg.shown) { chg.shown = false; el.classList.remove("on"); cacheT = {}; cacheS = {}; }
    return;
  }
  /* Nieuwe laadbeurt: het scherm mag weer opkomen, ook als je het vorige
     hebt weggetikt. */
  if (d.charge_session !== chg.session) {
    chg.session = d.charge_session;
    chg.dismissed = 0;
  }
  if (chg.dismissed === chg.session) {
    if (chg.shown) { chg.shown = false; el.classList.remove("on"); }
    return;
  }
  if (!chg.shown) { chg.shown = true; el.classList.add("on"); }

  var pct = d.battery_pct || 0;
  el.classList.toggle("full", !!d.charge_full);
  txt("chargelabel", d.charge_full ? "Volledig geladen" : "Laden");
  txt("chargeval", n(pct));
  wide("chargebar", pct);
  txt("chargeeta", d.charge_full ? "vol" : etaText(d.charge_eta_min));
  txt("chargesub", n(d.voltage, 1) + " V \u00b7 " + n(d.cell_voltage, 2) + " V/cel");
}

$("charge").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  e.stopPropagation();
  chg.dismissed = chg.session;            // deze beurt niet meer tonen
  chg.shown = false;
  $("charge").classList.remove("on");
  cacheT = {}; cacheS = {};
  paint();
});

/* ── bijwerken ─────────────────────────────────────────────────────────────
   De service kijkt bij het opstarten of er een nieuwe versie op GitHub staat.
   Installeren blijft een bewuste tik: een kapotte versie die zichzelf tijdens
   het opstarten op je stuur zet, wil je niet. */

var upd = { available: false, running: false, checked: false, text: "", cls: "", version: "—" };

/* Unix-tijd (seconden) → 28-07-2026 */
function updDate(t) {
  if (!t) return "";
  var d = new Date(t * 1000);
  return ("0" + d.getDate()).slice(-2) + "-" + ("0" + (d.getMonth() + 1)).slice(-2)
    + "-" + d.getFullYear();
}
var updTimer = null;

function paintUpdate() {
  var st = $("setupd"), b = $("updbtn");
  if (!st) return;
  $("setver").textContent = upd.version;
  st.textContent = upd.text;
  st.className = "setstat" + (upd.cls ? " " + upd.cls : "");
  b.textContent = upd.running ? "Bezig…" : (upd.available ? "Installeren" : "Zoeken");
  b.style.opacity = upd.running ? "0.45" : "1";
}

function readUpdate(u) {
  /* De volledige versie staat onderaan de instellingen; de rij bovenaan toont
     alleen of er iets nieuws is. */
  if (u.currentShort) {
    upd.version = u.currentShort
      + (u.branch && u.branch !== "main" ? " (" + u.branch + ")" : "")
      + (u.installedAt ? " · " + updDate(u.installedAt) : "");
  } else {
    upd.version = "onbekend";
  }

  if (u.running) {
    upd.running = true;
    upd.text = u.runMessage ? u.runMessage + "…" : "bezig…";
    upd.cls = "";
  } else if (u.runState === "fout") {
    upd.running = false;
    upd.available = !!u.available;
    upd.text = u.runMessage || "mislukt";
    upd.cls = "bad";
  } else if (u.error) {
    upd.running = false;
    upd.available = false;
    upd.text = u.error;
    upd.cls = "bad";
  } else if (u.available) {
    upd.running = false;
    upd.available = true;
    upd.text = "nieuw: " + u.latestShort;
    upd.cls = "new";
  } else {
    upd.running = false;
    upd.available = false;
    upd.text = u.currentShort ? "actueel · " + u.currentShort : "actueel";
    upd.cls = "";
  }
  upd.checked = true;
  paintUpdate();
}

function fetchUpdate(force) {
  return fetch("/update" + (force ? "?check=1" : ""), { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw { code: r.status };
      return r.json();
    })
    .then(readUpdate)
    ["catch"](function (e) {
      /* Tijdens de herstart aan het eind van een update is de server even weg;
         dat is geen fout, dus laat de tekst dan staan. */
      if (upd.running) return;
      /* 404 betekent iets anders dan "geen netwerk": dan draait er een versie
         van vóór deze knop, en moet je die ene keer met de hand bijwerken. */
      upd.text = (e && e.code === 404) ? "server te oud — werk handmatig bij" : "niet bereikbaar";
      upd.cls = "bad";
      upd.checked = true;
      paintUpdate();
    });
}

/* Zolang er iets loopt elke 2 s kijken; anders stoppen. */
function followUpdate() {
  clearInterval(updTimer);
  updTimer = setInterval(function () {
    fetchUpdate(false).then(function () {
      if (!upd.running) { clearInterval(updTimer); updTimer = null; }
    });
  }, 2000);
}

$("updbtn").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  if (upd.running) return;
  var b = $("updbtn");
  b.classList.add("hit");
  setTimeout(function () { b.classList.remove("hit"); }, 90);

  if (!upd.available) {                     // zoeken
    upd.text = "controleren…";
    upd.cls = "";
    paintUpdate();
    fetchUpdate(true);
    return;
  }
  upd.running = true;                       // installeren
  upd.text = "starten…";
  upd.cls = "";
  paintUpdate();
  fetch("/update", { method: "POST" })
    .then(function (r) { return r.json()["catch"](function () { return {}; }); })
    .then(function (res) {
      if (res && res.error) {
        upd.running = false;
        upd.text = res.error;
        upd.cls = "bad";
        paintUpdate();
        return;
      }
      followUpdate();
    })["catch"](function () {
      upd.running = false;
      upd.text = "starten mislukt";
      upd.cls = "bad";
      paintUpdate();
    });
});

/* ── scrollknoppen ─────────────────────────────────────────────────────────
   De lijsten zijn hoger dan het vlak waarin ze staan — instellingen toont ~3,5
   van de 7 rijen — en de scrollbalk is verborgen. Twee chevrons per lijst
   schuiven rij voor rij, zodat je niet hoeft te slepen op een rij vol knoppen.
   Ingedrukt houden herhaalt: het verbindingsscherm kan 40 netwerken tonen. */

var HOLD_START = 400;    // ms voordat het herhalen begint
var HOLD_STEP = 120;     // ms tussen de herhalingen

function navButtons(id) {
  return [].slice.call(document.querySelectorAll('[data-scroll="' + id + '"]'));
}

/** Verberg de knoppen als de lijst past; dim ze aan het begin en het eind. */
function syncNav(id) {
  var sc = $(id);
  if (!sc) return;
  var max = sc.scrollHeight - sc.clientHeight;
  var can = max > 1;
  navButtons(id).forEach(function (b) {
    b.style.display = can ? "flex" : "none";
    var atEnd = +b.dataset.dir < 0 ? sc.scrollTop <= 1 : sc.scrollTop >= max - 1;
    b.classList.toggle("off", can && atEnd);
  });
}

/**
 * Spring naar de volgende of vorige rijgrens. Mikken op rijgrenzen in plaats
 * van op een vast aantal pixels, want een melding met lange tekst is hoger
 * dan de 56 px van een gewone rij.
 */
function stepScroll(id, dir) {
  var sc = $(id);
  if (!sc) return;
  var kids = sc.children;
  var y = sc.scrollTop;
  var target = null;
  if (dir > 0) {
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].offsetTop > y + 1) { target = kids[i].offsetTop; break; }
    }
    if (target === null) target = sc.scrollHeight;
  } else {
    for (var j = kids.length - 1; j >= 0; j--) {
      if (kids[j].offsetTop < y - 1) { target = kids[j].offsetTop; break; }
    }
    if (target === null) target = 0;
  }
  // Geen behavior:"smooth" — een geanimeerde scroll van 300 ms is te zwaar
  // voor de trage SPI-display.
  sc.scrollTop = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, target));
  syncNav(id);
}

(function bindNav() {
  var held = null;
  var stop = function () {
    if (!held) return;
    clearTimeout(held.timer);
    held.btn.classList.remove("hit");
    held = null;
  };
  [].slice.call(document.querySelectorAll("[data-scroll]")).forEach(function (b) {
    var id = b.dataset.scroll, dir = +b.dataset.dir;
    b.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (b.classList.contains("off")) return;
      stop();
      b.classList.add("hit");
      stepScroll(id, dir);
      var repeat = function () {
        stepScroll(id, dir);
        if (b.classList.contains("off")) { stop(); return; }
        if (held) held.timer = setTimeout(repeat, HOLD_STEP);
      };
      held = { btn: b, timer: setTimeout(repeat, HOLD_START) };
    });
    b.addEventListener("pointerup", stop);
    b.addEventListener("pointercancel", stop);
    b.addEventListener("pointerleave", stop);
  });
  ["setlist", "netlist", "noticelist"].forEach(function (id) {
    var sc = $(id);
    // Ook na slepen met de vinger moeten de knoppen kloppen.
    if (sc) sc.addEventListener("scroll", function () { syncNav(id); }, { passive: true });
  });
})();

/* ── schermtoetsenbord ─────────────────────────────────────────────────────
   AZERTY. Chromium op desktop-Linux heeft geen eigen aanraaktoetsenbord, dus
   zonder dit blok is een nieuw beveiligd wifi-netwerk niet te koppelen. */

var SHIFT_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5L4 12h4v7h8v-7h4L12 3.5z"/></svg>';
var BACK_SVG = '<svg viewBox="0 0 24 24" width="22" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5h13v14H8L2 12 8 5z"/><path d="M12 9.5l5 5M17 9.5l-5 5"/></svg>';

/* Elke laag heeft dezelfde vorm: 10 / 10 / 6 tekens plus een brede toets aan
   weerszijden, zodat de toetsen niet verspringen als je van laag wisselt. */
var LAYERS = [
  [
    ["a", "z", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["q", "s", "d", "f", "g", "h", "j", "k", "l", "m"],
    [{ t: "shift" }, "w", "x", "c", "v", "b", "n", { t: "back" }],
    [{ t: "mode", to: 1, label: "?123" }, { t: "space" }, { t: "go" }]
  ],
  [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["-", "/", ":", ";", "(", ")", "€", "&", "@", "\""],
    [{ t: "mode", to: 2, label: "#+=" }, ".", ",", "?", "!", "'", "`", { t: "back" }],
    [{ t: "mode", to: 0, label: "ABC" }, { t: "space" }, { t: "go" }]
  ],
  [
    ["[", "]", "{", "}", "<", ">", "\\", "|", "~", "^"],
    ["%", "*", "+", "=", "_", "§", "£", "$", "°", "#"],
    [{ t: "mode", to: 1, label: "123" }, "«", "»", "¦", "¤", "¥", "±", { t: "back" }],
    [{ t: "mode", to: 0, label: "ABC" }, { t: "space" }, { t: "go" }]
  ]
];

var MAX_SHOWN = 30;                 // wat er in het veld past
var kb = { open: false, value: "", layer: 0, shift: 0, masked: true, onDone: null, confirm: "Verbind" };

function kbPaint() {
  var v = $("kbdval");
  var s = kb.value;
  var shown = s.length > MAX_SHOWN ? s.slice(-MAX_SHOWN) : s;
  var lead = s.length > MAX_SHOWN ? "…" : "";
  if (!s) {
    v.className = "empty";
    v.textContent = "Wachtwoord";
  } else {
    v.className = "";
    v.textContent = lead + (kb.masked ? new Array(shown.length + 1).join("•") : shown);
  }
  $("kbdeye").classList.toggle("on", !kb.masked);
}

function kbRender() {
  var box = $("kbdkeys");
  box.innerHTML = "";
  var rows = LAYERS[kb.layer];
  for (var r = 0; r < rows.length; r++) {
    var row = document.createElement("div");
    row.className = "krow";
    for (var i = 0; i < rows[r].length; i++) {
      var spec = rows[r][i];
      var b = document.createElement("button");
      if (typeof spec === "string") {
        b.className = "key";
        b.dataset.ch = spec;
        b.textContent = kb.shift && kb.layer === 0 ? spec.toUpperCase() : spec;
      } else if (spec.t === "shift") {
        b.className = "key wide" + (kb.shift ? " on" : "");
        b.dataset.act = "shift";
        b.innerHTML = SHIFT_SVG;
      } else if (spec.t === "back") {
        b.className = "key wide";
        b.dataset.act = "back";
        b.innerHTML = BACK_SVG;
      } else if (spec.t === "mode") {
        b.className = "key mode";
        b.dataset.act = "mode";
        b.dataset.to = String(spec.to);
        b.textContent = spec.label;
      } else if (spec.t === "space") {
        b.className = "key space";
        b.dataset.ch = " ";
        b.textContent = "";
      } else {
        b.className = "key go";
        b.dataset.act = "go";
        b.textContent = kb.confirm;
      }
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  kbPaint();
}

function kbType(ch) {
  if (kb.value.length >= 63) return;      // bovengrens van een WPA-wachtwoord
  kb.value += (kb.shift && ch.length === 1) ? ch.toUpperCase() : ch;
  if (kb.shift === 1) { kb.shift = 0; kbRender(); return; }
  kbPaint();
}

function kbKey(act, node) {
  if (act === "shift") {
    /* Tik = één hoofdletter, nog een tik = vast. */
    kb.shift = kb.shift === 0 ? 1 : (kb.shift === 1 ? 2 : 0);
    kbRender();
  } else if (act === "back") {
    kb.value = kb.value.slice(0, -1);
    kbPaint();
  } else if (act === "mode") {
    kb.layer = +node.dataset.to;
    kb.shift = 0;
    kbRender();
  } else if (act === "go") {
    var done = kb.onDone, value = kb.value;
    closeKeyboard();
    if (done) done(value);
  }
}

function openKeyboard(opts) {
  kb.open = true;
  kb.value = "";
  kb.layer = 0;
  kb.shift = 0;
  kb.masked = true;
  kb.onDone = opts.onDone || null;
  kb.confirm = opts.confirm || "Verbind";
  $("kbdtitle").textContent = opts.title || "Wachtwoord";
  kbRender();
  $("kbd").classList.add("on");
}

function closeKeyboard() {
  kb.open = false;
  kb.value = "";                          // het wachtwoord blijft niet hangen
  kb.onDone = null;
  $("kbd").classList.remove("on");
  kbPaint();
}

$("kbdkeys").addEventListener("pointerdown", function (e) {
  var b = e.target.closest(".key");
  if (!b) return;
  e.preventDefault();
  b.classList.add("hit");
  setTimeout(function () { b.classList.remove("hit"); }, 90);
  if (b.dataset.act) kbKey(b.dataset.act, b);
  else kbType(b.dataset.ch);
});
$("kbdclose").addEventListener("pointerdown", function (e) { e.preventDefault(); closeKeyboard(); });
$("kbdeye").addEventListener("pointerdown", function (e) {
  e.preventDefault();
  kb.masked = !kb.masked;
  kbPaint();
});

/* Hangt er een USB-toetsenbord aan tijdens het opbouwen, dan werkt dat ook. */
document.addEventListener("keydown", function (e) {
  if (!kb.open) return;
  if (e.key === "Enter") { kbKey("go"); }
  else if (e.key === "Backspace") { kbKey("back"); }
  else if (e.key === "Escape") { closeKeyboard(); }
  else if (e.key.length === 1) { kb.value += e.key; kbPaint(); }
  else return;
  e.preventDefault();
});

/* ── verbindingen ──────────────────────────────────────────────────────── */
function netStatus(it) {
  if (net.busy === it.id) return "verbinden…";
  if (net.error && net.error.id === it.id) return net.error.msg;
  if (it.active) return "verbonden";
  if (net.tab === "bt") return it.known ? "gekoppeld" : "koppelen";
  return (it.secured && !it.known) ? "beveiligd" : "verbind";
}

function renderNet() {
  var items = net.items[net.tab] || [];
  var list = $("netlist");
  var html = "";

  /* Bovenaan de bluetooth-lijst een rij die zegt of we aan het zoeken zijn en
     waarmee je opnieuw kunt zoeken. Als knop in de kop erbij paste het niet —
     die rij heeft al twee tabs, twee scrollpijlen en een sluitknop — en hier
     staat hij bovendien waar je kijkt als je een apparaat mist. */
  if (net.tab === "bt") {
    html += '<button id="btscan" class="scanrow"' + (net.scanning ? " disabled" : "") + '>'
      + '<span class="nm"></span><span class="st"></span></button>';
  }

  if (!items.length && !net.scanning) {
    html += '<div id="netempty"></div>';
  } else {
    html += items.map(function (it) {
      return '<button data-id="' + encodeURIComponent(it.id) + '"' + (it.active ? ' class="sel"' : '') + '>'
        + '<span class="nm"></span><span class="st"></span></button>';
    }).join("");
  }
  list.innerHTML = html;

  if (net.tab === "bt") {
    var sc = $("btscan");
    sc.classList.toggle("busy", net.scanning);
    sc.querySelector(".nm").textContent = net.scanning ? "Zoeken naar apparaten…" : "Opnieuw zoeken";
    sc.querySelector(".st").textContent = net.scanErr || (net.scanning ? "even geduld" : "zoek");
  }
  if ($("netempty")) {
    $("netempty").textContent = net.tab === "wifi" ? "Geen netwerken gevonden" : "Niets gevonden";
  }
  [].slice.call(list.querySelectorAll("button[data-id]")).forEach(function (b, i) {
    var it = items[i];
    b.querySelector(".nm").textContent = it.name;
    b.querySelector(".st").textContent = netStatus(it);
  });
  syncNav("netlist");
}

function fetchNetList(scan) {
  var kind = net.tab;
  var url = "/net?kind=" + kind + (scan && kind === "bt" ? "&scan=1" : "");
  fetch(url, { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw 0;
    return r.json();
  }).then(function (j) {
    net.items[kind] = j.items || [];
    if (kind === "bt") {
      net.scanning = !!j.scanning;
      net.scanErr = j.error || "";
    }
    if (net.tab === kind) { renderNet(); pollScan(); }
  })["catch"](function () {
    net.items[kind] = [];
    if (kind === "bt") { net.scanning = false; net.scanErr = ""; }
    if (net.tab === kind) renderNet();
  });
}

/* Zoeken duurt een seconde of twaalf en apparaten komen er één voor één bij,
   dus tijdens het zoeken halen we de lijst gewoon opnieuw op. Zodra de server
   zegt dat hij klaar is stopt dat vanzelf. */
function pollScan() {
  clearTimeout(net.scanTimer);
  net.scanTimer = null;
  if (!net.scanning || net.tab !== "bt" || !$("net").classList.contains("on")) return;
  net.scanTimer = setTimeout(function () { fetchNetList(false); }, 2000);
}

function stopScanPoll() {
  clearTimeout(net.scanTimer);
  net.scanTimer = null;
}

function openNet(tab) {
  net.tab = tab;
  net.scanErr = "";
  $("net").classList.add("on");
  $("segwifi").classList.toggle("on", tab === "wifi");
  $("segbt").classList.toggle("on", tab === "bt");
  stopScanPoll();
  renderNet();
  syncNav("netlist");              // pas meten als het scherm zichtbaar is
  /* Bluetooth begint meteen te zoeken, net als wifi. Ook als er al iets
     verbonden is — dat is juist het moment waarop je iets anders zoekt. */
  fetchNetList(tab === "bt");
}

function pickNet(id) {
  var items = net.items[net.tab] || [];
  var it = null;
  for (var i = 0; i < items.length; i++) if (items[i].id === id) it = items[i];
  if (!it || net.busy) return;

  if (it.active) return sendNet(it, false, null);          // verbonden → verbreken
  /* Beveiligd en nog niet gekoppeld: eerst het wachtwoord vragen. */
  if (net.tab === "wifi" && it.secured && !it.known) return askPassword(it);
  sendNet(it, true, null);
}

function askPassword(it) {
  openKeyboard({
    title: it.name,
    confirm: "Verbind",
    onDone: function (pw) {
      if (pw) sendNet(it, true, pw);
    }
  });
}

function sendNet(it, connect, password) {
  var id = it.id;
  net.busy = id;
  net.error = null;
  renderNet();
  var body = { kind: net.tab, id: id, name: it.name, connect: connect };
  if (password) body.password = password;
  fetch("/net", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json()["catch"](function () { return {}; }); })
    .then(function (res) {
      net.busy = "";
      /* Mislukt het, dan blijft dat op de rij zelf staan tot de volgende
         poging — en gaat het toetsenbord opnieuw open als het aan het
         wachtwoord lag. */
      if (res && res.error) net.error = { id: id, msg: res.error };
      fetchNetList();
      fetchWifi();
      fetchBt();
      if (res && res.needsPassword && net.tab === "wifi") askPassword(it);
    })["catch"](function () {
      net.busy = "";
      net.error = { id: id, msg: "mislukt" };
      renderNet();
    });
}

$("segwifi").addEventListener("pointerdown", function (e) { e.preventDefault(); openNet("wifi"); });
$("segbt").addEventListener("pointerdown", function (e) { e.preventDefault(); openNet("bt"); });
$("netclose").addEventListener("pointerdown", function (e) {
  e.preventDefault(); stopScanPoll(); $("net").classList.remove("on");
});

/* Een tik selecteert alleen als de vinger < 10 px beweegt — scrollen
   selecteert dus niets. */
var nd = null;
$("netlist").addEventListener("pointerdown", function (e) {
  var b = e.target.closest("[data-id]");
  if (b) { nd = { x: e.clientX, y: e.clientY, id: decodeURIComponent(b.dataset.id) }; return; }
  var s = e.target.closest("#btscan");
  nd = s && !s.disabled ? { x: e.clientX, y: e.clientY, scan: true } : null;
});
$("netlist").addEventListener("pointerup", function (e) {
  var d = nd; nd = null;
  if (!d || Math.abs(e.clientY - d.y) > 10 || Math.abs(e.clientX - d.x) > 10) return;
  if (d.scan) {
    net.scanning = true;             // meteen zichtbaar, de server bevestigt zo
    net.scanErr = "";
    renderNet();
    return fetchNetList(true);
  }
  pickNet(d.id);
});
$("netlist").addEventListener("pointercancel", function () { nd = null; });

/* ── render ────────────────────────────────────────────────────────────── */
var cacheT = {}, cacheS = {};
function txt(id, s) { if (cacheT[id] !== s) { cacheT[id] = s; $(id).textContent = s; } }
function wide(id, pct) {
  pct = Math.max(0, Math.min(100, pct || 0)).toFixed(0) + "%";
  if (cacheS["w" + id] !== pct) { cacheS["w" + id] = pct; $(id).style.width = pct; }
}
function cls(id, c) { if (cacheS["c" + id] !== c) { cacheS["c" + id] = c; $(id).className = c; } }
function tempCls(v) { return v >= cfg.tempCrit ? "crit" : (v >= cfg.tempWarn ? "warn" : ""); }
function batCls(v) { return v < 10 ? "crit" : (v < 20 ? "warn" : ""); }
function n(v, d) { return (typeof v === "number" && isFinite(v) ? v : 0).toFixed(d || 0); }

function paint() {
  if (MODE === "demo") last = demoTick();
  var d = last;
  if (!d) return;

  checkAlarm(d);
  paintNotice(d);
  paintCharge(d);
  applyTheme(false);

  var nw = new Date();
  txt("clock", ("0" + nw.getHours()).slice(-2) + ":" + ("0" + nw.getMinutes()).slice(-2));
  txt("stxt", MODE === "live" ? "verbonden" : (MODE === "off" ? "geen vesc" : "demo"));
  cls("dot", MODE === "live" ? "" : (MODE === "off" ? "off" : "demo"));

  /* Zodra de echte VESC-data binnenkomt vervalt alles wat de demo-rit heeft
     opgebouwd — anders staat er een verzonnen topsnelheid op het scherm.
     De Pi bewaart de echte waarde, dus daar vallen we op terug. */
  if (prevMode === "demo" && MODE !== "demo") {
    topSpeed = bootTopSpeed;
    cacheT = {}; cacheS = {};
  }
  prevMode = MODE;

  /* Topsnelheid loopt door op elk scherm, niet alleen op het rit-scherm. */
  if (typeof d.speed_kmh === "number" && isFinite(d.speed_kmh)) {
    topSpeed = Math.max(topSpeed, d.speed_kmh);
  }
  var bp = d.battery_pct;

  if (view === 0) {
    txt("vmaxtxt", n(topSpeed));
    txt("speed", n(d.speed_kmh));
    wide("speedbar", d.speed_kmh / cfg.speedMax * 100);

    var lvl = bp <= 15 ? " empty" : (bp <= 30 ? " low" : "");
    cls("batcard", "card" + lvl);
    cls("rangecard", "card" + lvl);
    txt("bat", n(bp));
    wide("batbar", bp);

    var whkm = d.trip_km > 0.3 ? d.wh_used / d.trip_km : cfg.whPerKm;
    var range = Math.max(0, cfg.packWh * bp / 100) / Math.max(5, whkm);
    txt("range", n(range, 1));
  } else if (view === 1) {
    txt("tm", n(d.temp_motor));
    cls("tm", "v big " + tempCls(d.temp_motor));
    txt("tf", n(d.temp_fet));
    cls("tf", "v big " + tempCls(d.temp_fet));
    txt("duty", n(d.duty * 100));
    wide("dutybar", d.duty * 100);
    txt("im", n(d.motor_current, 1));
    txt("ib", n(d.battery_current, 1));
    txt("rpm", n(d.rpm));
  } else {
    var bc = batCls(bp);
    txt("vv", n(d.voltage, 1));
    txt("vc", n(d.cell_voltage, 2));
    txt("bat2", n(bp));
    cls("bat2", "v mid " + bc);
    wide("bat2bar", bp);
    cls("bat2bar", bc === "crit" ? "fill-crit" : (bc === "warn" ? "fill-warn" : ""));
    txt("wh", n(d.wh_used));
    txt("trip", n(d.trip_km, 1));
    txt("whkm", d.trip_km > 0.2 ? n(d.wh_used / d.trip_km, 1) : "—");
  }
}

/* ── start ─────────────────────────────────────────────────────────────── */
function boot(saved) {
  if (saved) {
    Object.keys(cfg).forEach(function (k) {
      if (typeof saved[k] === typeof cfg[k]) cfg[k] = saved[k];
    });
    if (saved.pollMs) POLL_MS = Math.max(80, saved.pollMs);
    if (typeof saved.topSpeed === "number") { topSpeed = bootTopSpeed = saved.topSpeed; }
  }
  /* Staat er een andere indeling opgeslagen, dan is dit de verkeerde pagina.
     Meteen doorsturen, vóór de timers gaan lopen. */
  if (cfg.layout !== PAGE_LAYOUT) { location.replace(layoutFile(cfg.layout)); return; }

  fitRotation();
  window.addEventListener("resize", fitRotation);

  applyTheme(true);
  renderSettings();
  show(cfg.start);

  poll();
  setInterval(poll, POLL_MS);
  setInterval(paint, RENDER_MS);
  paint();

  paintUpdate();
  fetchUpdate(false);
  setInterval(function () { fetchUpdate(false); }, 3600000);

  fetchWeather();
  setInterval(fetchWeather, 300000);
  fetchModem();
  setInterval(fetchModem, 10000);
  fetchWifi();
  fetchBt();
  setInterval(function () { fetchWifi(); fetchBt(); }, 10000);
}

fetch("/settings", { cache: "no-store" })
  .then(function (r) { if (!r.ok) throw 0; return r.json(); })
  .then(boot)["catch"](function () { boot(null); });
