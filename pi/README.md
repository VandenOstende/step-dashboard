# Step Dashboard — Raspberry Pi 4 + VESC

Het dashboard uit `project/Step Dashboard.dc.html`, uitgevoerd als een echte
installatie: een Node-service die de VESC via USB uitleest en de kiosk-UI
serveert, en Chromium die die UI fullscreen op het 3,5"-scherm zet.

```
pi/
  public/index.html      de UI — 480 × 320, alles inline, geen externe requests
  src/serial.js          seriële poort zonder npm-modules
  src/vesc.js            VESC-protocol (framing, CRC16, pakketten)
  src/telemetry.js       ruwe waarden → het datacontract van de UI
  src/system.js          nmcli / bluetoothctl / mmcli / backlight / desktop
  src/weather.js         buitentemperatuur
  src/config.js          config.json + persistente staat
  src/server.js          HTTP-server en routes
  tools/vesc-probe.js    kijk wat je VESC vertelt
  tools/selftest.js      protocol- en rekentests, zonder hardware
  install/               systemd-units, udev-regels, installatiescript
```

## Waarom er (bijna) niets ingesteld hoeft te worden

De VESC-firmware rekent snelheid, afgelegde afstand en accupercentage **zelf**
uit, op basis van de wielmaat, poolparen, overbrenging en accugegevens die in
de controller staan. Die waarden zet je één keer met de setup-wizard van VESC
Tool — op je laptop of op de Pi, dat maakt niet uit; ze worden in de controller
opgeslagen, niet in de app.

Deze service vraagt ze op met `COMM_GET_VALUES_SETUP` en neemt ze over. VESC
Tool hoeft daarna niet meer te draaien: het is een GUI zonder API, en zolang
hij openstaat houdt hij de USB-poort bezet.

Controleer met:

```bash
node tools/vesc-probe.js
```

Zegt die "de setup-wizard is gedraaid", dan ben je klaar. Zegt hij van niet,
dan vertelt hij welke waarden je onder `"step"` in `config.json` moet zetten;
de service rekent het dan zelf uit.

## Installeren

Op Raspberry Pi OS (Bookworm of Bullseye), 64-bit, op een Pi 4:

```bash
sudo apt install -y nodejs chromium-browser network-manager bluez modemmanager
sudo apt install -y fonts-inter          # optioneel: het lettertype uit het ontwerp

git clone <deze repo> /tmp/step && cd /tmp/step/pi
sudo ./install/install.sh
```

Het script zet de code in `/opt/step-dashboard`, voegt de gebruiker toe aan
`dialout` (VESC) en `video` (schermhelderheid), installeert de udev-regels en
start `step-dashboard.service`.

Controleren:

```bash
systemctl status step-dashboard
curl -s http://127.0.0.1:8080/data
```

Werkt dat, zet dan de kiosk aan:

```bash
sudo systemctl enable --now step-kiosk
```

**Geen `npm install` nodig.** De service gebruikt alleen wat in Node zelf zit;
de seriële poort wordt met `stty` in raw-modus gezet en daarna als bestand
gelezen. Dat kan, omdat de VESC zich via USB als CDC-ACM-apparaat meldt, waar
de baudrate toch geen betekenis heeft. Zo is de Pi ook zonder internet te
installeren.

### Het 3,5"-scherm

De SPI-driver van zo'n display is merkafhankelijk (Waveshare, Kuman, GeeekPi…)
en valt buiten dit project. Zorg dat het scherm werkt op **480 × 320 liggend**
vóór je de kiosk aanzet; de UI is exact op dat formaat ontworpen en scrollt
niet. In `/boot/firmware/config.txt` komt dat meestal neer op de overlay van je
displayfabrikant plus:

```
display_rotate=1
```

## Configuratie

`config.json` — door jou beheerd, wordt alleen gelezen:

| sleutel | betekenis |
| --- | --- |
| `vesc.port` | bv. `/dev/ttyACM0` of `/dev/vesc`; `null` = automatisch zoeken |
| `vesc.pollMs` | pollinterval, standaard 150 ms |
| `step.*` | alleen gebruikt als de VESC geen setup-waarden levert |
| `step.packWh` | accucapaciteit voor de bereikschatting |
| `weather.latitude/longitude` | `null` = via de modem (`mmcli --location-get`) |
| `weather.place` | plaatsnaam in de topbalk |
| `system.backlightPath` | `null` = eerste map in `/sys/class/backlight` |
| `system.backlightCommand` | alternatief commando; `{level}` wordt vervangen |
| `system.desktopCommand` | wat de Desktop-knop uitvoert |

