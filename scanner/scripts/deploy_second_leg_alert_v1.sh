#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rh-chain-monitor}"
ALERT_ENV="/etc/rh-chain-monitor-alert.env"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "ERROR: run as root: sudo bash scanner/scripts/deploy_second_leg_alert_v1.sh"
  exit 1
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

DEPLOY_STARTED="$(date --iso-8601=seconds)"
systemctl restart rh-chain-monitor.service
sleep 6
systemctl is-active --quiet rh-chain-monitor.service

echo "Waiting for supervised second-leg worker cycle (avoids a competing SQLite writer)..."
cycle_seen=0
for _ in $(seq 1 18); do
  if journalctl -u rh-chain-monitor.service --since "$DEPLOY_STARTED" --no-pager \
      | grep -q '\[second-leg cycle\]'; then
    cycle_seen=1
    break
  fi
  sleep 5
done
if [[ "$cycle_seen" -ne 1 ]]; then
  echo "ERROR: no supervised second-leg cycle observed within 90 seconds"
  journalctl -u rh-chain-monitor.service --since "$DEPLOY_STARTED" --no-pager \
    | grep -E '\[second-leg worker boot\]|\[second-leg cycle\]|\[second-leg worker\]|second-leg-alert-worker' \
    | tail -30 || true
  exit 4
fi

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

echo "DONE: second-leg Bark + Telegram minute alerts V1 deployed"
