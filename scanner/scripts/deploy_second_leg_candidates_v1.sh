#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rh-chain-monitor}"
LOCK_FILE="/run/rh-second-leg-candidates-v1.lock"
GENERATED="${SECOND_LEG_GENERATED_WATCHLIST:-/data/second_leg_watchlist.generated.json}"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "ERROR: run as root: sudo bash scanner/scripts/deploy_second_leg_candidates_v1.sh"
  exit 1
fi
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "ERROR: another Step 12 deployment is already running"
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
npm --prefix scanner run second-leg-candidate-check

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

DEPLOY_SINCE="$(date '+%Y-%m-%d %H:%M:%S')"
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
  journalctl -u rh-chain-monitor.service -n 120 --no-pager || true
  exit 4
fi

echo "Main service restarted successfully (new MainPID=$NEW_PID)."
echo "Waiting for automatic candidate library cycle..."
CYCLE_LINE=""
for _ in $(seq 1 24); do
  CYCLE_LINE="$(journalctl -u rh-chain-monitor.service --since "$DEPLOY_SINCE" --no-pager 2>/dev/null | grep -F '[second-leg candidate cycle]' | tail -1 || true)"
  if [[ -n "$CYCLE_LINE" && -s "$GENERATED" ]]; then
    break
  fi
  sleep 5
done
if [[ -z "$CYCLE_LINE" || ! -s "$GENERATED" ]]; then
  echo "ERROR: candidate worker did not produce a cycle/generated watchlist within 120 seconds"
  journalctl -u rh-chain-monitor.service --since "$DEPLOY_SINCE" --no-pager | tail -160 || true
  exit 5
fi
echo "$CYCLE_LINE"

python3 - "$GENERATED" <<'PY'
import json,sqlite3,sys
p=sys.argv[1]
rows=json.load(open(p,encoding='utf-8'))
con=sqlite3.connect('/data/rh_monitor.db',timeout=5)
con.row_factory=sqlite3.Row
health=con.execute('''SELECT COUNT(*) total,
 SUM(CASE WHEN enabled=1 AND status='ACTIVE' THEN 1 ELSE 0 END) active,
 SUM(CASE WHEN status='BLOCKED' THEN 1 ELSE 0 END) blocked,
 SUM(CASE WHEN status='WATCH' THEN 1 ELSE 0 END) watch,
 SUM(CASE WHEN status='WARMUP' THEN 1 ELSE 0 END) warmup,
 SUM(CASE WHEN manual_override=1 THEN 1 ELSE 0 END) manual,
 SUM(CASE WHEN source LIKE 'AUTO_CANARY%' THEN 1 ELSE 0 END) auto
 FROM second_leg_candidates''').fetchone()
blocked={r[0].lower() for r in con.execute("SELECT token_address FROM second_leg_candidates WHERE status='BLOCKED' OR buy_blocked=1 OR risk_gate='BLOCK'")}
generated={str(r.get('address','')).lower() for r in rows}
leaked=sorted(blocked & generated)
print('candidate_library=',dict(health))
print('generated_watchlist=',len(rows))
print('generated_auto=',sum(1 for r in rows if str(r.get('candidateSource','')).startswith('AUTO_CANARY')))
print('generated_manual=',sum(1 for r in rows if r.get('manualOverride')))
print('blocked_leaks=',len(leaked))
if leaked:
    print('ERROR: blocked candidate leaked into generated watchlist')
    raise SystemExit(6)
if not rows:
    print('ERROR: generated watchlist is empty')
    raise SystemExit(7)
PY

echo "Checking supervised second-leg worker consumes generated watchlist..."
SECOND_LINE=""
for _ in $(seq 1 18); do
  SECOND_LINE="$(journalctl -u rh-chain-monitor.service --since "$DEPLOY_SINCE" --no-pager 2>/dev/null | grep -F '[second-leg cycle]' | tail -1 || true)"
  if [[ -n "$SECOND_LINE" ]]; then break; fi
  sleep 5
done
if [[ -z "$SECOND_LINE" ]]; then
  echo "ERROR: no supervised second-leg cycle observed"
  journalctl -u rh-chain-monitor.service --since "$DEPLOY_SINCE" --no-pager | tail -160 || true
  exit 8
fi
echo "$SECOND_LINE"

restore_health
HEALTH_WAS_ACTIVE=0
trap - EXIT
if systemctl list-unit-files --type=service | grep -q '^rh-chain-health.service'; then
  systemctl is-active --quiet rh-chain-health.service && echo "health monitor active" || true
fi

echo "DONE: Step 12 automatic second-leg candidate library V1 deployed"
