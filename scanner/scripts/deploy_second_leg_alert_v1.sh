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

systemctl restart rh-chain-monitor.service
sleep 6
systemctl is-active --quiet rh-chain-monitor.service

set -a
# shellcheck disable=SC1090
source "$ALERT_ENV"
set +a

echo "Running one live second-leg cycle..."
node scanner/src/second_leg_alert_worker.mjs --once | tail -5 || true

echo "Sending Bark + Telegram second-leg test..."
node scanner/src/second_leg_alert_worker.mjs --test-notify

echo "Checking worker boot..."
journalctl -u rh-chain-monitor.service -n 180 --no-pager \
  | grep -E '\[second-leg worker boot\]|\[second-leg cycle\]|\[second-leg alert sent\]|second-leg-alert-worker' \
  | tail -20 || true

if [[ -f /data/rh_monitor.db ]]; then
  python3 - <<'PY'
import sqlite3
p='/data/rh_monitor.db'
c=sqlite3.connect(p)
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
