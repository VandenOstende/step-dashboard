"use strict";
/**
 * Rijmodi: ECO, SPORT, of wat je in config.json zet.
 *
 * De VESC heeft hier een commando voor dat precies hiervoor bedoeld is:
 *
 *   COMM_SET_MCCONF_TEMP        (48)  snelheidsgrenzen in erpm
 *   COMM_SET_MCCONF_TEMP_SETUP  (49)  snelheidsgrenzen in m/s
 *
 * Payload, overgenomen uit bldc/comm/commands.c:
 *
 *   u8   store, forward_can, ack, divide_by_controllers
 *   f32  l_current_min_scale, l_current_max_scale        0..1
 *   f32  min, max snelheid       (m/s bij 49, erpm bij 48)
 *   f32  l_min_duty, l_max_duty
 *   f32  l_watt_min, l_watt_max
 *   f32  l_in_current_min, l_in_current_max              optioneel
 *
 * Drie dingen maken dit bruikbaar op een schermpje aan een stuur:
 *
 * · store = 0. Het gaat naar het werkgeheugen van de VESC, niet naar flash.
 *   Er wordt niets in de controller overschreven, en een verkeerd profiel is
 *   weg zodra de step een keer uit gaat. Wij zetten dit nooit op 1: flash
 *   heeft een eindig aantal schrijfrondes en een halve schrijfactie kost je je
 *   motorconfiguratie.
 * · current_max_scale is een schaal van 0 tot 1 op wat er in VESC Tool staat,
 *   en de firmware klemt hem daar zelf ook op af. Er is dus geen manier waarop
 *   dit dashboard méér vermogen verzint dan jij hebt ingesteld.
 * · Het loopt over dezelfde seriële verbinding die er al is. Geen tweede
 *   schrijfpad, geen extra rechten.
 *
 * Wat het níet kan: de huidige waarden uit de VESC lezen. Dat zou het hele
 * mcconf-blok vergen en dat verschilt per firmwareversie. De regel "SPORT" is
 * daarom niet "geen grens" maar "jouw eigen getallen uit VESC Tool" — staan
 * die verkeerd in config.json, dan is SPORT verkeerd.
 *
 * De getallen worden hier omgezet naar bytes en verder nergens; vesc.js stuurt
 * ze alleen. Zo zijn ze te controleren zonder een poort, net als bij
 * wifiConnectPlan() voor nmcli.
 */

const COMM_SET_MCCONF_TEMP = 48;
const COMM_SET_MCCONF_TEMP_SETUP = 49;

/* Grenzen waar we sowieso binnen blijven, wat er ook in config.json staat. */
const DUTY_MAX = 0.95;          // hoger laat de firmware toch niet toe
const SPEED_ONBEGRENSD = 400;   // m/s — hoog genoeg om "geen grens" te betekenen
const WATT_ONBEGRENSD = 1e6;
const STROOM_ONBEGRENSD = 1e4;

const klem = (v, lo, hi, terug) => {
  const n = Number(v);
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : terug;
};

/**
 * Eén regel uit config.json naar iets waar we op kunnen rekenen. Ontbrekende
 * of onzinnige waarden vallen terug op "niet begrenzen" in plaats van op nul —
 * een vergeten veld hoort je step niet stil te zetten.
 */
function normaliseer(p) {
  if (!p || typeof p.name !== "string" || !p.name.trim()) return null;
  const getal = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  const speed = getal(p.speedMaxKmh);
  const watt = getal(p.wattMax);
  const stroom = getal(p.inCurrentMax);
  return {
    name: p.name.trim(),
    currentMinScale: klem(p.currentMinScale, 0, 1, 1),
    currentMaxScale: klem(p.currentMaxScale, 0, 1, 1),
    speedMaxKmh: speed !== null && isFinite(speed) && speed > 0 ? klem(speed, 1, 200, null) : null,
    dutyMax: klem(p.dutyMax, 0.05, DUTY_MAX, DUTY_MAX),
    wattMax: watt !== null && isFinite(watt) && watt > 0 ? klem(watt, 50, 100000, null) : null,
    inCurrentMax: stroom !== null && isFinite(stroom) && stroom > 0 ? klem(stroom, 1, 500, null) : null
  };
}

