"use strict";
/**
 * De meetlus: wat er per VESC-meting gebeurt.
 *
 * Dit stond in de route GET /data, en daar hoorde het niet. De kilometerstand
 * en de rijtijd worden opgeteld met tijdsverschillen, dus als dat optellen aan
 * een HTTP-verzoek hangt, telt de teller alleen zolang er een browser kijkt —
 * kiosk dicht is teller stil — en telt hij dubbel zodra er twee browsers
 * meekijken. Hetzelfde gold voor de wielmaat-monsters van setup.js: die werden
 * op de cadans van de browser verzameld in plaats van op die van de metingen.
 *
 * Precies dezelfde fout zat eerder in de cruisecontrol, en om precies dezelfde
 * reden hangt die al aan vesc.on("values"). Nu de rest ook.
 *
 * Het staat in een eigen module en niet in server.js omdat server.js een poort
 * opent en een VESC start; dat valt niet te require-en in de zelftest. Elke
 * andere bouwsteen hier is een testbare module — de meetlus was de enige die
 * dat niet was, en dat is niet toevallig ook de plek waar de fouten zaten.
 *
 * Wat een verzoek daarna nog kost is 6 microseconden: het klaarliggende object
 * teruggeven. Dat is gemeten met tools/bench-loop.js.
 */

/* Zo lang wachten we minstens tussen twee schrijfacties naar config.json. Dat
   bestand gaat via een synchrone lees-schrijf-hernoem, en die hoort niet vaak
   op de meetlus te staan. */
const LEER_PAUZE_MS = 60000;
/* En zo lang tussen twee topsnelheid-patches. De topsnelheid zelf staat meteen
   goed in het geheugen; dit gaat alleen over hoe vaak hij naar schijf mag. */
const TOP_PAUZE_MS = 5000;

class Ride {
  constructor(o) {
    this.cfg = o.cfg;
    this.state = o.state;
    this.telemetry = o.telemetry;
    this.setup = o.setup;
    this.charge = o.charge;
    this.cruise = o.cruise;
    this.saveStep = o.saveStep;
    this.log = o.log || function () {};

    this.laatste = null;        // het klaarliggende contract
    this.top = (this.state.data.topSpeed) || 0;
    this.topAt = 0;
    this.leerFout = false;      // config.json is niet te schrijven
    this.leerRev = -1;          // laatste setup-revisie die we hebben verwerkt
    this.leerAt = 0;
    this.ch = null;             // laatste laadstand
  }

  /** Eén VESC-meting. Hier gebeurt al het rekenwerk. */
  meting(snap, now) {
    const nu = now || Date.now();
    this.cruise.update(snap, nu);
    this._observeer(snap);
    this._leer(nu);
    this.laatste = this._bouw(snap, nu);
    return this.laatste;
  }

  /** De VESC is weg. Eén keer een geldig offline-contract neerleggen. */
  weg(now) {
    const nu = now || Date.now();
    /* Zonder dit telt een hervatting na een lang gat alsnog de afgetopte twee
       seconden rijtijd mee, terwijl er niet gereden is. De afstandsteller
       blijft bewust wél staan: wiebelt de USB-stekker tijdens het rijden, dan
       telt de VESC gewoon door en hoort die afstand er alsnog bij. */
    this.telemetry.pause();
    this.laatste = this._bouw(null, nu);
    return this.laatste;
  }

  /** Wat GET /data teruggeeft. */
  data() {
    if (!this.laatste) this.weg();
    return this.laatste;
  }

  /**
   * Opnieuw samenstellen na een reset van de tellers, zodat het klaarliggende
   * object meteen klopt en niet pas bij de volgende meting.
   *
   * Cruise wordt bewust niet opnieuw gevoed: nog een monster met dezelfde erpm
   * in het vlakheidsvenster duwen maakt de meting kunstmatig vlakker. De
   * laadstand hergebruiken we om dezelfde reden.
   */
  hertel(now) {
    const nu = now || Date.now();
    this.laatste = this._bouw(this.laatsteSnap || null, nu, true);
    return this.laatste;
  }

  /* ── binnenwerk ───────────────────────────────────────────────────────── */

