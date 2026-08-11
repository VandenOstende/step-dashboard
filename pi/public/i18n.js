"use strict";
/* Teksten en accentkleuren, letterlijk overgenomen uit het ontwerp
   project/Ride Dash.dc.html. Overtypen is vragen om fouten, en de vier talen
   zijn daar al nagelopen.

   Onderaan staat een tweede blok: teksten die het ontwerp niet nodig had maar
   de echte app wel — de dag/nacht-namen (die stonden in het ontwerp los in de
   code) en het scherm voor de stepgegevens, dat geen ontwerp heeft omdat de
   VESC ze meestal zelf weet.

   Er staat een test op dat elke taal dezelfde sleutels heeft. Voeg je een
   tekst toe, dan moet hij dus in alle vier de talen. */

var ACCENTS = [
  { hex: '#9184d9', nl: 'Blurple', en: 'Blurple', fr: 'Blurple', de: 'Blurple' },
  { hex: '#4fa3a0', nl: 'Teal', en: 'Teal', fr: 'Turquoise', de: 'Türkis' },
  { hex: '#d98f52', nl: 'Oranje', en: 'Orange', fr: 'Orange', de: 'Orange' },
  { hex: '#3f7fd9', nl: 'Blauw', en: 'Blue', fr: 'Bleu', de: 'Blau' },
  { hex: '#c25a8f', nl: 'Magenta', en: 'Magenta', fr: 'Magenta', de: 'Magenta' },
  { hex: '#e0a92b', nl: 'Goud', en: 'Gold', fr: 'Or', de: 'Gold' },
  { hex: '#4f9e63', nl: 'Groen', en: 'Green', fr: 'Vert', de: 'Grün' },
  { hex: '#d95f4a', nl: 'Koraal', en: 'Coral', fr: 'Corail', de: 'Koralle' }
];

