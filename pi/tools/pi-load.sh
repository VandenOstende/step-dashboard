#!/bin/sh
# Wat kost het dashboard op de Pi?
#
#   sudo ./tools/pi-load.sh [seconden]
#
# Meet het CPU-verbruik van de node-service en van alle chromium-processen over
# een venster, plus de temperatuur en of de Pi terugklokt. Zonder dit is "het
# voelt sneller" het enige bewijs dat je hebt.
#
# Draai hem voor en na een `git pull` en vergelijk. Laat het scherm ondertussen
# met rust: bedienen kost zelf ook wat.
set -eu

VENSTER=${1:-10}
HZ=$(getconf CLK_TCK 2>/dev/null || echo 100)

# utime + stime van een pid, in tikken.
tikken() {
  [ -r "/proc/$1/stat" ] || { echo ""; return; }
  # De procesnaam kan spaties bevatten; alles na de laatste ")" is het veld
  # dat we willen tellen. utime en stime zijn daarin veld 12 en 13.
  rest=$(sed 's/.*) //' "/proc/$1/stat")
  echo "$rest" | awk '{print $12 + $13}'
}

# Nul-bytes én regeleindes eruit: een cmdline mag allebei bevatten en dan
# loopt de tabel door elkaar.
naam() {
  tr '\0\n' '  ' < "/proc/$1/cmdline" 2>/dev/null | tr -s ' ' | cut -c1-52
}

# Zoeken op het uitvoerbare bestand, niet op een losse tekenreeks: anders vindt
# pgrep dit script zelf, want daar staat "src/server.js" ook in.
PIDS=$(pgrep -f 'node .*src/server\.js' 2>/dev/null || true)
PIDS="$PIDS $(pgrep -x chromium 2>/dev/null || true)"
PIDS="$PIDS $(pgrep -x chromium-browser 2>/dev/null || true)"
PIDS="$PIDS $(pgrep -x chrome 2>/dev/null || true)"
# En onszelf en onze ouder eruit, voor de zekerheid.
PIDS=$(echo $PIDS | tr ' ' '\n' | grep -v '^$' | grep -vx "$$" | grep -vx "$PPID" | sort -un || true)

[ -n "$PIDS" ] || { echo "geen step-dashboard of chromium gevonden"; exit 1; }

VOOR=""
for p in $PIDS; do VOOR="$VOOR $p:$(tikken "$p")"; done

echo "meten, $VENSTER seconden…"
sleep "$VENSTER"

echo
printf '%-8s %-54s %s\n' "pid" "proces" "cpu"
printf '%s\n' "----------------------------------------------------------------------------"
TOTAAL=0
for p in $PIDS; do
  v=$(echo "$VOOR" | tr ' ' '\n' | grep "^$p:" | cut -d: -f2)
  n=$(tikken "$p")
  [ -n "$v" ] && [ -n "$n" ] || continue
  pct=$(awk -v a="$v" -v b="$n" -v s="$VENSTER" -v hz="$HZ" 'BEGIN{printf "%.1f", (b-a)/hz/s*100}')
  TOTAAL=$(awk -v t="$TOTAAL" -v p="$pct" 'BEGIN{printf "%.1f", t+p}')
  printf '%-8s %-54s %5s %%\n' "$p" "$(naam "$p")" "$pct"
done
printf '%s\n' "----------------------------------------------------------------------------"
printf '%-63s %5s %%\n' "samen" "$TOTAAL"
echo

# Hoeveel processen start het systeem in dit venster? De netwerkstatus is de
# grootverbruiker; met de cache hoort dat rond de zes per minuut te liggen.
if [ -r /proc/stat ]; then
  echo "forks sinds het opstarten: $(awk '/^processes /{print $2}' /proc/stat)"
  echo "  (draai dit script twee keer en trek af — dat is het forktempo)"
fi

command -v vcgencmd >/dev/null 2>&1 && {
  echo
  echo "temperatuur: $(vcgencmd measure_temp 2>/dev/null || echo onbekend)"
  echo "terugklokken: $(vcgencmd get_throttled 2>/dev/null || echo onbekend)"
  echo "  0x0 is goed; alles anders betekent onderspanning of hitte."
}
