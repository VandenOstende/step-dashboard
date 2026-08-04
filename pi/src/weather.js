"use strict";
/**
 * Buitentemperatuur voor uiterst links in de topbalk.
 *
 * De locatie komt uit drie bronnen, in deze volgorde:
 *
 *   1. config.json — weather.latitude / weather.longitude
 *   2. de gps van een 5G-modem, via `mmcli --location-get`
 *   3. het IP-adres, via een opzoekdienst (weather.ipFallback)
 *
 * Die derde is er omdat de meeste steps geen modem hebben en niemand zin
 * heeft om coördinaten in een bestand te typen. Hij levert meteen ook een
 * plaatsnaam, dus dan staat er "18° Gent" in plaats van alleen een getal.
 * Het weer zelf komt van Open-Meteo, dat geen sleutel vraagt.
 *
 * Zonder netwerk faalt dit endpoint netjes en laat de UI het veld leeg.
 */

const { modemLocation } = require("./system");

const CACHE_MS = 10 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;
const GEO_CACHE_MS = 60 * 60 * 1000;
const IP_URL = "https://ipwho.is/";

/* Uit elkaar getrokken zodat de test hem kan voeren zonder netwerk. Zowel
   ipwho.is als ipapi.co gebruiken deze veldnamen, dus je kunt weather.ipUrl
   naar de ander laten wijzen als er eentje plat ligt. */
function parseIpLocation(j) {
  if (!j || j.success === false) return null;
  const lat = parseFloat(j.latitude);
  const lon = parseFloat(j.longitude);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;   // "onbekend" verpakt als nulpunt
  return { latitude: lat, longitude: lon, place: String(j.city || "") };
}

async function fetchJson(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

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
      return { latitude: this.cfg.latitude, longitude: this.cfg.longitude, place: "" };
    }
    if (this.loc && Date.now() - this.locAt < GEO_CACHE_MS) return this.loc;

    let loc = await modemLocation();

    if (!loc && this.cfg.ipFallback !== false) {
      try {
        loc = parseIpLocation(await fetchJson(this.cfg.ipUrl || IP_URL, 8000));
      } catch {
        loc = null;   // geen net, of de dienst ligt plat — dan maar geen weer
      }
    }

    if (loc) { this.loc = loc; this.locAt = Date.now(); }
    return loc;
  }

  async get() {
    if (this.cache && Date.now() - this.cachedAt < CACHE_MS) return this.cache;
    if (this.pending) return this.pending;

    this.pending = (async () => {
      try {
        const loc = await this._location();
        if (!loc) throw new Error("geen locatie");
        const url = "https://api.open-meteo.com/v1/forecast"
          + "?latitude=" + encodeURIComponent(loc.latitude)
          + "&longitude=" + encodeURIComponent(loc.longitude)
          + "&current=temperature_2m";
        const j = await fetchJson(url, 8000);
        const t = j && j.current && j.current.temperature_2m;
        if (typeof t !== "number") throw new Error("geen temperatuur");
        /* Open-Meteo doet geen reverse geocoding. De plaatsnaam komt dus uit
           config.json, of anders van de IP-opzoeking hierboven. */
        const out = { temp_c: t, place: this.cfg.place || loc.place || "" };
        this.cache = out;
        this.cachedAt = Date.now();
        return out;
      } catch (err) {
        /* Rij je de wifi uit, dan valt het weer weg. Een buitentemperatuur van
           een uur oud is nog steeds ongeveer goed en in elk geval nuttiger dan
           een leeg vakje, dus die houden we vast tot hij echt oud is. */
        if (this.cache && Date.now() - this.cachedAt < STALE_MS) {
          return Object.assign({ stale: true }, this.cache);
        }
        throw err;
      }
    })().finally(() => { this.pending = null; });

    return this.pending;
  }
}

module.exports = { Weather, parseIpLocation };
