# Hoe het in elkaar zit

Installeren en instellen staat in de [README bovenin de repo](../README.md).
Dit is meer een notitieblok voor mezelf over hoe de code werkt en waarom
sommige dingen zo raar zijn.

```
public/index.html   de hele UI — één bestand, alles inline
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
tools/vesc-probe.js kijken wat je VESC vertelt
tools/selftest.js   tests, zonder hardware
```

## Aan de layout werken

```bash
npm run design      # → http://localhost:8081/design
```

Dit start een tweede server die `public/` serveert zoals de echte, maar alle
endpoints uit een scenario haalt. Geen VESC, geen nmcli, geen bluetoothctl —
je kunt er dus aan werken op je laptop, zonder step in de gang.

Het paneel zet de UI in een frame van precies 480 × 320, met een knop voor 2×
als je details wilt zien. Ernaast:

- **Scherm** — springt naar elk scherm. Deze knoppen roepen de functies in de
  pagina rechtstreeks aan (het frame is same-origin), dus je krijgt exact wat
  een tik op het schermpje ook doet. Handig voor het toetsenbord en het
  aan/uit-scherm, waar je anders drie keer moet klikken.
- **Situatie** — rijden, motor heet, lage accu, storing, laden, geen VESC.
  Elke situatie zet ook de waarden die er niet over gaan terug naar normaal,
  anders blijft het temperatuuralarm over je laadscherm heen staan.
- **Waarden** — schuiven voor snelheid, accu, duty, temperaturen, stromen.
  Zet "snelheid laten golven" uit als je een schermafdruk wilt maken.
- **Wat de UI heeft gestuurd** — elke POST die de pagina doet, inclusief de
  lengte van een ingetypt wachtwoord. Zo zie je of een knop echt iets doet.

Sla `public/index.html` op en het frame herlaadt zichzelf; het paneel kijkt elke
0,7 s naar de mtime. Dat scheelt de hele dag heen-en-weer klikken.

Dit gereedschap hoort niet op de Pi thuis. Het wordt wel meegekopieerd (de hele
`tools/` gaat mee), maar niets start het en het luistert nergens op tot je het
zelf aanroept.

## De UI is één bestand

Geen build, geen framework, geen bundler. De Pi heeft geen internet, dus alles
zit inline: de kleuren en maten uit het ontwerp staan als CSS-variabelen
bovenaan, de iconen zijn inline SVG. Inter wordt gebruikt als je hem lokaal
hebt (`apt install fonts-inter`), anders valt hij terug op system-ui.

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
