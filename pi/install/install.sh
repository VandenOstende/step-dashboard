#!/bin/bash
# Installeer het Step Dashboard op een Raspberry Pi.
#
#   sudo ./install/install.sh
#
# Zet de code in /opt/step-dashboard, installeert twee systemd-units (de
# service en de kiosk), de udev-regels en de sudoers-regel voor de
# Desktop-knop. Bestaande config.json wordt niet overschreven.
set -euo pipefail

DEST=/opt/step-dashboard
USER_NAME=${STEP_USER:-pi}
SRC=$(cd "$(dirname "$0")/.." && pwd)

[[ $EUID -eq 0 ]] || { echo "draai dit met sudo" >&2; exit 1; }
id "$USER_NAME" >/dev/null 2>&1 || { echo "gebruiker $USER_NAME bestaat niet (zet STEP_USER)" >&2; exit 1; }

echo "→ controleren wat er is"
command -v node >/dev/null || { echo "node ontbreekt: sudo apt install -y nodejs" >&2; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
(( NODE_MAJOR >= 18 )) || { echo "node $NODE_MAJOR is te oud, minstens 18 nodig" >&2; exit 1; }
for t in stty nmcli; do
  command -v "$t" >/dev/null || echo "   let op: $t ontbreekt"
done
command -v bluetoothctl >/dev/null || echo "   let op: bluetoothctl ontbreekt (bluez)"
command -v mmcli        >/dev/null || echo "   let op: mmcli ontbreekt (modemmanager) — mobiel bereik blijft leeg"

echo "→ code naar $DEST"
mkdir -p "$DEST"
for d in src public install tools; do
  rm -rf "${DEST:?}/$d"
  cp -r "$SRC/$d" "$DEST/$d"
done
cp "$SRC/package.json" "$DEST/"
[[ -f "$DEST/config.json" ]] || cp "$SRC/config.json" "$DEST/config.json"
chmod +x "$DEST/install/kiosk.sh"
chown -R "$USER_NAME":"$USER_NAME" "$DEST"

echo "→ rechten"
usermod -aG dialout,video "$USER_NAME"
install -d -o "$USER_NAME" -g "$USER_NAME" /var/lib/step-dashboard
install -m 0440 "$SRC/install/step-dashboard.sudoers" /etc/sudoers.d/step-dashboard
visudo -cf /etc/sudoers.d/step-dashboard >/dev/null
install -m 0644 "$SRC/install/99-step-dashboard.rules" /etc/udev/rules.d/99-step-dashboard.rules
udevadm control --reload-rules || true
udevadm trigger --subsystem-match=backlight || true

echo "→ services"
sed "s/^User=pi$/User=$USER_NAME/;s/^Group=pi$/Group=$USER_NAME/" \
  "$SRC/install/step-dashboard.service" > /etc/systemd/system/step-dashboard.service
sed "s/^User=pi$/User=$USER_NAME/;s/^Group=pi$/Group=$USER_NAME/" \
  "$SRC/install/step-kiosk.service" > /etc/systemd/system/step-kiosk.service
systemctl daemon-reload
systemctl enable --now step-dashboard.service

echo
echo "De service draait. Controleer met:"
echo "  systemctl status step-dashboard"
echo "  curl -s http://127.0.0.1:8080/data"
echo
echo "Kiosk aanzetten zodra het scherm werkt:"
echo "  sudo systemctl enable --now step-kiosk"
echo
echo "VESC uitlezen om te controleren of de setup-wizard gedraaid heeft:"
echo "  node $DEST/tools/vesc-probe.js"