  _observeer(snap) {
    /* Meekijken of de VESC zelf weet hoe de step in elkaar zit. Dat is alleen
       te zien terwijl de motor draait, dus het moet in de lus mee. */
    this.setup.observe(snap);
    /* Eén keer rijdend gezien = onthouden, zodat de status een herstart
       overleeft; ziet een latere rit "missing", dan wordt dat ook onthouden. */
    const seen = this.state.data.setupSeen;
    if (this.setup.status === "ok" && !seen) this.state.patch({ setupSeen: true });
    else if (this.setup.status === "missing" && seen) this.state.patch({ setupSeen: false });
  }

  /* Weet de VESC het zelf, dan schrijven we het op — één keer, en nooit over
     een waarde heen die jij met de hand hebt gezet.

     De oude versie draaide dit bij elk verzoek, voor altijd: de vroege return
     testte op source "hand", maar na het leren wordt source "vesc", dus die
     greep nooit. Een simpele "klaar"-vlag zou te veel wegnemen — als de
     afgeleide wielmaat later meer dan twee procent afwijkt (andere band,
     andere overbrenging) hoort hij opnieuw te leren. Vandaar de revisieteller
     van SetupWatch: alleen als daar echt iets veranderd is valt er iets te
     schrijven. */
  _leer(nu) {
    if (this.cfg.step.source === "hand" || this.leerFout) return;
    if (this.setup.rev === this.leerRev) return;
    if (nu - this.leerAt < LEER_PAUZE_MS) return;

    const patch = this.setup.patch();
    this.leerRev = this.setup.rev;
    if (!patch) return;

    this.leerAt = nu;
    patch.source = "vesc";
    patch.learnedAt = nu;
    try {
      this.saveStep(this.cfg, patch);
      this.telemetry.cells = this.cfg.step.batteryCells;
      this.log("stepgegevens van de VESC overgenomen:", JSON.stringify(patch));
    } catch (err) {
      /* Staat config.json op alleen-lezen, dan is dat geen reden om het bij
         elke meting opnieuw te proberen. */
      this.leerFout = true;
      this.log("kon config.json niet bijwerken: " + err.message);
    }
  }

  _bouw(snap, nu, hergebruikLaden) {
    if (snap) this.laatsteSnap = snap;
    const d = this.telemetry.build(snap);

    /* De VESC meldt cruisecontrol niet; dit leidt het af uit de hendelstand,
       de motorstroom en een vlakke snelheid. Bijhouden gebeurt in meting();
       hier lezen we alleen de stand. */
    const cc = this.cruise.state();
    d.cruise = cc.active;
    d.cruise_supported = cc.supported;

    /* De topsnelheid staat meteen goed in het geheugen; naar schijf gaat hij
       hoogstens elke vijf seconden. Anders patcht hij tijdens het optrekken
       honderden keren achter elkaar, en elke patch kopieert de hele staat. */
    if (d.connected && d.speed_kmh > this.top) {
      this.top = d.speed_kmh;
      if (nu - this.topAt > TOP_PAUZE_MS) {
        this.topAt = nu;
        this.state.patch({ topSpeed: this.top });
      }
    }
    d.top_kmh = this.top;

    /* Laden herkennen we aan de spanning die stijgt terwijl de step stilstaat;
       een gewone lader hangt rechtstreeks aan de accu en loopt niet via de
       VESC, dus stroom meten alleen is niet genoeg. */
    const ch = hergebruikLaden && this.ch ? this.ch : this.charge.update(d, nu);
    this.ch = ch;
    d.charging = ch.charging;
    d.charge_eta_min = ch.etaMin;
    d.charge_full = ch.full;
    d.charge_session = ch.session;
    /* Laadstroom alleen als de lader via de controller loopt. Hangt hij
       rechtstreeks aan de accu — bij de meeste steps is dat zo — dan ziet de
       VESC er niets van en zet de UI n.v.t. neer. */
    d.charge_a = ch.charging && d.battery_current < -0.2 ? -d.battery_current : null;

    return d;
  }
}

module.exports = { Ride, LEER_PAUZE_MS, TOP_PAUZE_MS };
