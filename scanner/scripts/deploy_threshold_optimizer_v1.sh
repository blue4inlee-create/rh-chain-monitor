#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rh-chain-monitor}"
CADDY_FILE="/etc/caddy/Caddyfile"
THRESHOLD_PATH="/sheet-thresholds-5a3d9c7e1b4f.csv"
PUBLIC_HOST="rh.192-236-234-216.sslip.io"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "ERROR: run as root: sudo bash scanner/scripts/deploy_threshold_optimizer_v1.sh"
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
npm --prefix scanner run threshold-check

BACKUP="${CADDY_FILE}.threshold-v1.$(date +%Y%m%d%H%M%S).bak"
cp -a "$CADDY_FILE" "$BACKUP"
python3 - "$CADDY_FILE" "$THRESHOLD_PATH" <<'PY'
import re,sys
path,threshold=sys.argv[1:]
s=open(path,encoding='utf-8').read()
if threshold in s:
    print('Caddy threshold route already present')
    raise SystemExit(0)
block=f'''    handle {threshold} {{\n        rewrite * /thresholds.csv\n        reverse_proxy 127.0.0.1:3105\n    }}\n'''
pattern=r'(?m)^(\s*)handle\s*\{\s*\n\s*reverse_proxy\s+127\.0\.0\.1:8080\s*\n\s*\}'
matches=list(re.finditer(pattern,s))
if not matches:
    raise SystemExit('ERROR: generic 8080 Caddy handle not found; no changes written')
m=matches[-1]
indent=m.group(1)
insert='\n'.join(indent + line if line else line for line in block.split('\n'))
s=s[:m.start()] + insert + '\n' + s[m.start():]
open(path,'w',encoding='utf-8').write(s)
print('Caddy threshold route added')
PY

if ! caddy validate --config "$CADDY_FILE" >/dev/null; then
  cp -a "$BACKUP" "$CADDY_FILE"
  echo "ERROR: Caddy validation failed; original config restored"
  exit 3
fi
systemctl reload caddy
systemctl restart rh-chain-monitor.service
sleep 5
systemctl is-active --quiet rh-chain-monitor.service

curl -fsS http://127.0.0.1:3105/health
printf '\n'
TCODE="$(curl -sS -o /tmp/rh-thresholds.csv -w '%{http_code}' "https://${PUBLIC_HOST}:8443${THRESHOLD_PATH}")"
echo "thresholds HTTP=$TCODE lines=$(wc -l < /tmp/rh-thresholds.csv)"
head -2 /tmp/rh-thresholds.csv || true

echo "DONE: threshold optimizer V1 deployed"