/** De lijst uit config.json, ontdaan van regels die nergens op slaan. */
function profiles(cfg) {
  const lijst = (cfg && cfg.modes && Array.isArray(cfg.modes.list)) ? cfg.modes.list : [];
  const uit = [];
  const gezien = new Set();
  for (const p of lijst) {
    const n = normaliseer(p);
    if (!n || gezien.has(n.name)) continue;
    gezien.add(n.name);
    uit.push(n);
  }
  return uit;
}

function findProfile(cfg, naam) {
  return profiles(cfg).find((p) => p.name === naam) || null;
}

/** km/u → erpm, met de stepgegevens uit config.json. */
function erpmVoor(kmh, step) {
  const omtrek = (step.wheelDiameterM || 0.254) * Math.PI;
  const wielRpm = (kmh / 3.6) / omtrek * 60;
  return wielRpm * (step.gearRatio || 1) * (step.polePairs || 15);
}

/**
 * Het pakket voor één profiel, of null als er niets te sturen valt.
 *
 * `setupOk` zegt of de setup-wizard van VESC Tool gedraaid heeft. Zo ja, dan
 * kan de snelheidsgrens in m/s en rekent de VESC hem zelf om met de wielmaat
 * die híj kent — dat is de betrouwbaarste weg. Zo nee, dan rekenen wij hem om
 * naar erpm met de waarden uit config.json, want dan staat er in de controller
 * niets bruikbaars.
 */
function buildProfilePacket(cfg, naam, setupOk) {
  if (!cfg || !cfg.modes || !cfg.modes.enabled) return null;
  const p = findProfile(cfg, naam);
  if (!p) return null;

  const setup = !!setupOk;
  const cmd = setup ? COMM_SET_MCCONF_TEMP_SETUP : COMM_SET_MCCONF_TEMP;

  let maxSpeed;
  if (p.speedMaxKmh === null) {
    maxSpeed = setup ? SPEED_ONBEGRENSD : erpmVoor(SPEED_ONBEGRENSD * 3.6, cfg.step || {});
  } else {
    maxSpeed = setup ? p.speedMaxKmh / 3.6 : erpmVoor(p.speedMaxKmh, cfg.step || {});
  }

  const velden = [
    p.currentMinScale,
    p.currentMaxScale,
    -maxSpeed,                                     // achteruit even ver als vooruit
    maxSpeed,
    -p.dutyMax,
    p.dutyMax,
    -(p.wattMax === null ? WATT_ONBEGRENSD : p.wattMax),
    p.wattMax === null ? WATT_ONBEGRENSD : p.wattMax,
    -(p.inCurrentMax === null ? STROOM_ONBEGRENSD : p.inCurrentMax),
    p.inCurrentMax === null ? STROOM_ONBEGRENSD : p.inCurrentMax
  ];

  /* store, forward_can, ack, divide_by_controllers.
     store blijft nul — zie de kop van dit bestand. */
  const extra = Buffer.alloc(4 + velden.length * 4);
  extra[0] = 0;
  extra[1] = 0;
  extra[2] = 1;      // ack: we willen weten of het aangekomen is
  extra[3] = 0;
  /* buffer_append_float32_auto in de firmware is bit voor bit IEEE-754 big
     endian — nagerekend, en er staat een test op. Vandaar writeFloatBE. */
  velden.forEach((v, i) => extra.writeFloatBE(v, 4 + i * 4));

  return { cmd, extra, profile: p };
}

module.exports = {
  buildProfilePacket, profiles, findProfile, normaliseer, erpmVoor,
  COMM_SET_MCCONF_TEMP, COMM_SET_MCCONF_TEMP_SETUP, DUTY_MAX
};
