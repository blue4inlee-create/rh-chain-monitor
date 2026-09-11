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

trim() {
  local v="$1"
  v="${v//$'\r'/}"
  v="${v//$'\n'/}"
  printf '%s' "$v" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

read -rsp "Bark device key: " BARK_DEVICE_KEY; echo
BARK_DEVICE_KEY="$(trim "$BARK_DEVICE_KEY")"
if [[ -z "$BARK_DEVICE_KEY" ]]; then
  echo "ERROR: Bark device key is required"
  exit 1
fi

while true; do
  read -rsp "Telegram bot token: " TELEGRAM_BOT_TOKEN; echo
  TELEGRAM_BOT_TOKEN="$(trim "$TELEGRAM_BOT_TOKEN")"
  TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN#bot}"

  if [[ ! "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{20,}$ ]]; then
    echo "ERROR: This does not look like a BotFather API token."
    echo "Use the token returned by @BotFather after /newbot, not the bot username or t.me link."
    continue
  fi

  echo "Validating Telegram bot..."
  TMP_JSON="$(mktemp)"
  HTTP_CODE="$(curl -sS --max-time 10 -o "$TMP_JSON" -w '%{http_code}' "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" || true)"
  BOT_JSON="$(cat "$TMP_JSON")"
  rm -f "$TMP_JSON"

  if [[ "$HTTP_CODE" != "200" ]]; then
    if [[ "$HTTP_CODE" == "401" || "$HTTP_CODE" == "404" ]]; then
      echo "ERROR: Telegram rejected this token (HTTP $HTTP_CODE)."
      echo "Open @BotFather -> /mybots -> choose your bot -> API Token, then copy the full token again."
    else
      echo "ERROR: Telegram validation failed (HTTP ${HTTP_CODE:-unknown})."
    fi
    continue
  fi

  if ! python3 - "$BOT_JSON" <<'PY'
import json,sys
j=json.loads(sys.argv[1])
if not j.get('ok'):
    raise SystemExit(1)
print('Telegram bot OK:', j['result'].get('username',''))
PY
  then
    echo "ERROR: Telegram response was not a valid bot response. Try the token again."
    continue
  fi
  break
done

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
