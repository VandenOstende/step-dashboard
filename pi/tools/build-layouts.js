"use strict";
/**
 * Zet de twee indelingen samen uit één bron.
 *
 *   node tools/build-layouts.js
 *
 *   tools/layout-body.html  →  public/index.html    (liggend, 480 × 320)
 *                              public/portrait.html (staand,  320 × 480)
 *
 * De opmaak is voor allebei letterlijk hetzelfde — dezelfde element-id's,
 * dezelfde volgorde. De vormtaal staat in public/theme.css en het gedrag in
 * public/app.js, allebei gedeeld. Wat hier per indeling bijkomt is alleen
 * maatvoering: hoe groot de cijfers zijn en wat naast of onder elkaar staat.
 *
 * Twee handgeschreven pagina's zouden bij de eerste wijziging al uit elkaar
 * lopen, en dan werkt een knop in de ene indeling wel en in de andere niet.
 * Wijzig dus layout-body.html en draai dit script; de twee bestanden in
 * public/ zijn uitvoer.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const PUB = path.join(ROOT, "public") + path.sep;

const src = fs.readFileSync(path.join(ROOT, "tools", "layout-body.html"), "utf8");
const body = src.slice(src.indexOf('<div id="root">'));
if (!body.includes('id="speedbox"')) throw new Error("opmaak niet gevonden");

const painter = `<script src="app.js"></script>
<script>
"use strict";
/* Alleen de cellenrij op het accuscherm tekent deze pagina zelf; app.js zet
   tekst en breedtes, geen losse blokjes. */
(function () {
  var CELLEN = 13;
  var box = document.getElementById("cells");
  if (box) for (var i = 0; i < CELLEN; i++) box.appendChild(document.createElement("i"));

  function teken() {
    var d = window.last;
    if (!d || !box) return;
    var bp = d.battery_pct || 0;
    var kl = bp < 10 ? "crit" : (bp < 20 ? "warn" : "on");
    var vol = Math.round(bp / 100 * CELLEN);
    for (var i = 0; i < box.children.length; i++) box.children[i].className = i < vol ? kl : "";
  }
  function start() { teken(); setInterval(teken, 160); }
  if (window.last) start(); else setTimeout(start, 300);
})();
</script>`;

function page(titel, viewport, layout, css) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="${viewport}">
<title>${titel}</title>
<link rel="stylesheet" href="theme.css">
<style>
${css}
</style>
</head>
<body data-layout="${layout}">
${body}
${painter}
</body>
</html>
`;
}

