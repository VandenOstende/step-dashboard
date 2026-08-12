"use strict";
/**
 * Bijwerken vanaf GitHub.
 *
 * Controleren gebeurt met de publieke GitHub-API: één verzoek dat de laatste
 * commit op de tak teruggeeft. Dat is genoeg om te weten of er iets nieuws is
 * en vraagt geen git op de Pi.
 *
 * Installeren doet `step-update`, een script dat als root draait. Dat wordt
 * losgekoppeld gestart met systemd-run, want het herstart de service waar deze
 * code in draait — zonder die ontkoppeling zou het zichzelf halverwege
 * afbreken. De voortgang komt daarom uit een statusbestand en niet uit het
 * proces zelf.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const { ROOT } = require("./config");

const CHECK_CACHE_MS = 10 * 60 * 1000;
const STATUS_FILE = "/var/lib/step-dashboard/update-status.json";
const UPDATER = "/usr/local/sbin/step-update";

/** https://github.com/eigenaar/repo.git → eigenaar/repo */
function slugFor(repo) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo || "");
  return m ? m[1] + "/" + m[2] : null;
}

/** https://github.com/eigenaar/repo.git → https://api.github.com/repos/eigenaar/repo */
function apiUrlFor(repo, branch) {
  const slug = slugFor(repo);
  if (!slug) return null;
  return "https://api.github.com/repos/" + slug
    + "/commits/" + encodeURIComponent(branch || "main");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

class Updater {
  constructor(cfg) {
    this.cfg = (cfg && cfg.update) || {};
    this.versionFile = path.join(ROOT, "version.json");
    this.updater = UPDATER;
    this.cache = null;
    this.cachedAt = 0;
    this.pending = null;
    this.lastError = null;
  }

  /** De commit die nu geïnstalleerd staat; install.sh schrijft dit weg. */
  installed() {
    const v = readJson(this.versionFile);
    return v && v.commit ? v : null;
  }

  /** Voortgang van een lopende installatie, geschreven door step-update. */
  progress() {
    return readJson(STATUS_FILE);
  }

  async remote(force) {
    if (!force && this.cache && Date.now() - this.cachedAt < CHECK_CACHE_MS) return this.cache;
    if (this.pending) return this.pending;

    const url = apiUrlFor(this.cfg.repo, this.cfg.branch);
    if (!url) throw new Error("geen geldige repository ingesteld");

    this.pending = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { "Accept": "application/vnd.github+json", "User-Agent": "step-dashboard" }
        });
        if (!res.ok) throw new Error("GitHub gaf " + res.status);
        const j = await res.json();
        if (!j || !j.sha) throw new Error("onverwacht antwoord");
        const out = {
          commit: j.sha,
          date: j.commit && j.commit.committer && j.commit.committer.date,
          message: (j.commit && j.commit.message ? j.commit.message : "").split("\n")[0]
        };
        this.cache = out;
        this.cachedAt = Date.now();
        this.lastError = null;
        return out;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => { this.pending = null; });

    return this.pending;
  }

  /**
   * De commits tussen wat er staat en wat er klaarligt — dat is wat het
   * release-scherm toont. GitHub levert ze met de compare-API; die geeft ze in
   * chronologische volgorde, dus het nieuwste komt hier bovenaan te staan.
   * Lukt het niet, dan is het geen fout: dan is er gewoon geen lijst.
   */
  async notes(base, head) {
    const slug = slugFor(this.cfg.repo);
    if (!slug || !base || !head || base === head) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(
        "https://api.github.com/repos/" + slug + "/compare/" + base + "..." + head,
        {
          signal: ctrl.signal,
          headers: { "Accept": "application/vnd.github+json", "User-Agent": "step-dashboard" }
        }
      );
      if (!res.ok) return [];
      const j = await res.json();
      if (!j || !Array.isArray(j.commits)) return [];
      return j.commits.slice(-30).reverse().map((c) => ({
        sha: (c.sha || "").slice(0, 6),
        msg: ((c.commit && c.commit.message) || "").split("\n")[0]
      }));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** Alles wat de UI moet weten, in één object. */
  async status(force) {
    const cur = this.installed();
    const run = this.progress();
    const out = {
      repo: slugFor(this.cfg.repo) || "",
      current: cur ? cur.commit : null,
      currentShort: cur ? cur.commit.slice(0, 7) : null,
      installedAt: cur ? cur.at : null,
      branch: cur ? cur.branch : null,
      latest: null,
      latestShort: null,
      latestDate: null,
      message: null,
      notes: [],
      available: false,
      running: !!(run && (run.state === "bezig" || run.state === "herstarten")),
      runState: run ? run.state : null,
      runMessage: run ? run.message : null,
      canInstall: fs.existsSync(this.updater),
      error: null
    };

    try {
      const rem = await this.remote(force);
      out.latest = rem.commit;
      out.latestShort = rem.commit.slice(0, 7);
      out.latestDate = rem.date || null;
      out.message = rem.message;
      // Zonder bekende huidige versie kunnen we niets vergelijken; dan is
      // "bijwerken" nog steeds mogelijk, maar we beweren niet dat het nodig is.
      out.available = !!(cur && rem.commit !== cur.commit);
      if (out.available) out.notes = await this.notes(cur.commit, rem.commit);
    } catch (err) {
      out.error = err.name === "AbortError" ? "geen antwoord van GitHub" : err.message;
      this.lastError = out.error;
    }
    return out;
  }

  /**
   * Start de installatie. systemd-run zet het los van deze service, zodat de
   * herstart aan het eind dit proces mag omleggen.
   */
  start() {
    return new Promise((resolve) => {
      const run = this.progress();
      if (run && (run.state === "bezig" || run.state === "herstarten")) {
        return resolve({ ok: false, error: "al bezig" });
      }
      if (!fs.existsSync(this.updater)) {
        return resolve({ ok: false, error: "updater niet geïnstalleerd" });
      }
      const args = [
        // Geen argumenten: step-update leest repo en tak uit config.json.
        // Zo kan de sudoers-regel exact zijn, zonder jokertekens.
        "/usr/bin/systemd-run", "--unit=step-selfupdate", "--collect", "--quiet", this.updater
      ];
      execFile("sudo", args, { timeout: 15000 }, (err, _out, stderr) => {
        if (err) {
          const msg = (stderr || "").trim() || err.message;
          return resolve({ ok: false, error: /sudo|password/i.test(msg) ? "geen rechten" : "starten mislukt" });
        }
        resolve({ ok: true });
      });
    });
  }
}

module.exports = { Updater, apiUrlFor };
