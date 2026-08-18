#!/bin/sh
# Start Chromium fullscreen op het 3,5"-scherm (480 × 320, liggend).
#
# Werkt zowel op een Wayland-opstelling (cage) als op X11 (xinit). Welke van
# de twee gebruikt wordt hangt af van wat er geïnstalleerd is; Raspberry Pi OS
# Bookworm draait standaard Wayland, Bullseye X11.
set -eu

URL="${STEP_URL:-http://127.0.0.1:8080/}"
PROFILE="${STEP_PROFILE:-/var/lib/step-dashboard/chromium}"

# Wacht tot de service antwoordt, anders toont Chromium een foutpagina.
i=0
while [ "$i" -lt 60 ]; do
  if curl -sf -o /dev/null "$URL"; then break; fi
  i=$((i + 1))
  sleep 0.5
done

CHROME=""
for c in chromium-browser chromium google-chrome-stable; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
[ -n "$CHROME" ] || { echo "geen chromium gevonden" >&2; exit 1; }

mkdir -p "$PROFILE"

# Chromium onthoudt een vorige crash en toont dan een herstelballon; die
# vlaggen zetten dat uit. Geen updatecontroles, want de Pi is offline.
set -- \
  --kiosk "$URL" \
  --user-data-dir="$PROFILE" \
  --window-size=480,320 \
  --window-position=0,0 \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate,TranslateUI,AutofillServerCommunication \
  --disable-component-update \
  --check-for-update-interval=31536000 \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --touch-events=enabled \
  --force-device-scale-factor=1 \
  --autoplay-policy=no-user-gesture-required \
  --password-store=basic \
  --no-first-run

# Afstelling voor een traag paneel en een SD-kaart. Uit te zetten met
# STEP_KIOSK_TUNING=0 in de unit — dan hoef je bij een zwart scherm geen editor
# over SSH open te trekken.
#
#   --disable-background-networking
#       De Pi staat vaak buiten bereik. Zonder dit blijft Chromium op de
#       achtergrond varianten, safebrowsing-lijsten en tijdzones ophalen, en
#       loopt elk van die verzoeken in een timeout.
#   --disable-sync, --disable-domain-reliability, --disable-breakpad
#       Diensten die alleen zin hebben met een account en een netwerk.
#   --disk-cache-size=1, --disable-gpu-shader-disk-cache
#       De pagina wordt met Cache-Control: no-store geserveerd, dus deze twee
#       caches leveren niets op en schrijven alleen naar de SD-kaart.
#   --renderer-process-limit=1
#       Eén pagina, dus één renderer. Meer processen kosten alleen geheugen.
#   --enable-low-end-device-mode, --num-raster-threads=1
#       Kleinere rastertegels en zuiniger met geheugen. Op 320 x 480 heeft meer
#       rasterwerk geen zin.
#
# Bewust NIET: --single-process, --disable-gpu, --in-process-gpu. Die leveren
# meer op maar pakken per opstelling anders uit; zie de README als je ze wilt
# proberen.
if [ "${STEP_KIOSK_TUNING:-1}" != "0" ]; then
  set -- "$@" \
    --disable-background-networking \
    --disable-sync \
    --disable-domain-reliability \
    --disable-breakpad \
    --disk-cache-size=1 \
    --disable-gpu-shader-disk-cache \
    --renderer-process-limit=1 \
    --enable-low-end-device-mode \
    --num-raster-threads=1
fi

if command -v cage >/dev/null 2>&1 && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  exec cage -d -- "$CHROME" --ozone-platform=wayland "$@"
elif command -v xinit >/dev/null 2>&1; then
  # vt1 -keeptty: zonder expliciete VT zoekt Xorg hem via /dev/tty0 (alleen
  # root, mode 0600) en faalt hij onder een systemd-service met
  # "parse_vt_settings: Cannot open /dev/tty0".
  # Het SPI-schermpje meldt zich als fb1; met alleen HDMI blijft fb0 gelden.
  [ -e /dev/fb1 ] && export FRAMEBUFFER=/dev/fb1
  # -nocursor: geen muispijl op een aanraakscherm
  exec xinit /usr/bin/env "$CHROME" "$@" -- :0 vt1 -keeptty -nocursor
else
  exec "$CHROME" "$@"
fi
