#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rh-chain-monitor}"
CADDY_FILE="/etc/caddy/Caddyfile"
SHADOW_PATH="/sheet-shadow-2c7e9a4d1f6b.csv"
PUBLIC_HOST="rh.192-236-234-216.sslip.io"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "ERROR: run as root: sudo bash scanner/scripts/deploy_shadow_threshold_pool_v1.sh"
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
npm --prefix scanner run shadow-check

BACKUP="${CADDY_FILE}.shadow-pool-v1.$(date +%Y%m%d%H%M%S).bak"
cp -a "$CADDY_FILE" "$BACKUP"
python3 - "$CADDY_FILE" "$SHADOW_PATH" <<'PY'
import re,sys
path,shadow=sys.argv[1:]
s=open(path,encoding='utf-8').read()
if shadow in s:
    print('Caddy shadow route already present')
    raise SystemExit(0)
block=f'''    handle {shadow} {{\n        rewrite * /shadow.csv\n        reverse_proxy 127.0.0.1:3105\n    }}\n'''
pattern=r'(?m)^(\s*)handle\s*\{\s*\n\s*reverse_proxy\s+127\.0\.0\.1:8080\s*\n\s*\}'
matches=list(re.finditer(pattern,s))
if not matches:
    raise SystemExit('ERROR: generic 8080 Caddy handle not found; no changes written')
m=matches[-1]
indent=m.group(1)
insert='\n'.join(indent + line if line else line for line in block.split('\n'))
s=s[:m.start()] + insert + '\n' + s[m.start():]
open(path,'w',encoding='utf-8').write(s)
print('Caddy shadow route added')
PY

if ! caddy validate --config "$CADDY_FILE" >/dev/null; then
  cp -a "$BACKUP" "$CADDY_FILE"
  echo "ERROR: Caddy validation failed; original config restored"
  exit 3
fi
systemctl reload caddy
systemctl restart rh-chain-monitor.service
sleep 6
systemctl is-active --quiet rh-chain-monitor.service

curl -fsS http://127.0.0.1:3105/health
printf '\n'
SCODE="$(curl -sS -o /tmp/rh-shadow.csv -w '%{http_code}' "https://${PUBLIC_HOST}:8443${SHADOW_PATH}")"
echo "shadow HTTP=$SCODE lines=$(wc -l < /tmp/rh-shadow.csv)"
head -12 /tmp/rh-shadow.csv || true

journalctl -u rh-chain-monitor.service -n 180 --no-pager \
  | grep -E '\[shadow threshold boot\]|\[shadow threshold\]|\[history worker boot\]|\[history export boot\]' \
  | tail -20 || true

echo "DONE: Shadow threshold pool V1 deployed"
