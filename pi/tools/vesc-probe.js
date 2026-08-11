"use strict";
/**
 * Kijk wat de VESC over USB vertelt.
 *
 *   node tools/vesc-probe.js [/dev/ttyACM0]
 *
 * Zegt vooral of de setup-wizard van VESC Tool gedraaid heeft: levert de
 * controller zelf snelheid, afstand en accuniveau, dan hoeft dit dashboard
 * geen enkele fysieke constante te kennen. Doet hij dat niet, dan vertelt
 * dit script welke waarden je in config.json moet zetten.
 */

const { loadConfig } = require("../src/config");
const { Vesc } = require("../src/vesc");
const { Telemetry } = require("../src/telemetry");

const cfg = loadConfig();
if (process.argv[2]) cfg.vesc.port = process.argv[2];

const fakeState = {
  data: { trip: { distanceM: 0, wattHours: 0, valid: true } },
  get trip() { return this.data.trip; },
  patch(p) { Object.assign(this.data, p); }
};

const vesc = new Vesc(cfg.vesc);
const telemetry = new Telemetry(cfg, fakeState);

vesc.on("log", (m) => console.log("  " + m));
vesc.start();

console.log("VESC-probe — poort: " + (cfg.vesc.port || "automatisch zoeken"));
console.log("Wachten op data (5 s)…\n");

const fmt = (v, d) => (typeof v === "number" && isFinite(v) ? v.toFixed(d === undefined ? 2 : d) : "—");

setTimeout(() => {
  const snap = vesc.connected ? vesc.snapshot() : null;

  if (!snap) {
    console.log("\nGeen antwoord van een VESC.\n");
    console.log("Controleer:");
    console.log("  • zit de USB-kabel erin en staat de controller aan?");
    console.log("  • ls -l /dev/ttyACM*   — is het apparaat er?");
    console.log("  • groups               — zit je in de groep 'dialout'?");
    console.log("  • draait er geen VESC Tool die de poort bezet houdt?");
    vesc.stop();
    process.exit(1);
  }

  console.log("\n── ruwe waarden (COMM_GET_VALUES) ───────────────────────────");
  console.log("  pakspanning        " + fmt(snap.vIn, 1) + " V");
  console.log("  erpm               " + fmt(snap.erpm, 0));
  console.log("  duty               " + fmt(snap.duty * 100, 1) + " %");
  console.log("  motorstroom        " + fmt(snap.currentMotor, 2) + " A");
  console.log("  accustroom         " + fmt(snap.currentIn, 2) + " A");
  console.log("  motortemperatuur   " + fmt(snap.tempMotor, 1) + " °C");
  console.log("  FET-temperatuur    " + fmt(snap.tempFet, 1) + " °C");
  console.log("  verbruikt          " + fmt(snap.wattHours, 1) + " Wh");
  console.log("  tachometer         " + fmt(snap.tachometer, 0));
  console.log("  storing            " + (snap.fault || "geen"));

  const hasSetup = typeof snap.speedMs === "number";
  console.log("\n── setup-waarden (COMM_GET_VALUES_SETUP) ────────────────────");
  if (!hasSetup) {
    console.log("  Deze firmware beantwoordt COMM_GET_VALUES_SETUP niet.");
  } else {
    console.log("  snelheid           " + fmt(snap.speedMs * 3.6, 1) + " km/u");
    console.log("  afstand            " + fmt(snap.distanceM / 1000, 3) + " km");
    console.log("  accuniveau         " + fmt(snap.batteryLevel * 100, 1) + " %");
  }

  /* De gashendel. Cruisecontrol meldt de VESC niet; de app leidt het af uit
     deze waarde plus de motorstroom. Hier zie je of je hendel überhaupt
     gelezen wordt en welk niveau hij in rust geeft — dat zijn de getallen
     waarmee je cruise.minCurrentA afstelt. */
  console.log("\n── gashendel (COMM_GET_DECODED_ADC) ─────────────────────────");
  if (typeof snap.throttle !== "number") {
    console.log("  Deze firmware beantwoordt COMM_GET_DECODED_ADC niet.");
    console.log("  Cruisecontrol wordt dan niet herkend.");
  } else if ((snap.throttleVolt || 0) <= 0.2) {
    console.log("  niveau             " + fmt(snap.throttle * 100, 1) + " %");
    console.log("  spanning           " + fmt(snap.throttleVolt, 3) + " V");
    console.log("  Geen ADC-hendel in gebruik (spanning blijft nul), dus");
    console.log("  cruisecontrol is niet af te leiden.");
  } else {
    console.log("  niveau             " + fmt(snap.throttle * 100, 1) + " %");
    console.log("  spanning           " + fmt(snap.throttleVolt, 3) + " V");
    console.log("  Draai de hendel eens open en draai dit nog een keer: zo zie");
    console.log("  je het bereik. Cruisecontrol wordt herkend aan niveau nul");
    console.log("  terwijl de motorstroom boven cruise.minCurrentA blijft.");
  }

  const wizardOk = hasSetup && snap.batteryLevel > 0;
  console.log("\n── conclusie ────────────────────────────────────────────────");
  if (wizardOk) {
    console.log("  ✓ De setup-wizard is gedraaid: de VESC rekent snelheid,");
    console.log("    afstand en accuniveau zelf uit. Het blok \"step\" in");
    console.log("    config.json wordt niet gebruikt — alleen packWh, voor de");
    console.log("    bereikschatting, staat in de instellingen van de app.");
  } else {
    console.log("  ! De VESC levert geen bruikbare setup-waarden.");
    console.log("    Draai de setup-wizard in VESC Tool (wielmaat, poolparen,");
    console.log("    overbrenging, accucellen en -capaciteit) — dat is de");
    console.log("    nauwkeurigste route.");
    console.log("    Wil je dat niet, zet dan in config.json onder \"step\":");
    console.log("      polePairs       aantal magneetparen (magneten ÷ 2)");
    console.log("      wheelDiameterM  wieldiameter in meter (10\" = 0.254)");
    console.log("      gearRatio       motoromwentelingen per wielomwenteling");
    console.log("      batteryCells    cellen in serie");
    if (snap.vIn > 5) {
      const guess = Math.round(snap.vIn / 3.8);
      console.log("    Op " + fmt(snap.vIn, 1) + " V lijkt " + guess + "S waarschijnlijk"
        + " (" + fmt(snap.vIn / guess, 2) + " V per cel).");
    }
  }

  console.log("\n── zoals de UI het krijgt (/data) ───────────────────────────");
  console.log(JSON.stringify(telemetry.build(snap), null, 2));

  vesc.stop();
  process.exit(0);
}, 5000);
