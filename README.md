# Step Dashboard

Een eigen dashboard voor mijn elektrische step. Een Raspberry Pi 4 hangt met USB
aan de VESC-controller en toont snelheid, accu, temperaturen en de rest
fullscreen op een 3,5"-schermpje op het stuur.

De VESC-app op je telefoon is prima, maar ik wil niet rijden met een telefoon in
een houder — en ik wil zelf bepalen wat er op dat scherm staat.

## Wat het doet

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

Alles draait lokaal. Geen internet nodig, geen CDN's, geen externe fonts — de
step staat vaak buiten bereik en dan moet het gewoon werken.

## Hardware

- Raspberry Pi 4 (4 GB, maar 2 GB is ruim genoeg)
- VESC-controller via USB — bij mij een Flipsky Mini MK5
- 3,5" SPI-touchscreen, 480 × 320, liggend
- Optioneel: 5G-dongle voor het weerbericht en de bereikbalkjes

Het schermpje is traag, dus de UI ververst zo'n 6× per seconde en raakt alleen
de pixels aan die echt veranderen. Geen animaties, geen transities.

## Installeren

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

## De VESC uitlezen

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

## Instellen

`config.json` is van jou, die wordt alleen gelezen. Het belangrijkste:

| sleutel | waarvoor |
| --- | --- |
| `vesc.port` | `/dev/ttyACM0` of `/dev/vesc`; `null` = zelf zoeken |
| `step.packWh` | accucapaciteit, voor de bereikschatting |
| `step.*` | wielmaat en poolparen — alleen nodig als de VESC ze niet levert |
| `weather.*` | coördinaten en plaatsnaam voor de buitentemperatuur |
| `system.*` | backlight-pad en het commando achter de Desktop-knop |

`state.json` in `/var/lib/step-dashboard/` is van de service: je instellingen,
de topsnelheid en het nulpunt van de ritteller. De UI slaat zelf niks op, dat
doet de Pi.

## Endpoints

De pagina praat met een handvol endpoints op dezelfde origin:

| route | wat |
| --- | --- |
| `GET /data` | snelheid, accu, temperaturen — elke 150 ms |
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

## Bijwerken

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

## Zelf ermee spelen

```bash
cd pi
npm test     # 37 tests: VESC-protocol, CRC, framing, de omrekeningen
npm start    # http://127.0.0.1:8080
```

Zonder VESC eraan meldt `/data` `connected: false` en zegt het scherm
rechtsboven "geen vesc". Open je `pi/public/index.html` los in een browser, dan
is er helemaal geen server en valt de UI na drie mislukte pogingen terug op een
gesimuleerde rit — handig om aan het uiterlijk te werken zonder de step erbij te
halen.

## Nog te doen

- Het verbruik over meerdere ritten leren in plaats van de vaste Wh/km als
  aanname. De Pi zou dat moeten bijhouden, want de UI mag niks opslaan.
- Verborgen netwerken (zelf een SSID intypen) in het verbindingsscherm.
- Plaatsnaam bij het weer komt nu uit `config.json`; reverse geocoding zou
  netter zijn.
- De klok loopt fout zonder internet. Een RTC-module of `fake-hwclock` is nodig,
  anders klopt ook het automatische thema niet.

## Herkomst

Het ontwerp is eerst als klikbaar prototype gemaakt in Claude Design; die
bestanden staan nog in `project/`. De werkende versie staat in `pi/`.