var T = {
  nl: {
    settings: 'Instellingen', connections: 'Verbindingen', limits: 'Temperatuurlimieten',
    language: 'Taal', accent: 'Accentkleur', units: 'Eenheden', power: 'Uitschakelen', tapToWake: 'Tik om te starten', reboot: 'Herstarten', shutdown: 'Uitschakelen', cancel: 'Annuleren', rebooting: 'Herstarten…', metric: 'Metrisch', imperial: 'Imperiaal', avgUse: 'Ø Verbruik', notifications: 'Meldingen', clear: 'Wissen', noAlerts: 'Geen meldingen — alles in orde.',
    trip: 'Trip A', odo: 'Kilometerstand', temps: 'Temp.', kmTotal: 'totaal', range: 'Bereik', charging: 'Opladen', chargeAmp: 'Laadstroom', timeLeft: 'Resterend', gainRate: 'Winst', chargeFull: 'Volledig geladen', tapClose: 'Tik om te sluiten',
    speedDetail: 'Snelheidsmeting', current: 'Huidig', topSpeed: 'Maximum', avgSpeed: 'Gemiddeld', holdToReset: 'Resetten', releaseToReset: 'Loslaten annuleert…',
    scan: 'Scan', scanning: 'Zoeken…', connected: 'Verbonden', strong: 'sterk', medium: 'matig', weak: 'zwak', paired: 'gekoppeld', nearby: 'dichtbij', audio: 'audio',
    motor: 'Motor', controller: 'VESC / controller', battery: 'Accu', now: 'Nu',
    limitsHint: 'Bij het bereiken van een limiet verschijnt het waarschuwingsscherm.',
    warning: 'WARNING', confirm: 'BEVESTIGEN', coolDown: '— stop en laat afkoelen',
    motorTemp: 'Motortemperatuur', escTemp: 'Controllertemperatuur', battTemp: 'Accutemperatuur',
    wifiPw: 'Wi-Fi wachtwoord', btPin: 'Bluetooth pincode', pwHint: 'Voer het wachtwoord in en tik op ✓',
    pwErr: 'Minimaal 4 tekens', space: 'spatie',
    updAvailable: 'Update beschikbaar', updSearch: 'Zoeken naar update', updSearching: 'Zoeken naar update…',
    updInstalling: 'Bezig met updaten…', updOk: 'Je bent up-to-date', updCurrent: 'Huidig',
    updNow: 'Nu updaten naar'
  },
  en: {
    settings: 'Settings', connections: 'Connections', limits: 'Temperature limits',
    language: 'Language', accent: 'Accent colour', units: 'Units', power: 'Power off', tapToWake: 'Tap to wake', reboot: 'Reboot', shutdown: 'Shutdown', cancel: 'Cancel', rebooting: 'Rebooting…', metric: 'Metric', imperial: 'Imperial', avgUse: 'Ø Use', notifications: 'Notifications', clear: 'Clear', noAlerts: 'No faults — all systems nominal.',
    trip: 'Trip A', odo: 'Odometer', temps: 'Temps', kmTotal: 'total', range: 'Range', charging: 'Charging', chargeAmp: 'Charge current', timeLeft: 'Time left', gainRate: 'Gain', chargeFull: 'Fully charged', tapClose: 'Tap to close',
    speedDetail: 'Speed readout', current: 'Current', topSpeed: 'Top speed', avgSpeed: 'Average', holdToReset: 'Reset', releaseToReset: 'Release cancels…',
    scan: 'Scan', scanning: 'Scanning…', connected: 'Connected', strong: 'strong', medium: 'fair', weak: 'weak', paired: 'paired', nearby: 'nearby', audio: 'audio',
    motor: 'Motor', controller: 'VESC / controller', battery: 'Battery', now: 'Now',
    limitsHint: 'The warning screen appears when a limit is reached.',
    warning: 'WARNING', confirm: 'ACKNOWLEDGE', coolDown: '— stop and let it cool down',
    motorTemp: 'Motor temperature', escTemp: 'Controller temperature', battTemp: 'Battery temperature',
    wifiPw: 'Wi-Fi password', btPin: 'Bluetooth pairing code', pwHint: 'Enter the password and tap ✓',
    pwErr: 'At least 4 characters', space: 'space',
    updAvailable: 'Update available', updSearch: 'Check for update', updSearching: 'Checking for update…',
    updInstalling: 'Updating…', updOk: 'You are up to date', updCurrent: 'Current',
    updNow: 'Update now to'
  },
  fr: {
    settings: 'Réglages', connections: 'Connexions', limits: 'Limites de température',
    language: 'Langue', accent: 'Couleur d’accent', units: 'Unités', power: 'Éteindre', tapToWake: 'Toucher pour démarrer', reboot: 'Redémarrer', shutdown: 'Éteindre', cancel: 'Annuler', rebooting: 'Redémarrage…', metric: 'Métrique', imperial: 'Impérial', avgUse: 'Ø Conso.', notifications: 'Notifications', clear: 'Effacer',
    noAlerts: 'Aucun défaut — tout est normal.',
    trip: 'Trajet A', odo: 'Compteur', temps: 'Temp.', kmTotal: 'au total', range: 'Autonomie', charging: 'Charge', chargeAmp: 'Courant de charge', timeLeft: 'Restant', gainRate: 'Gain', chargeFull: 'Charge complète', tapClose: 'Toucher pour fermer',
    speedDetail: 'Mesure de vitesse', current: 'Actuelle', topSpeed: 'Maximale', avgSpeed: 'Moyenne', holdToReset: 'Réinitialiser', releaseToReset: 'Relâcher annule…',
    scan: 'Scan', scanning: 'Recherche…', connected: 'Connecté', strong: 'fort', medium: 'moyen', weak: 'faible', paired: 'appairé', nearby: 'à proximité', audio: 'audio',
    motor: 'Moteur', controller: 'VESC / contrôleur', battery: 'Batterie', now: 'Actuel',
    limitsHint: 'L’écran d’alerte apparaît dès qu’une limite est atteinte.',
    warning: 'WARNING', confirm: 'CONFIRMER', coolDown: '— arrêtez et laissez refroidir',
    motorTemp: 'Température moteur', escTemp: 'Température contrôleur', battTemp: 'Température batterie',
    wifiPw: 'Mot de passe Wi-Fi', btPin: 'Code Bluetooth', pwHint: 'Saisissez le mot de passe puis ✓',
    pwErr: 'Au moins 4 caractères', space: 'espace',
    updAvailable: 'Mise à jour disponible', updSearch: 'Rechercher une mise à jour',
    updSearching: 'Recherche…', updInstalling: 'Mise à jour…', updOk: 'Vous êtes à jour',
    updCurrent: 'Actuelle', updNow: 'Mettre à jour vers'
  },
  de: {
    settings: 'Einstellungen', connections: 'Verbindungen', limits: 'Temperaturgrenzen',
    language: 'Sprache', accent: 'Akzentfarbe', units: 'Einheiten', power: 'Ausschalten', tapToWake: 'Tippen zum Starten', reboot: 'Neustart', shutdown: 'Ausschalten', cancel: 'Abbrechen', rebooting: 'Neustart…', metric: 'Metrisch', imperial: 'Imperial', avgUse: 'Ø Verbrauch', notifications: 'Meldungen', clear: 'Löschen',
    noAlerts: 'Keine Fehler — alles in Ordnung.',
    trip: 'Trip A', odo: 'Kilometerstand', temps: 'Temp.', kmTotal: 'gesamt', range: 'Reichweite', charging: 'Laden', chargeAmp: 'Ladestrom', timeLeft: 'Restzeit', gainRate: 'Zuwachs', chargeFull: 'Voll geladen', tapClose: 'Tippen zum Schließen',
    speedDetail: 'Geschwindigkeitsmessung', current: 'Aktuell', topSpeed: 'Höchstwert', avgSpeed: 'Durchschnitt', holdToReset: 'Zurücksetzen', releaseToReset: 'Loslassen bricht ab…',
    scan: 'Scan', scanning: 'Suche…', connected: 'Verbunden', strong: 'stark', medium: 'mittel', weak: 'schwach', paired: 'gekoppelt', nearby: 'in der Nähe', audio: 'Audio',
    motor: 'Motor', controller: 'VESC / Controller', battery: 'Akku', now: 'Jetzt',
    limitsHint: 'Beim Erreichen einer Grenze erscheint der Warnbildschirm.',
    warning: 'WARNING', confirm: 'BESTÄTIGEN', coolDown: '— anhalten und abkühlen lassen',
    motorTemp: 'Motortemperatur', escTemp: 'Controllertemperatur', battTemp: 'Akkutemperatur',
    wifiPw: 'WLAN-Passwort', btPin: 'Bluetooth-PIN', pwHint: 'Passwort eingeben und ✓ tippen',
    pwErr: 'Mindestens 4 Zeichen', space: 'Leertaste',
    updAvailable: 'Update verfügbar', updSearch: 'Nach Update suchen', updSearching: 'Suche nach Update…',
    updInstalling: 'Update läuft…', updOk: 'Alles aktuell', updCurrent: 'Aktuell',
    updNow: 'Jetzt aktualisieren auf'
  }
};

