#!/usr/bin/env bash
# Build and verify an exact public Git revision before replacing the running code.
# Usage: sudo bash deploy/release.sh <40-character-commit> <expected-version>
set -euo pipefail
revision="${1:-}"
version="${2:-}"
[[ "$EUID" == 0 && "$revision" =~ ^[0-9a-f]{40}$ && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf '%s\n' 'Need root, an exact commit and a release version.' >&2; exit 1; }
[[ -d /opt/ai-plaza && ! -L /opt/ai-plaza && -d /var/lib/ai-plaza && -f /etc/ai-plaza/server.env ]] || { printf '%s\n' 'Expected existing installation and data directories.' >&2; exit 1; }
export PATH="/opt/ai-plaza-node/bin:$PATH"
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
next="/opt/ai-plaza.next-$stamp"
previous="/opt/ai-plaza.previous-$stamp"
backup="/var/backups/ai-plaza/release-$stamp.tar.gz"
[[ ! -e "$next" && ! -e "$previous" ]]
install -d -m 0700 /var/backups/ai-plaza
umask 0022
if git -C /opt/ai-plaza cat-file -e "$revision^{commit}" 2>/dev/null; then
  # Reuse already-fetched Git objects on hosts with an unreliable GitHub link.
  # No working-tree files or uncommitted server changes are copied into the release.
  git clone --no-hardlinks --no-checkout /opt/ai-plaza "$next"
  git -C "$next" remote set-url origin https://github.com/undefinedKey/ai-play.git
else
  git clone --no-checkout https://github.com/undefinedKey/ai-play.git "$next"
fi
git -C "$next" checkout --detach "$revision"
[[ "$(git -C "$next" rev-parse HEAD)" == "$revision" ]]
cd "$next"
node --input-type=module -e 'import fs from "node:fs"; if(JSON.parse(fs.readFileSync("package.json")).version!==process.argv[1])process.exit(1)' "$version"
npm ci --no-audit --no-fund
node --test --test-concurrency=1 tests/*.test.js
npm run build
node deploy/check-artifacts.mjs
node scripts/benchmark-adventure.mjs --realtime --seconds=30

was_active=0
if systemctl is-active --quiet ai-plaza.service; then was_active=1; fi
stopped=0
switched=0
committed=0
rollback() {
  code=$?
  if [[ "$committed" == 0 && "$stopped" == 1 ]]; then
    systemctl stop ai-plaza.service || true
    if [[ -d "$previous" ]]; then
      if [[ "$switched" == 1 && -d /opt/ai-plaza ]]; then mv -- /opt/ai-plaza "/opt/ai-plaza.failed-$stamp"; fi
      if [[ ! -e /opt/ai-plaza ]]; then mv -- "$previous" /opt/ai-plaza; fi
    fi
    if [[ "$was_active" == 1 ]]; then systemctl start ai-plaza.service || true; fi
    printf '%s\n' 'Release failed; previous code restored. Data backup remains private.' >&2
  fi
  exit "$code"
}
trap rollback EXIT
systemctl stop ai-plaza.service
stopped=1
umask 0077
tar -czf "$backup.partial" -C / var/lib/ai-plaza etc/ai-plaza/server.env
tar -tzf "$backup.partial" >/dev/null
mv -- "$backup.partial" "$backup"
# Preserve the entire previous checkout, including any server-local modifications.
mv -- /opt/ai-plaza "$previous"
mv -- "$next" /opt/ai-plaza
switched=1
chown -R root:root /opt/ai-plaza
chmod -R u=rwX,go=rX /opt/ai-plaza
systemctl start ai-plaza.service
healthy=0
for attempt in {1..15}; do
  if curl -fsS http://127.0.0.1:3000/api/health | node --input-type=module -e 'let text="";for await(const chunk of process.stdin)text+=chunk;const h=JSON.parse(text);if(!h.ok||h.version!==process.argv[1]||!h.capabilities.adventure||!h.capabilities.monster_ai||!h.capabilities.monster_patrol||!h.capabilities.movement_candidates||!h.capabilities.farming||!h.capabilities.inventory||!h.capabilities.equipment||!h.capabilities.opportunities||h.mode!=="accounts")process.exit(1)' "$version"; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" == 1 ]]
curl -fsS http://127.0.0.1:3000/api/public/world | node --input-type=module -e 'let text="";for await(const chunk of process.stdin)text+=chunk;const w=JSON.parse(text);if(w.life?.plots_per_agent!==2||w.life?.crops?.length!==2||w.agents.some(a=>a.life?.plots?.length!==2||a.life?.inventory!==undefined||!a.life?.stats?.attack)||w.adventure?.map?.width!==w.room?.width||w.adventure?.map?.height!==w.room?.height||w.adventure?.zones?.length!==3||w.adventure?.monsters?.length!==3||w.adventure.monsters.some(m=>!m.home_position||!m.behavior||m.aggro_radius!==3||m.patrol_radius!==2||m.patrol_interval_ms!==2000))process.exit(1);console.log(JSON.stringify({agents:w.agents.length,active:w.agents.filter(a=>a.status==="active").length,adventure:true,monster_ai:true,monster_patrol:true,farming:true,equipment:true,map:w.adventure.map}))'
curl -fsS 'http://127.0.0.1:3000/watch?view=adventure' -o /dev/null
[[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/world)" == 401 ]]
systemctl is-active --quiet ai-plaza.service
committed=1
printf 'RELEASE_OK commit=%s version=%s previous=%s backup=%s\n' "$revision" "$version" "$previous" "$backup"
