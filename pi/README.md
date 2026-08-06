# Hoe het in elkaar zit

Installeren en instellen staat in de [README bovenin de repo](../README.md).
Dit is meer een notitieblok voor mezelf over hoe de code werkt en waarom
sommige dingen zo raar zijn.

```
tools/layout-body.html   de opmaak — één bron voor beide indelingen
tools/build-layouts.js   zet daar de twee pagina's uit samen
public/index.html   liggend, 480 × 320   ← uitvoer
public/portrait.html staand,  320 × 480   ← uitvoer
public/layout.css   de maatvoering voor beide indelingen
public/styles/      de vormtalen — één bestand per stijl
public/app.js       het gedrag, gedeeld door allebei
src/serial.js       seriële poort zonder npm-modules
src/vesc.js         VESC-protocol: framing, CRC16, pakketten
src/telemetry.js    ruwe waarden → wat de UI verwacht
src/system.js       nmcli, bluetoothctl, mmcli, backlight
src/weather.js      buitentemperatuur
src/charge.js       herkennen dat de accu laadt, en hoelang nog
src/config.js       config.json en de opgeslagen staat
src/update.js       versie vergelijken met GitHub
src/server.js       de HTTP-server
install/step-update het script dat als root bijwerkt
tools/design.js     designomgeving: de UI met nagemaakte hardware
tools/concepts/     ontwerpen die nog geen productie zijn
tools/vesc-probe.js kijken wat je VESC vertelt
tools/selftest.js   tests, zonder hardware
```

## Twee indelingen, één bron

Geen framework en geen bundler. De Pi heeft geen internet, dus alles staat
lokaal: `layout.css` voor de maatvoering, `styles/<stijl>.css` voor de
vormtaal, `app.js` voor het gedrag, iconen als inline SVG. Segoe UI wordt gebruikt als je hem hebt, anders valt hij terug op
system-ui — het ontwerp leunt op vorm en niet op één specifiek lettertype.

`index.html` is liggend, `portrait.html` staand, en ze zijn **allebei
uitvoer**. De opmaak staat één keer in `tools/layout-body.html` en de
maatvoering voor allebei in `public/layout.css`; het kenmerk `data-layout` op
de body kiest welke helft telt. `tools/build-layouts.js` zet de twee pagina's
samen:

```bash
node tools/build-layouts.js     # na elke wijziging in layout-body.html
```

Alles wat gedeeld kan worden is ook echt gedeeld — opmaak, vormtaal, gedrag.
Twee handgeschreven pagina's lopen bij de eerste wijziging al uit elkaar, en
dan werkt een knop in de ene indeling wel en in de andere niet. Dat is precies
het soort fout dat je pas op het stuur ziet.

## Vier stijlen, één opmaak

`layout.css` zegt wát waar staat en hoe groot het is, en is helemaal in tokens
geschreven: `var(--card)`, `var(--accent)`, `var(--r-card)`. Een bestand in
`public/styles/` vult die tokens in en zet er zijn eigen vormregels achteraan.
Er zijn er vier:

| stijl | vormtaal |
|---|---|
| **Windows** | Fluent: mica, kaarten met een rand van 1 px plus een lichtere lijn erboven, hoeken van 8 px, een accentbalkje onder de actieve tab |
| **Nocturne** | het oorspronkelijke ontwerp: donkerblauw, paars accent, puntjes onderaan, knoppen die met een rand markeren |
| **Apple** | iOS: eilanden zonder rand met een radius van 18 px, systeemkleuren, een segmented control onderaan |
| **Cyber** | Night City bij daglicht: geknipte hoeken, mono-labels, segmentbalken en de snelheid in een hazard-geel blok |

Je kiest ze in **Instellingen → Stijl**. Dat verwisselt één `<link>`
(`applyStyle()` in `app.js`); er wordt niets herladen en de indeling
verschuift niet — dat is precies waarom de maatvoering apart staat.

De namen staan op vier plekken: de knoppen in `layout-body.html`, `STIJLEN` in
`app.js`, de whitelist in `server.js` en de bestanden in `public/styles/`.
`npm test` controleert dat die vier het met elkaar eens zijn, en dat elk
stijlblad alle tokens invult die `layout.css` gebruikt — een stijl die er één
vergeet levert een half onzichtbare UI op.