/* ── liggend, 480 × 320 ──────────────────────────────────────────────────── */
const LIGGEND = `/* Maatvoering voor het liggende schermpje. De vormtaal staat in theme.css. */
#root{width:480px;height:320px}
#top{height:26px;gap:10px;padding:0 12px}
#statusbtn{height:26px}
#notice{height:28px;margin:6px 12px 0;padding:0 11px}

.pane{gap:8px;padding:8px 12px}

/* 1 · RIT — snelheid links, accu en bereik in een kolom ernaast. */
#p0{gap:8px}
#speedbox{flex:1;min-width:0;padding:10px 16px 12px;gap:8px}
#speed{font-size:100px;font-weight:600;line-height:.9;letter-spacing:-.035em}
#speedmeta{padding-bottom:9px}
#side{width:150px;flex:none;display:flex;flex-direction:column;gap:8px}
#side .card{flex:1}
#side .val{display:flex;align-items:baseline;gap:4px}
#side .n{font-size:38px;font-weight:600;line-height:1;letter-spacing:-.03em}
#side .u{font-size:13px;color:var(--text2)}

/* 2 · MOTOR — twee temperaturen boven, drie kleinere waarden eronder. */
#p1{flex-direction:column;gap:8px}
#temps{flex:1;min-height:0;display:flex;gap:8px}
#temps .card{flex:1}
#temps .val{display:flex;align-items:baseline;gap:4px}
#p1 .v.big{font-size:44px;font-weight:600;line-height:1;letter-spacing:-.03em}
#temps .u{font-size:13px;color:var(--text2)}
#motorrow{flex:none;display:flex;gap:8px}
#motorrow .card{flex:1;gap:6px}
#motorrow .val{display:flex;align-items:baseline;gap:4px}
#motorrow .n{font-size:23px;font-weight:600;line-height:1}
#motorrow .u{font-size:12px;color:var(--text2)}

/* 3 · ACCU — percentage links, de rest als lijst ernaast. */
#p2{flex-direction:column;gap:8px}
#packtop{flex:1;min-height:0;display:flex;gap:8px}
#packbig{flex:1;background:var(--card);border:1px solid var(--stroke);border-radius:var(--r-card);
  box-shadow:inset 0 1px 0 var(--stroke-top);padding:10px 14px;
  display:flex;flex-direction:column;justify-content:center;gap:9px}
#packnum{display:flex;align-items:baseline;gap:4px}
#bat2{font-size:62px;font-weight:600;line-height:1;letter-spacing:-.035em}
#packpct{font-size:18px;color:var(--text2)}
#cells{height:14px}
#packlist{width:188px;flex:none;display:flex;flex-direction:column;gap:5px}
#packlist .row{flex:1;display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:0 11px;background:var(--card);border:1px solid var(--stroke);border-radius:var(--r-ctl)}
#packlist .v{display:flex;align-items:baseline;gap:3px;font-size:17px;font-weight:600}
#packlist .u{font-size:11px;color:var(--text2)}

#dots{height:28px;padding:0 12px 4px}

.sheet{inset:26px 0 0;padding:8px 12px 10px}
.sheettitle{font-size:18px}
.xbtn{width:40px;height:32px}
#charge{inset:26px 0 0;padding:16px 24px}
#chargepct{font-size:88px}
#chargepct span+span{font-size:22px}
#chargetrack{width:300px}
#kbd{padding:8px}
.key.wide{flex:0 0 54px}
.key.mode{flex:0 0 60px;font-size:12px}
.key.go{flex:0 0 102px}
#power{padding:10px 12px 12px}
#powerclose{height:40px}
#alarm{padding:20px 28px}
#alarmhead svg{width:34px;height:34px}
#alarmtitle{font-size:32px}
#alarmmsg{font-size:18px}
#alarmclose{height:42px;min-width:170px;padding:0 20px;font-size:14px}`;

