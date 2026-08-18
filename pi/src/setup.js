"use strict";
/**
 * Weet de VESC hoe de step in elkaar zit?
 *
 * De setup-wizard van VESC Tool zet wielmaat, poolparen en overbrenging in de
 * controller. Is dat gebeurd, dan levert `COMM_GET_VALUES_SETUP` snelheid,
 * afstand en accuniveau kant-en-klaar en hoeft dit project niets te weten.
 * Is het níet gebeurd, dan komen daar nullen uit en rekent telemetry.js het
 * zelf uit met de constanten in config.json — die dan wel moeten kloppen.
 *
 * Dit bestand kijkt welke van de twee het is, en leidt in het eerste geval af
 * wat er af te leiden valt, zodat het in config.json terechtkomt:
 *
 *   status "ok"       de VESC meldt een snelheid terwijl de motor draait
 *   status "missing"  hij meldt nul terwijl de motor draait, of hij beantwoordt
 *                     het setup-pakket helemaal niet
 *   status "unknown"  de step heeft nog niet gereden, dus er valt niets te zien
 *
 * Waarom pas bij rijden: stilstaand melden een ingestelde en een niet-ingestelde
 * VESC allebei nul. Het verschil is alleen te zien terwijl de motor draait.
 *
 * Wat er af te leiden valt is één getal, geen drie. De VESC rekent
 *
 *   snelheid = erpm / poolparen / overbrenging / 60 × omtrek
 *
 * en wij zien alleen de linker- en de rechterkant. Poolparen, overbrenging en
 * wielmaat zijn daaruit niet los te trekken — hun combinatie wel. We houden
 * poolparen en overbrenging dus op wat er in config.json staat en lossen de
 * wielmaat op. Klopt die eerste twee, dan klopt de wielmaat ook; kloppen ze
 * niet, dan is de wielmaat een vervangende waarde die dezelfde snelheid
 * oplevert. Voor het uitrekenen van km/u maakt dat niets uit, en dat is
 * waarvoor het gebruikt wordt.
 *
 * Het aantal cellen komt uit de pakspanning en staat daar los van.
 */

const { guessCells } = require("./telemetry");

/* Onder deze erpm zegt een snelheid van nul niets — dan staat de step stil. */
const ERPM_DRAAIT = 500;
/* Zoveel bruikbare metingen voordat we een wielmaat durven op te schrijven.
   Eén meting kan een uitschieter zijn: erpm en snelheid komen uit twee
   verschillende pakketten en lopen bij het optrekken niet gelijk. */
const MONSTERS = 12;
/* Kleiner verschil dan dit schrijven we niet weg — anders wordt config.json
   bij elke rit opnieuw aangeraakt voor een halve millimeter. */
const AFWIJKING = 0.02;

function mediaan(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

class SetupWatch {
  constructor(cfg, bewaard) {
    this.cfg = cfg;
    /* Is de status ooit rijdend op "ok" gezet, dan hoeft dat niet elke boot
       opnieuw bewezen: hij start dan als "ok" en alleen een rit die het
       tegendeel laat zien haalt hem er weer af. */
    this.status = bewaard ? "ok" : "unknown";
    this.monsters = [];
    this.wheel = null;      // afgeleide wielmaat in meter
    this.cells = null;      // afgeleid aantal cellen in serie
    /* Hoogt op zodra er echt iets nieuws is afgeleid. De meetlus schrijft
       config.json alleen bij als deze teller verschoven is; zonder dat draait
       hij die vergelijking bij élke meting, voor altijd. */
    this.rev = 0;
    this._vLaatst = null;
  }

  /** Eén momentopname van de VESC bekijken. */
  observe(snap) {
    if (!snap) return;

    /* De VESC meldt de spanning in stappen van 0,1 V, dus het antwoord
       verandert bijna nooit — en guessCells is een lus van 28 stappen. */
    const v = snap.vIn || 0;
    if (v > 5 && v !== this._vLaatst) {
      this._vLaatst = v;
      const c = guessCells(v);
      if (c !== this.cells) { this.cells = c; this.rev++; }
    }

    /* Beantwoordt de firmware het setup-pakket niet, dan is er niets om op te
       wachten: dan moeten de constanten uit config.json komen. */
    if (typeof snap.speedMs !== "number") { this.status = "missing"; return; }

    const erpm = Math.abs(snap.erpm || 0);
    if (erpm < ERPM_DRAAIT) return;          // stilstaand zegt het niets

    const ms = Math.abs(snap.speedMs);
    if (ms < 0.1) { this.status = "missing"; return; }

    this.status = "ok";
    const s = this.cfg.step;
    const omtrek = ms * 60 * (s.polePairs || 15) * (s.gearRatio || 1) / erpm;
    const wiel = omtrek / Math.PI;
    /* Grenzen tegen onzin: een stepwiel is geen 4 cm en geen meter. */
    if (wiel > 0.08 && wiel < 0.8) {
      this.monsters.push(wiel);
      if (this.monsters.length > MONSTERS * 3) this.monsters.shift();
      if (this.monsters.length >= MONSTERS) {
        const w = mediaan(this.monsters);
        if (w !== this.wheel) { this.wheel = w; this.rev++; }
      }
    }
  }

  /** Wat er nu bekend is, in de vorm die config.json gebruikt. */
  derived() {
    const uit = {};
    if (this.wheel) uit.wheelDiameterM = Math.round(this.wheel * 10000) / 10000;
    if (this.cells) uit.batteryCells = this.cells;
    return uit;
  }

  /**
   * Wat er in config.json bijgeschreven moet worden, of null als er niets te
   * doen is. Alleen bij status "ok" — een VESC die het zelf niet weet heeft
   * ook niets te vertellen.
   */
  patch() {
    if (this.status !== "ok") return null;
    const d = this.derived();
    const s = this.cfg.step;
    const uit = {};
    if (d.wheelDiameterM
        && Math.abs(d.wheelDiameterM - s.wheelDiameterM) / s.wheelDiameterM > AFWIJKING) {
      uit.wheelDiameterM = d.wheelDiameterM;
    }
    if (d.batteryCells && d.batteryCells !== s.batteryCells) uit.batteryCells = d.batteryCells;
    return Object.keys(uit).length ? uit : null;
  }
}

module.exports = { SetupWatch, ERPM_DRAAIT, MONSTERS };