Eén valkuil: schrijf een stijl níét met een aparte `body.light`-regel voor
knoppen. `body.light .seg` weegt zwaarder dan `.seg.on`, en dan is niet meer te
zien welke knop aan staat. Zet het verschil in een token (zie `--btn` in
`apple.css`).

Ontwerpen die geen stijl zijn geworden — de wijzerplaat bijvoorbeeld, die zijn
eigen DOM nodig heeft — staan in `tools/concepts/`.

Welke pagina je voor je hebt staat op de body:

```html
<body data-layout="Liggend">     <!-- of "Staand" -->
```

`app.js` leest dat als `PAGE_LAYOUT`. Staat er in de instellingen een andere
indeling opgeslagen, dan stuurt de pagina bij het opstarten meteen door naar de
andere — vóór de timers gaan lopen. De kiosk hoeft dus niets te weten: die opent
altijd `/` en komt vanzelf op de goede uit.

Wisselen slaat eerst op en springt daarna pas (`saveSettingsNow`). Met de gewone
opslag, die 400 ms wacht, gaat de POST mee het graf in bij het herladen en
stuurt de andere pagina je meteen terug.

Wat je bij een nieuwe indeling moet naleven: elk id dat `app.js` aanraakt moet
in de opmaak staan, en elementen waar `cls()` op werkt houden precies de klassen
die dat script erop zet (`#tm` is `v big`, `#batcard` is `card`). Die twee dingen
zijn met een regex uit `app.js` te halen en na te lopen — dat scheelt zoeken.

Renderen gebeurt ~6× per seconde en alleen de nodes die echt veranderen worden
aangeraakt — vandaar die `cacheT` en `cacheS` in `paint()`. Het schermpje is
traag; een normale herteken-loop maakt het onbruikbaar traag.

Er zit ook een demo-modus in. Is `/data` onbereikbaar, dan simuleert de pagina
na drie mislukte pogingen zelf een rit. Zo kun je aan het uiterlijk werken door
gewoon het HTML-bestand te openen.

## Het VESC-protocol

Framing zit in `vesc.js`, overgenomen uit `bldc/comm/packet.c`:

```
0x02 len(1)  payload  crc16(2)  0x03      korte pakketten
0x03 len(2)  payload  crc16(2)  0x03      langere
```

CRC is CRC16-CCITT, poly 0x1021, init 0.

Wat me een avond gekost heeft: **een startbyte is niet te vertrouwen.** Een
payload-byte kan er net zo uitzien, en zo'n vals begin kan een lengte opgeven
die over het volgende, echte pakket heen loopt. Dan wacht je op bytes die nooit
komen en ben je een geldig pakket kwijt. `_scan()` controleert daarom een
kandidaat helemaal — startbyte, verwacht commando, CRC én het afsluitende 0x03 —
voordat hij hem accepteert, en zoekt bij twijfel gewoon verder in de buffer.
Er zit een test op met een opzettelijk verminkt pakket gevolgd door een goed
pakket.

We vragen twee dingen op: `COMM_GET_VALUES` voor temperaturen, stromen en
storingen, en `COMM_GET_VALUES_SETUP` voor snelheid, afstand en accuniveau.
Beantwoordt de firmware die tweede niet, dan stopt hij er na een paar rondes
mee en rekent `telemetry.js` het zelf uit.

## Serieel zonder npm

`serial.js` zet de poort met `stty` in raw-modus en leest hem daarna met `fs`.
Dat kan omdat de VESC een CDC-ACM-apparaat is, waar de baudrate geen betekenis
heeft — er hoeft dus niets aan lijnparameters gedaan te worden.

Eén valkuil: gebruik **niet** `fs.promises.open()`. Die geeft een `FileHandle`
terug, en zodra dat object opgeruimd wordt sluit Node de onderliggende fd —
midden in een lopende lezing. Dat gaf om de paar seconden een `EBADF` en een
herverbinding. Met de callback-variant van `fs.open()` krijg je een kale fd en
speelt dat niet.

De leeslus draait met `stty min 0 time 1`, zodat `read()` na 100 ms terugkomt
ook als er niets is. Anders blijft er permanent een threadpool-slot bezet.

