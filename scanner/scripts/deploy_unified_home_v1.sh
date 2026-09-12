#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rh-chain-monitor}"
CADDY_FILE="/etc/caddy/Caddyfile"
SECOND_LEG_PATH="/sheet-second-leg-6b2e4d8c1a9f.csv"
PUBLIC_HOST="rh.192-236-234-216.sslip.io"
LOCK_FILE="/run/rh-unified-home-v1.lock"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "ERROR: run as root: sudo bash scanner/scripts/deploy_unified_home_v1.sh"
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "ERROR: another unified-home deployment is already running"
  exit 2
fi

cd "$APP_DIR"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "ERROR: tracked local changes detected; refusing to overwrite them."
  git status --short
  exit 3
fi

git pull --ff-only origin main
npm --prefix scanner run check

BACKUP="${CADDY_FILE}.unified-home-v1.$(date +%Y%m%d%H%M%S).bak"
cp -a "$CADDY_FILE" "$BACKUP"
python3 - "$CADDY_FILE" "$SECOND_LEG_PATH" <<'PY'
import re,sys
path,route=sys.argv[1:]
s=open(path,encoding='utf-8').read()
if route in s:
    print('Caddy second-leg route already present')
    raise SystemExit(0)
block=f'''    handle {route} {{\n        rewrite * /second-leg.csv\n        reverse_proxy 127.0.0.1:3105\n    }}\n'''
pattern=r'(?m)^(\s*)handle\s*\{\s*\n\s*reverse_proxy\s+127\.0\.0\.1:8080\s*\n\s*\}'
matches=list(re.finditer(pattern,s))
if not matches:
    raise SystemExit('ERROR: generic 8080 Caddy handle not found; no changes written')
m=matches[-1]
indent=m.group(1)
insert='\n'.join(indent + line if line else line for line in block.split('\n'))
s=s[:m.start()] + insert + '\n' + s[m.start():]
open(path,'w',encoding='utf-8').write(s)
print('Caddy second-leg route added')
PY

if ! caddy validate --config "$CADDY_FILE" >/dev/null; then
  cp -a "$BACKUP" "$CADDY_FILE"
  echo "ERROR: Caddy validation failed; original config restored"
  exit 4
fi
systemctl reload caddy

HEALTH_WAS_ACTIVE=0
if systemctl is-active --quiet rh-chain-health.service; then
  HEALTH_WAS_ACTIVE=1
  echo "Pausing independent health monitor during planned restart..."
  systemctl stop rh-chain-health.service
fi
restore_health() {
  if [[ "$HEALTH_WAS_ACTIVE" -eq 1 ]]; then
    systemctl start rh-chain-health.service || true
  fi
}
trap restore_health EXIT

OLD_PID="$(systemctl show rh-chain-monitor.service -p MainPID --value || true)"
echo "Scheduling non-blocking rh-chain-monitor restart (old MainPID=${OLD_PID:-0})..."
systemctl restart --no-block rh-chain-monitor.service

NEW_PID=""
for i in $(seq 1 24); do
  STATE="$(systemctl show rh-chain-monitor.service -p ActiveState --value || true)"
  SUB="$(systemctl show rh-chain-monitor.service -p SubState --value || true)"
  PID="$(systemctl show rh-chain-monitor.service -p MainPID --value || true)"
  echo "restart wait $i/24: state=${STATE:-unknown}/${SUB:-unknown} MainPID=${PID:-0}"
  if [[ "$STATE" == "active" && "$PID" =~ ^[1-9][0-9]*$ && "$PID" != "${OLD_PID:-0}" ]]; then
    NEW_PID="$PID"
    break
  fi
  sleep 5
done
if [[ -z "$NEW_PID" ]]; then
  echo "ERROR: main service did not restart with a new MainPID within 120 seconds"
  systemctl status rh-chain-monitor.service --no-pager || true
  journalctl -u rh-chain-monitor.service -n 100 --no-pager || true
  exit 5
fi

echo "Main service restarted successfully (new MainPID=$NEW_PID)."
for _ in $(seq 1 18); do
  if curl -fsS --max-time 5 http://127.0.0.1:3105/health >/tmp/rh-history-health.json 2>/dev/null; then
    if grep -q '"secondLegExport":true' /tmp/rh-history-health.json; then
      break
    fi
  fi
  sleep 5
done
if ! grep -q '"secondLegExport":true' /tmp/rh-history-health.json 2>/dev/null; then
  echo "ERROR: history export did not advertise secondLegExport=true"
  cat /tmp/rh-history-health.json 2>/dev/null || true
  exit 6
fi
cat /tmp/rh-history-health.json
printf '\n'

curl -fsS --max-time 10 http://127.0.0.1:3105/second-leg.csv -o /tmp/rh-second-leg-local.csv
LOCAL_LINES="$(wc -l < /tmp/rh-second-leg-local.csv)"
echo "local second-leg lines=$LOCAL_LINES"
head -8 /tmp/rh-second-leg-local.csv || true

SCODE="$(curl -sS --max-time 15 -o /tmp/rh-second-leg-public.csv -w '%{http_code}' "https://${PUBLIC_HOST}:8443${SECOND_LEG_PATH}")"
echo "second-leg HTTPS=$SCODE lines=$(wc -l < /tmp/rh-second-leg-public.csv)"
if [[ "$SCODE" != "200" ]]; then
  echo "ERROR: public second-leg export is not HTTP 200"
  exit 7
fi
head -8 /tmp/rh-second-leg-public.csv || true

restore_health
HEALTH_WAS_ACTIVE=0
trap - EXIT
if systemctl list-unit-files --type=service | grep -q '^rh-chain-health.service'; then
  systemctl is-active --quiet rh-chain-health.service && echo "health monitor active" || true
fi

echo "DONE: unified homepage second-leg feed V1 deployed"
