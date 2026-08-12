"use strict";
/**
 * Zet public/index.html samen uit de opmaak en de iconen.
 *
 *   node tools/build-page.js
 *
 *   tools/page.html   +   tools/icons/*.svg   →   public/index.html
 *
 * Waarom een bouwstap voor één pagina: de iconen. Het ontwerp gebruikt er 45
 * uit Phosphor, en die haalt het van unpkg. De Pi heeft geen internet, dus ze
 * moeten mee in het bestand. Ze met de hand in de opmaak plakken maakt die
 * onleesbaar en niet meer bij te werken; zo staan ze als losse SVG's in
 * tools/icons/ en wordt er één sprite van gemaakt.
 *
 * Ophalen deed ik met:
 *   https://raw.githubusercontent.com/phosphor-icons/core/main/assets/<variant>/<naam>.svg
 * Phosphor is MIT. In de opmaak gebruik je ze als:
 *   <svg class="ico"><use href="#i-gauge"></use></svg>        regular
 *   <svg class="ico"><use href="#i-warning-f"></use></svg>    fill
 *
 * Verder controleert dit script hetzelfde als zijn voorganger: elk id dat
 * app.js aanraakt moet in de opmaak staan. Dat is het net onder de trapeze —
 * een typefout in een id levert anders een stille, halve UI op.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const PUB = path.join(ROOT, "public");

/* ── de sprite ───────────────────────────────────────────────────────────── */
const ICO = path.join(ROOT, "tools", "icons");
const symbolen = [];
for (const f of fs.readdirSync(ICO).sort()) {
  if (!f.endsWith(".svg")) continue;
  const svg = fs.readFileSync(path.join(ICO, f), "utf8");
  const m = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!m) throw new Error("geen svg in " + f);
  const variant = f.startsWith("fill-") ? "fill" : "regular";
  const naam = f.replace(/^(regular|fill)-/, "").replace(/(-fill)?\.svg$/, "");
  const id = "i-" + naam + (variant === "fill" ? "-f" : "");
  symbolen.push('<symbol id="' + id + '" viewBox="0 0 256 256">' + m[1].trim() + "</symbol>");
}
const sprite = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">\n'
  + symbolen.join("\n") + "\n</svg>";

/* ── de pagina ───────────────────────────────────────────────────────────── */
const page = fs.readFileSync(path.join(ROOT, "tools", "page.html"), "utf8");
if (!page.includes("<!--ICONEN-->")) throw new Error("<!--ICONEN--> ontbreekt in page.html");
const uit = page.replace("<!--ICONEN-->", sprite);
fs.writeFileSync(path.join(PUB, "index.html"), uit);

/* ── controle: bestaat elk id dat app.js aanraakt? ───────────────────────── */
const js = fs.readFileSync(path.join(PUB, "app.js"), "utf8");
const ids = new Set();
for (const r of [/\$\("([^"]+)"\)/g, /getElementById\("([^"]+)"\)/g,
                 /txt\("([^"]+)"/g, /cls\("([^"]+)"/g, /icon\("([^"]+)"/g,
                 /show\("([^"]+)"/g, /hide\("([^"]+)"/g]) {
  for (const m of js.matchAll(r)) ids.add(m[1]);
}
const have = new Set([...uit.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
/* Deze maakt app.js zelf aan of ze horen bij de sprite. */
const DYNAMIC = new Set(["root"]);
const missing = [...ids].filter((i) => !have.has(i) && !DYNAMIC.has(i) && !i.startsWith("i-"));

/* ── controle: bestaat elk icoon dat aangeroepen wordt? ──────────────────── */
/* Een verkeerde naam levert een leeg vierkantje op: de <use> wijst nergens
   heen en de browser zegt er niets over. */
const spriteIds = new Set(symbolen.map((s) => s.match(/id="([^"]+)"/)[1]));
const gebruikt = new Set();
for (const m of uit.matchAll(/href="#(i-[^"]+)"/g)) gebruikt.add(m[1]);
/* In app.js komen iconen langs in ternairen en in tabellen; elke tekenreeks
   die met i- begint tellen is eenvoudiger dan elke vorm apart herkennen. */
for (const m of js.matchAll(/"(i-[a-z0-9-]+)"/g)) gebruikt.add(m[1]);
const geenIcoon = [...gebruikt].filter((i) => !spriteIds.has(i));
const ongebruikt = [...spriteIds].filter((i) => !gebruikt.has(i));

console.log("iconen:", symbolen.length, "· pagina:", Math.round(uit.length / 1024) + " kB");
console.log("ids die app.js aanraakt:", ids.size);
console.log("ontbreekt in de opmaak:", missing.length ? missing.join(", ") : "niets");
console.log("iconen zonder tekening:", geenIcoon.length ? geenIcoon.join(", ") : "niets");
if (ongebruikt.length) console.log("iconen die niemand gebruikt:", ongebruikt.join(", "));
if (missing.length || geenIcoon.length) process.exitCode = 1;
