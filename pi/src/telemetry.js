"use strict";
/**
 * Van ruwe VESC-waarden naar het data-contract dat de UI verwacht:
 *
 *   connected, speed_kmh, rpm, erpm, duty (0..1), battery_pct, voltage,
 *   cell_voltage, motor_current, battery_current, power_w, temp_motor,
 *   temp_fet, wh_used, trip_km
 *
 * Snelheid, afstand en accupercentage komen bij voorkeur uit de VESC zelf
 * (COMM_GET_VALUES_SETUP). Alleen als de firmware die niet levert — of als de
 * setup-wizard nooit gedraaid heeft en de waarden dus 0 blijven — rekenen we
 * ze hier uit met de constanten uit config.json.
 */

/* Ontlaadcurve van een li-ion-cel: celspanning → ladingspercentage.
   Alleen gebruikt als de VESC zelf geen accuniveau meldt. */
const CELL_CURVE = [
  [3.00, 0], [3.30, 5], [3.50, 12], [3.60, 20], [3.70, 32], [3.75, 42],
  [3.80, 52], [3.85, 62], [3.90, 70], [3.95, 77], [4.00, 84], [4.05, 90],
  [4.10, 95], [4.20, 100]
];

function pctFromCellVoltage(v) {
  if (!isFinite(v)) return 0;
  if (v <= CELL_CURVE[0][0]) return 0;
  const end = CELL_CURVE[CELL_CURVE.length - 1];
  if (v >= end[0]) return 100;
  for (let i = 1; i < CELL_CURVE.length; i++) {
    const [v1, p1] = CELL_CURVE[i];
    if (v <= v1) {
      const [v0, p0] = CELL_CURVE[i - 1];
      return p0 + (p1 - p0) * (v - v0) / (v1 - v0);
    }
  }
  return 100;
}

/** Aantal cellen in serie raden uit de pakspanning (dichtst bij 3,8 V/cel). */
function guessCells(vIn) {
  if (!isFinite(vIn) || vIn < 5) return null;
  let best = null, bestErr = Infinity;
  for (let n = 3; n <= 30; n++) {
    const err = Math.abs(vIn / n - 3.8);
    if (err < bestErr) { bestErr = err; best = n; }
  }
  return best;
}

class Telemetry {
  constructor(cfg, state) {
    this.cfg = cfg;
    this.state = state;
    this.cells = cfg.step.batteryCells || null;
    this.warnedNoSetup = false;
  }

  /** Meters afgelegd volgens de tachometer, als de VESC zelf niets meldt. */
  _distanceFromTacho(tacho) {
    const s = this.cfg.step;
    const poles = 2 * (s.polePairs || 15);
    const scale = (s.wheelDiameterM * Math.PI) / (3 * poles * (s.gearRatio || 1));
    return tacho * scale;
  }

  _speedFromErpm(erpm) {
    const s = this.cfg.step;
    const motorRpm = erpm / (s.polePairs || 15);
    const wheelRpm = motorRpm / (s.gearRatio || 1);
    return wheelRpm / 60 * (s.wheelDiameterM * Math.PI) * 3.6;   // km/u
  }

  /** Nulpunt van de rit-teller op de huidige stand zetten. */
  resetTrip(snap) {
    const raw = snap ? this._raw(snap) : { distanceM: 0, wattHours: 0 };
    this.state.patch({ trip: { distanceM: raw.distanceM, wattHours: raw.wattHours, valid: true } });
  }

  _raw(snap) {
    const hasSetup = typeof snap.distanceM === "number";
    return {
      distanceM: hasSetup ? snap.distanceM : this._distanceFromTacho(snap.tachometer || 0),
      wattHours: (snap.wattHours || 0) - (snap.wattHoursCharged || 0)
    };
  }

  offline() {
    return {
      connected: false,
      speed_kmh: 0, rpm: 0, erpm: 0, duty: 0,
      battery_pct: 0, voltage: 0, cell_voltage: 0,
      motor_current: 0, battery_current: 0, power_w: 0,
      temp_motor: 0, temp_fet: 0,
      wh_used: 0, trip_km: 0,
      fault: null
    };
  }

  build(snap) {
    if (!snap) return this.offline();

    const s = this.cfg.step;
    const vIn = snap.vIn || 0;

    if (!this.cells) this.cells = guessCells(vIn);
    const cells = this.cells || 1;

    /* Snelheid: liefst uit de VESC (m/s). Meldt die 0 terwijl de motor draait,
       dan is de setup-wizard nooit gedraaid en rekenen we het zelf uit. */
    let speedKmh;
    if (typeof snap.speedMs === "number" && (snap.speedMs !== 0 || !snap.erpm)) {
      speedKmh = snap.speedMs * 3.6;
    } else {
      speedKmh = this._speedFromErpm(snap.erpm || 0);
      if (typeof snap.speedMs === "number" && !this.warnedNoSetup) {
        this.warnedNoSetup = true;
        console.warn("[telemetry] de VESC meldt snelheid 0 terwijl de motor draait — "
          + "draai de setup-wizard in VESC Tool, of controleer step.* in config.json");
      }
    }

    /* Accupercentage: liefst het niveau dat de VESC zelf bijhoudt. */
    const cellV = cells ? vIn / cells : 0;
    let pct;
    if (typeof snap.batteryLevel === "number" && snap.batteryLevel > 0) {
      pct = snap.batteryLevel * 100;
    } else {
      pct = pctFromCellVoltage(cellV);
    }
    pct = Math.max(0, Math.min(100, pct));

    /* Rit-teller: verschil met het opgeslagen nulpunt. Draait de VESC opnieuw
       op, dan lopen zijn tellers terug naar nul en volgt het nulpunt mee. */
    const raw = this._raw(snap);
    const base = this.state.trip;
    if (!base.valid || raw.distanceM < base.distanceM - 1 || raw.wattHours < base.wattHours - 0.5) {
      this.state.patch({ trip: { distanceM: 0, wattHours: 0, valid: true } });
    }
    const b = this.state.trip;
    const tripKm = Math.max(0, (raw.distanceM - b.distanceM) / 1000);
    const whUsed = Math.max(0, raw.wattHours - b.wattHours);

    const erpm = snap.erpm || 0;
    return {
      connected: true,
      speed_kmh: Math.max(0, speedKmh),
      rpm: erpm / (s.polePairs || 15),
      erpm: erpm,
      duty: snap.duty || 0,
      battery_pct: pct,
      voltage: vIn,
      cell_voltage: cellV,
      motor_current: snap.currentMotor || 0,
      battery_current: snap.currentIn || 0,
      power_w: (snap.currentIn || 0) * vIn,
      temp_motor: snap.tempMotor || 0,
      temp_fet: snap.tempFet || 0,
      wh_used: whUsed,
      trip_km: tripKm,
      fault: snap.fault || null
    };
  }
}

module.exports = { Telemetry, pctFromCellVoltage, guessCells };
