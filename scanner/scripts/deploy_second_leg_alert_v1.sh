#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rh-chain-monitor}"
ALERT_ENV="/etc/rh-chain-monitor-alert.env"
LOCK_FILE="/run/rh-second-leg-deploy.lock"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "ERROR: run as root: sudo bash scanner/scripts/deploy_second_leg_alert_v1.sh"
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "ERROR: another second-leg deployment is already running; do not start a second copy."
  exit 5
fi

cd "$APP_DIR"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "ERROR: tracked local changes detected; refusing to overwrite them."
  git status --short
  exit 2
fi
if [[ ! -f "$ALERT_ENV" ]]; then
  echo "ERROR: $ALERT_ENV missing; configure Bark/Telegram first"
  exit 3
fi

git pull --ff-only origin main
npm --prefix scanner run check
npm --prefix scanner run second-leg-check

set -a
# shellcheck disable=SC1090
source "$ALERT_ENV"
set +a

health_was_active=0
if systemctl is-active --quiet rh-chain-health.service 2>/dev/null; then
  health_was_active=1
  echo "Pausing independent health monitor during planned restart..."
  systemctl stop --no-block rh-chain-health.service || true
  for _ in $(seq 1 6); do
    systemctl is-active --quiet rh-chain-health.service 2>/dev/null || break
    sleep 2
  done
fi
restore_health() {
  if [[ "$health_was_active" -eq 1 ]]; then
    systemctl start --no-block rh-chain-health.service || true
    health_was_active=0
  fi
}
trap restore_health EXIT

DEPLOY_STARTED="$(date --iso-8601=seconds)"
old_pid="$(systemctl show rh-chain-monitor.service -p MainPID --value 2>/dev/null || echo 0)"
[[ "$old_pid" =~ ^[0-9]+$ ]] || old_pid=0

echo "Scheduling non-blocking rh-chain-monitor restart (old MainPID=$old_pid)..."
systemctl restart --no-block rh-chain-monitor.service

echo "Waiting for a new active MainPID; progress is printed every 5 seconds..."
restart_ok=0
for i in $(seq 1 24); do
  state="$(systemctl show rh-chain-monitor.service -p ActiveState --value 2>/dev/null || echo unknown)"
  sub="$(systemctl show rh-chain-monitor.service -p SubState --value 2>/dev/null || echo unknown)"
  pid="$(systemctl show rh-chain-monitor.service -p MainPID --value 2>/dev/null || echo 0)"
  [[ "$pid" =~ ^[0-9]+$ ]] || pid=0
  echo "restart wait ${i}/24: state=$state/$sub MainPID=$pid"
  if [[ "$state" == "active" && "$pid" -gt 0 && ( "$old_pid" -eq 0 || "$pid" != "$old_pid" ) ]]; then
    restart_ok=1
    break
  fi
  sleep 5
done
if [[ "$restart_ok" -ne 1 ]]; then
  echo "ERROR: rh-chain-monitor did not complete restart within 120 seconds"
  systemctl status rh-chain-monitor.service --no-pager -l || true
  journalctl -u rh-chain-monitor.service --since "$DEPLOY_STARTED" --no-pager | tail -80 || true
  exit 6
fi

echo "Main service restarted successfully. Waiting for supervised second-leg worker healthy cycle..."
cycle_seen=0
cycle_line=""
for _ in $(seq 1 24); do
  cycle_line="$(journalctl -u rh-chain-monitor.service --since "$DEPLOY_STARTED" --no-pager \
    | grep -F '[second-leg cycle]' \
    | tail -1 || true)"
  if [[ -n "$cycle_line" && "$cycle_line" == *'"errors":0'* ]]; then
    cycle_seen=1
    break
  fi
  sleep 5
done
if [[ "$cycle_seen" -ne 1 ]]; then
  echo "ERROR: no healthy supervised second-leg cycle (errors=0) observed within 120 seconds"
  journalctl -u rh-chain-monitor.service --since "$DEPLOY_STARTED" --no-pager \
    | grep -E '\[second-leg worker boot\]|\[second-leg cycle\]|\[second-leg worker\]|second-leg-alert-worker' \
    | tail -40 || true
  exit 4
fi

echo "Healthy second-leg cycle observed:"
echo "$cycle_line"

echo "Sending Bark + Telegram second-leg test..."
node scanner/src/second_leg_alert_worker.mjs --test-notify

echo "Checking worker boot/cycle..."
journalctl -u rh-chain-monitor.service --since "$DEPLOY_STARTED" --no-pager \
  | grep -E '\[second-leg worker boot\]|\[second-leg cycle\]|\[second-leg alert sent\]|second-leg-alert-worker' \
  | tail -20 || true

if [[ -f /data/rh_monitor.db ]]; then
  python3 - <<'PY'
import sqlite3
p='file:/data/rh_monitor.db?mode=ro'
c=sqlite3.connect(p, uri=True, timeout=5)
try:
  rows=c.execute("select symbol,stage,round(score,1),round(confidence,1),risk_gate,observed_at from second_leg_live order by symbol").fetchall()
  print('second_leg_live rows=',len(rows))
  for r in rows: print(r)
except Exception as e:
  print('second_leg_live check:',e)
finally:
  c.close()
PY
fi

restore_health
sleep 2
if systemctl is-active --quiet rh-chain-health.service 2>/dev/null; then
  echo "health monitor active"
fi

echo "DONE: second-leg Bark + Telegram minute alerts V1 deployed"
