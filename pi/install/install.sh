#!/bin/bash
# Installeer het Step Dashboard op een Raspberry Pi.
#
#   sudo ./install/install.sh
#
# Zet de code in /opt/step-dashboard, installeert twee systemd-units (de
# service en de kiosk), de udev-regels en de sudoers-regel voor het
# bijwerken. Bestaande config.json wordt niet overschreven.
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

# Inter is het lettertype van het ontwerp. Zonder valt de UI terug op
# system-ui — leesbaar, maar de cijfers staan dan niet in even brede kolommen
# en de maatvoering schuift. Het staat in Debian, dus we halen het gewoon op.
if ! fc-list 2>/dev/null | grep -qi "Inter"; then
  echo "→ lettertype Inter installeren"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends fonts-inter \
    || echo "   let op: fonts-inter installeren lukte niet — de UI valt terug op system-ui"
  command -v fc-cache >/dev/null && fc-cache -f >/dev/null 2>&1 || true
fi

echo "→ code naar $DEST"
mkdir -p "$DEST"
for d in src public install tools; do
  rm -rf "${DEST:?}/$d"
  cp -r "$SRC/$d" "$DEST/$d"
done
cp "$SRC/package.json" "$DEST/"

# De designomgeving is gereedschap voor op je eigen computer: hij zet een
# tweede webserver op met nagemaakte hardware erachter. Op de step heeft dat
# niets te zoeken, dus die gaat er na het kopiëren weer uit.
rm -f "$DEST/tools/design.js" "$DEST/tools/design.html" "$DEST/tools/shots.js" "$DEST/tools/bench.js"
rm -rf "$DEST/tools/icons"

# Welke commit staat er nu? De updater vergelijkt dit met GitHub.
COMMIT=$(git -C "$SRC/.." rev-parse HEAD 2>/dev/null || echo "")
BRANCH_NOW=$(git -C "$SRC/.." rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
printf '{"commit":"%s","branch":"%s","at":%s}\n' \
  "$COMMIT" "$BRANCH_NOW" "$(date +%s)" > "$DEST/version.json"
# Bestaande waarden blijven; alleen wat er later is bijgekomen wordt aangevuld.
if [[ -f "$DEST/config.json" ]]; then
  node "$SRC/install/merge-config.js" "$SRC/config.json" "$DEST/config.json"
else
  cp "$SRC/config.json" "$DEST/config.json"
fi
chmod +x "$DEST/install/kiosk.sh"
chown -R "$USER_NAME":"$USER_NAME" "$DEST"

echo "→ rechten"
usermod -aG dialout,video "$USER_NAME"
install -d -o "$USER_NAME" -g "$USER_NAME" /var/lib/step-dashboard
# De updater draait als root en staat buiten $DEST, want $DEST is van de
# service-gebruiker — een script dat die zelf kan aanpassen en met sudo mag
# draaien is een achterdeur naar root.
install -m 0755 -o root -g root "$SRC/install/step-update" /usr/local/sbin/step-update

# De regels staan op naam van "pi"; zet de echte gebruiker erin, anders werkt
# het bijwerken niet op een Pi met een andere gebruikersnaam.
sed "s/^pi ALL=/$USER_NAME ALL=/" "$SRC/install/step-dashboard.sudoers" \
  > /etc/sudoers.d/step-dashboard
chmod 0440 /etc/sudoers.d/step-dashboard
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
systemctl enable step-dashboard.service
# Expliciet herstarten: `enable --now` start een service die al draait niet
# opnieuw, en dan draait het oude proces verder met de nieuwe bestanden op
# schijf. Dat geeft een UI die vooruitloopt op zijn eigen server.
systemctl restart step-dashboard.service

# Stond de kiosk al aan, dan wijst zijn symlink nog naar het oude target uit
# de vorige versie van deze unit. reenable legt hem opnieuw aan volgens de
# [Install]-sectie zoals die er nu staat.
if systemctl is-enabled step-kiosk.service >/dev/null 2>&1; then
  systemctl reenable step-kiosk.service >/dev/null 2>&1 || true
  systemctl restart step-kiosk.service || true
fi

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
echo
echo "Geïnstalleerde versie: ${COMMIT:0:7}${COMMIT:+ (}${BRANCH_NOW}${COMMIT:+)}"
