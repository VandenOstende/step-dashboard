"use strict";
/**
 * Herkennen dat de accu wordt opgeladen, en schatten hoe lang het nog duurt.
 *
 * Het lastige: een gewone acculader hangt rechtstreeks aan de accu, niet via
 * de VESC. De controller ziet dus geen laadstroom — alleen dat de pakspanning
 * omhoog kruipt. Daarom kijken we naar twee dingen:
 *
 *   1. de pakspanning stijgt terwijl de step stilstaat, of
 *   2. er loopt stroom de accu ín via de controller (negatieve accustroom),
 *      wat gebeurt bij regeneratief remmen of een lader áchter de VESC.
 *
 * De schatting komt uit een rechte lijn door het verloop van het
 * accupercentage. Die is de eerste minuten onbetrouwbaar en wordt daarna
 * beter; zolang we het niet weten, zeggen we dat ook in plaats van een getal
 * te verzinnen.
 */

const HIST_MS = 20 * 60 * 1000;   // zoveel geschiedenis houden we vast
const SAMPLE_MS = 5000;           // en zo vaak nemen we een monster
/* Twee vensters, want er zijn twee dingen te zien. Bij het aansluiten springt
   de klemspanning meteen een paar tienden omhoog — dat is binnen een minuut
   te zien. Daarna kruipt hij langzaam door: een 13S-pak dat in vijf uur vol
   is stijgt zo'n 0,035 V per minuut, en de VESC meldt spanning in stappen van
   0,1 V. Daar is een venster van vijf minuten voor nodig. */
const STEP_MS = 60 * 1000;
const STEP_V = 0.2;               // sprong bij het aansluiten
const DETECT_MS = 300 * 1000;
const RISE_V = 0.12;              // trage stijging tijdens het laden
const CHARGE_A = -0.3;            // accustroom die als laden telt (A, negatief)
const STOP_MS = 150 * 1000;       // zolang zonder signaal → niet meer aan het laden
const MOVING_KMH = 2;             // hierboven rijd je, dan laad je niet
const MIN_SPAN_MS = 3 * 60 * 1000; // zoveel geschiedenis voor een schatting
const FULL_PCT = 99.5;

class Charge {
  constructor() {
    this.hist = [];
    this.charging = false;
    this.since = null;
    this.session = 0;
    this.lastSignal = 0;
    this.lastSample = 0;
  }

  reset() {
    this.hist = [];
    this.charging = false;
    this.since = null;
    this.lastSignal = 0;
  }

  /** Spanningsverschil over een venster; 0 als we te weinig geschiedenis hebben. */
  _riseOver(now, win) {
    if (this.hist.length < 2) return 0;
    const cutoff = now - win;
    let oldest = null;
    for (const s of this.hist) {
      if (s.t >= cutoff) { oldest = s; break; }
    }
    if (!oldest) oldest = this.hist[0];
    const newest = this.hist[this.hist.length - 1];
    if (newest.t - oldest.t < win * 0.5) return 0;
    return newest.v - oldest.v;
  }

  /**
   * Minuten tot vol, via een kleinste-kwadratenlijn door het percentage.
   * null als we het nog niet kunnen zeggen.
   */
  _eta(now, pct) {
    if (pct >= FULL_PCT) return 0;
    const from = this.since || 0;
    const pts = this.hist.filter((s) => s.t >= from);
    if (pts.length < 3) return null;
    const span = pts[pts.length - 1].t - pts[0].t;
    if (span < MIN_SPAN_MS) return null;

    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    const t0 = pts[0].t;
    for (const p of pts) {
      const x = (p.t - t0) / 60000;    // minuten
      sx += x; sy += p.pct; sxx += x * x; sxy += x * p.pct;
    }
    const n = pts.length;
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) return null;
    const slope = (n * sxy - sx * sy) / denom;   // procent per minuut
    if (slope <= 0.005) return null;             // staat praktisch stil
    const mins = (100 - pct) / slope;
    if (!isFinite(mins) || mins < 0 || mins > 24 * 60) return null;
    return Math.round(mins);
  }

  /**
   * @param d   het datacontract zoals de UI het krijgt
   * @param now tijd in ms
   */
  update(d, now) {
    if (!d || !d.connected) {
      this.reset();
      return this.state(null);
    }

    const pct = d.battery_pct || 0;
    const v = d.voltage || 0;
    const moving = (d.speed_kmh || 0) > MOVING_KMH;

    if (moving) {
      // Rijden sluit laden uit; begin schoon aan de volgende laadbeurt.
      if (this.charging) this.reset();
      else { this.hist = []; this.lastSignal = 0; }
      return this.state(pct);
    }

    if (now - this.lastSample >= SAMPLE_MS) {
      this.lastSample = now;
      this.hist.push({ t: now, pct: pct, v: v });
      while (this.hist.length && this.hist[0].t < now - HIST_MS) this.hist.shift();
    }

    const rising = this._riseOver(now, STEP_MS) >= STEP_V
      || this._riseOver(now, DETECT_MS) >= RISE_V;
    const drawing = (d.battery_current || 0) <= CHARGE_A;
    const signal = rising || drawing;

    if (signal) this.lastSignal = now;

    if (!this.charging && signal) {
      this.charging = true;
      this.since = now;
      this.session++;
      // De geschiedenis van vóór het aansluiten zegt niets over deze beurt.
      this.hist = this.hist.filter((s) => s.t >= now - DETECT_MS);
    } else if (this.charging && this.lastSignal && now - this.lastSignal > STOP_MS) {
      // Bij vol worden stopt de stijging ook; dan blijft "vol" staan tot je rijdt.
      if (pct < FULL_PCT) this.reset();
    }

    return this.state(pct);
  }

  state(pct) {
    return {
      charging: this.charging,
      session: this.session,
      since: this.since,
      full: this.charging && pct != null && pct >= FULL_PCT,
      etaMin: this.charging && pct != null ? this._eta(this.lastSample, pct) : null
    };
  }
}

module.exports = { Charge, FULL_PCT };