/* ── staand, 320 × 480 ───────────────────────────────────────────────────── */
const STAAND = `/* Maatvoering voor het staande schermpje. Staand is er meer hoogte dan
   breedte, dus alles wat liggend naast elkaar staat gaat hier onder elkaar —
   ook de knoppenrijen, want met een duim mik je daar beter op. */
#root{width:320px;height:480px}
#top{height:26px;gap:8px;padding:0 10px}
#statusbtn{height:26px}
#notice{height:28px;margin:6px 10px 0;padding:0 10px;font-size:12px}

.pane{flex-direction:column;gap:7px;padding:7px 10px}

/* 1 · RIT — de snelheid krijgt de volle breedte. */
#p0{gap:7px}
#speedbox{flex:1;min-height:0;padding:12px 14px 14px;gap:10px}
#speed{font-size:110px;font-weight:600;line-height:.88;letter-spacing:-.04em}
#speedmeta{padding-bottom:11px}
#speedunit{font-size:15px}
#side{flex:none;display:flex;flex-direction:column;gap:7px}
#side .card{padding:9px 13px}
#side .val{display:flex;align-items:baseline;gap:4px}
#side .n{font-size:34px;font-weight:600;line-height:1;letter-spacing:-.03em}
#side .u{font-size:13px;color:var(--text2)}
#batcard{gap:7px}
#rangecard{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}

/* 2 · MOTOR — temperaturen onder elkaar, de drie kleine waarden in een rij. */
#p1{gap:7px}
#temps{flex:1;min-height:0;display:flex;flex-direction:column;gap:7px}
#temps .card{flex:1}
#temps .val{display:flex;align-items:baseline;gap:4px}
#p1 .v.big{font-size:42px;font-weight:600;line-height:1;letter-spacing:-.03em}
#temps .u{font-size:13px;color:var(--text2)}
#motorrow{flex:none;display:flex;gap:7px}
#motorrow .card{flex:1;gap:5px;padding:8px 9px;min-width:0}
#motorrow .k{font-size:9.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#motorrow .val{display:flex;align-items:baseline;gap:3px}
#motorrow .n{font-size:19px;font-weight:600;line-height:1}
#motorrow .u{font-size:10px;color:var(--text2)}

/* 3 · ACCU — percentage boven, de lijst eronder. */
#p2{gap:7px}
/* packtop moet de hoogte pakken, anders heeft de lijst erin niets om over te
   verdelen en kruipen de rijen bovenin. */
#packtop{flex:1;min-height:0;display:flex;flex-direction:column;gap:7px}
#packbig{flex:none;background:var(--card);border:1px solid var(--stroke);border-radius:var(--r-card);
  box-shadow:inset 0 1px 0 var(--stroke-top);padding:11px 14px;
  display:flex;flex-direction:column;gap:9px}
#packnum{display:flex;align-items:baseline;gap:4px}
#bat2{font-size:60px;font-weight:600;line-height:1;letter-spacing:-.035em}
#packpct{font-size:17px;color:var(--text2)}
#cells{height:15px}
#packlist{flex:1;min-height:0;display:flex;flex-direction:column;gap:5px}
#packlist .row{flex:1;display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:0 12px;background:var(--card);border:1px solid var(--stroke);border-radius:var(--r-ctl)}
#packlist .v{display:flex;align-items:baseline;gap:3px;font-size:17px;font-weight:600}
#packlist .u{font-size:11px;color:var(--text2)}

#dots{height:30px;padding:0 10px 4px}

.sheet{inset:26px 0 0;padding:8px 10px 10px}
.sheettitle{font-size:17px}
.xbtn{width:40px;height:32px}
/* Drie knoppen naast elkaar passen niet met leesbare labels. */
.sysbtns{flex-direction:column;gap:6px}
.pbtn{height:46px}
/* Krap gemeten: "Temp waarschuwing" heeft de ruimte nodig die de smallere
   knoppen vrijmaken. */
.setrow{padding:0 11px;gap:5px}
.setrow .lbl{font-size:12px}
.seg{width:52px;height:30px;font-size:11.5px}
.seg.lay{width:70px}
.step{width:32px}
.setval{width:44px}
.setval.wide{width:52px}
#charge{inset:26px 0 0;padding:16px 20px}
#chargepct{font-size:92px}
#chargepct span+span{font-size:20px}
#chargetrack{width:100%}
/* Tien toetsen op 320 px geeft ~27 px breed. Smal, maar er is hoogte zat: de
   toetsen worden 58 px hoog en staan onderaan, waar je duim al is. */
#kbd{padding:8px}
#kbdkeys{flex:none;height:246px;margin-top:auto}
.key{font-size:16px}
.key.wide{flex:0 0 42px}
.key.mode{flex:0 0 48px;font-size:11px}
.key.go{flex:0 0 82px;font-size:11px}
#power{padding:10px}
#powerbtns{flex-direction:column;gap:8px}
#powerclose{height:44px}
#alarm{padding:18px 22px}
#alarmhead{flex-direction:column;gap:10px}
#alarmhead svg{width:40px;height:40px}
#alarmtitle{font-size:30px}
#alarmmsg{font-size:18px}
#alarmclose{height:46px;min-width:180px;padding:0 20px;font-size:14px}`;

fs.writeFileSync(PUB + "index.html",
  page("Step Dashboard", "width=480,height=320,initial-scale=1,user-scalable=no", "Liggend", LIGGEND));
fs.writeFileSync(PUB + "portrait.html",
  page("Step Dashboard", "width=320,height=480,initial-scale=1,user-scalable=no", "Staand", STAAND));

/* Controle: elk id dat app.js aanraakt moet in de opmaak staan. */
const js = fs.readFileSync(PUB + "app.js", "utf8");
const ids = new Set();
for (const r of [/\$\("([^"]+)"\)/g, /getElementById\("([^"]+)"\)/g,
                 /txt\("([^"]+)"/g, /cls\("([^"]+)"/g, /wide\("([^"]+)"/g]) {
  for (const m of js.matchAll(r)) ids.add(m[1]);
}
const have = new Set([...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const DYNAMIC = new Set(["btscan", "netempty", "root"]);
const missing = [...ids].filter((i) => !have.has(i) && !DYNAMIC.has(i));
console.log("ids die app.js aanraakt:", ids.size);
console.log("ontbreekt in de opmaak:", missing.length ? missing.join(", ") : "niets");
if (missing.length) process.exitCode = 1;
