# Step Dashboard

A custom dashboard for my electric scooter, running on a Raspberry Pi 4 wired to
a VESC controller over USB.

**[English](#english)** · **[Nederlands](#nederlands)**

---

## English

A Raspberry Pi 4 hangs off the VESC controller over USB and shows speed, battery,
temperatures and the rest fullscreen on a 3.5" display mounted on the handlebars.

The VESC phone app is fine, but I don't want to ride with a phone in a cradle —
and I want to decide myself what goes on that screen.

### What it does

Three screens: **Ride** (big speed, battery percentage, estimated range),
**Motor** (temperatures, duty, currents, rpm) and **Battery** (pack voltage, cell
voltage, Wh, distance, Wh/km). Tapping the screen moves to the next one; the
three dots at the bottom show where you are.

Beyond that:

- If the motor or the FETs get too hot, a warning fills the whole screen. It
  blinks three times and then stays until you tap it away.
- Faults, low battery and excessive duty show up in the top bar, which cycles
  through them when there's more than one. Tapping opens the full list.
- The theme follows the clock: light between 07:30 and 18:00, dark outside that.
- Joining a Wi-Fi network needs no keyboard — there's one on screen (AZERTY).
- Settings for thresholds, brightness, start screen, and resetting the trip
  counter and top speed.
- On boot it checks whether a newer version is on GitHub. If there is, the
  notification bar says so and one tap in the settings installs it.
- Plug in the charger and a charging screen appears: percentage, a bar, and an
  estimate of how much longer it needs. Tap it away if it's in the way.

Everything runs locally. No internet needed, no CDNs, no external fonts — the
scooter is often out of range and it should just work.

### Hardware

- Raspberry Pi 4 (4 GB, though 2 GB is plenty)
- VESC controller over USB — mine is a Flipsky Mini MK5
- 3.5" SPI touchscreen, 480 × 320, landscape
- Optional: a 5G dongle for the weather and the signal bars

The display is slow, so the UI repaints about 6 times a second and only touches
the pixels that actually changed. No animations, no transitions.

### Installing

On Raspberry Pi OS:

```bash
sudo apt install -y nodejs chromium-browser network-manager bluez modemmanager
git clone https://github.com/VandenOstende/step-dashboard.git
cd step-dashboard/pi
sudo ./install/install.sh
```

Check that it's running:

```bash
systemctl status step-dashboard
curl -s http://127.0.0.1:8080/data
```

If that works, turn on the kiosk:

```bash
sudo systemctl enable --now step-kiosk
```

**No `npm install` needed.** There are zero dependencies. The serial port is put
into raw mode with `stty` and then read as a plain file — which works because the
VESC enumerates as a CDC-ACM device, where the baud rate is meaningless anyway.
That makes the whole install doable offline.

The SPI driver for the display is out of scope here; it differs per brand. Make
sure your screen works at 480 × 320 landscape *before* you enable the kiosk — the
UI is built for exactly that size and doesn't scroll.

### Reading the VESC

This took me the most digging, so for anyone building the same thing:

You do **not** need to put wheel size, pole pairs and gearing into this app. The
VESC firmware computes speed, distance and battery percentage itself, from what
the setup wizard in VESC Tool wrote into the controller. Just ask for
`COMM_GET_VALUES_SETUP` (command 47) and you get metres per second and a battery
level back.

VESC Tool itself doesn't need to be running afterwards — in fact it can't be:
it's a GUI without an API and it holds the USB port open.

To check whether the wizard has been run:

```bash
node tools/vesc-probe.js
```

If it says no, it tells you which values to put in `config.json`; the app then
works it out from the erpm and the tachometer.

### Configuration

`config.json` is yours; it is only ever read. The important bits:

| key | what for |
| --- | --- |
| `vesc.port` | `/dev/ttyACM0` or `/dev/vesc`; `null` = find it automatically |
| `step.packWh` | pack capacity, for the range estimate |
| `step.*` | wheel size and pole pairs — only needed if the VESC doesn't supply them |
| `update.*` | repository, branch, and whether to check or install on boot |
| `weather.*` | coordinates and place name for the outside temperature |
| `system.*` | backlight path and the command behind the Desktop button |

`state.json` in `/var/lib/step-dashboard/` belongs to the service: your settings,
the top speed and the zero point of the trip counter. The UI stores nothing
itself — the Pi does that.

### Endpoints

The page talks to a handful of endpoints on the same origin:

| route | what |
| --- | --- |
| `GET /data` | speed, battery, temperatures, charging state — every 150 ms |
| `GET/POST /settings` | store settings |
| `POST /reset-trip`, `/reset-top` | zero the counters |
| `POST /backlight` | screen brightness |
| `POST /desktop` | leave the kiosk |
| `GET /wifi`, `/bt`, `/modem` | top-bar status via nmcli, bluetoothctl, mmcli |
| `GET /weather` | outside temperature |
| `GET/POST /net` | scan networks and connect |
| `GET/POST /update` | compare the version with GitHub, and update |

If a system tool is missing — no modem, no backlight — the endpoint returns
nothing gracefully and the UI shows "no signal". Nothing crashes over it.

### Charging

A normal charger connects straight to the battery, not through the VESC, so
there's no charging current to measure — the controller only sees the pack
voltage creeping up. So that's what `src/charge.js` watches, while the scooter
is stationary: the jump when you plug in (0.2 V within a minute) and the slow
climb after that (0.12 V over five minutes). A 13S pack that fills in four
hours rises about 0.04 V per minute, and the VESC reports voltage in steps of
0.1 V — measure over a shorter window and you see nothing. If current *is*
flowing into the pack through the controller, it's obvious immediately.

The remaining time comes from a straight line fitted through the percentage
over time. For the first three minutes it says "tijd nog onbekend" rather than
inventing a number, and it gets more accurate as it goes.

The screen sits below all the panels, so you can still reach the settings past
it, and below the temperature alarm. Tap it away and it returns on the next
charging session.

### Updating

Settings → top row. It shows which version is running; **Search** checks GitHub
and **Install** fetches the new one and restarts the service. That last part
takes about half a minute, during which the screen reloads.

Under the hood it pulls a fresh clone into a temporary directory and runs
`install/install.sh` from there. Your `config.json` and stored settings survive.
If fetching or installing fails, the old version keeps running — nothing is
replaced until the clone has landed.

From the terminal it works too:

```bash
cd ~/step-dashboard && git pull
cd pi && sudo ./install/install.sh && sudo systemctl restart step-dashboard
```

Installing automatically on boot is possible via `update.autoInstall` in
`config.json`. It's off by default: a broken version installing itself onto your
handlebars while you're trying to leave is not a pleasant prospect. *Checking*
does happen automatically — that's `update.checkOnStart`.

### Playing with it yourself

```bash
cd pi
npm test     # 47 tests: VESC protocol, CRC, framing, the conversions
npm start    # http://127.0.0.1:8080
```

Without a VESC attached, `/data` reports `connected: false` and the screen says
"geen vesc" in the top right. Open `pi/public/index.html` directly in a browser
and there's no server at all — after three failed attempts the UI falls back to a
simulated ride, which is handy for working on the looks without dragging the
scooter along.

### Still to do

- Learn the consumption across several rides instead of the fixed Wh/km
  assumption. The Pi would have to track that, since the UI isn't allowed to
  store anything.
- Hidden networks (typing an SSID yourself) in the connection screen.
- The place name for the weather comes from `config.json` right now; reverse
  geocoding would be nicer.
- The clock drifts without internet. An RTC module or `fake-hwclock` is needed,
  otherwise the automatic theme is wrong too.

### Where it came from

The design was first made as a clickable prototype in Claude Design; those files
are still in `project/`. The working version lives in `pi/`.

### A note on language

The interface is in Dutch, and so are the code comments — it's a personal
project. The structure should be readable regardless: `pi/README.md` explains how
the code fits together, also in Dutch. Ask if you'd like that translated.

---

## Nederlands

Een eigen dashboard voor mijn elektrische step. Een Raspberry Pi 4 hangt met USB
aan de VESC-controller en toont snelheid, accu, temperaturen en de rest
fullscreen op een 3,5"-schermpje op het stuur.

De VESC-app op je telefoon is prima, maar ik wil niet rijden met een telefoon in
een houder — en ik wil zelf bepalen wat er op dat scherm staat.

### Wat het doet

Drie schermen: **Rit** (snelheid groot, accupercentage, geschat bereik),
**Motor** (temperaturen, duty, stromen, rpm) en **Accu** (spanning, celspanning,
Wh, afstand, Wh/km). Tikken op het scherm gaat naar het volgende; de drie
puntjes onderaan laten zien waar je zit.

Verder:

- Wordt de motor of de FET te warm, dan vult een waarschuwing het hele scherm.
  Hij knippert drie keer en blijft dan staan tot je hem wegtikt.
- Storingen, lage accu en te hoge duty verschijnen in de bovenbalk, die
  doorloopt als er meerdere zijn. Tikken opent de volledige lijst.
- Het thema volgt de klok: licht tussen 07:30 en 18:00, daarbuiten donker.
- Wifi verbinden kan zonder toetsenbord, er zit er een op het scherm (AZERTY).
- Instellingen voor drempels, helderheid, startscherm en het resetten van de
  ritteller en topsnelheid.
- Bij het opstarten kijkt hij of er een nieuwe versie op GitHub staat. Is die
  er, dan zegt de meldingsbalk dat en werk je bij met één tik in de
  instellingen.
- Hang je de lader eraan, dan verschijnt een laadscherm: percentage, een balk,
  en een schatting hoelang het nog duurt. Wegtikken kan als het in de weg zit.

Alles draait lokaal. Geen internet nodig, geen CDN's, geen externe fonts — de
step staat vaak buiten bereik en dan moet het gewoon werken.

### Hardware

- Raspberry Pi 4 (4 GB, maar 2 GB is ruim genoeg)
- VESC-controller via USB — bij mij een Flipsky Mini MK5
- 3,5" SPI-touchscreen, 480 × 320, liggend
- Optioneel: 5G-dongle voor het weerbericht en de bereikbalkjes

Het schermpje is traag, dus de UI ververst zo'n 6× per seconde en raakt alleen
de pixels aan die echt veranderen. Geen animaties, geen transities.

### Installeren

Op Raspberry Pi OS:

```bash
sudo apt install -y nodejs chromium-browser network-manager bluez modemmanager
git clone https://github.com/VandenOstende/step-dashboard.git
cd step-dashboard/pi
sudo ./install/install.sh
```

Even controleren of het draait:

```bash
systemctl status step-dashboard
curl -s http://127.0.0.1:8080/data
```

Werkt dat, dan de kiosk aanzetten:

```bash
sudo systemctl enable --now step-kiosk
```

**Geen `npm install` nodig.** Er zitten nul dependencies in. De seriële poort
gaat met `stty` in raw-modus en wordt daarna gewoon als bestand gelezen — dat
mag, want de VESC meldt zich als CDC-ACM-apparaat en de baudrate doet er dan
toch niet toe. Zo is de hele installatie offline te doen.

De SPI-driver van het schermpje valt hierbuiten, die verschilt per merk. Zorg
dat je scherm op 480 × 320 liggend werkt vóór je de kiosk aanzet; de UI is
precies op dat formaat gemaakt en scrollt niet.

### De VESC uitlezen

Dit kostte me het meeste uitzoekwerk, dus voor wie hetzelfde wil bouwen:

Je hoeft de wielmaat, poolparen en overbrenging **niet** in deze app te zetten.
De VESC-firmware rekent snelheid, afstand en accupercentage zelf uit op basis
van wat er met de setup-wizard van VESC Tool in de controller is gezet. Vraag
gewoon `COMM_GET_VALUES_SETUP` (commando 47) op en je krijgt meters per seconde
en een accuniveau terug.

VESC Tool zelf hoeft daarna niet te draaien — sterker nog, dat kan niet: het is
een GUI zonder API en hij houdt de USB-poort bezet.

Controleren of de wizard gedraaid heeft:

```bash
node tools/vesc-probe.js
```

Zegt die van niet, dan vertelt hij welke waarden je in `config.json` moet zetten;
de app rekent het dan zelf uit uit de erpm en de tachometer.

### Instellen

`config.json` is van jou, die wordt alleen gelezen. Het belangrijkste:

| sleutel | waarvoor |
| --- | --- |
| `vesc.port` | `/dev/ttyACM0` of `/dev/vesc`; `null` = zelf zoeken |
| `step.packWh` | accucapaciteit, voor de bereikschatting |
| `step.*` | wielmaat en poolparen — alleen nodig als de VESC ze niet levert |
| `update.*` | repository, tak, en of hij bij het opstarten controleert of installeert |
| `weather.*` | coördinaten en plaatsnaam voor de buitentemperatuur |
| `system.*` | backlight-pad en het commando achter de Desktop-knop |

`state.json` in `/var/lib/step-dashboard/` is van de service: je instellingen,
de topsnelheid en het nulpunt van de ritteller. De UI slaat zelf niks op, dat
doet de Pi.

### Endpoints

De pagina praat met een handvol endpoints op dezelfde origin:

| route | wat |
| --- | --- |
| `GET /data` | snelheid, accu, temperaturen, laadstatus — elke 150 ms |
| `GET/POST /settings` | instellingen bewaren |
| `POST /reset-trip`, `/reset-top` | tellers op nul |
| `POST /backlight` | schermhelderheid |
| `POST /desktop` | kiosk verlaten |
| `GET /wifi`, `/bt`, `/modem` | topbalk-status via nmcli, bluetoothctl, mmcli |
| `GET /weather` | buitentemperatuur |
| `GET/POST /net` | netwerken scannen en verbinden |
| `GET/POST /update` | versie vergelijken met GitHub, en bijwerken |

Ontbreekt er een systeemtool — geen modem, geen backlight — dan geeft het
endpoint netjes niks terug en toont de UI "geen bereik". Niks crasht daarop.

### Laden

Een gewone lader hangt rechtstreeks aan de accu en niet via de VESC, dus er is
geen laadstroom te meten — de controller ziet alleen de pakspanning omhoog
kruipen. Daar kijkt `src/charge.js` dus naar, terwijl de step stilstaat: de
sprong bij het aansluiten (0,2 V binnen een minuut) en daarna de trage stijging
(0,12 V over vijf minuten). Een 13S-pak dat in vier uur vol is stijgt zo'n
0,04 V per minuut, en de VESC meldt spanning in stappen van 0,1 V — meet je
over een korter venster, dan zie je niets. Loopt er wél stroom de accu in via
de controller, dan is het meteen duidelijk.

De resterende tijd komt uit een rechte lijn door het percentageverloop. De
eerste drie minuten staat er "tijd nog onbekend" in plaats van een verzonnen
getal; daarna wordt het steeds preciezer.

Het scherm staat onder alle vensters, zodat je er nog bij de instellingen langs
kunt, en onder het temperatuuralarm. Wegtikken kan; bij de volgende laadbeurt
komt het terug.

### Bijwerken

Instellingen → bovenste rij. Daar staat welke versie draait; **Zoeken** kijkt bij
GitHub en **Installeren** haalt de nieuwe binnen en herstart de service. Dat
laatste duurt een halve minuut, waarin het scherm even herlaadt.

Onder water haalt hij een verse kloon in een tijdelijke map en draait daar
`install/install.sh` uit. Je `config.json` en je opgeslagen instellingen blijven
staan. Gaat het ophalen of installeren mis, dan blijft de oude versie gewoon
draaien — er wordt pas iets vervangen als de kloon binnen is.

Vanaf de terminal kan het ook:

```bash
cd ~/step-dashboard && git pull
cd pi && sudo ./install/install.sh && sudo systemctl restart step-dashboard
```

Automatisch installeren bij het opstarten kan met `update.autoInstall` in
`config.json`. Staat standaard uit: een kapotte versie die zichzelf tijdens het
opstarten op je stuur zet is geen prettig vooruitzicht. Alleen *controleren*
gebeurt wel automatisch, dat is `update.checkOnStart`.

### Zelf ermee spelen

```bash
cd pi
npm test     # 47 tests: VESC-protocol, CRC, framing, de omrekeningen
npm start    # http://127.0.0.1:8080
```

Zonder VESC eraan meldt `/data` `connected: false` en zegt het scherm
rechtsboven "geen vesc". Open je `pi/public/index.html` los in een browser, dan
is er helemaal geen server en valt de UI na drie mislukte pogingen terug op een
gesimuleerde rit — handig om aan het uiterlijk te werken zonder de step erbij te
halen.

### Nog te doen

- Het verbruik over meerdere ritten leren in plaats van de vaste Wh/km als
  aanname. De Pi zou dat moeten bijhouden, want de UI mag niks opslaan.
- Verborgen netwerken (zelf een SSID intypen) in het verbindingsscherm.
- Plaatsnaam bij het weer komt nu uit `config.json`; reverse geocoding zou
  netter zijn.
- De klok loopt fout zonder internet. Een RTC-module of `fake-hwclock` is nodig,
  anders klopt ook het automatische thema niet.

### Herkomst

Het ontwerp is eerst als klikbaar prototype gemaakt in Claude Design; die
bestanden staan nog in `project/`. De werkende versie staat in `pi/`.
