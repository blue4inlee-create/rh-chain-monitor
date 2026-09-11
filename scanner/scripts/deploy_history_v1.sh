#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rh-chain-monitor}"
CADDY_FILE="/etc/caddy/Caddyfile"
HISTORY_PATH="/sheet-history-4f0d7c91a2b8.csv"
CALIBRATION_PATH="/sheet-calibration-8e3a1f6b7c2d.csv"
PUBLIC_HOST="rh.192-236-234-216.sslip.io"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "ERROR: run as root: sudo bash scanner/scripts/deploy_history_v1.sh"
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
npm --prefix scanner run history-check

if [[ ! -f "$CADDY_FILE" ]]; then
  echo "ERROR: $CADDY_FILE not found"
  exit 3
fi

BACKUP="${CADDY_FILE}.history-v1.$(date +%Y%m%d%H%M%S).bak"
cp -a "$CADDY_FILE" "$BACKUP"

python3 - "$CADDY_FILE" "$HISTORY_PATH" "$CALIBRATION_PATH" <<'PY'
import re,sys
path,hist,cal=sys.argv[1:]
s=open(path,encoding='utf-8').read()
blocks=[]
if hist not in s:
    blocks.append(f'''    handle {hist} {{\n        rewrite * /history.csv\n        reverse_proxy 127.0.0.1:3105\n    }}\n''')
if cal not in s:
    blocks.append(f'''    handle {cal} {{\n        rewrite * /calibration.csv\n        reverse_proxy 127.0.0.1:3105\n    }}\n''')
if not blocks:
    print('Caddy history routes already present')
    raise SystemExit(0)
pattern=r'(?m)^(\s*)handle\s*\{\s*\n\s*reverse_proxy\s+127\.0\.0\.1:8080\s*\n\s*\}'
matches=list(re.finditer(pattern,s))
if not matches:
    raise SystemExit('ERROR: generic 8080 Caddy handle not found; no changes written')
m=matches[-1]
indent=m.group(1)
insert='\n'.join(blocks)
insert='\n'.join(indent + line if line else line for line in insert.split('\n'))
s=s[:m.start()] + insert + '\n' + s[m.start():]
open(path,'w',encoding='utf-8').write(s)
print('Caddy history routes added without exposing secrets')
PY

if ! caddy validate --config "$CADDY_FILE" >/dev/null; then
  cp -a "$BACKUP" "$CADDY_FILE"
  echo "ERROR: Caddy validation failed; original config restored"
  exit 4
fi
systemctl reload caddy
systemctl restart rh-chain-monitor.service
sleep 5
systemctl is-active --quiet rh-chain-monitor.service

curl -fsS http://127.0.0.1:3105/health
printf '\n'
HCODE="$(curl -sS -o /tmp/rh-history.csv -w '%{http_code}' "https://${PUBLIC_HOST}:8443${HISTORY_PATH}")"
CCODE="$(curl -sS -o /tmp/rh-calibration.csv -w '%{http_code}' "https://${PUBLIC_HOST}:8443${CALIBRATION_PATH}")"
echo "history HTTP=$HCODE lines=$(wc -l < /tmp/rh-history.csv)"
echo "calibration HTTP=$CCODE lines=$(wc -l < /tmp/rh-calibration.csv)"

journalctl -u rh-chain-monitor.service -n 120 --no-pager \
  | grep -E '\[history worker boot\]|\[history export boot\]|\[alert worker boot\]' \
  | tail -12 || true

echo "DONE: historical outcome tracking + HTTPS exports deployed"
