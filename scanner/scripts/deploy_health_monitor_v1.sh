#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rh-chain-monitor}"
UNIT_FILE="/etc/systemd/system/rh-chain-health.service"
NODE_BIN="$(command -v node)"
MONITOR="$APP_DIR/scanner/src/production_health_monitor.mjs"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "ERROR: run as root: sudo bash scanner/scripts/deploy_health_monitor_v1.sh"
  exit 1
fi
cd "$APP_DIR"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "ERROR: tracked local changes detected; refusing to overwrite them."
  git status --short
  exit 2
fi

git pull --ff-only origin main
npm --prefix scanner run check
npm --prefix scanner run health-check

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=RH Chain independent production health monitor
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/scanner
Environment=NODE_ENV=production
Environment=SQLITE_PATH=/data/rh_monitor.db
Environment=HEALTH_POLL_MS=30000
Environment=HEALTH_REMINDER_MS=1800000
Environment=HEALTH_RESTART_AFTER_FAILURES=2
Environment=HEALTH_RESTART_COOLDOWN_MS=600000
Environment=HEALTH_DISK_WARN_PCT=80
Environment=HEALTH_DISK_CRITICAL_PCT=92
Environment=HEALTH_OPPORTUNITY_STALE_MS=180000
Environment=HEALTH_HTTP_TIMEOUT_MS=6500
Environment=HEALTH_OPPORTUNITY_HTTP_TIMEOUT_MS=12000
Environment=HEALTH_HTTPS_FAIL_CONFIRMATIONS=2
Environment=HEALTH_HTTPS_RECOVERY_CONFIRMATIONS=2
Environment=HEALTH_PUSH_ALERTS=false
ExecStart=$NODE_BIN $MONITOR
Restart=always
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable rh-chain-health.service >/dev/null
systemctl restart rh-chain-health.service
sleep 5
systemctl is-active --quiet rh-chain-health.service

echo "health service active"
echo "health push notifications disabled; Bark/Telegram are reserved for trade signals"
journalctl -u rh-chain-health.service -n 80 --no-pager \
  | grep -E '\[health monitor boot\]|\[health monitor\]|\[health auto-restart\]|\[health notify\]' \
  | tail -20 || true

if [[ -f /data/rh_health_status.json ]]; then
  python3 - <<'PY'
import json
p='/data/rh_health_status.json'
j=json.load(open(p,encoding='utf-8'))
print('health status ok=',j.get('ok'))
print('incidents=',[x.get('key') for x in j.get('incidents',[])])
print('diskPct=',round((j.get('checks',{}).get('disk',{}).get('usedPct') or 0),1))
print('opportunityAgeSec=',j.get('checks',{}).get('db',{}).get('opportunityAgeSec'))
print('pushAlerts=',j.get('monitor',{}).get('pushAlerts'))
print('httpsRoutes=',{k:{'incident':v.get('incident'),'failures':v.get('failures'),'successes':v.get('successes')} for k,v in j.get('httpsRoutes',{}).items()})
PY
fi

echo "DONE: production health monitor V1 deployed in silent mode"
