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

if command -v cage >/dev/null 2>&1 && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  exec cage -d -- "$CHROME" --ozone-platform=wayland "$@"
elif command -v xinit >/dev/null 2>&1; then
  # -nocursor: geen muispijl op een aanraakscherm
  exec xinit /usr/bin/env "$CHROME" "$@" -- :0 -nocursor
else
  exec "$CHROME" "$@"
fi
