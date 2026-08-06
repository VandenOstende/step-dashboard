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
 * dezelfde volgorde. Het verschil zit alleen in het kenmerk data-layout op
 * <body>: public/layout.css houdt de maatvoering voor beide indelingen vast
 * en dat kenmerk kiest welke helft telt. De vormtaal komt uit
 * public/styles/<stijl>.css en het gedrag uit public/app.js.
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

function page(titel, viewport, layout) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="${viewport}">
<title>${titel}</title>
<link rel="stylesheet" href="layout.css">
<link id="stylecss" rel="stylesheet" href="styles/windows.css">
</head>
<body data-layout="${layout}">
${body}
${painter}
</body>
</html>
`;
}

fs.writeFileSync(PUB + "index.html",
  page("Step Dashboard", "width=480,height=320,initial-scale=1,user-scalable=no", "Liggend"));
fs.writeFileSync(PUB + "portrait.html",
  page("Step Dashboard", "width=320,height=480,initial-scale=1,user-scalable=no", "Staand"));

/* Controle: elk id dat app.js aanraakt moet in de opmaak staan. */
const js = fs.readFileSync(PUB + "app.js", "utf8");
const ids = new Set();
for (const r of [/\$\("([^"]+)"\)/g, /getElementById\("([^"]+)"\)/g,
                 /txt\("([^"]+)"/g, /cls\("([^"]+)"/g, /wide\("([^"]+)"/g]) {
  for (const m of js.matchAll(r)) ids.add(m[1]);
}
const have = new Set([...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
/* Deze staan niet in layout-body.html: btscan/netempty maakt app.js zelf aan,
   root komt uit de opmaak hierboven en stylecss is de <link> in de <head>. */
const DYNAMIC = new Set(["btscan", "netempty", "root", "stylecss"]);
const missing = [...ids].filter((i) => !have.has(i) && !DYNAMIC.has(i));
console.log("ids die app.js aanraakt:", ids.size);
console.log("ontbreekt in de opmaak:", missing.length ? missing.join(", ") : "niets");
if (missing.length) process.exitCode = 1;