## Wifi-wachtwoorden

Het schermtoetsenbord stuurt het wachtwoord via **stdin** naar `nmcli --ask`,
niet als argument. Argumenten staan in `ps` en `/proc` en zijn door elke lokale
gebruiker te lezen. Kent NetworkManager het netwerk al met een verkeerd
wachtwoord, dan wordt het profiel bijgewerkt en opnieuw geactiveerd. Oude
nmcli-versies kennen `--ask` niet; dan valt het terug op de argumentvorm.

`wifiConnectPlan()` bouwt alleen het commando en voert niks uit, zodat de tests
kunnen controleren wat er zou gebeuren — inclusief dat het wachtwoord echt niet
in de argumenten belandt.

Alle systeemaanroepen gaan via `execFile` met een argumentenlijst, nooit via een
shell. Een SSID met een puntkomma erin mag geen commando worden.

## Bluetooth zoeken

`bluetoothctl scan on` doet niet wat je denkt. De zoektocht hangt aan het
proces: sluit dat af, dan stopt hij. En omdat `run()` stdin altijd dichtdoet —
anders blijft bluetoothctl op invoer wachten — is dat proces meteen weer weg.
Je start dus een zoektocht van nul seconden.

`--timeout N` lost het op: het proces blijft precies N seconden staan en stopt
daarna zelf, dus er is geen achtergrondproces om te bewaken. We wachten er niet
op. De server onthoudt alleen tot wanneer er gezocht wordt en geeft de lijst
meteen terug; de UI haalt hem elke twee seconden opnieuw op, want apparaten
komen er één voor één bij. Kent je bluez `--timeout` niet (ouder dan 5.55), dan
komt dat als "zoeken niet ondersteund" op de zoekrij te staan in plaats van dat
er niets gebeurt.

`bluetoothctl devices` zonder filter geeft ook wat de zoektocht net gevonden
heeft, dus daar hoeft niets extra's voor. De lijst zet verbonden bovenaan, dan
gekoppeld, dan wat een naam heeft. Naamloze apparaten — enkel een mac-adres —
staan onderaan en gaan er niet uit: soms is dat rare adres net je koptelefoon.

## Waar de step staat

De buitentemperatuur links boven heeft coördinaten nodig. Die komen uit
`config.json`, anders uit de gps van een 5G-modem, en anders uit een opzoeking
op het IP-adres. Die laatste is er omdat de meeste steps geen modem hebben en
niemand zin heeft om zelf coördinaten op te zoeken. Uit te zetten met
`weather.ipFallback: false`.

In de topbalk staat alleen het getal. De plaatsnaam komt nog wel uit `/weather`
— handig om te controleren waar hij denkt te staan — maar op 480 px is elk
woord dat je niet nodig hebt er één te veel.

Rij je de wifi uit, dan houdt hij de laatst bekende temperatuur nog drie uur
vast. Buiten wordt het niet ineens tien graden kouder, en een oud getal is
bruikbaarder dan een leeg vakje.

Het mobiele bereik werkt andersom: `modem()` geeft `present` terug, en zit er
geen dongle in dan verdwijnen de balkjes helemaal uit de topbalk. "Geen bereik"
melden over hardware die er niet is, is geen informatie. Verschijnen mag meteen,
verdwijnen pas na drie keer op rij niks — ModemManager is even stil als hij
herstart en dan hoort de topbalk niet te knipperen.

## Zichzelf bijwerken

Twee stukken. `src/update.js` vraagt de laatste commit op via de publieke
GitHub-API en vergelijkt die met `version.json`, dat `install.sh` bij elke
installatie wegschrijft. Installeren doet `step-update`, een los script dat als
root draait.

Dat script moet **losgekoppeld** starten, want het herstart aan het eind de
service waar de aanroep vandaan kwam — zonder `systemd-run` snijdt het zichzelf
halverwege af. Daarom komt de voortgang ook uit een statusbestand in
`/var/lib/step-dashboard/` en niet uit het proces: de UI blijft dat lezen terwijl
de server onder haar handen herstart.

