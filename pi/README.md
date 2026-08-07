# How it fits together · Hoe het in elkaar zit

**[English](#english)** · **[Nederlands](#nederlands)**

> *TRANSLATED WITH CLAUDE, UI MADE BY CLAUDE DESIGNER*
>
> *VERTAALD MET CLAUDE, UI GEMAAKT DOOR CLAUDE DESIGNER*

---

## English

Installing and configuring is in the [README at the top of the repo](../README.md).
This is more of a notebook to myself about how the code works and why some of it
is odd.

```
tools/layout-body.html   the markup — one source for both layouts
tools/build-layouts.js   assembles the two pages from it
public/index.html    landscape, 480 × 320   ← output
public/portrait.html portrait,  320 × 480   ← output
public/theme.css     the design language and the sizing, shared by both
public/app.js        the behaviour, shared by both
src/serial.js        serial port without npm modules
src/vesc.js          VESC protocol: framing, CRC16, packets
src/telemetry.js     raw values → what the UI expects
src/system.js        nmcli, bluetoothctl, mmcli, backlight
src/weather.js       outside temperature
src/charge.js        recognising that the battery is charging, and for how long
src/config.js        config.json and the stored state
src/setup.js         does the VESC know how the scooter is put together?
src/modes.js         riding modes: the limits packet for the VESC
src/update.js        comparing the version with GitHub
src/server.js        the HTTP server
install/step-update  the script that updates as root
tools/design.js      design environment: the UI with faked hardware
tools/vesc-probe.js  seeing what your VESC has to say
tools/selftest.js    tests, no hardware needed
```

### Two layouts, one source

No framework and no bundler. The Pi has no internet, so everything is local:
`theme.css` for the design language, `app.js` for the behaviour, icons as inline
SVG. Inter is used if you have it installed (`apt install fonts-inter`),
otherwise it falls back to system-ui — the design leans on shape, not on one
particular typeface.

`index.html` is landscape, `portrait.html` is portrait, and both are **output**.
The markup lives once in `tools/layout-body.html`, and the design language plus
the sizing for both in `public/theme.css`; the `data-layout` attribute on the
body picks which half applies. `tools/build-layouts.js` assembles the two pages:

```bash
node tools/build-layouts.js     # after every change to layout-body.html
```

Everything that can be shared really is shared — markup, design language,
behaviour. Two hand-written pages drift apart at the first change, and then a
button works in one layout and not in the other. That's exactly the kind of
mistake you only find on the handlebars.

The design language is Nocturne, the original design: dark blue ground, purple
accent, flat cards with a 1 px border, dots at the bottom, and a battery that
colours the whole card as it drains. There were four styles side by side for a
while — Windows, Apple and Cyber as well, selectable in the settings. That was
rolled back; if you want to see them, they're in commit `5c6acd5`.

Which page you're looking at is on the body:

```html
<body data-layout="Liggend">     <!-- or "Staand" -->
```

`app.js` reads that as `PAGE_LAYOUT`. If the settings hold a different layout,
the page redirects to the other one at startup — before the timers start. The
kiosk needs to know nothing: it always opens `/` and ends up in the right place.

Switching saves first and jumps afterwards (`saveSettingsNow`). With the normal
save, which waits 400 ms, the POST dies with the reload and the other page sends
you straight back.

What a new layout has to honour: every id `app.js` touches must exist in the
markup, and elements `cls()` writes to keep exactly the classes that script puts
on them (`#tm` is `v big`, `#batcard` is `card`). Both are extractable from
`app.js` with a regex and checkable — that saves hunting.

Rendering happens ~6× a second and only touches the nodes that actually change —
hence `cacheT` and `cacheS` in `paint()`. The little screen is slow; a normal
redraw loop makes it unusably slow.

There's a demo mode too. If `/data` is unreachable, the page simulates a ride
itself after three failed attempts. So you can work on the looks by simply
opening the HTML file.

### The VESC protocol

Framing is in `vesc.js`, taken from `bldc/comm/packet.c`:

```
0x02 len(1)  payload  crc16(2)  0x03      short packets
0x03 len(2)  payload  crc16(2)  0x03      longer ones
```

CRC is CRC16-CCITT, poly 0x1021, init 0.

What cost me an evening: **a start byte cannot be trusted.** A payload byte can
look just like one, and a false start like that can declare a length that runs
straight over the next, real packet. Then you're waiting for bytes that never
come and you've lost a valid packet. So `_scan()` validates a candidate
completely — start byte, expected command, CRC *and* the closing 0x03 — before
accepting it, and when in doubt just keeps looking further in the buffer. There's
a test for it with a deliberately mangled packet followed by a good one.

We ask for two things: `COMM_GET_VALUES` for temperatures, currents and faults,
and `COMM_GET_VALUES_SETUP` for speed, distance and battery level. If the
firmware doesn't answer that second one, it gives up after a few rounds and
`telemetry.js` works it out itself.

### Knowing whether the VESC knows

`COMM_GET_VALUES_SETUP` gives speed, distance and battery level ready-made — but
only if the setup wizard in VESC Tool has been run. If it hasn't, that packet
comes back full of zeroes and `telemetry.js` computes it from the `step` block in
`config.json`. So the difference matters, and `setup.js` watches for it.

The catch: **standing still, both look identical.** A configured and an
unconfigured VESC both report zero when the wheel isn't turning. So the check
only counts above 500 erpm, and until then the status stays `"unknown"` — which
the UI says out loud rather than guessing.

If the VESC does know, there's something to learn from it. It computes

```
speed = erpm / polePairs / gearRatio / 60 × circumference
```

and we see only the left- and right-hand sides. Pole pairs, gearing and wheel
size can't be separated out of that — their combination can. So the two from
`config.json` stay put and the wheel size is solved for. Right first two, right
wheel size; wrong ones, and it's a stand-in that yields the same speed. For
computing km/h that makes no difference, and that's what it's for.

A median over twelve samples, not one: erpm and speed come from two different
packets and don't line up while accelerating. Below a 2% difference nothing is
written, otherwise `config.json` gets touched every ride for half a millimetre.

Writing is the one exception to "config.json is yours, we only read it". It's
read-merge-write so anything else in the file survives, and via a temp file plus
rename so a power cut halfway doesn't leave a broken config behind. It never
writes over `source: "hand"` — what you set yourself stays set. And if the write
fails (read-only filesystem), it gives up rather than retrying every 150 ms.

### Riding modes

`COMM_SET_MCCONF_TEMP` (48) and `COMM_SET_MCCONF_TEMP_SETUP` (49) exist for
exactly this. Payload, from `bldc/comm/commands.c`:

```
u8   store, forward_can, ack, divide_by_controllers
f32  l_current_min_scale, l_current_max_scale      0..1
f32  min, max speed        (m/s on 49, erpm on 48)
f32  l_min_duty, l_max_duty
f32  l_watt_min, l_watt_max
f32  l_in_current_min, l_in_current_max            optional, backwards compatible
```

**`store` stays zero. Always.** It goes to the controller's working memory;
setting it to 1 writes to flash, which has a finite number of write cycles and
where a half-finished write costs you your motor configuration. There's a test
on the wire bytes that fails if that byte is ever anything but zero.

`buffer_append_float32_auto` in the firmware turns out to be plain IEEE-754 big
endian — `frexp`, exponent + 126, mantissa `(sig − 0.5)·2·2²³`, which is exactly
what `writeFloatBE` produces. So no custom encoder, but there *is* a test that
reimplements the C version and compares byte for byte, because that claim is
the kind that quietly stops being true. The one difference is subnormals, which
the firmware flushes to zero; a second test pins that down and asserts we never
send one.

Which command depends on `setup.js`: with the wizard run, 49 with the speed in
m/s and the VESC converting it with the wheel size it knows; without, 48 with
the erpm computed from `step.*`. That way the speed cap never depends on a
wizard that may not have run.

We set `ack = 1`, so the VESC replies with a single byte: the command number.
That number had to go into `EXPECTED` in `vesc.js`, otherwise `_scan()` throws
the reply away as a false start byte.

The packet is built in `modes.js` and nowhere else; `vesc.js` only sends it. So
the bytes can be checked without a serial port, the same way `wifiConnectPlan()`
works for nmcli.

A profile is a set of absolute values from `config.json`, not a delta — the app
can't read the current limits out of the controller without parsing the whole
mcconf block, which is firmware-version specific. `currentMaxScale` is the one
field that's inherently safe: 0..1 of what's in the controller, clamped by the
firmware itself.

The buttons come from the markup: anything with `class="seg mode"` and a
`data-mode` joins in, wherever it sits, because the handler is delegated. An
empty `<div id="modes">` gets filled from `config.json` — that container is
owned by `app.js` and rebuilt when the list differs; buttons elsewhere are the
design's and only get their `.on` or `hidden`.

One fix came along with it: the tap listener on `#panes` now ignores taps that
start on a `button`. Without that, a mode button on the ride screen would
switch the mode *and* move to the next screen.

### Serial without npm

`serial.js` puts the port in raw mode with `stty` and then reads it with `fs`.
That works because the VESC is a CDC-ACM device, where the baud rate has no
meaning — so there's nothing to do about line parameters.

One trap: do **not** use `fs.promises.open()`. It hands back a `FileHandle`, and
as soon as that object is collected Node closes the underlying fd — in the middle
of a running read. That produced an `EBADF` and a reconnect every few seconds.
With the callback form of `fs.open()` you get a bare fd and the problem
disappears.

The read loop runs with `stty min 0 time 1`, so `read()` returns after 100 ms
even when there's nothing. Otherwise a threadpool slot stays occupied forever.

### Wi-Fi passwords

The on-screen keyboard sends the password to `nmcli --ask` over **stdin**, not as
an argument. Arguments show up in `ps` and `/proc` and are readable by any local
user. If NetworkManager already knows the network with a wrong password, the
profile is updated and reactivated. Old nmcli versions don't know `--ask`; then it
falls back to the argument form.

`wifiConnectPlan()` only builds the command and runs nothing, so the tests can
check what *would* happen — including that the password really doesn't end up in
the arguments.

All system calls go through `execFile` with an argument list, never through a
shell. An SSID with a semicolon in it must not become a command.

### Bluetooth scanning

`bluetoothctl scan on` doesn't do what you think. The scan is tied to the
process: close it and the scan stops. And because `run()` always closes stdin —
otherwise bluetoothctl sits waiting for input — that process is gone immediately.
So you start a scan that lasts zero seconds.

`--timeout N` fixes it: the process stays up for exactly N seconds and then stops
by itself, so there's no background process to babysit. We don't wait for it. The
server only remembers until when it's scanning and returns the list right away;
the UI re-fetches every two seconds, because devices appear one at a time. If
your bluez doesn't know `--timeout` (older than 5.55), that shows up as "search
not supported" on the search row rather than nothing happening.

`bluetoothctl devices` without a filter also returns what the scan just found, so
nothing extra is needed for that. The list puts connected first, then paired,
then whatever has a name. Nameless devices — just a mac address — go at the
bottom and are not dropped: sometimes that odd address is exactly your headset.

### Where the scooter is

The outside temperature in the top left needs coordinates. They come from
`config.json`, otherwise from the GPS of a 5G modem, and otherwise from a lookup
on the IP address. That last one exists because most scooters have no modem and
nobody feels like looking up coordinates by hand. Turn it off with
`weather.ipFallback: false`.

The top bar shows only the number. The place name still comes out of `/weather` —
handy for checking where it thinks it is — but on 480 px every word you don't
need is one too many.

Ride out of Wi-Fi range and it holds the last known temperature for three hours.
It doesn't suddenly get ten degrees colder outside, and an old number is more
useful than an empty box.

Mobile signal works the other way round: `modem()` returns `present`, and if
there's no dongle the bars disappear from the top bar entirely. Reporting "no
signal" about hardware that isn't there is not information. Appearing may be
immediate, disappearing only after three rounds of nothing — ModemManager goes
quiet for a moment when it restarts, and the top bar shouldn't blink for that.

### Updating itself

Two pieces. `src/update.js` fetches the latest commit through the public GitHub
API and compares it with `version.json`, which `install.sh` writes on every
install. Installing is done by `step-update`, a separate script that runs as
root.

That script has to start **detached**, because at the end it restarts the very
service the call came from — without `systemd-run` it cuts itself off halfway.
That's also why progress comes from a status file in `/var/lib/step-dashboard/`
and not from the process: the UI keeps reading that while the server restarts
under its hands.

The script lives in `/usr/local/sbin/` and not in `/opt/step-dashboard`, because
that directory belongs to the service user. A script you can edit yourself *and*
are allowed to run with sudo is a back door to root. For the same reason there
are no wildcards in the sudoers rule: `step-update` reads the repository and the
branch from `config.json` itself, so nothing has to pass through sudo.

It always fetches a fresh clone instead of pulling in the directory where you
once ran `git clone` — that one may have been moved or thrown away.

### Power

`systemctl reboot` and `poweroff` are normally allowed without root, but through
logind — and that wants a session. The service runs as a system daemon without
one, so polkit refuses. Hence sudo, with two spelled-out rules.

What the UI sends never reaches the command: `powerCommand()` looks up
`"reboot"` or `"shutdown"` in a table and returns `null` for anything else. So
there is no string that runs from the browser all the way to sudo.

The screen is the confirmation. Another "are you sure" on a touchscreen only
makes it more annoying, not safer — and you're two taps away from it starting on
the ride screen.

### What's different in portrait

Portrait is 320 px wide, and that forces a few things:

- **Button rows** (system, power) no longer fit side by side with readable
  labels, so they stack. Watch out for `flex:none` there: the shared `.pbtn` has
  `flex:1`, and in a column that doesn't grow itself that means a basis of zero —
  the buttons then shrink to the height of their own text. They were 20 px tall
  like that, and you don't hit that with a thumb. They're a fixed 64 px now, and
  `margin-top:auto` keeps them at the bottom where your thumb already is.
- **The keyboard** has ten keys per row, so 27 px wide. That's narrow, but
  there's height to spare: the keys are 59 px tall and stuck to the bottom.
  Stretching them over the full height gave 91 px keys, and you don't aim better
  for that.
- **The speed unit** sits on the baseline of the big digits through
  `align-items: baseline` on `#speedrow`, with a bit of `padding-bottom` on
  `#speedmeta` to line up "max 41" underneath it. A fixed number of pixels stops
  being right the moment Inter is or isn't installed.

### The design environment

```bash
npm run design      # http://127.0.0.1:8081/design
```

`tools/design.js` serves `public/` exactly as the real server does, but every
endpoint is faked. Next to the frame sit sliders and switches for speed,
battery, temperatures, charging, Wi-Fi, Bluetooth, modem and weather, plus
ready-made situations (riding, motor hot, low battery, charging, no VESC) so you
can reach every screen in one click. The frame reloads by itself when a file in
`public/` changes.

Three buttons pick the layout: landscape, portrait, and **Staand op 480 × 320** —
the portrait page in a landscape frame, exactly like on the scooter, so you see
a wrong rotation here instead of on the handlebars.

`install.sh` deletes `tools/design.js` and `tools/design.html` after copying.
The design environment is for the computer, not for the Pi.

### Concepts

`tools/concepts/` is empty — there are no designs sitting next to the app any
more. What used to be there (nocturne, wijzerplaat, cyber, apple, windows) is in
the history: `git show ab1a694:pi/tools/concepts/` shows them.

The mechanism is still there. Drop an `.html` into `tools/concepts/` and it shows
up by itself as a button under the frame of the design environment, served on
`/concept/<name>`. Such pages load the real `public/app.js` — same element ids,
same behaviour — with only different markup around it, so you click through a
working UI and not a picture. They deliberately don't belong in `public/`: until
a design is approved it doesn't belong in the app.

What a new set of markup has to honour:

- **every id `app.js` touches must exist** — otherwise the render loop falls
  over. Extractable with a regex from `app.js`; the builder of the portrait
  version does exactly that.
- **elements `cls()` writes to keep their base classes**, because that function
  overwrites `className` wholesale (`#tm` is `v big`, `#batcard` is `card`).
- **the colour names `app.js` writes straight into style attributes must exist**:
  `--color-crit-fill`, `--color-warn-fill`, `--color-warn`, `--color-accent`,
  `--color-neutral-800`, `--color-neutral-500` and `--color-text`. Forget those
  and the temperature alarm loses its background and the arcs of the Wi-Fi icon
  stay grey. If your design has its own palette, point them at your own names.

What `app.js` cannot do is draw: it sets text and widths, nothing more. A design
that wants rings or segments reads `window.last` itself in its own script block.
That collides with nothing, because app.js only manages its own ids.

One trap while testing: overwriting `window.last` does nothing, because `poll()`
fetches again every 150 ms. To pin a value down and look at it, intercept
`/data` itself.

### The page rotates itself

The panel on the handlebars is 480 × 320 and stays that way, even if you pick the
portrait layout. So `fitRotation()` compares what the page was drawn for
(`DESIGN`) with what it got (`innerWidth/innerHeight`), and puts a quarter turn
on it when those don't match. The body fills the panel, `#root` keeps the design
size and is rotated about its own centre.

Why not at OS level: `display_rotate` in `config.txt` only works with certain
drivers, fbtft wants a module parameter, and under Wayland it's `wlr-randr`
again. One wrong attempt and your screen stays black while you can no longer get
at it. This is one line of CSS that does the same thing everywhere.

Touch didn't need converting: the browser hit-tests straight through the
transform. Tested with a real `touchscreen.tap()` on the Settings button in the
rotated system window.

Which way round is in `cfg.rotate` (90 or 270) — how you hang the screen decides
which of the two is right.

The design environment has a **Staand op 480 × 320** button for this: it loads
the portrait page in a landscape frame, exactly like on the scooter. Without that
button you only see a wrong rotation once it's on the handlebars.

### Notifications that go somewhere

Most notifications tell you something: too hot, battery low, VESC gone. For those
the list is the end of the line. The update notification is different — it's
about a button somewhere else. A notification that says "see Settings" is a
notification that gives you work.

So a notification like that gets an `act` in `notices()`. Tap the bar while that
one is showing and it goes straight to that screen instead of to the list; and in
the list, that row is tappable itself, with an accent border and "openen" instead
of "info" beside it. The rest of the notifications behave unchanged.

Moving is not a tap, same as in the network list: scrolling through the
notifications opens nothing.

### Buttons for the lists

The settings list is eleven rows, 564 px of content in a space of 228 px, so you
see about four of them. There is no scrollbar — that's hidden on purpose — so
nothing tells you there's more underneath, and dragging over a row full of
buttons feels risky.

Hence two chevrons in the header of every scrollable list (settings, connections,
notifications), in the same style as the close button. They're **hidden** when
the list fits entirely and **dimmed** when you're already at the top or bottom,
so they also say where you are. Jumping happens in one go, without
`behavior:"smooth"` — the SPI display is slow and a 300 ms animated scroll is
exactly what you don't want.

Holding one down repeats: after 400 ms it keeps going at about eight rows a
second, because the connections screen can show up to forty networks and that
would otherwise be forty separate taps. Dragging with a finger keeps working; the
buttons are an addition, not a replacement.

### Layers on the screen

The overlays sit at fixed z-index levels:

```
7  temperature alarm
6  power
5  on-screen keyboard, and setting the scooter up
4  system and settings
3  notifications
2  connections
1  charging
```

The alarm is deliberately on top. An overheating motor has to interrupt you while
you're typing a password or shutting something down, not the other way round.

### Testing

```bash
npm test
```

71 tests, no hardware needed: CRC against the known test vector, framing,
fragmented and mangled packets, the conversion from erpm to km/h and from
tachometer to distance, zeroing the trip counter (including when the VESC
restarts and resets its own counters), how the nmcli commands are built,
comparing versions, recognising charging — including the slowest charger we still
want to see — which location source wins for the weather, that the power
screen can never produce anything other than `systemctl reboot` or `systemctl
poweroff`, and how the VESC's setup state is recognised — including that a
single outlier doesn't skew the derived wheel size and that writing to
`config.json` leaves the rest of the file alone — and the riding-mode packet,
byte for byte, including that `store` is never anything but zero.

For the UI I clicked through it with Playwright at 480 × 320 and 320 × 480, in
both themes, over all ten screens. That isn't in the repo, but the approach is
simple: start the server, intercept `/data` to pin the values down, `page.tap()`
the buttons, and check two things — that `scrollWidth`/`scrollHeight` stay within
the panel, so everything fits without scrolling, and that every visible button
measures at least 28 px in both directions. That second check exists because the
portrait system buttons were 20 px tall for a while and nothing noticed until I
tried it on the handlebars.

Without a VESC you can fake one with a PTY pair: `pty.openpty()`, listen for
commands 4 and 47, and send answers back with the same framing. That makes the
whole chain testable apart from the USB cable itself.

---

## Nederlands

Installeren en instellen staat in de [README bovenin de repo](../README.md).
Dit is meer een notitieblok voor mezelf over hoe de code werkt en waarom
sommige dingen zo raar zijn.

```
tools/layout-body.html   de opmaak — één bron voor beide indelingen
tools/build-layouts.js   zet daar de twee pagina's uit samen
public/index.html    liggend, 480 × 320   ← uitvoer
public/portrait.html staand,  320 × 480   ← uitvoer
public/theme.css     de vormtaal en de maatvoering, gedeeld door allebei
public/app.js        het gedrag, gedeeld door allebei
src/serial.js        seriële poort zonder npm-modules
src/vesc.js          VESC-protocol: framing, CRC16, pakketten
src/telemetry.js     ruwe waarden → wat de UI verwacht
src/system.js        nmcli, bluetoothctl, mmcli, backlight
src/weather.js       buitentemperatuur
src/charge.js        herkennen dat de accu laadt, en hoelang nog
src/config.js        config.json en de opgeslagen staat
src/setup.js         weet de VESC hoe de step in elkaar zit?
src/modes.js         rijmodi: het grenzenpakket voor de VESC
src/update.js        versie vergelijken met GitHub
src/server.js        de HTTP-server
install/step-update  het script dat als root bijwerkt
tools/design.js      designomgeving: de UI met nagemaakte hardware
tools/vesc-probe.js  kijken wat je VESC vertelt
tools/selftest.js    tests, zonder hardware
```

### Twee indelingen, één bron

Geen framework en geen bundler. De Pi heeft geen internet, dus alles staat
lokaal: `theme.css` voor de vormtaal, `app.js` voor het gedrag, iconen als
inline SVG. Inter wordt gebruikt als je hem geïnstalleerd hebt (`apt install
fonts-inter`), anders valt hij terug op system-ui — het ontwerp leunt op vorm en
niet op één specifiek lettertype.

`index.html` is liggend, `portrait.html` staand, en ze zijn **allebei uitvoer**.
De opmaak staat één keer in `tools/layout-body.html` en de vormtaal plus de
maatvoering voor allebei in `public/theme.css`; het kenmerk `data-layout` op de
body kiest welke helft telt. `tools/build-layouts.js` zet de twee pagina's
samen:

```bash
node tools/build-layouts.js     # na elke wijziging in layout-body.html
```

Alles wat gedeeld kan worden is ook echt gedeeld — opmaak, vormtaal, gedrag.
Twee handgeschreven pagina's lopen bij de eerste wijziging al uit elkaar, en
dan werkt een knop in de ene indeling wel en in de andere niet. Dat is precies
het soort fout dat je pas op het stuur ziet.

De vormtaal is Nocturne, het oorspronkelijke ontwerp: donkerblauwe ondergrond,
paars accent, platte kaarten met een rand van 1 px, puntjes onderaan en een
accu die de hele kaart kleurt als hij leegloopt. Er zijn een tijdlang vier
stijlen naast elkaar geweest — Windows, Apple en Cyber erbij, te kiezen in de
instellingen. Dat is teruggedraaid; wie ze wil terugzien vindt ze in commit
`5c6acd5`.

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

### Het VESC-protocol

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

### Weten of de VESC het weet

`COMM_GET_VALUES_SETUP` geeft snelheid, afstand en accuniveau kant-en-klaar —
maar alleen als de setup-wizard van VESC Tool gedraaid heeft. Zo niet, dan komt
dat pakket vol nullen terug en rekent `telemetry.js` het uit met het blok `step`
in `config.json`. Het verschil doet er dus toe, en `setup.js` kijkt ernaar.

Het addertje: **stilstaand zien de twee er hetzelfde uit.** Een ingestelde en een
niet-ingestelde VESC melden allebei nul zolang het wiel niet draait. De controle
telt daarom pas boven 500 erpm, en tot die tijd blijft de status `"unknown"` —
wat de UI ook gewoon zo zegt in plaats van te gokken.

Weet de VESC het wél, dan valt er iets van hem af te kijken. Hij rekent

```
snelheid = erpm / poolparen / overbrenging / 60 × omtrek
```

en wij zien alleen de linker- en de rechterkant. Poolparen, overbrenging en
wielmaat zijn daar niet uit los te trekken — hun combinatie wel. Die eerste twee
blijven dus op wat er in `config.json` staat en de wielmaat wordt opgelost.
Kloppen die twee, dan klopt de wielmaat ook; kloppen ze niet, dan is het een
vervangende waarde die dezelfde snelheid oplevert. Voor het uitrekenen van km/u
maakt dat niets uit, en daarvoor is het.

Een mediaan over twaalf metingen, niet één: erpm en snelheid komen uit twee
verschillende pakketten en lopen bij het optrekken niet gelijk. Onder de 2%
verschil wordt er niets weggeschreven, anders wordt `config.json` elke rit
aangeraakt voor een halve millimeter.

Schrijven is de ene uitzondering op "config.json is van jou, wij lezen alleen".
Het gaat lezen-samenvoegen-schrijven zodat de rest van het bestand blijft staan,
en via een tijdelijk bestand plus hernoemen zodat een stroomstoring halverwege
geen kapotte config achterlaat. Over `source: "hand"` schrijft hij nooit heen —
wat jij zelf zet, blijft staan. En mislukt het schrijven (alleen-lezen
bestandssysteem), dan geeft hij het op in plaats van het elke 150 ms opnieuw te
proberen.

### Rijmodi

`COMM_SET_MCCONF_TEMP` (48) en `COMM_SET_MCCONF_TEMP_SETUP` (49) bestaan hier
precies voor. Payload, uit `bldc/comm/commands.c`:

```
u8   store, forward_can, ack, divide_by_controllers
f32  l_current_min_scale, l_current_max_scale      0..1
f32  min, max snelheid     (m/s bij 49, erpm bij 48)
f32  l_min_duty, l_max_duty
f32  l_watt_min, l_watt_max
f32  l_in_current_min, l_in_current_max            optioneel, achterwaarts compatibel
```

**`store` blijft nul. Altijd.** Het gaat naar het werkgeheugen van de
controller; op 1 zetten schrijft naar flash, dat een eindig aantal
schrijfrondes heeft en waar een halve schrijfactie je motorconfiguratie kost.
Er staat een test op de bytes over de kabel die omvalt zodra die byte iets
anders is dan nul.

`buffer_append_float32_auto` in de firmware blijkt gewoon IEEE-754 big endian —
`frexp`, exponent + 126, mantisse `(sig − 0,5)·2·2²³`, en dat is precies wat
`writeFloatBE` oplevert. Dus geen eigen encoder, maar wél een test die de
C-versie nabouwt en byte voor byte vergelijkt, want dat soort beweringen houdt
stilletjes op te kloppen. Het enige verschil zijn subnormale getallen, die de
firmware op nul zet; een tweede test legt dat vast en controleert dat wij er
nooit een sturen.

Welk commando het wordt hangt aan `setup.js`: is de wizard gedraaid, dan 49 met
de snelheid in m/s en rekent de VESC hem zelf om met de wielmaat die híj kent;
zo niet, dan 48 met de erpm die wij uitrekenen uit `step.*`. Zo hangt de
snelheidsgrens nooit aan een wizard die misschien niet gedraaid is.

We zetten `ack = 1`, dus de VESC antwoordt met één byte: het commandonummer.
Dat nummer moest in `EXPECTED` in `vesc.js`, anders gooit `_scan()` het antwoord
weg als valse startbyte.

Het pakket wordt in `modes.js` gebouwd en nergens anders; `vesc.js` stuurt het
alleen. Zo zijn de bytes te controleren zonder seriële poort, net zoals
`wifiConnectPlan()` dat voor nmcli doet.

Een profiel is een set absolute waarden uit `config.json`, geen verschil — de
app kan de huidige grenzen niet uit de controller lezen zonder het hele
mcconf-blok te ontleden, en dat verschilt per firmwareversie. `currentMaxScale`
is het enige veld dat uit zichzelf veilig is: 0..1 van wat er in de controller
staat, en de firmware klemt hem daar zelf op af.

De knoppen komen uit de opmaak: alles met `class="seg mode"` en een `data-mode`
doet mee, waar het ook staat, want de afhandeling is gedelegeerd. Een lege
`<div id="modes">` wordt gevuld uit `config.json` — die doos is van `app.js` en
wordt opnieuw opgebouwd zodra de lijst afwijkt; knoppen elders zijn van het
ontwerp en krijgen alleen hun `.on` of `hidden`.

Er ging één reparatie mee: de tik-luisteraar op `#panes` negeert nu tikken die
op een `button` beginnen. Zonder dat zou een modusknop op het rijscherm én van
stand wisselen én naar het volgende scherm springen.

### Serieel zonder npm

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

### Wifi-wachtwoorden

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

### Bluetooth zoeken

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

### Waar de step staat

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

### Zichzelf bijwerken

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

### Aan/uit

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

### Wat er staand anders is

Staand is 320 px breed, en dat dwingt een paar dingen af:

- **Knoppenrijen** (systeem, aan/uit) passen niet meer naast elkaar met leesbare
  labels, dus die staan onder elkaar. Let daar op `flex:none`: de gedeelde
  `.pbtn` heeft `flex:1`, en in een kolom die zelf niet meegroeit betekent dat
  een basis van nul — dan krimpen de knoppen tot de hoogte van hun eigen tekst.
  Ze waren zo 20 px hoog, en daar mik je met een duim niet op. Nu vast 64 px, en
  `margin-top:auto` houdt ze onderaan waar je duim toch al is.
- **Het toetsenbord** heeft tien toetsen per rij, dus 27 px breed. Dat is smal,
  maar er is hoogte zat: de toetsen zijn 59 px hoog en staan onderaan geplakt.
  Uitrekken over de hele hoogte gaf toetsen van 91 px, en daar mik je niet beter
  door.
- **De eenheid bij de snelheid** staat op de basislijn van de grote cijfers via
  `align-items: baseline` op `#speedrow`, met wat `padding-bottom` op
  `#speedmeta` om "max 41" eronder uit te lijnen. Een vast aantal pixels klopt
  niet meer zodra Inter wel of juist niet geïnstalleerd is.

### De designomgeving

```bash
npm run design      # http://127.0.0.1:8081/design
```

`tools/design.js` serveert `public/` precies zoals de echte server dat doet,
maar alle endpoints zijn nagemaakt. Naast het frame staan schuiven en schakelaars
voor snelheid, accu, temperaturen, laden, wifi, bluetooth, modem en weer, plus
kant-en-klare situaties (rijden, motor heet, lage accu, laden, geen vesc) zodat
je elk scherm in één klik te pakken hebt. Het frame herlaadt vanzelf zodra er
een bestand in `public/` verandert.

Drie knoppen kiezen de indeling: liggend, staand, en **Staand op 480 × 320** —
de staande pagina in een liggend frame, precies zoals op de step, zodat je een
verkeerde draaiing hier ziet en niet op het stuur.

`install.sh` gooit `tools/design.js` en `tools/design.html` weg na het kopiëren.
De designomgeving is voor op de computer, niet voor op de Pi.

### Concepten

De map `tools/concepts/` is leeg — er staan geen ontwerpen meer naast de app.
Wat er stond (nocturne, wijzerplaat, cyber, apple, windows) zit in de
geschiedenis: `git show ab1a694:pi/tools/concepts/` laat ze zien.

Het mechanisme is er nog wél. Zet je een `.html` in `tools/concepts/`, dan
verschijnt hij vanzelf als knop onder het frame van de designomgeving en
serveert de server hem op `/concept/<naam>`. Zulke pagina's laden het echte
`public/app.js` — dezelfde element-id's, hetzelfde gedrag — met alleen een
andere opmaak eromheen, dus je klikt er doorheen als door een werkende UI en
niet door een plaatje. Ze horen bewust níet in `public/`: tot een ontwerp
goedgekeurd is hoort het niet in de app.

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
  achtergrond en blijven de boogjes van het wifi-icoon grijs. Heeft je ontwerp
  een eigen palet, laat ze dan doorwijzen naar je eigen namen.

Wat `app.js` níet kan is tekenen: hij zet tekst en breedtes, meer niet. Een
ontwerp dat ringen of segmenten wil, leest daarvoor zelf `window.last` uit in
een eigen scriptblok. Dat botst nergens mee, want app.js beheert alleen zijn
eigen id's.

Eén valkuil bij het testen: `window.last` overschrijven doet niets, want
`poll()` haalt elke 150 ms opnieuw op. Wil je een waarde vastzetten om naar te
kijken, onderschep dan `/data` zelf.

### De pagina draait zichzelf

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

### Meldingen die ergens heen gaan

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

### Knoppen voor de lijsten

Het instellingenscherm is elf rijen, 564 px inhoud in een vlak van 228 px, dus
je ziet er een stuk of vier. Een scrollbalk is er niet — die is bewust verborgen
— dus niets verraadt dat er meer onder staat, en slepen over een rij vol knoppen
voelt riskant.

Vandaar twee chevrons in de kop van elke scrollbare lijst (instellingen,
verbindingen, meldingen), in dezelfde stijl als de sluitknop. Ze zijn
**verborgen** als de lijst helemaal past en **gedimd** als je al boven- of
onderaan bent, zodat ze ook vertellen waar je zit. Springen gebeurt in één keer,
zonder `behavior:"smooth"` — de SPI-display is traag en een geanimeerde scroll
van 300 ms is precies wat je niet wilt.

Ingedrukt houden herhaalt: na 400 ms schuift hij door met zo'n acht rijen per
seconde, want het verbindingsscherm kan tot veertig netwerken tonen en dat
zouden anders veertig losse tikken zijn. Slepen met je vinger blijft werken; de
knoppen zijn een aanvulling, geen vervanging.

### Lagen op het scherm

De overlays zitten op vaste z-index-niveaus:

```
7  temperatuuralarm
6  aan/uit
5  schermtoetsenbord en step instellen
4  systeem en instellingen
3  meldingen
2  verbindingen
1  laden
```

Het alarm staat bewust bovenaan. Een te warme motor moet je onderbreken terwijl
je een wachtwoord intypt of iets aan het afsluiten bent, niet andersom.

### Testen

```bash
npm test
```

71 tests, geen hardware nodig: CRC tegen de bekende testvector, framing,
gefragmenteerde en verminkte pakketten, de omrekening van erpm naar km/u en van
tachometer naar afstand, het nulpunt van de ritteller (ook als de VESC opnieuw
opstart en zijn tellers terugzet), de opbouw van de nmcli-commando's, het
vergelijken van versies, het herkennen van laden — inclusief de traagste lader
die we nog willen zien — welke locatiebron voorgaat bij het weer, en dat er uit
het aan/uit-scherm nooit iets anders komt dan `systemctl reboot` of
`systemctl poweroff`, en hoe de setup-staat van de VESC herkend wordt —
inclusief dat één uitschieter de afgeleide wielmaat niet scheeftrekt en dat
schrijven naar `config.json` de rest van het bestand met rust laat — en het
rijmoduspakket, byte voor byte, inclusief dat `store` nooit iets anders is dan
nul.

Voor de UI heb ik met Playwright doorgeklikt op 480 × 320 en 320 × 480, in beide
thema's, over alle tien de schermen. Dat zit niet in de repo, maar de aanpak is
simpel: server starten, `/data` onderscheppen om de waarden vast te zetten,
`page.tap()` op de knoppen, en twee dingen controleren — dat
`scrollWidth`/`scrollHeight` binnen het paneel blijven, dus dat alles past zonder
scrollen, en dat elke zichtbare knop minstens 28 px haalt in beide richtingen.
Die tweede controle bestaat omdat de staande systeemknoppen een tijd 20 px hoog
zijn geweest en niets het merkte tot ik het op het stuur probeerde.

Zonder VESC kun je er ook een nadoen met een PTY-paar: `pty.openpty()`, luisteren
op commando 4 en 47, en antwoorden terugsturen met dezelfde framing. Zo is de
hele keten te testen behalve de USB-kabel zelf.