`state.json` (`/var/lib/step-dashboard/state.json`) — door de service beheerd:
de instellingen die je in de UI zet, de topsnelheid en het nulpunt van de
rit-teller. De UI slaat zelf niets op, precies zoals de briefing vroeg; de Pi
onthoudt het.

## Endpoints

| route | doel |
| --- | --- |
| `GET /data` | het datacontract, ~7×/s opgehaald |
| `GET/POST /settings` | UI-instellingen bewaren en terugvinden |
| `POST /reset-trip` | rit-teller op nul |
| `POST /reset-top` | topsnelheid op nul |
| `POST /backlight` | `{level: 20..100}` |
| `POST /desktop` | kiosk verlaten |
| `GET /wifi` | `{connected, ssid, level: 0..3}` — nmcli |
| `GET /bt` | `{connected, name, mac}` — bluetoothctl |
| `GET /modem` | `{bars: 0..5, tech}` — mmcli |
| `GET /weather` | `{temp_c, place}` — Open-Meteo |
| `GET /net?kind=wifi\|bt` | scanlijst voor het verbindingsscherm |
| `POST /net` | `{kind, id, connect}` |

`/data` levert exact het contract uit de briefing — `connected`, `speed_kmh`,
`rpm`, `erpm`, `duty`, `battery_pct`, `voltage`, `cell_voltage`,
`motor_current`, `battery_current`, `power_w`, `temp_motor`, `temp_fet`,
`wh_used`, `trip_km` — plus `fault`, de storingscode van de VESC, die als
melding in de topbalk verschijnt.

Ontbreekt een systeemtool (geen modem, geen backlight-klasse), dan geeft het
endpoint netjes een leeg resultaat en toont de UI "geen bereik" of verandert
er niets. Niets crasht daarop.

## Testen zonder step

```bash
npm test          # protocol, framing, CRC en de omrekening
npm start         # service op http://127.0.0.1:8080
```

Zonder VESC meldt `/data` `connected: false`; de UI toont dan rechtsboven
"geen vesc" en zet "Geen VESC-verbinding" in de meldingsbalk. Open je
`public/index.html` los in een browser, dan is `/data` onbereikbaar en valt de
UI na drie mislukte pogingen terug op de demo-rit.

## Bediening

* **Tik op de pagina** — volgend scherm: Rit → Motor → Accu → Rit. De drie
  puntjes onderaan tonen waar je bent.
* **Tik rechtsboven op de statusbalk** — systeemvenster met de actieve wifi en
  het mobiele netwerk, en de knoppen Verbindingen, Instellingen en Desktop.
* **Tik op een melding in de topbalk** — het volledige meldingenoverzicht.
* **Thema** volgt de klok: licht van 07:30 tot 18:00, daarbuiten donker. Te
  overrulen in de instellingen. Zonder internet heeft de Pi een RTC-module of
  `fake-hwclock` nodig, anders klopt zowel de klok als het thema niet.
* **Temperatuuralarm** vult het scherm, knippert 3× (0,5 s aan / 0,5 s uit) en
  blijft daarna staan tot je bevestigt. Amber en rood alarmeren apart.

## Afwijkingen van het prototype

Drie dingen zijn bewust anders dan in `Step Dashboard.dc.html`:

1. **`tempWarn` staat op 70 °C** in plaats van 100. In het component stond de
   waarschuwingsdrempel bóven de kritieke drempel (90 °C), waardoor de
   waarschuwing pas ná het kritieke alarm zou komen. 70/90 is wat de
   oorspronkelijke briefing vroeg; beide zijn instelbaar en de service
   accepteert geen warn boven crit.
2. **De topsnelheid loopt op elk scherm door.** In het prototype werd hij
   alleen bijgehouden zolang je op het rit-scherm stond, dus een sprint terwijl
   je naar het motorscherm keek telde niet mee.
3. **In het lichte thema is `--color-accent-300` donker gemaakt.** Het
   component liet die op `#d2cefd` staan, precies de kleur die het lichte thema
   ook als achtergrond van een verbonden netwerkrij gebruikt — het label
   "verbonden" was daar onleesbaar.

Verder is de lijst in het verbindingsscherm nu echt: hij komt van `/net` in
plaats van uit de vaste demo-lijst, en een rij toont kort "verbinden…" terwijl
`nmcli` of `bluetoothctl` bezig is. Wifi-netwerken die een wachtwoord nodig
hebben tonen dat als status — een schermtoetsenbord zit er niet in, dus koppel
zo'n netwerk één keer via `nmcli` of de desktop; daarna kent NetworkManager het
en werkt de knop wel.
