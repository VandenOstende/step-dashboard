"use strict";
/**
 * Staat de cruisecontrol aan?
 *
 * De VESC vertelt het niet. In app_adc.c is cruise een hardwarepin
 * (`cc_button`, van de UART-TX- of ICU-pad), en die komt nergens de comms in;
 * `mc_interface_get_control_mode()`, dat op CONTROL_MODE_SPEED springt zodra
 * cruise aangrijpt, komt in heel comm/commands.c niet voor. Er is dus geen
 * pakket, geen veld, geen bit.
 *
 * Wat de firmware wél doet is dit:
 *
 *     if (current_mode && cc_button && fabsf(pwr) < 0.001) {
 *         ...
 *         mc_interface_set_pid_speed(pid_rpm);
 *
 * Gas op nul, terwijl de motor stroom blijft trekken en de snelheid vlak
 * blijft. Die combinatie komt verder nergens voor:
 *
 *   uitrollen   gas nul, nauwelijks stroom, snelheid zakt
 *   remmen      negatieve stroom
 *   rijden      gas boven nul
 *   cruise      gas nul, stroom loopt, snelheid staat stil
 *
 * Het is dus een gevolgtrekking en geen feit, en zo hoort hij zich ook te
 * gedragen: liever een keer missen dan iets beweren dat niet waar is. Vandaar
 * dat hij pas na een halve seconde aangaat en dat er een harde voorwaarde
 * vooraf staat — `supported`.
 *
 * `supported` wordt pas waar zodra de hendelspanning ooit boven de drempel is
 * geweest. Draait de ADC-app niet, dan blijft het gedecodeerde niveau altijd
 * nul en zou "gas nul terwijl er stroom loopt" continu waar zijn. Dan hoort er
 * niets beweerd te worden, en gebeurt dat ook niet.
 *
 * Dit werkt alleen bij een ADC-gashendel. app_ppm.c kent geen cruisecontrol;
 * de nunchuk wel, maar via COMM_GET_DECODED_CHUK en met andere logica.
 */

/* Onder deze erpm rijdt de step niet — dezelfde grens als in setup.js. */
const ERPM_RIJDT = 500;
/* Boven deze hendelspanning weten we dat er een ADC-hendel gelezen wordt. Een
   hendel in rust geeft rond 0,8 V; niets aangesloten geeft nul. */
const VOLT_HENDEL = 0.2;
/* Zoveel mag de hendel afwijken van nul en nog "losgelaten" heten. */
const GAS_LOS = 0.02;
/* Zoveel procent mag de snelheid schommelen en nog "vastgehouden" heten. */
const ERPM_VLAK = 0.04;
/* Over welk venster we die vlakheid bekijken. */
const VENSTER_MS = 500;
/* Uit gaat sneller dan aan: één rare meting mag niet laten knipperen, maar
   loslaten moet wel meteen te zien zijn. */
const LOS_MS = 200;

class Cruise {
  constructor(cfg) {
    const c = (cfg && cfg.cruise) || {};
    this.enabled = c.enabled !== false;
    this.minCurrentA = isFinite(c.minCurrentA) ? Number(c.minCurrentA) : 3;
    this.holdMs = isFinite(c.holdMs) ? Number(c.holdMs) : 600;
    this.supported = false;
    this.active = false;
    this.sinds = 0;        // wanneer de kandidaat begon, 0 = geen kandidaat
    this.losSinds = 0;     // wanneer hij ophield kandidaat te zijn
    this.venster = [];     // recente erpm's met hun tijdstip
  }

  /** Bij het wegvallen van de verbinding weten we weer niets. */
  reset() {
    this.supported = false;
    this.active = false;
    this.sinds = 0;
    this.losSinds = 0;
    this.venster = [];
  }

  /** Bleef de snelheid over het laatste halve seconde binnen de marge? */
  _vlak(erpm, nu) {
    this.venster.push({ t: nu, e: erpm });
    while (this.venster.length && nu - this.venster[0].t > VENSTER_MS) this.venster.shift();
    /* Nog te weinig geschiedenis: dan is er niets vast te stellen, en "niet
       vastgesteld" telt hier als "niet vlak". */
    if (this.venster.length < 3 || nu - this.venster[0].t < VENSTER_MS * 0.6) return false;
    let lo = Infinity, hi = -Infinity;
    for (const m of this.venster) { if (m.e < lo) lo = m.e; if (m.e > hi) hi = m.e; }
    const mid = Math.abs((lo + hi) / 2);
    return mid > 0 && (hi - lo) / mid <= ERPM_VLAK;
  }

  update(snap, nu) {
    if (!this.enabled || !snap) { this.reset(); return this.state(); }

    /* Geen antwoord op COMM_GET_DECODED_ADC: dan valt er niets af te leiden. */
    if (typeof snap.throttle !== "number") { this.reset(); return this.state(); }
    if ((snap.throttleVolt || 0) > VOLT_HENDEL) this.supported = true;

    const erpm = Math.abs(snap.erpm || 0);
    const vlak = this._vlak(erpm, nu);

    const kandidaat = this.supported
      && snap.throttle < GAS_LOS
      && erpm > ERPM_RIJDT
      && (snap.currentMotor || 0) > this.minCurrentA
      && vlak;

    if (kandidaat) {
      this.losSinds = 0;
      if (!this.sinds) this.sinds = nu;
      if (nu - this.sinds >= this.holdMs) this.active = true;
    } else {
      this.sinds = 0;
      if (this.active) {
        if (!this.losSinds) this.losSinds = nu;
        if (nu - this.losSinds >= LOS_MS) { this.active = false; this.losSinds = 0; }
      }
    }
    return this.state();
  }

  state() {
    return { active: this.active, supported: this.supported };
  }
}

module.exports = { Cruise, ERPM_RIJDT, VOLT_HENDEL, GAS_LOS, ERPM_VLAK, VENSTER_MS, LOS_MS };
