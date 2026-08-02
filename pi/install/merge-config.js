"use strict";
/**
 * Vult ontbrekende sleutels aan in een bestaande config.json.
 *
 *   node merge-config.js <meegeleverd> <van jou>
 *
 * Zonder dit blijft een config van een oudere versie missen wat er later is
 * bijgekomen. De server merkt daar weinig van — die legt zijn defaults er toch
 * overheen — maar step-update is een shellscript dat het bestand rechtstreeks
 * leest, en dat struikelt dan over een sleutel die er niet is.
 *
 * Bestaande waarden worden nooit aangeraakt; er wordt alleen toegevoegd.
 */

const fs = require("fs");

const [shipped, target] = process.argv.slice(2);
if (!shipped || !target) {
  console.error("gebruik: merge-config.js <meegeleverd> <van jou>");
  process.exit(2);
}

function merge(def, cur) {
  if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return cur;
  const out = Object.assign({}, cur);
  const added = [];
  for (const k of Object.keys(def)) {
    if (!(k in out)) {
      out[k] = def[k];
      added.push(k);
    } else if (def[k] && typeof def[k] === "object" && !Array.isArray(def[k])) {
      out[k] = merge(def[k], out[k]);
    }
  }
  merge.added = (merge.added || []).concat(added);
  return out;
}

let def, cur;
try {
  def = JSON.parse(fs.readFileSync(shipped, "utf8"));
} catch (err) {
  console.error("meegeleverde config onleesbaar: " + err.message);
  process.exit(1);
}
try {
  cur = JSON.parse(fs.readFileSync(target, "utf8"));
} catch (err) {
  // Kapot of leeg: dan is de meegeleverde versie beter dan niets, maar we
  // gooien het oude bestand niet zomaar weg.
  console.error("bestaande config onleesbaar (" + err.message + ") — back-up gemaakt");
  try { fs.copyFileSync(target, target + ".kapot"); } catch { /* niets */ }
  cur = {};
}

merge.added = [];
const out = merge(def, cur);

if (merge.added.length) {
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log("   config aangevuld met: " + merge.added.join(", "));
} else {
  console.log("   config is compleet");
}
