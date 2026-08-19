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
tools/page.html          the markup — one page, fifteen screens
tools/icons/             45 Phosphor SVGs (MIT)
tools/build-page.js      welds those two into public/index.html
public/index.html    portrait, 320 × 480   ← output, don't edit
public/theme.css     the design language and the sizing
public/app.js        the behaviour
public/i18n.js       the four languages and the eight accent colours
public/fonts/        JetBrains Mono, for the digits
src/serial.js        serial port without npm modules
src/vesc.js          VESC protocol: framing, CRC16, packets
src/telemetry.js     raw values → what the UI expects
src/system.js        nmcli, bluetoothctl, mmcli, backlight
src/weather.js       outside temperature
src/charge.js        recognising that the battery is charging, and for how long
src/config.js        config.json, the stored state, and sanitising the settings
src/setup.js         does the VESC know how the scooter is put together?
src/modes.js         riding modes: the limits packet for the VESC
src/cruise.js        inferring whether cruise control is on
src/ride.js          the measurement loop: everything that happens per reading
src/update.js        comparing the version with GitHub, and the release notes
src/server.js        the HTTP server
install/step-update  the script that updates as root
tools/design.js      design environment: the UI with faked hardware
tools/shots.js       the screenshots in docs/ui/
tools/bench.js       how much work the UI makes the browser do
tools/bench-loop.js  the same question for the server side
tools/pi-load.sh     what it all costs on the Pi itself
tools/vesc-probe.js  seeing what your VESC has to say
tools/selftest.js    tests, no hardware needed
```

### One page, welded together

No framework and no bundler. The Pi has no internet, so everything is local:
`theme.css` for the design language, `app.js` for the behaviour, `i18n.js` for
the words, and the icons baked into the page.

`public/index.html` is **output**. The markup lives in `tools/page.html` and the
icons as 45 separate SVGs in `tools/icons/`; `tools/build-page.js` makes one
sprite out of them, drops it in at `<!--ICONEN-->`, and writes the result:

```bash
node tools/build-page.js
```

Why a build step for a single page: the icons. The design uses 45 from Phosphor
and pulls them off unpkg. That's not available on the scooter, so they have to be
in the file — and pasting 45 SVGs into the markup by hand makes it unreadable and
unmaintainable. They're fetched from
`raw.githubusercontent.com/phosphor-icons/core/main/assets/<variant>/<name>.svg`;
Phosphor is MIT. In the markup you use them as:

```html
<svg class="ico"><use href="#i-gauge"></use></svg>      <!-- regular -->
<svg class="ico"><use href="#i-warning-f"></use></svg>  <!-- fill -->
```

The same script is the safety net under the trapeze. It checks that every id
`app.js` touches exists in the markup, and that every icon that gets called has a
drawing. A typo in an id otherwise gives you a silent, half-working UI; a typo in
an icon name gives you an empty square, and the browser says nothing about
either. Both checks are in `npm test` as well, so it can't be forgotten.

There used to be two layouts, landscape and portrait, assembled from one shared
body. Ride Dash is portrait only and `build-layouts.js`, `layout-body.html` and
`portrait.html` are gone.

### Four languages, one table

`public/i18n.js` holds `T.nl`, `T.en`, `T.fr` and `T.de`, and the eight accent
colours. The file was generated from the design rather than retyped — the design
already had all four languages in it, and copying 67 keys by hand four times is
asking for trouble.

Text in the markup carries `data-t="key"`; `applyLang()` walks over those and
fills them in. Anything the app composes at runtime goes through `t.<key>`
directly. Switching language is `applyLang()` plus a repaint — no reload, so it
works while you're riding.

A test checks that all four languages have exactly the same keys, that none of
them is empty, and that every `data-t` in the page resolves. Add a text and it
has to be in all four.

### Everything the user picks goes to the Pi

Language, units, accent colour, day or night, the three temperature limits and
their switches: they all live in `state.json`, over `GET`/`POST /settings`. The
design put them in `localStorage`, which won't do here — the kiosk profile is
disposable, and a setting you can't read from anywhere else isn't much of a
setting.

`schoneSettings()` in `config.js` is the gatekeeper. Whatever comes in, something
valid comes out: the accent colour has to be one of the eight, the language one
of four, the limits are clamped to their ranges, the switches stay booleans. It
runs on reading too, not just on writing, because a `state.json` from the
previous version still has `theme: "Auto"` and a layout in it and the UI can't do
anything with those.

The accent colour is one CSS variable. `applyTheme()` sets `--accent`,
`--accent-soft` (the same colour at 12 or 18 % depending on the theme) and
`--accent-ink` (darkened for the day theme, because the raw colour is too light
on white). Everything else in `theme.css` refers to those three, so eight colours
cost three lines of JavaScript instead of eight palettes.

### What the VESC doesn't measure

Battery temperature is the honest case: the controller has no input for it, so
`temp_batt` is `null` — not `0`. The UI shows **n/a**, the limit still exists and
can be set, and the alarm skips that one. A zero would have read as "very cold"
and put a green tick next to a sensor that isn't there.

The odometer is the other one. The VESC has no odometer that survives a restart:
its tachometer starts at zero the moment the controller powers up. So
`telemetry.js` accumulates it — each measurement adds the bit that came in
between, a counter running backwards means a restart and the reference moves
along, and the total goes to `state.json` every ten seconds. Not every
measurement: `state.patch()` postpones the write by half a second, so patching
seven times a second means it never happens while you ride.

Riding time works the same way, for Timer A and the average speed, and only while
the scooter is actually moving. The jump is capped at two seconds so a hiccup in
the loop or a suspended tab doesn't land in the counter.

Charging current is only reported when the charger runs through the controller.
On most scooters it hangs straight off the battery, the VESC sees nothing of it,
and the charging screen says n/a there too.

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

### Guessing at cruise control

The VESC doesn't report it. `cc_button` in `app_adc.c` is a hardware pin off
the UART-TX or ICU pad and never reaches the comms interface, and
`mc_interface_get_control_mode()` — which flips to `CONTROL_MODE_SPEED` the
moment cruise engages — appears nowhere in `commands.c`.

What the firmware does do is this:

```c
if (current_mode && cc_button && fabsf(pwr) < 0.001) {
    ...
    mc_interface_set_pid_speed(pid_rpm);
```

Throttle at zero, motor still pulling, speed held. That combination occurs
nowhere else, so `cruise.js` watches for it: throttle below 0.02, above 500
erpm, motor current above `cruise.minCurrentA`, and the erpm inside 4 % over the
last half second.

**The important guard is `supported`.** It stays false until the throttle
*voltage* has been seen above 0.2 V. Without an ADC throttle the decoded level
sits at zero forever, and "throttle released while current flows" would then be
permanently true. A throttle at rest reads about 0.8 V; nothing connected reads
zero. That one check is what keeps this from being a lie generator.

On after 600 ms of the pattern, off after 200 ms without it. Asymmetric on
purpose: slow to claim, quick to drop, and one odd sample doesn't make it
flicker.

`COMM_GET_DECODED_ADC` (32) goes out **every other round** — 3 Hz is plenty for
something that has to hold for half a second, and it halves the traffic for that
packet. Same fallback as `useSetup`: firmware that never answers gets asked six
times and then left alone.

One thing the wire test caught and unit tests couldn't: this must be fed from
the VESC's own `values` event, **not** from the `/data` route. Hang it off the
request and the sample window follows however often the browser polls, so the
half second it's supposed to hold for stops meaning anything. It's the kind of
mistake that passes every test until you drive it.

The interface gets two hooks and no opinions: `<body>` gets the class `cruise`,
and anything with `data-cruise` gets `hidden` while it's off. The scan runs
every paint rather than only on a change, so an element that appears later still
lines up; nothing is written unless the value actually differs.

Only for ADC throttles. `app_ppm.c` has no cruise control, and the nunchuk has
it but through `COMM_GET_DECODED_CHUK` (33) with different logic.

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

The release screen shows what's actually in the update. That's a second call:
GitHub's compare API (`/compare/<current>...<latest>`) returns the commits in
between, and those become the list. It's only fetched when there is something
new, and if it fails there's simply no list — a version you can install is more
important than the story behind it.

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

If the command is refused — missing sudo rule, broken install — the off screen
says so ("Failed — tap to go back") instead of showing "Tap to wake" while the
machine quietly keeps running. A connection that dies without an answer is the
opposite case: that is what shutting down looks like, and the screen stays as
it is. The gaps between Reboot, Shutdown and Cancel also belong to the nearest
button now — a tap between two rows used to land on nothing.

### Sizing on 320 × 480

Portrait is 320 px wide, and that decides a lot. The numbers below come from the
design and are worth knowing before you move something:

- The page is a flex column with `gap: 8px` and `padding: 10px 12px 12px`, so the
  content is exactly 296 px wide. The ride area in the middle is `flex: 1`; the
  battery row and the three cards are `flex: none`. Everything else follows from
  that.
- **The speed** is 132 px with `line-height: 1.69`, so its line box is 223 px
  tall. That looks like a mistake and isn't: it's what pushes the unit down and
  keeps the number optically centred in the space above the battery.
- `#speedbtn` is a flex item with `min-width: 0`. Without that the 132 px digits
  set the minimum width of the whole row and everything beside them gets pushed
  off the screen. That is exactly what happened the first time.
- **The bell column is absolutely positioned**, not a flex item. The design had a
  duty bar on the right to balance it; that bar is gone, and in the flex row the
  big number would then sit 24 px off the centre of the screen. Out of the flow,
  the number is centred on the panel and the bell floats in the left margin.
- **The keys** are ten per row on 296 px, so about 26 px wide, and 52 px tall.
  Narrow, but there's height to spare and you aim with your thumb vertically.
- **The digits are JetBrains Mono**, the words are Inter. Two weights, 400 and
  500; that is everything this UI needs, since the heaviest thing on screen is
  the word WARNING and that stays Inter. The assignment is surgical: the twelve
  rules in `theme.css` that carry `font-variant-numeric: tabular-nums` are
  exactly the elements that hold numbers, and those twelve got
  `font-family: var(--mono)`. One exception: the unit *behind* a number is a
  word, not a figure — `km/min` in the charging card goes back to Inter, which
  is also just narrow enough to fit.
- **The card labels** get about nine characters at 11 px with `.14em` of
  tracking. The design had "KILOMETERSTAND" there and it ran over the edge;
  it's **ODO** now, in all four languages. Where something still overflows — the
  trip card says "Ø VERBRUIK" when you tap it — running over beats an ellipsis,
  because the word stays readable.
- **What listens is bigger than what you see.** The back arrow and the close
  cross are 20 px icons, and on a 3.5" panel that is a target of one and a half
  millimetres — smaller than the fingertip meant to hit it. The rest of the UI
  never had that problem: a `.row` is 46 px tall, `.wide` 44, the bell 38. The
  fix keeps the drawing where it was and grows only the area that listens:
  `padding: 12px 16px` with `margin: -12px -16px`, which makes a 52 × 44 px
  target and takes the same number back out of the layout. The icon does not
  move by a pixel — `tools/shots.js` proves it, four of the fifteen screenshots
  come out byte-identical. Side effect worth having: on `.back` the area runs
  past the top-left screen edge, so the whole corner closes the sheet, and a
  corner is the easiest thing there is to hit on a touchscreen. The `Scan` chips
  use a `::after` overlay for the same reason; the topmost one is clipped by its
  scroll box, so that one grows from 21 to 27 px instead of 34. After the back
  button, every control got the same sweep — `tools/raakvlak.js` walks all
  fourteen screens and measures, via `elementFromPoint`, how big the area is
  that actually answers a tap. The bell, the status icons, the mode button, the
  ± steppers, the switches and the Clear link all grew to ≥ 44 px in at least
  one direction without moving a pixel. Two things stay small because physics
  says so: the keyboard keys (ten columns on 296 px is 25–28 px a key — but the
  5 px gaps between them now belong to the nearest key instead of to nobody)
  and whatever borders directly on another button, where the space simply runs
  out and every pixel already belongs to someone.
- **A tap that lands has to look different from one that misses.** There was no
  `:active` anywhere in this UI, so the only way you learned you had missed was
  that the screen stayed put — and then you tapped again. `.back`, `.iconbtn`
  and `.chip` now go to `--surface` while pressed.
- **A tap fires on release, a swipe never fires.** Everything used to activate
  on `pointerdown` — the moment the finger touched the glass. Start a swipe on
  a row in a scrollable list and that row fired before the scroll could begin:
  swiping through the settings opened sheets, swiping the language list
  changed the language. Everything now listens to `click`, which the browser
  only delivers when the gesture wasn't a scroll — that distinction between a
  tap and a swipe is precisely what `click` exists for. The keyboard too, and
  not just for uniformity: the ✓ key used to close the sheet on `pointerdown`,
  and the click that belongs to the release then landed on the network list
  that appeared underneath — which reopened the password sheet, empty.
  `preventDefault` on pointerdown does not stop that click. Committing a key
  on release is also what every phone keyboard does; `:active` marks the
  press. The scroll boxes also got
  `overscroll-behavior: contain`, so a swipe that reaches the end of a list
  doesn't leak into whatever is underneath.

### Light enough for the panel

The screen on the handlebars hangs off SPI. Every repaint has to be pushed
over that bus, so what matters isn't how fast the Pi is — it's how often the
browser decides something changed. `tools/bench.js` measures exactly that, by
reading Chromium's own counters through the devtools protocol:

```bash
node tools/design.js &
node tools/bench.js
```

The design as it came out of Claude Design was, measured while riding, doing
**62 style recalculations and 39 layouts per second**. Turning things off one
at a time showed where that came from:

| | style/s | layout/s |
|---|---|---|
| as designed | 62 | 39 |
| without animations | 38 | 36 |
| without transitions | 60 | 4 |
| without both | 4 | 4 |

So the actual work — read the data, write it to the screen — is those 4. The
other 58 were decoration running in a loop. Three changes fixed it:

- **The bars scale, they don't measure.** The duty bar animated `height` and the
  battery bar `width`, both in percent. Those are layout properties: every step
  makes the browser lay the page out again. What's left uses
  `transform: scaleX()`, which skips layout entirely — and the transition is gone
  with it. Data arrives 6.7 times a second; a quarter-second transition on top of
  that means the bar is *permanently* animating, which is the one thing an SPI
  display can't afford.
- **The duty bar is gone.** Duty is a float that changes on every single
  measurement, so it was the one element that wrote to the screen 6.7 times a
  second no matter what — halving the style recalculations all by itself. Speed,
  battery and the temperatures move far more slowly and mostly write nothing.
  It's still in `/data` if it ever needs to come back.
- **Blinking comes from a timer, and only when there's something to say.** An
  infinite CSS animation makes Chromium recalculate that element's style every
  frame, even with `steps()`, even when nothing changes. The blinking dot in the
  top bar alone cost 19 recalculations a second, around the clock. `app.js` now
  toggles a `.dim` class twice a second — and skips even that when no
  notification, low battery, update or charge is pending. The VESC dot doesn't
  blink at all any more: it's solid green when the link is there and red when it
  isn't, which says the same thing. Blinking means something again, and a normal
  ride has none of it. "Nearly empty" also requires there to *be* a reading:
  with no VESC `telemetry.offline()` reports 0 %, and 0 % without a measurement
  is not an empty battery — it used to set `.low` and blink forever on a
  workbench with nothing plugged in. The bell and the battery row sit in the
  ride screen, so the timer skips them while a sheet covers it; the update row
  and the charging bolt live *inside* a sheet and keep going.
- **Nothing is painted that you can't see.** With a full-screen sheet open, the
  ride screen underneath used to keep updating at 6.7 Hz. `show()` tracks which
  layers are open; `paintRide()` returns immediately when one covers it, and
  paints once when the last one closes. The speed readout is the exception —
  it covers the ride screen but its own numbers keep running, so it's built
  once and only refilled after that.

On top of that, every style write goes through a guard that skips it when the
value hasn't changed. Setting `style.width` to the same string still marks the
element dirty.

Measured again afterwards — 62 and 39 became 2 and 2, and standing still the
page does nothing at all:

| | style/s | layout/s |
|---|---|---|
| riding | 2 | 2 |
| riding with a notification | 2 | 2 |
| charging | 2 | 2 |
| settings open | 0 | 0 |
| standing still | 0 | 0 |

What's left is what actually changes. Watching the DOM for twenty seconds of
riding: the `V · A` line writes 1.1 times a second and the speed 0.9, because
those are the two numbers that genuinely move. Battery percent, the
temperatures, the odometer, trip and range wrote nothing at all in that window —
they're whole numbers that change every twenty seconds or so. Everything is
*read* 6.7 times a second, all of it from the same `/data` request; the screen
only follows where the value moved.

One warning about the tool: an earlier version counted frames with
`requestAnimationFrame`, which keeps the browser awake and then measures its
own presence — it reported a confident 60 fps in every situation. It counts
nothing but Chromium's own metrics now.

### The other side: what the server costs

The browser was the obvious place to look, and it was the wrong one to stop at.
`tools/bench-loop.js` runs the whole measurement chain against a fake state and
reports microseconds per reading and per request:

```bash
node tools/bench-loop.js
```

The answer, with 236 samples in the charging history — the branch I expected to
be expensive:

```
meting        4.3 µs/stuk    bij 6,7/s: 0.03 ms/s
verzoek       6.4 µs/stuk    bij 6,7/s: 0.04 ms/s
laden         6.7 µs/stuk    bij 6,7/s: 0.04 ms/s
```

All of it is noise. Ten times slower on a Pi it is still noise. **The
computation was never the problem.** What was:

**Three child processes every five seconds.** `/wifi`, `/bt` and `/modem` each
ran `nmcli`, `bluetoothctl` and `mmcli`, with no cache anywhere in
`system.js` — 0.6 fork/exec per second, around the clock, to draw three icons in
the top bar that hardly ever change. On a Pi 4 each of those has to open a D-Bus
connection and initialise glib; that is tens to hundreds of milliseconds of CPU
per launch. Against 6 microseconds of arithmetic.

So `ttlCache()` in `system.js`, in the same shape as `weather.js`: a result with
an expiry, plus a shared promise so two simultaneous questions run one process.
Errors are cached too — a missing `mmcli` should not be rediscovered twelve
times a minute. The client polls every 30 s and the expiry sits at 25 s,
deliberately *under* the polling interval: set them equal and a request lands
just inside the window as often as just outside, and the cache earns its keep
half the time. The modem gets five minutes once it reports `present: false`; no
dongle stays no dongle.

**36 processes a minute became 6.** The cache is dropped inside `system.js`
itself — at the end of `wifiConnect`, `wifiDisconnect`, `btConnect`,
`btDisconnect` and `btStartScan` — and not in the route, so it also works for a
page that wasn't reloaded after an update. `wifiList()` and `btList()` are not
cached at all: you only fetch those while looking straight at them.

### The measurement loop is not a request

`GET /data` used to do the arithmetic. That is cheap, as measured above — but
it's the wrong place, and one of the things it did there was a bug.

`telemetry.build()` integrates the odometer and the riding time from time
deltas. Hang that off an HTTP request and the odometer only counts while a
browser is watching: kiosk closed, counter stopped. Two browsers, and it counts
twice. The wheel-size samples in `setup.js` had the same defect — collected at
the browser's cadence instead of the VESC's, so two requests between two
readings counted the same reading twice.

That is exactly the fault that was in the cruise control before, which is why
that one already hangs off `vesc.on("values")`. Now the rest does too, in
`src/ride.js`. In its own module, for one reason: `server.js` opens a port and
starts a VESC, so it can't be `require`d from the self-test. Every other
building block here is a testable module — the measurement loop was the only one
that wasn't, and that is not a coincidence about where the faults were.

Three things it has to get right:

- **The VESC going away.** Three layers: the `status` event (the watchdog fires
  within 1.2 s, and `port.on("close")` too), a `ride.weg()` at startup because
  there is no status event if there was never a connection, and a one-boolean
  safety net in the route. Miss the event and the contract would freeze on the
  last reading.
- **`telemetry.pause()` on disconnect.** Without it the first reading after a
  gap adds the capped two seconds of riding time for a gap in which nobody rode.
  The distance counter deliberately keeps its reference: if the USB plug wiggles
  mid-ride the VESC keeps counting and that distance genuinely belongs.
- **Learning has to be able to stop without losing relearning.** The old
  `leerVanVesc` ran forever: its early return tested for `source === "hand"`, but
  after learning `source` becomes `"vesc"`, so it never fired. A plain "done"
  flag would take too much away — if the derived wheel size later drifts more
  than 2 % (different tyre, different gearing) it *should* learn again. So
  `SetupWatch` counts revisions and `Ride` skips while that counter stands still.

**State is written asynchronously now.** `writeFileSync` in a timer stops the
event loop, VESC reading included, for as long as the SD card takes. The
`JSON.stringify` still happens synchronously at the start of the write — that is
the whole trick, because everything that changes afterwards can no longer end up
in the file being written — and a revision counter is checked just before the
rename so a slow writer can never bury what `flush()` just put down.

And one line in the unit: `UV_THREADPOOL_SIZE=8`. The serial read keeps one of
the four default threadpool slots permanently occupied (`stty min 0 time 1`, so
a read returns after at most 100 ms and there is always one open), and file
serving, DNS lookups and the state writes fight over the remaining three.
Threads that do nothing cost stack space and no more.

### The design environment

```bash
npm run design      # http://127.0.0.1:8081/design
```

`tools/design.js` serves `public/` exactly as the real server does, but every
endpoint is faked. Next to the frame sit sliders and switches for speed,
battery, temperatures, charging, Wi-Fi, Bluetooth and modem, plus ready-made
situations (riding, motor hot, low battery, charging, no VESC) so you can reach
every screen in one click. The frame reloads by itself when a file in `public/`
changes.

Two buttons pick the view: **Staand 320 × 480**, the page as it was drawn, and
**Op het paneel 480 × 320**, the same page in a landscape frame — exactly like on
the scooter, so you see a wrong rotation here instead of on the handlebars.

The design environment also keeps the settings, so language, units and accent
colour survive a reload of the frame. That matters more than it sounds: without
it every screenshot comes out in a different colour.

`install.sh` deletes `tools/design.js`, `tools/design.html`, `tools/shots.js` and
`tools/icons/` after copying. Those are for the computer, not for the Pi.

### Screenshots

```bash
node tools/design.js &
node tools/shots.js         # → docs/ui/*.png
```

Fifteen pictures, taken from the running page at 320 × 480 with a device pixel
ratio of 2, and one at 480 × 320 to show the rotation. The script resets the
settings before every shot — otherwise the colour of the previous run is still in
there and no two series look alike.

Two things it has to wait for. The temperature alarm blinks seven times and its
acknowledge button fades in after 2.9 seconds, so that one gets 3.6 seconds
before the shutter. And clicking is `force: true`: the app listens on
`pointerdown` and finds its target with `closest()`, so a hit on a child element
is fine — Playwright refuses those by default.

Playwright is not in `package.json`. It's a 300 MB dependency for a repository
that otherwise has none; `PLAYWRIGHT=/path/to/playwright node tools/shots.js`
points it at an existing installation.

### The page rotates itself

The panel on the handlebars is 480 × 320. The page is 320 × 480. So
`fitRotation()` compares what the page was drawn for with what it got
(`innerWidth`/`innerHeight`) and puts a quarter turn on it when those don't
match. The body fills the panel, `#root` keeps the design size and is rotated
about its own centre.

Why not at OS level: `display_rotate` in `config.txt` only works with certain
drivers, fbtft wants a module parameter, and under Wayland it's `wlr-randr`
again. One wrong attempt and your screen stays black while you can no longer get
at it. This is one line of CSS that does the same thing everywhere.

Touch didn't need converting: the browser hit-tests straight through the
transform.

Which way round is in `rotate` (90 or 270) — how you hang the screen decides
which of the two is right.

### Notifications are derived, not stored

The bell doesn't have a list you fill; it has a list that follows from the data.
Every paint, `bouwAlerts()` works out what's wrong — a VESC fault, a battery
under 10 %, a motor or controller within ten degrees of its limit — and that *is*
the list. Cause gone, notification gone.

Dismissing puts the key on an ignore list, and that list empties itself as soon
as the cause disappears. Without that second half one tap would hide a fault
forever, which is the opposite of what dismissing should mean.

Redrawing happens on change only. This runs seven times a second, and rebuilding
the drawer's HTML every time would make the little screen crawl — so there's a
fingerprint of keys and details, and only a different one triggers a repaint.

### Layers on the screen

The overlays sit at fixed z-index levels:

```
12  temperature alarm, powered off
11  power menu, charging
 9  on-screen keyboard
 8  speed readout, units, language, accent, limits, release, scooter values
 7  connections
 6  notifications
 5  settings
```

The alarm is deliberately on top. An overheating motor has to interrupt you while
you're typing a password or shutting something down, not the other way round.

The keyboard above the connections screen is not a detail either: it opens *from*
that screen, so with the same z-index the DOM order decides, and the network list
would sit on top of the keys. It did, once — the keys reacted and you couldn't see
them.

### Testing

```bash
npm test
```

124 tests, no hardware needed: CRC against the known test vector, framing,
fragmented and mangled packets, the conversion from erpm to km/h and from
tachometer to distance, zeroing the trip counter (including when the VESC
restarts and resets its own counters), the odometer that carries on across such
a restart, the riding time that only runs while you ride, how the nmcli commands
are built, comparing versions, recognising charging — including the slowest
charger we still want to see — which location source wins for the weather, that
the power screen can never produce anything other than `systemctl reboot` or
`systemctl poweroff`, and how the VESC's setup state is recognised — including
that a single outlier doesn't skew the derived wheel size and that writing to
`config.json` leaves the rest of the file alone — and the riding-mode packet,
byte for byte, including that `store` is never anything but zero.

Nine of them are about the measurement loop, and two of those exist because of
a real fault: **the odometer keeps counting without a browser**, and **two
browsers do not count twice**. Another checks that `config.json` is written once
and not on every reading, and another that a read-only `config.json` is not
retried forever. Five more are about writing the state: three patches in quick
succession make one file, a patch during a write is not lost, the file is always
valid JSON after two hundred random patches, `flush()` is not buried by a slow
writer, and writing does not stall the event loop. Seven cover the status cache.

Six of them are about the UI without opening a browser: all four languages have
the same keys, none of the translations is empty, every `data-t` in the page
resolves, the eight accent colours of the UI are the eight the server accepts,
every id `app.js` touches exists, and every icon that gets called has a drawing
in the sprite. Those are the mistakes that produce a silent, half-working
screen, and they're cheap to catch from a file.

Beyond that I clicked through it with Playwright at 320 × 480 and 480 × 320, in
both themes, over all fifteen screens — that's what `tools/shots.js` does, and it
fails on any error in the console.

Without a VESC you can fake one with a PTY pair: `pty.openpty()`, listen for
commands 4 and 47, and send answers back with the same framing. That makes the
whole chain testable apart from the USB cable itself.

---

## Nederlands

Installeren en instellen staat in de [README bovenin de repo](../README.md).
Dit is meer een notitieblok voor mezelf over hoe de code werkt en waarom
sommige dingen zo raar zijn.

```
tools/page.html          de opmaak — één pagina, vijftien schermen
tools/icons/             45 Phosphor-SVG's (MIT)
tools/build-page.js      last die twee tot public/index.html aan elkaar
public/index.html    staand, 320 × 480   ← uitvoer, niet bewerken
public/theme.css     de vormtaal en de maatvoering
public/app.js        het gedrag
public/i18n.js       de vier talen en de acht accentkleuren
public/fonts/        JetBrains Mono, voor de cijfers
src/serial.js        seriële poort zonder npm-modules
src/vesc.js          VESC-protocol: framing, CRC16, pakketten
src/telemetry.js     ruwe waarden → wat de UI verwacht
src/system.js        nmcli, bluetoothctl, mmcli, backlight
src/weather.js       buitentemperatuur
src/charge.js        herkennen dat de accu laadt, en hoelang nog
src/config.js        config.json, de opgeslagen staat en het schonen van de instellingen
src/setup.js         weet de VESC hoe de step in elkaar zit?
src/modes.js         rijmodi: het grenzenpakket voor de VESC
src/cruise.js        afleiden of cruisecontrol aanstaat
src/ride.js          de meetlus: alles wat er per meting gebeurt
src/update.js        versie vergelijken met GitHub, en de release-notities
src/server.js        de HTTP-server
install/step-update  het script dat als root bijwerkt
tools/design.js      designomgeving: de UI met nagemaakte hardware
tools/shots.js       de schermafdrukken in docs/ui/
tools/bench.js       hoeveel werk de UI de browser geeft
tools/bench-loop.js  dezelfde vraag voor de serverkant
tools/pi-load.sh     wat het geheel op de Pi zelf kost
tools/vesc-probe.js  kijken wat je VESC vertelt
tools/selftest.js    tests, zonder hardware
```

### Eén pagina, aan elkaar gelast

Geen framework en geen bundler. De Pi heeft geen internet, dus alles staat
lokaal: `theme.css` voor de vormtaal, `app.js` voor het gedrag, `i18n.js` voor de
woorden, en de iconen in de pagina gebakken.

`public/index.html` is **uitvoer**. De opmaak staat in `tools/page.html` en de
iconen als 45 losse SVG's in `tools/icons/`; `tools/build-page.js` maakt er één
sprite van, zet die op `<!--ICONEN-->` neer en schrijft het resultaat weg:

```bash
node tools/build-page.js
```

Waarom een bouwstap voor één pagina: de iconen. Het ontwerp gebruikt er 45 uit
Phosphor en haalt ze van unpkg. Dat bestaat niet op de step, dus ze moeten mee in
het bestand — en 45 SVG's met de hand in de opmaak plakken maakt die onleesbaar
en niet meer bij te werken. Ophalen deed ik met
`raw.githubusercontent.com/phosphor-icons/core/main/assets/<variant>/<naam>.svg`;
Phosphor is MIT. In de opmaak gebruik je ze als:

```html
<svg class="ico"><use href="#i-gauge"></use></svg>      <!-- regular -->
<svg class="ico"><use href="#i-warning-f"></use></svg>  <!-- fill -->
```

Datzelfde script is het net onder de trapeze. Het controleert of elk id dat
`app.js` aanraakt in de opmaak staat, en of elk icoon dat aangeroepen wordt een
tekening heeft. Een typefout in een id levert anders een stille, halve UI op; een
typefout in een icoonnaam een leeg vierkantje, en de browser zegt over allebei
niets. Beide controles zitten ook in `npm test`, zodat het niet vergeten kan
worden.

Er waren twee indelingen, liggend en staand, samengesteld uit één gedeelde body.
Ride Dash is alleen staand, en `build-layouts.js`, `layout-body.html` en
`portrait.html` zijn weg.

### Vier talen, één tabel

`public/i18n.js` bevat `T.nl`, `T.en`, `T.fr` en `T.de`, en de acht
accentkleuren. Dat bestand is uit het ontwerp gegenereerd en niet overgetypt —
het ontwerp had de vier talen al, en 67 sleutels vier keer met de hand
overnemen is vragen om fouten.

Tekst in de opmaak draagt `data-t="sleutel"`; `applyLang()` loopt daaroverheen en
vult ze in. Wat de app zelf samenstelt gaat rechtstreeks via `t.<sleutel>`. Van
taal wisselen is `applyLang()` plus opnieuw tekenen — geen herlaadbeurt, dus het
kan onderweg.

Een test controleert of alle vier de talen precies dezelfde sleutels hebben, of
er geen enkele leeg is, en of elke `data-t` in de pagina iets oplevert. Voeg je
een tekst toe, dan moet hij in alle vier.

### Alles wat de gebruiker kiest gaat naar de Pi

Taal, eenheden, accentkleur, dag of nacht, de drie temperatuurlimieten en hun
schakelaars: ze staan allemaal in `state.json`, via `GET`/`POST /settings`. Het
ontwerp zette ze in `localStorage`, en dat kan hier niet — het kioskprofiel is
wegwerpbaar, en een instelling die je nergens anders kunt uitlezen is niet echt
een instelling.

`schoneSettings()` in `config.js` is de portier. Wat er ook binnenkomt, er komt
iets geldigs uit: de accentkleur moet een van de acht zijn, de taal een van vier,
de limieten worden binnen hun bereik geklemd, de schakelaars blijven booleaans.
Hij draait ook bij het lezen en niet alleen bij het schrijven, want in een
`state.json` van de vorige versie staat nog `theme: "Auto"` en een indeling, en
daar kan de UI niets mee.

De accentkleur is één CSS-variabele. `applyTheme()` zet `--accent`,
`--accent-soft` (dezelfde kleur op 12 of 18 % afhankelijk van het thema) en
`--accent-ink` (donkerder gemaakt voor het dagthema, want de rauwe kleur is te
licht op wit). Al de rest in `theme.css` verwijst naar die drie, dus acht kleuren
kosten drie regels JavaScript in plaats van acht paletten.

### Wat de VESC niet meet

De accutemperatuur is het eerlijke geval: de controller heeft er geen ingang
voor, dus `temp_batt` is `null` — geen `0`. De UI zet er **n.v.t.** neer, de
limiet bestaat en is in te stellen, en het alarm slaat die over. Een nul zou
gelezen zijn als "erg koud" en een groen vinkje zetten naast een sensor die er
niet is.

De kilometerstand is het andere. De VESC heeft geen teller die een herstart
overleeft: zijn tachometer begint bij nul zodra de controller opstart. Dus telt
`telemetry.js` zelf op — elke meting legt het stukje ertussen erbij, een teller
die terugloopt betekent een herstart en dan schuift het ijkpunt mee, en het
totaal gaat elke tien seconden naar `state.json`. Niet elke meting:
`state.patch()` stelt het schrijven een halve seconde uit, dus zeven keer per
seconde patchen betekent dat het nooit gebeurt zolang je rijdt.

De rijtijd werkt hetzelfde, voor Timer A en de gemiddelde snelheid, en telt
alleen terwijl de step ook echt rijdt. De sprong is afgetopt op twee seconden,
zodat een hapering in de lus of een geschorst tabblad niet in de teller belandt.

De laadstroom wordt alleen gemeld als de lader via de controller loopt. Bij de
meeste steps hangt hij rechtstreeks aan de accu, ziet de VESC er niets van, en
staat er ook op het laadscherm n.v.t.

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

### Gokken naar cruisecontrol

De VESC meldt het niet. `cc_button` in `app_adc.c` is een hardwarepin van de
UART-TX- of ICU-pad en komt nergens de comms in, en
`mc_interface_get_control_mode()` — dat op `CONTROL_MODE_SPEED` springt zodra
cruise aangrijpt — komt in `commands.c` niet voor.

Wat de firmware wél doet is dit:

```c
if (current_mode && cc_button && fabsf(pwr) < 0.001) {
    ...
    mc_interface_set_pid_speed(pid_rpm);
```

Gas op nul, motor trekt nog, snelheid vastgehouden. Die combinatie komt verder
nergens voor, dus `cruise.js` kijkt daarnaar: gas onder 0,02, boven 500 erpm,
motorstroom boven `cruise.minCurrentA`, en de erpm binnen 4 % over het laatste
halve seconde.

**De belangrijke rem is `supported`.** Die blijft onwaar tot de
hendel*spanning* boven 0,2 V is geweest. Zonder ADC-hendel blijft het
gedecodeerde niveau eeuwig nul, en dan zou "gas los terwijl er stroom loopt"
permanent waar zijn. Een hendel in rust geeft rond 0,8 V; niets aangesloten
geeft nul. Die ene controle is wat dit ervan weerhoudt een leugenmachine te
worden.

Aan na 600 ms patroon, uit na 200 ms zonder. Met opzet scheef: traag met
beweren, snel met loslaten, en één rare meting laat niets knipperen.

`COMM_GET_DECODED_ADC` (32) gaat **om de andere ronde** de deur uit — 3 Hz is
ruim genoeg voor iets dat een halve seconde moet standhouden, en het halveert
het verkeer voor dat pakket. Dezelfde terugval als `useSetup`: firmware die
nooit antwoordt wordt zes keer gevraagd en daarna met rust gelaten.

Eén ding dat de kabeltest ving en de unittests niet konden: dit moet gevoed
worden vanuit de `values`-gebeurtenis van de VESC, **niet** vanuit de
/data-route. Hang je het aan het verzoek, dan volgt het tijdvenster hoe vaak de
browser toevallig pollt, en betekent die halve seconde niets meer. Precies het
soort fout dat door elke test heen komt tot je het echt laat rijden.

De interface krijgt twee haken en geen mening: `<body>` krijgt de klasse
`cruise`, en alles met `data-cruise` krijgt `hidden` zolang het uit staat. Het
langslopen gebeurt elke tekenronde en niet alleen bij een wisseling, zodat een
element dat later in de pagina komt ook klopt; er wordt alleen geschreven als de
stand echt anders is.

Alleen voor ADC-hendels. In `app_ppm.c` zit geen cruisecontrol, en de nunchuk
heeft het wel maar via `COMM_GET_DECODED_CHUK` (33) met andere logica.

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

Het release-scherm laat zien wat er écht in de update zit. Dat is een tweede
oproep: de compare-API van GitHub (`/compare/<huidig>...<nieuwste>`) geeft de
commits ertussen terug, en die worden de lijst. Hij wordt alleen opgehaald als er
iets nieuws is, en mislukt hij, dan is er gewoon geen lijst — een versie die je
kunt installeren is belangrijker dan het verhaal erachter.
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

Weigert het commando — sudo-regel weg, installatie kapot — dan zegt het
uit-scherm dat ook ("Niet gelukt — tik om terug te gaan") in plaats van "Tik om
te starten" te tonen terwijl de machine stilletjes doordraait. Een verbinding
die zonder antwoord wegvalt is het omgekeerde geval: zo ziet afsluiten er nou
eenmaal uit, en dan blijft het scherm gewoon staan. De spleten tussen
Herstarten, Uitschakelen en Annuleren horen nu ook bij de dichtstbijzijnde
knop — een tik tussen twee rijen landde eerst op niets.

### Maatvoering op 320 × 480

Staand is 320 px breed, en dat bepaalt veel. De getallen hieronder komen uit het
ontwerp en zijn goed om te weten voor je iets verschuift:

- De pagina is een flexkolom met `gap: 8px` en `padding: 10px 12px 12px`, dus de
  inhoud is precies 296 px breed. Het rijgedeelte in het midden is `flex: 1`; de
  accurij en de drie kaarten zijn `flex: none`. De rest volgt daaruit.
- **De snelheid** is 132 px met `line-height: 1.69`, dus zijn regelvak is 223 px
  hoog. Dat ziet eruit als een vergissing en is het niet: het is wat de eenheid
  omlaag duwt en het cijfer optisch midden in de ruimte boven de accu houdt.
- `#speedbtn` is een flexitem met `min-width: 0`. Zonder dat bepalen de cijfers
  van 132 px de minimumbreedte van de hele rij en wordt alles ernaast van het
  scherm geduwd. Precies dat gebeurde de eerste keer.
- **De bel-kolom staat absoluut**, niet als flexitem. In het ontwerp gaf de
  duty-balk rechts er tegenwicht aan; die balk is weg, en in de flexrij zou het
  grote cijfer dan 24 px uit het midden van het scherm hangen. Uit de stroom
  gehaald staat het cijfer midden op het paneel en zweeft de bel in de
  linkermarge.
- **De toetsen** zijn er tien per rij op 296 px, dus zo'n 26 px breed, en 52 px
  hoog. Smal, maar er is hoogte over en met je duim mik je verticaal.
- **De cijfers zijn JetBrains Mono**, de woorden Inter. Twee gewichten, 400 en
  500; meer heeft deze UI niet nodig, want het zwaarste op het scherm is het
  woord WARNING en dat blijft Inter. De toewijzing is chirurgisch: de twaalf
  regels in `theme.css` met `font-variant-numeric: tabular-nums` zijn precies de
  elementen die cijfers dragen, en die twaalf kregen `font-family: var(--mono)`.
  Eén uitzondering: de eenheid *achter* een getal is een woord en geen cijfer —
  `km/min` op de laadkaart gaat terug naar Inter, en dat is meteen net smal
  genoeg om te passen.
- **De kaartlabels** hebben ruimte voor zo'n negen tekens op 11 px met `.14em`
  spatiëring. In het ontwerp stond daar "KILOMETERSTAND" en dat liep over de
  rand; het is nu **ODO**, in alle vier de talen. Loopt er toch nog iets over —
  de trip-kaart zegt "Ø VERBRUIK" als je erop tikt — dan is overlopen beter dan
  afkappen, want het woord blijft leesbaar.
- **Wat luistert is groter dan wat je ziet.** De terugpijl en het sluitkruisje
  zijn icoontjes van 20 px, en op een paneel van 3,5" is dat een doel van
  anderhalve millimeter — kleiner dan de vingertop die het moet raken. De rest
  van de UI had dat probleem nooit: een `.row` is 46 px hoog, `.wide` 44, de bel
  38. De oplossing laat de tekening staan waar hij stond en vergroot alleen het
  vlak dat luistert: `padding: 12px 16px` met `margin: -12px -16px`, wat een
  aanraakvlak van 52 × 44 px oplevert en datzelfde getal weer uit de opmaak
  haalt. Het icoontje verschuift geen pixel — `tools/shots.js` bewijst het, vier
  van de vijftien afdrukken komen er byte-identiek uit. Bijeffect dat je wil: bij
  `.back` loopt het vlak door tot voorbij de linkerbovenhoek, dus de hele hoek
  sluit het scherm, en een hoek is het makkelijkste doel dat er op een
  aanraakscherm bestaat. De `Scan`-knopjes doen hetzelfde met een `::after`; de
  bovenste wordt door zijn scrollvak afgeknipt en gaat daarom van 21 naar 27 px
  in plaats van 34. Na de terugknop is elke knop dezelfde ronde langsgegaan —
  `tools/raakvlak.js` loopt alle veertien schermen af en meet met
  `elementFromPoint` hoe groot het vlak is dat werkelijk op een tik antwoordt.
  De bel, de statusicoontjes, de modusknop, de plus/min-knoppen, de
  schakelaars en de Wissen-link groeiden allemaal naar ≥ 44 px in minstens één
  richting zonder een pixel te verschuiven. Twee dingen blijven klein omdat de
  natuurkunde dat zegt: de toetsen (tien kolommen op 296 px is 25–28 px per
  toets — maar de spleten van 5 px ertussen horen nu bij de dichtstbijzijnde
  toets in plaats van bij niemand) en alles wat direct aan een andere knop
  grenst, waar de ruimte simpelweg op is en elke pixel al van iemand is.
- **Een tik die raakt moet er anders uitzien dan een tik die mist.** Er stond
  nergens een `:active` in deze UI, dus je merkte alleen dat je ernaast zat
  doordat het scherm bleef staan — en dan tikte je nog een keer. `.back`,
  `.iconbtn` en `.chip` gaan tijdens het indrukken naar `--surface`.
- **Een tik vuurt bij het loslaten, een veeg vuurt nooit.** Alles reageerde op
  `pointerdown` — het moment dat de vinger het glas raakt. Begon een veeg op
  een rij in een scrollbare lijst, dan vuurde die rij nog voor het scrollen
  kon beginnen: door de instellingen vegen opende schermen, over de taallijst
  vegen veranderde de taal. Alles luistert nu naar `click`, die de browser
  alleen aflevert als het gebaar geen scroll was — dat onderscheid tussen tik
  en veeg is precies waar `click` voor bestaat. Ook het toetsenbord, en niet
  alleen voor de eenvoud: de ✓-toets sloot het scherm ooit op `pointerdown`,
  en de click die bij het loslaten hoort landde dan op de netwerklijst die
  eronder tevoorschijn kwam — die opende het wachtwoordscherm meteen weer,
  leeg. `preventDefault` op pointerdown houdt die click niet tegen. Typen op
  loslaten is bovendien wat elk telefoontoetsenbord doet; `:active` markeert
  de aanslag. De scrollvakken kregen ook
  `overscroll-behavior: contain`, zodat een veeg die het einde van een lijst
  bereikt niet doorlekt naar wat eronder ligt.

### Licht genoeg voor het schermpje

Het scherm op het stuur hangt aan SPI. Elke hertekening moet over die bus, dus
wat telt is niet hoe snel de Pi is maar hoe vaak de browser besluit dat er iets
veranderd is. `tools/bench.js` meet precies dat, door de tellers van Chromium
zelf uit te lezen via het devtools-protocol:

```bash
node tools/design.js &
node tools/bench.js
```

Het ontwerp zoals het uit Claude Design kwam deed, gemeten tijdens het rijden,
**62 stijlherberekeningen en 39 layouts per seconde**. Stuk voor stuk uitzetten
liet zien waar dat vandaan kwam:

| | stijl/s | layout/s |
|---|---|---|
| zoals ontworpen | 62 | 39 |
| zonder animaties | 38 | 36 |
| zonder transities | 60 | 4 |
| zonder allebei | 4 | 4 |

Het echte werk — de data lezen en op het scherm zetten — is dus die 4. De
andere 58 waren opsmuk die in een lus doorliep. Drie wijzigingen losten het op:

- **De balken schalen, ze meten niet.** De duty-balk animeerde `height` en de
  accubalk `width`, allebei in procenten. Dat zijn layout-eigenschappen: elke
  stap laat de browser de pagina opnieuw indelen. Wat er over is gebruikt
  `transform: scaleX()`, wat langs layout heen gaat — en de transitie is meteen
  weg. De data komt 6,7 keer per seconde binnen; een transitie van een kwart
  seconde daarbovenop betekent dat die balk *permanent* staat te animeren, en
  dat is het enige wat een SPI-schermpje niet kan hebben.
- **De duty-balk is weg.** Duty is een kommagetal dat bij élke meting verandert,
  dus dat was het enige element dat hoe dan ook 6,7 keer per seconde naar het
  scherm schreef — goed voor de helft van alle stijlherberekeningen, in zijn
  eentje. Snelheid, accu en de temperaturen bewegen veel trager en schrijven
  meestal niets. Hij staat nog wel in `/data`, mocht hij ooit terug moeten.
- **Knipperen komt uit een timer, en alleen als er iets te melden is.** Een
  oneindige CSS-animatie laat Chromium elke frame de stijl van dat element
  opnieuw uitrekenen, ook met `steps()`, ook als er niets verandert. Alleen het
  knipperende stipje in de bovenbalk kostte negentien herberekeningen per
  seconde, dag en nacht. `app.js` zet nu twee keer per seconde een `.dim`-klasse
  om — en slaat ook dát over als er geen melding, lege accu, update of laadbeurt
  is. Het stipje van de VESC knippert helemaal niet meer: het staat vast groen
  als de verbinding er is en rood als hij weg is, en dat zegt hetzelfde.
  Knipperen betekent weer iets, en op een gewone rit gebeurt het niet. "Bijna
  leeg" vraagt bovendien of er *wel* iets gemeten wordt: zonder VESC meldt
  `telemetry.offline()` 0 %, en 0 % zonder meting is geen lege accu — dat zette
  `.low` en knipperde eeuwig door op een werkbank waar niets aan hangt. De bel
  en de accurij liggen in het rijscherm, dus de timer slaat ze over zolang er
  een scherm overheen ligt; de updaterij en het laadicoontje liggen juist ín
  zo'n scherm en gaan wel door.
- **Er wordt niets getekend wat je niet ziet.** Met een scherm eroverheen liep
  het rijscherm eronder gewoon door op 6,7 Hz. `show()` houdt bij welke lagen
  open staan; `paintRide()` keert meteen terug zodra er een overheen ligt, en
  tekent één keer als de laatste dichtgaat. De snelheidsmeting is de
  uitzondering — die dekt het rijscherm af maar zijn eigen cijfers moeten
  meelopen, dus die wordt één keer opgebouwd en daarna alleen nog bijgevuld.

Daarbovenop gaat elke stijlwijziging door een controle die hem overslaat als de
waarde niet veranderd is. `style.width` op dezelfde tekenreeks zetten markeert
het element namelijk alsnog als vuil.

Daarna opnieuw gemeten — 62 en 39 werden 2 en 2, en stilstaand doet de pagina
helemaal niets meer:

| | stijl/s | layout/s |
|---|---|---|
| rijden | 2 | 2 |
| rijden met een melding | 2 | 2 |
| laden | 2 | 2 |
| instellingen open | 0 | 0 |
| stilstaand | 0 | 0 |

Wat er overblijft is wat er echt verandert. Twintig seconden rijden met een
MutationObserver erop: de regel `V · A` schrijft 1,1 keer per seconde en de
snelheid 0,9, want dat zijn de twee getallen die echt bewegen. Het accupercentage,
de temperaturen, de kilometerstand, de trip en het bereik schreven in dat venster
niets — dat zijn hele getallen die om de twintig seconden een stap doen. Alles
wordt 6,7 keer per seconde *gelezen*, allemaal uit hetzelfde `/data`-verzoek; het
scherm volgt alleen waar de waarde is opgeschoven.

Eén waarschuwing over het gereedschap: een eerdere versie telde frames met
`requestAnimationFrame`, en die lus houdt de browser zelf wakker en meet dan
zijn eigen aanwezigheid — hij meldde in elke situatie stellig 60 fps. Hij telt
nu niets anders dan de tellers van Chromium.

### De andere kant: wat de server kost

De browser was de voor de hand liggende plek om te kijken, en de verkeerde om
te stoppen. `tools/bench-loop.js` jaagt de hele meetketen langs een neppe staat
en meldt microseconden per meting en per verzoek:

```bash
node tools/bench-loop.js
```

Het antwoord, met 236 monsters in de laadhistorie — de tak waarvan ik dacht dat
hij duur was:

```
meting        4,3 µs/stuk    bij 6,7/s: 0,03 ms/s
verzoek       6,4 µs/stuk    bij 6,7/s: 0,04 ms/s
laden         6,7 µs/stuk    bij 6,7/s: 0,04 ms/s
```

Het is allemaal ruis. Tien keer trager op een Pi is het nog steeds ruis. **Het
rekenwerk was nooit het probleem.** Wat wel:

**Drie child processes per vijf seconden.** `/wifi`, `/bt` en `/modem` startten
elk `nmcli`, `bluetoothctl` en `mmcli`, zonder enige cache in `system.js` — 0,6
fork/exec per seconde, dag en nacht, om drie icoontjes in de bovenbalk te
tekenen die bijna nooit veranderen. Op een Pi 4 moet elk van die commando's een
D-Bus-verbinding opzetten en glib initialiseren; dat zijn tientallen tot
honderden milliseconden CPU per keer. Tegenover 6 microseconden rekenwerk.

Dus `ttlCache()` in `system.js`, in dezelfde vorm als `weather.js`: een uitkomst
met een houdbaarheidsdatum, plus een gedeelde belofte zodat twee gelijktijdige
vragen één proces draaien. Fouten worden ook bewaard — een ontbrekende `mmcli`
hoeft niet twaalf keer per minuut opnieuw ontdekt te worden. De client vraagt
elke 30 s en de houdbaarheid staat op 25 s, bewust *onder* die cadans: zet je ze
gelijk, dan valt een vraag even vaak net binnen als net buiten het venster en
levert de cache de helft van de tijd niets op. De modem krijgt vijf minuten
zodra hij `present: false` meldt; geen dongle blijft geen dongle.

**36 processen per minuut werden er 6.** De cache wordt ongeldig gemaakt in
`system.js` zelf — aan het eind van `wifiConnect`, `wifiDisconnect`,
`btConnect`, `btDisconnect` en `btStartScan` — en niet in de route, zodat het
ook werkt voor een pagina die na een update niet herladen is. `wifiList()` en
`btList()` worden helemaal niet gecached: die haal je alleen op terwijl je er
recht naar kijkt.

### De meetlus is geen verzoek

`GET /data` deed het rekenwerk. Dat is goedkoop, zoals hierboven gemeten — maar
het is de verkeerde plek, en één van de dingen die daar gebeurden was een fout.

`telemetry.build()` telt de kilometerstand en de rijtijd op uit tijdsverschillen.
Hang dat aan een HTTP-verzoek en de teller loopt alleen als er een browser
kijkt: kiosk dicht, teller stil. Twee browsers, en hij telt dubbel. De
wielmaat-monsters in `setup.js` hadden hetzelfde mankement — verzameld op de
cadans van de browser in plaats van die van de VESC, dus twee verzoeken tussen
twee metingen telden dezelfde meting dubbel.

Dat is precies de fout die eerder in de cruisecontrol zat, en daarom hangt die
al aan `vesc.on("values")`. Nu de rest ook, in `src/ride.js`. In een eigen
module, om één reden: `server.js` opent een poort en start een VESC, dus die
valt niet te `require`-en in de zelftest. Elke andere bouwsteen hier is een
testbare module — de meetlus was de enige die dat niet was, en het is geen
toeval waar de fouten dan zaten.

Drie dingen die goed moeten:

- **De VESC die wegvalt.** Drie lagen: de `status`-gebeurtenis (de watchdog
  vuurt binnen 1,2 s, en `port.on("close")` ook), een `ride.weg()` bij het
  opstarten omdat er geen statusgebeurtenis komt als er nooit verbinding was, en
  een vangnet van één booleaanse vergelijking in de route. Mis je die
  gebeurtenis, dan zou het contract bevriezen op de laatste meting.
- **`telemetry.pause()` bij verlies van verbinding.** Zonder dat telt de eerste
  meting na een gat de afgetopte twee seconden rijtijd mee voor een gat waarin
  niemand reed. De afstandsteller houdt bewust zijn ijkpunt: wiebelt de
  USB-stekker tijdens het rijden, dan telt de VESC door en hoort die afstand er
  echt bij.
- **Leren moet kunnen stoppen zonder het herleren te verliezen.** De oude
  `leerVanVesc` draaide voor altijd: zijn vroege return testte op
  `source === "hand"`, maar na het leren wordt `source` `"vesc"`, dus die greep
  nooit. Een simpele "klaar"-vlag zou te veel wegnemen — wijkt de afgeleide
  wielmaat later meer dan 2 % af (andere band, andere overbrenging), dan hóórt
  hij opnieuw te leren. Dus telt `SetupWatch` revisies en slaat `Ride` over
  zolang die teller stilstaat.

**De staat gaat nu asynchroon naar schijf.** `writeFileSync` in een timer legt
de eventloop stil, inclusief het lezen van de VESC, zolang de SD-kaart erover
doet. De `JSON.stringify` gebeurt nog steeds synchroon aan het begin van de
schrijfactie — dat is de hele truc, want alles wat daarna verandert kan niet
meer in het bestand terechtkomen dat nu geschreven wordt — en vlak voor de
hernoeming wordt een revisieteller gecontroleerd, zodat een trage schrijver
nooit kan begraven wat `flush()` net heeft neergezet.

En één regel in de unit: `UV_THREADPOOL_SIZE=8`. De seriële lezing houdt
permanent één van de vier standaard-threadpoolslots bezet (`stty min 0 time 1`,
dus een read komt na hoogstens 100 ms terug en er staat er altijd een open), en
het serveren van bestanden, de DNS-lookups en de state-schrijfacties vechten om
de overige drie. Threads die niets doen kosten stackruimte en verder niets.

### De designomgeving

```bash
npm run design      # http://127.0.0.1:8081/design
```

`tools/design.js` serveert `public/` precies zoals de echte server dat doet, maar
alle endpoints zijn nagemaakt. Naast het frame staan schuiven en schakelaars voor
snelheid, accu, temperaturen, laden, wifi, bluetooth en modem, plus
kant-en-klare situaties (rijden, motor heet, lage accu, laden, geen VESC) zodat
je elk scherm in één klik te pakken hebt. Het frame herlaadt zichzelf als er een
bestand in `public/` verandert.

Twee knoppen kiezen het beeld: **Staand 320 × 480**, de pagina zoals hij getekend
is, en **Op het paneel 480 × 320**, dezelfde pagina in een liggend frame — precies
zoals op de step, zodat je een verkeerde draaiing hier ziet en niet op het stuur.

De designomgeving bewaart ook de instellingen, dus taal, eenheden en accentkleur
overleven een herlaadbeurt van het frame. Dat scheelt meer dan het klinkt: zonder
komt elke schermafdruk in een andere kleur uit de bus.

`install.sh` gooit `tools/design.js`, `tools/design.html`, `tools/shots.js` en
`tools/icons/` na het kopiëren weer weg. Dat is gereedschap voor de computer, niet
voor de Pi.

### Schermafdrukken

```bash
node tools/design.js &
node tools/shots.js         # → docs/ui/*.png
```

Vijftien platen, gemaakt van de draaiende pagina op 320 × 480 met een
pixelverhouding van 2, en één op 480 × 320 om de draaiing te laten zien. Het
script zet de instellingen voor elke afdruk terug — anders hangt de kleur van de
vorige keer er nog in en lijkt geen enkele reeks op de andere.

Twee dingen waarop hij moet wachten. Het temperatuuralarm knippert zeven keer en
zijn bevestigknop komt na 2,9 seconden op, dus die krijgt 3,6 seconden voor de
sluiter. En klikken gaat met `force: true`: de app luistert op `pointerdown` en
vindt zijn doel met `closest()`, dus een treffer op een kindelement is prima —
Playwright weigert die standaard.

Playwright staat niet in `package.json`. Het is een dependency van 300 MB voor een
repo die er verder geen heeft; `PLAYWRIGHT=/pad/naar/playwright node tools/shots.js`
wijst hem naar een bestaande installatie.

### De pagina draait zichzelf

Het paneel op het stuur is 480 × 320. De pagina is 320 × 480. Dus vergelijkt
`fitRotation()` waarvoor de pagina getekend is met wat hij krijgt
(`innerWidth`/`innerHeight`), en zet er een kwartslag op als die twee niet
overeenkomen. De body vult het paneel, `#root` houdt de ontwerpmaat en wordt om
zijn eigen midden gedraaid.

Waarom niet op OS-niveau: `display_rotate` in `config.txt` werkt alleen met
bepaalde drivers, fbtft wil een moduleparameter, en onder Wayland is het weer
`wlr-randr`. Eén verkeerde poging en je scherm blijft zwart terwijl je er niet
meer bij kunt. Dit is één regel CSS die overal hetzelfde doet.

Aanraken hoefde niet omgerekend: de browser rekent tikken dwars door de transform
heen terug.

Welke kant op staat in `rotate` (90 of 270) — hoe jij het scherm ophangt bepaalt
welke van de twee klopt.

### Meldingen zijn afgeleid, niet bewaard

De bel heeft geen lijst die je vult, maar een lijst die uit de data volgt. Bij
elke tekenbeurt rekent `bouwAlerts()` uit wat er mis is — een VESC-storing, een
accu onder 10 %, een motor of controller binnen tien graden van zijn limiet — en
dát is de lijst. Oorzaak weg, melding weg.

Wegtikken zet de sleutel op een negeerlijst, en die loopt vanzelf leeg zodra de
oorzaak verdwijnt. Zonder die tweede helft zou één tik een storing voorgoed
verbergen, en dat is het tegenovergestelde van wat wegtikken hoort te betekenen.

Hertekenen gebeurt alleen bij verandering. Dit draait zeven keer per seconde, en
de HTML van de lade elke keer opnieuw opbouwen laat het schermpje kruipen — dus
er is een vingerafdruk van sleutels en details, en alleen een andere zet een
tekenbeurt in gang.

### Lagen op het scherm

De overlays liggen op vaste z-index-niveaus:

```
12  temperatuuralarm, uitgeschakeld
11  aan/uit-menu, laden
 9  schermtoetsenbord
 8  snelheidsmeting, eenheden, taal, accent, limieten, release, stepgegevens
 7  verbindingen
 6  meldingen
 5  instellingen
```

Het alarm ligt met opzet bovenaan. Een oververhitte motor moet je onderbreken
terwijl je een wachtwoord typt of iets afsluit, en niet andersom.

Dat het toetsenbord boven het verbindingsscherm ligt is ook geen detail: het gaat
vanúit dat scherm open, dus met dezelfde z-index beslist de volgorde in de opmaak
en zou de netwerklijst bovenop de toetsen liggen. Dat gebeurde ook — de toetsen
reageerden en je zag ze niet.

### Testen

```bash
npm test
```

124 tests, zonder hardware: CRC tegen de bekende testvector, framing, pakketten
in stukjes en met een kapotte CRC, de omrekening van erpm naar km/u en van
tachometer naar afstand, de ritteller op nul (ook als de VESC herstart en zijn
eigen tellers terugzet), de kilometerstand die over zo'n herstart heen doortelt,
de rijtijd die alleen loopt terwijl je rijdt, hoe de nmcli-commando's worden
opgebouwd, versies vergelijken, laden herkennen — inclusief de traagste lader die
we nog willen zien — welke locatiebron wint voor het weer, dat het aan/uit-scherm
nooit iets anders kan opleveren dan `systemctl reboot` of `systemctl poweroff`,
en hoe de setup-staat van de VESC wordt herkend — inclusief dat één uitschieter
de afgeleide wielmaat niet scheeftrekt en dat schrijven naar `config.json` de
rest van dat bestand met rust laat — en het rijmoduspakket, byte voor byte,
inclusief dat `store` nooit iets anders is dan nul.

Negen ervan gaan over de meetlus, en twee daarvan bestaan door een echte fout:
**de kilometerstand telt door zonder browser**, en **twee browsers tellen niet
dubbel**. Weer een andere controleert dat `config.json` één keer geschreven
wordt en niet bij elke meting, en nog een dat een alleen-lezen `config.json`
niet eeuwig opnieuw geprobeerd wordt. Vijf gaan over het wegschrijven van de
staat: drie patches vlak na elkaar leveren één bestand op, een patch tijdens het
schrijven gaat niet verloren, het bestand is na tweehonderd willekeurige patches
altijd geldige JSON, `flush()` wordt niet begraven door een trage schrijver, en
schrijven legt de eventloop niet stil. Zeven gaan over de statuscache.

Zes ervan gaan over de UI zonder een browser te openen: alle vier de talen hebben
dezelfde sleutels, geen enkele vertaling is leeg, elke `data-t` in de pagina
levert iets op, de acht accentkleuren van de UI zijn de acht die de server
accepteert, elk id dat `app.js` aanraakt bestaat, en elk icoon dat aangeroepen
wordt heeft een tekening in de sprite. Dat zijn de fouten die een stil, half
werkend scherm opleveren, en ze zijn goedkoop uit een bestand te halen.

Verder heb ik met Playwright doorgeklikt op 320 × 480 en 480 × 320, in beide
thema's, over alle vijftien de schermen — dat is wat `tools/shots.js` doet, en hij
valt om op elke fout in de console.

Zonder VESC kun je er ook een nadoen met een PTY-paar: `pty.openpty()`, luisteren
op commando 4 en 47, en antwoorden terugsturen met dezelfde framing. Zo is de
hele keten te testen behalve de USB-kabel zelf.
