#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rh-chain-monitor}"
ENV_FILE="/etc/rh-chain-monitor-alert.env"
DROPIN_DIR="/etc/systemd/system/rh-chain-monitor.service.d"
DROPIN_FILE="$DROPIN_DIR/alerts.conf"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root: sudo bash scanner/scripts/configure_alert_channels.sh"
  exit 1
fi

read -rsp "Bark device key: " BARK_DEVICE_KEY; echo
read -rsp "Telegram bot token: " TELEGRAM_BOT_TOKEN; echo

if [[ -z "$BARK_DEVICE_KEY" || -z "$TELEGRAM_BOT_TOKEN" ]]; then
  echo "ERROR: Bark key and Telegram bot token are both required"
  exit 1
fi

echo "Validating Telegram bot..."
BOT_JSON="$(curl -fsS --max-time 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe")"
python3 - "$BOT_JSON" <<'PY'
import json,sys
j=json.loads(sys.argv[1])
if not j.get('ok'):
    raise SystemExit('ERROR: Telegram token invalid')
print('Telegram bot OK:', j['result'].get('username',''))
PY

echo "Now open Telegram, send /start to your bot, then press Enter here."
read -r _
UPDATES_JSON="$(curl -fsS --max-time 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=20")"
TELEGRAM_CHAT_ID="$(python3 - "$UPDATES_JSON" <<'PY'
import json,sys
j=json.loads(sys.argv[1])
ids=[]
for u in j.get('result',[]):
    for k in ('message','edited_message','channel_post','my_chat_member'):
        x=u.get(k) or {}
        chat=x.get('chat') or {}
        if chat.get('id') is not None:
            ids.append(str(chat['id']))
if not ids:
    raise SystemExit('')
print(ids[-1])
PY
)"

if [[ -z "$TELEGRAM_CHAT_ID" ]]; then
  echo "ERROR: no Telegram chat found. Send /start to the bot and run again."
  exit 1
fi

umask 077
cat > "$ENV_FILE" <<EOF
ALERT_POLL_MS=15000
ALERT_CONFIRMATIONS=2
ALERT_COOLDOWN_MS=1800000
ALERT_MIN_SCORE=70
ALERT_MIN_CONFIDENCE=60
ALERT_MIN_LIQUIDITY=10000
ALERT_MAX_RISK_PENALTY=8
ALERT_INSTANT_SCORE=85
ALERT_REQUIRE_ALL_CHANNELS=true
BARK_SERVER=https://api.day.app
BARK_DEVICE_KEY=$BARK_DEVICE_KEY
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
EOF
chmod 600 "$ENV_FILE"

mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_FILE" <<EOF
[Service]
EnvironmentFile=$ENV_FILE
EOF

cd "$APP_DIR"
git pull --ff-only origin main
cd scanner
npm run check >/dev/null
npm run alert-check

systemctl daemon-reload
systemctl restart rh-chain-monitor.service
sleep 3
systemctl is-active --quiet rh-chain-monitor.service

echo "Sending Bark test..."
curl -fsS --max-time 10 -X POST "https://api.day.app/${BARK_DEVICE_KEY}" \
  --data-urlencode "title=RH Chain 提醒已启用" \
  --data-urlencode "body=Bark 分钟级 Early Alpha 提醒测试成功" \
  --data-urlencode "group=RH Chain" >/dev/null

echo "Sending Telegram test..."
curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=✅ RH Chain 分钟级 Early Alpha 提醒已启用\nBark + Telegram 双通道已连接。" >/dev/null

echo "Checking alert worker..."
journalctl -u rh-chain-monitor.service -n 80 --no-pager | grep -E '\[alert worker boot\]|\[alert sent\]|alert-worker' | tail -10 || true

echo "DONE: Bark + Telegram alert channels configured"
