"use strict";
/**
 * Buitentemperatuur voor uiterst links in de topbalk.
 *
 * Locatie: bij voorkeur uit config.json, anders van de modem (5G) via
 * `mmcli --location-get`. Weer: Open-Meteo, dat geen sleutel vraagt.
 * Zonder netwerk faalt dit endpoint netjes en laat de UI het veld leeg.
 */

const { modemLocation } = require("./system");

const CACHE_MS = 10 * 60 * 1000;
const GEO_CACHE_MS = 60 * 60 * 1000;

class Weather {
  constructor(cfg) {
    this.cfg = cfg.weather || {};
    this.cache = null;
    this.cachedAt = 0;
    this.loc = null;
    this.locAt = 0;
    this.pending = null;
  }

  async _location() {
    if (isFinite(this.cfg.latitude) && isFinite(this.cfg.longitude)
      && this.cfg.latitude !== null && this.cfg.longitude !== null) {
      return { latitude: this.cfg.latitude, longitude: this.cfg.longitude };
    }
    if (this.loc && Date.now() - this.locAt < GEO_CACHE_MS) return this.loc;
    const loc = await modemLocation();
    if (loc) { this.loc = loc; this.locAt = Date.now(); }
    return loc;
  }

  async get() {
    if (this.cache && Date.now() - this.cachedAt < CACHE_MS) return this.cache;
    if (this.pending) return this.pending;

    this.pending = (async () => {
      const loc = await this._location();
      if (!loc) throw new Error("geen locatie");
      const url = "https://api.open-meteo.com/v1/forecast"
        + "?latitude=" + encodeURIComponent(loc.latitude)
        + "&longitude=" + encodeURIComponent(loc.longitude)
        + "&current=temperature_2m";
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const j = await res.json();
        const t = j && j.current && j.current.temperature_2m;
        if (typeof t !== "number") throw new Error("geen temperatuur");
        // Open-Meteo doet geen reverse geocoding; de plaatsnaam komt uit
        // config.json (weather.place) en blijft anders leeg.
        const out = { temp_c: t, place: this.cfg.place || "" };
        this.cache = out;
        this.cachedAt = Date.now();
        return out;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => { this.pending = null; });

    return this.pending;
  }
}

module.exports = { Weather };