Het script staat in `/usr/local/sbin/` en niet in `/opt/step-dashboard`, want die
map is van de service-gebruiker. Een script dat je zelf kunt aanpassen én met
sudo mag draaien is een achterdeur naar root. Om dezelfde reden staan er geen
jokertekens in de sudoers-regel: `step-update` leest de repository en de tak zelf
uit `config.json`, zodat er niks door sudo heen hoeft.

Het haalt altijd een verse kloon op in plaats van te pullen in de map waar je
ooit `git clone` deed — die kan verplaatst of weggegooid zijn.

## Aan/uit

`systemctl reboot` en `poweroff` mogen normaal ook zonder root, maar dan wel
via logind — en dat vraagt een sessie. De service draait als systeemdaemon
zonder sessie, dus polkit weigert het. Vandaar sudo, met twee uitgeschreven
regels erbij.

Wat de UI stuurt komt nooit in het commando terecht: `powerCommand()` slaat
`"reboot"` of `"shutdown"` op in een tabel en geeft `null` terug voor al het
andere. Er is dus geen tekenreeks die van de browser tot aan sudo doorloopt.

Het scherm is zelf de bevestiging. Nog een "weet je het zeker" erbij maakt het
op een aanraakscherm alleen maar irritanter, niet veiliger — en je bent er pas
na twee tikken vanaf het rijscherm.

## Wat er staand anders is

Staand is 320 px breed, en dat dwingt een paar dingen af:

- **Meldingen** krijgen een eigen band over de volle breedte. Liggend deelt de
  meldingsbalk zijn plek met de buitentemperatuur; op 320 px blijft daar zo
  weinig van over dat je de helft van de tekst moet raden.
- **Drie knoppen naast elkaar** (systeem, aan/uit) passen niet meer met leesbare
  labels, dus die staan onder elkaar. Met een duim mik je daar toch beter op.
- **Het toetsenbord** heeft tien toetsen per rij, dus 27 px breed. Dat is smal,
  maar er is hoogte zat: de toetsen zijn 64 px hoog en staan onderaan geplakt.
  Uitrekken over de hele hoogte gaf toetsen van 91 px, en daar mik je niet beter
  door.
- **"max 41"** staat op dezelfde basislijn als de grote cijfers via
  `align-items: last baseline`. Een vast aantal pixels klopt niet meer zodra
  Inter wel of juist niet geïnstalleerd is.

## Concepten

In `tools/concepts/` staat ook **nocturne.html** en **nocturne-staand.html**:
het oorspronkelijke ontwerp uit Claude Design, zoals het tot en met versie
`8e3b5cb` op de step draaide. Bewaard toen de Windows-vormtaal productie werd,
zodat je ernaar terug kunt kijken — en desnoods terug kunt. Het draait op het
huidige `app.js`, dus het is geen plaatje maar een werkende UI.

`tools/concepts/` is waar een ontwerp begint. Het zijn losse pagina's die het
echte `public/app.js` laden — dezelfde element-id's, hetzelfde gedrag — met
alleen een andere opmaak eromheen. Je klikt er dus doorheen als door een
werkende UI, niet door een plaatje. Ze staan bewust níet in `public/`: tot een
concept goedgekeurd is hoort het niet in de app.

De designomgeving vindt ze vanzelf. Elk `.html`-bestand in die map verschijnt
als knop onder het frame; de server serveert ze op `/concept/<naam>`.

Wat een nieuwe opmaak moet naleven:

- **elk id dat `app.js` aanraakt moet bestaan** — anders valt de tekenlus om.
  Op te halen met een regex uit `app.js`; de bouwer van de staande versie doet
  dat ook.
- **elementen waar `cls()` op werkt houden hun basisklassen**, want die functie
  overschrijft `className` in z'n geheel (`#tm` is `v big`, `#batcard` is
  `card`).
- **de kleurnamen die `app.js` rechtstreeks in style-attributen schrijft moeten
  bestaan**: `--color-crit-fill`, `--color-warn-fill`, `--color-warn`,
  `--color-accent`, `--color-neutral-800`, `--color-neutral-500` en
  `--color-text`. Vergeet je die, dan verliest het temperatuuralarm zijn
  achtergrond en blijven de boogjes van het wifi-icoon grijs. In een concept
  met een eigen palet laat je ze doorwijzen naar je eigen namen.