/* ── wat het ontwerp niet had ──────────────────────────────────────────────
   Dag/nacht stond in het ontwerp los in de rendercode; hier hoort het bij de
   rest. De stepgegevens zijn een echt scherm dat het ontwerp niet kende:
   pole pairs, wieldiameter en overbrenging. Zonder die drie rekent de VESC
   een verkeerde snelheid uit, en dan klopt alles wat eruit volgt niet. */
var EXTRA = {
  nl: {
    day: 'Dag', night: 'Nacht', na: 'n.v.t.',
    stepValues: 'Stepgegevens', stepOk: 'Herkend door de VESC',
    stepMissing: 'Niet herkend — zelf invullen', stepHand: 'Met de hand ingesteld',
    stepUnknown: 'Nog niet vastgesteld — rij een stukje',
    polePairs: 'Poolparen', wheel: 'Wieldiameter', gear: 'Overbrenging',
    cells: 'Accucellen', auto: 'auto', save: 'Bewaren', saving: 'Bezig…', saved: 'Bewaard',
    stepHint: 'Deze drie bepalen de snelheid en de afstand. Staat de setup-wizard '
      + 'in VESC Tool goed, dan neemt de app ze daar vanzelf van over.',
    noNotes: 'Geen commits om te tonen.', updFailed: 'Bijwerken mislukt',
    faultLbl: 'VESC-storing', lowBatt: 'Accu bijna leeg', motorHot: 'Motor wordt warm',
    escHot: 'Controller wordt warm'
  },
  en: {
    day: 'Day', night: 'Night', na: 'n/a',
    stepValues: 'Scooter values', stepOk: 'Recognised by the VESC',
    stepMissing: 'Not recognised — enter them yourself', stepHand: 'Set by hand',
    stepUnknown: 'Not established yet — ride a little',
    polePairs: 'Pole pairs', wheel: 'Wheel diameter', gear: 'Gear ratio',
    cells: 'Battery cells', auto: 'auto', save: 'Save', saving: 'Saving…', saved: 'Saved',
    stepHint: 'These three set speed and distance. If the setup wizard in VESC Tool '
      + 'is filled in, the app picks them up from there by itself.',
    noNotes: 'No commits to show.', updFailed: 'Update failed',
    faultLbl: 'VESC fault', lowBatt: 'Battery nearly empty', motorHot: 'Motor heating up',
    escHot: 'Controller heating up'
  },
  fr: {
    day: 'Jour', night: 'Nuit', na: 'n/d',
    stepValues: 'Données trottinette', stepOk: 'Reconnu par le VESC',
    stepMissing: 'Non reconnu — à saisir', stepHand: 'Saisi à la main',
    stepUnknown: 'Pas encore établi — roulez un peu',
    polePairs: 'Paires de pôles', wheel: 'Diamètre de roue', gear: 'Rapport',
    cells: 'Cellules', auto: 'auto', save: 'Enregistrer', saving: 'En cours…', saved: 'Enregistré',
    stepHint: 'Ces trois valeurs déterminent la vitesse et la distance. Si l’assistant '
      + 'de VESC Tool est rempli, l’app les reprend automatiquement.',
    noNotes: 'Aucun commit à afficher.', updFailed: 'Échec de la mise à jour',
    faultLbl: 'Défaut VESC', lowBatt: 'Batterie presque vide', motorHot: 'Le moteur chauffe',
    escHot: 'Le contrôleur chauffe'
  },
  de: {
    day: 'Tag', night: 'Nacht', na: 'k. A.',
    stepValues: 'Rollerdaten', stepOk: 'Vom VESC erkannt',
    stepMissing: 'Nicht erkannt — selbst eintragen', stepHand: 'Von Hand gesetzt',
    stepUnknown: 'Noch nicht ermittelt — fahr ein Stück',
    polePairs: 'Polpaare', wheel: 'Raddurchmesser', gear: 'Übersetzung',
    cells: 'Akkuzellen', auto: 'auto', save: 'Speichern', saving: 'Läuft…', saved: 'Gespeichert',
    stepHint: 'Diese drei bestimmen Geschwindigkeit und Strecke. Ist der Setup-Assistent '
      + 'in VESC Tool ausgefüllt, übernimmt die App sie von dort.',
    noNotes: 'Keine Commits vorhanden.', updFailed: 'Update fehlgeschlagen',
    faultLbl: 'VESC-Fehler', lowBatt: 'Akku fast leer', motorHot: 'Motor wird warm',
    escHot: 'Controller wird warm'
  }
};
Object.keys(T).forEach(function (lg) { Object.assign(T[lg], EXTRA[lg]); });
