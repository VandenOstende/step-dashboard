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
src/config.js       config.json en de opgeslagen staat
src/server.js       de HTTP-server
tools/vesc-probe.js kijken wat je VESC vertelt
tools/selftest.js   tests, zonder hardware
```

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

## Lagen op het scherm

De overlays zitten op vaste z-index-niveaus:

```
6  temperatuuralarm
5  schermtoetsenbord
4  systeem en instellingen
3  meldingen
2  verbindingen
```

Het alarm staat bewust bovenaan. Een te warme motor moet je onderbreken terwijl
je een wachtwoord intypt, niet andersom.

## Testen

```bash
npm test
```

28 tests, geen hardware nodig: CRC tegen de bekende testvector, framing,
gefragmenteerde en verminkte pakketten, de omrekening van erpm naar km/u en van
tachometer naar afstand, het nulpunt van de ritteller (ook als de VESC opnieuw
opstart en zijn tellers terugzet), en de opbouw van de nmcli-commando's.

Voor de UI heb ik met Playwright op 480 × 320 doorgeklikt. Dat zit niet in de
repo, maar de aanpak is simpel: server starten, `page.tap()` op de knoppen, en
controleren dat `scrollWidth`/`scrollHeight` 480 × 320 blijven — alles moet
passen zonder scrollen.

Zonder VESC kun je er ook een nadoen met een PTY-paar: `pty.openpty()`, luisteren
op commando 4 en 47, en antwoorden terugsturen met dezelfde framing. Zo is de
hele keten te testen behalve de USB-kabel zelf.