Wat `app.js` níet kan is tekenen: hij zet tekst en breedtes, meer niet. Een
concept dat ringen of segmenten wil, leest daarvoor zelf `window.last` uit in
een eigen scriptblok. Dat botst nergens mee, want app.js beheert alleen zijn
eigen id's.

Eén valkuil bij het testen: `window.last` overschrijven doet niets, want
`poll()` haalt elke 150 ms opnieuw op. Wil je een waarde vastzetten om naar te
kijken, onderschep dan `/data` zelf.

## De pagina draait zichzelf

Het paneel op het stuur is 480 × 320 en blijft dat, ook als je de staande
indeling kiest. `fitRotation()` vergelijkt daarom waar de pagina voor getekend
is (`DESIGN`) met wat hij krijgt (`innerWidth/innerHeight`), en zet er een
kwartslag op als die niet overeenkomen. De body vult het paneel, `#root` houdt
de ontwerpmaat en wordt geroteerd om zijn eigen midden.

Waarom niet op OS-niveau: `display_rotate` in `config.txt` werkt alleen bij
bepaalde drivers, fbtft wil een moduleparameter, en onder Wayland is het weer
`wlr-randr`. Eén verkeerde poging en je scherm blijft zwart terwijl je er niet
meer bij kunt. Dit is één regel CSS die overal hetzelfde doet.

Aanraken hoefde niet omgerekend te worden: de browser doet hit-testing dwars
door de transform heen. Getest met een echte `touchscreen.tap()` op de
Instellingen-knop in het gedraaide systeemvenster.

Welke kant op staat in `cfg.rotate` (90 of 270) — hoe je het scherm ophangt
bepaalt welke van de twee klopt.

In de designomgeving zit er een knop **Staand op 480 × 320** voor: die laadt de
staande pagina in een liggend frame, precies zoals op de step. Zonder die knop
zie je een verkeerde draaiing pas op het stuur staan.

## Meldingen die ergens heen gaan

De meeste meldingen vertellen je iets: te warm, accu laag, VESC weg. Daar is de
lijst het eindstation. De update-melding is anders — die gaat over een knop die
ergens anders staat. Een melding die zegt "zie Instellingen" is een melding die
je werk geeft.

Zo'n melding krijgt daarom een `act` in `notices()`. Tik je op de balk terwijl
die melding aan de beurt is, dan gaat hij rechtstreeks naar dat scherm in plaats
van naar de lijst; en in de lijst is die rij zelf aantikbaar, met een accentrand
en "openen" in plaats van "info" ernaast. De rest van de meldingen gedraagt zich
onveranderd.

Bewegen is geen tik, net als bij de netwerklijst: scrollen door de meldingen
opent niets.

## Lagen op het scherm

De overlays zitten op vaste z-index-niveaus:

```
7  temperatuuralarm
6  aan/uit
5  schermtoetsenbord
4  systeem en instellingen
3  meldingen
2  verbindingen
```

Het alarm staat bewust bovenaan. Een te warme motor moet je onderbreken terwijl
je een wachtwoord intypt of iets aan het afsluiten bent, niet andersom.

## Testen

```bash
npm test
```

53 tests, geen hardware nodig: CRC tegen de bekende testvector, framing,
gefragmenteerde en verminkte pakketten, de omrekening van erpm naar km/u en van
tachometer naar afstand, het nulpunt van de ritteller (ook als de VESC opnieuw
opstart en zijn tellers terugzet), de opbouw van de nmcli-commando's, het
vergelijken van versies, het herkennen van laden — inclusief de traagste lader
die we nog willen zien — welke locatiebron voorgaat bij het weer, en dat er uit
het aan/uit-scherm nooit iets anders komt dan `systemctl reboot` of
`systemctl poweroff`.

Voor de UI heb ik met Playwright op 480 × 320 doorgeklikt. Dat zit niet in de
repo, maar de aanpak is simpel: server starten, `page.tap()` op de knoppen, en
controleren dat `scrollWidth`/`scrollHeight` 480 × 320 blijven — alles moet
passen zonder scrollen.

Zonder VESC kun je er ook een nadoen met een PTY-paar: `pty.openpty()`, luisteren
op commando 4 en 47, en antwoorden terugsturen met dezelfde framing. Zo is de
hele keten te testen behalve de USB-kabel zelf.
