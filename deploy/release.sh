#!/usr/bin/env bash
# Prepare first; trusted hooks stop the bridge and verify migration at cutover.
# Usage: sudo bash deploy/release.sh <40-character-commit> <expected-version>
set -euo pipefail
revision="${1:-}"
version="${2:-}"
[[ "$EUID" == 0 && "$revision" =~ ^[0-9a-f]{40}$ && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf '%s\n' 'Need root, an exact commit and a release version.' >&2; exit 1; }
[[ -d /opt/ai-plaza && ! -L /opt/ai-plaza && -d /var/lib/ai-plaza && -f /etc/ai-plaza/server.env ]] || { printf '%s\n' 'Expected existing installation and data directories.' >&2; exit 1; }
command -v python3 >/dev/null
python3 -c 'import sqlite3, tarfile, pathlib'
export PATH="/opt/ai-plaza-node/bin:$PATH"
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
next="/opt/ai-plaza.next-$stamp"
previous="/opt/ai-plaza.previous-$stamp"
backup="/var/backups/ai-plaza/release-$stamp.tar.gz"
data_helper="/var/backups/ai-plaza/release-data-$stamp.py"
status_file="${PLAZA_RELEASE_STATUS_FILE:-/var/backups/ai-plaza/release-$stamp.status.json}"
before_hook="${PLAZA_RELEASE_BEFORE_SWITCH_HOOK:-}"
verify_hook="${PLAZA_RELEASE_VERIFY_SWITCH_HOOK:-}"
[[ ! -e "$next" && ! -e "$previous" ]]
install -d -m 0700 /var/backups/ai-plaza
[[ "$status_file" =~ ^/var/backups/ai-plaza/[A-Za-z0-9._-]+\.json$ && ! -L "$status_file" ]]
for hook in "$before_hook" "$verify_hook"; do
  if [[ -n "$hook" ]]; then
    [[ "$hook" =~ ^/var/backups/ai-plaza/[A-Za-z0-9._-]+$ && -f "$hook" && ! -L "$hook" && -x "$hook" ]]
    [[ "$(stat -c %u "$hook")" == 0 ]]
    (( (8#$(stat -c %a "$hook") & 8#022) == 0 ))
  fi
done
umask 0022
if git -C /opt/ai-plaza cat-file -e "$revision^{commit}" 2>/dev/null; then
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
# Recovery is checked before any service is stopped or checkout moved.
install -m 0700 deploy/release-data.py "$data_helper"
python3 "$data_helper" --help >/dev/null
old_version="$(node --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync("/opt/ai-plaza/package.json")).version)')"
[[ "$old_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
was_active=0
if systemctl is-active --quiet ai-plaza.service; then was_active=1; fi
stop_attempted=0
backup_ready=0
committed=0
write_status() {
  umask 0077
  printf '{"phase":"%s","backup":"%s","previous":"%s","old_version":"%s","was_active":%s}\n' "$1" "$backup" "$previous" "$old_version" "$was_active" > "$status_file.tmp-$$"
  mv -- "$status_file.tmp-$$" "$status_file"
}
healthy_version() {
  local expected="$1"
  for attempt in {1..15}; do
    if curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3000/api/health | node --input-type=module -e 'let text="";for await(const chunk of process.stdin)text+=chunk;const h=JSON.parse(text);if(!h.ok||h.version!==process.argv[1]||h.mode!=="accounts")process.exit(1)' "$expected"; then return 0; fi
    sleep 1
  done
  return 1
}
server_stopped() {
  local pid state
  pid="$(systemctl show ai-plaza.service --property=MainPID --value)" || return 1
  state="$(systemctl show ai-plaza.service --property=ActiveState --value)" || return 1
  [[ "$pid" == 0 && ( "$state" == inactive || "$state" == failed ) ]]
}
rollback() {
  local code=$? restored=1
  trap - EXIT TERM INT
  set +e
  if [[ "$committed" == 0 ]]; then
    if [[ "$stop_attempted" == 1 ]]; then
      systemctl stop ai-plaza.service
      if ! server_stopped; then restored=0; fi
      if [[ "$restored" == 1 && -d "$previous" ]]; then
        if [[ -e /opt/ai-plaza ]]; then mv -- /opt/ai-plaza "/opt/ai-plaza.failed-$stamp" || restored=0; fi
        if [[ "$restored" == 1 ]]; then mv -- "$previous" /opt/ai-plaza || restored=0; fi
        if [[ "$restored" == 1 && "$backup_ready" == 1 ]]; then python3 "$data_helper" "$backup" "$stamp" || restored=0; fi
      fi
      if [[ "$restored" == 1 && "$was_active" == 1 ]]; then systemctl start ai-plaza.service || restored=0; fi
    fi
    if [[ "$restored" == 1 && "$was_active" == 1 ]]; then healthy_version "$old_version" || restored=0; fi
    if [[ "$restored" == 1 ]]; then
      write_status rolled_back
      printf '%s\n' 'RELEASE_ROLLBACK_OK previous code and world data verified; backup retained.' >&2
    else
      write_status rollback_failed
      systemctl stop ai-plaza.service || true
      printf '%s\n' 'RELEASE_ROLLBACK_FAILED services must remain stopped for operator recovery.' >&2
    fi
  fi
  exit "$code"
}
trap rollback EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
write_status prepared
if [[ -n "$before_hook" ]]; then "$before_hook" "$revision" "$version" "$backup" "$previous"; fi
# Mark before systemctl: a failed stop can still have stopped the unit.
stop_attempted=1
write_status stop_attempted
systemctl stop ai-plaza.service
server_stopped
umask 0077
tar -czf "$backup.partial" -C / var/lib/ai-plaza etc/ai-plaza/server.env
tar -tzf "$backup.partial" >/dev/null
mv -- "$backup.partial" "$backup"
backup_ready=1
write_status backup_ready
mv -- /opt/ai-plaza "$previous"
mv -- "$next" /opt/ai-plaza
write_status switched
chown -R root:root /opt/ai-plaza
chmod -R u=rwX,go=rX /opt/ai-plaza
systemctl start ai-plaza.service
healthy_version "$version"
cd /opt/ai-plaza
node deploy/check-live.mjs "$version"
systemctl is-active --quiet ai-plaza.service
if [[ -n "$verify_hook" ]]; then "$verify_hook" "$revision" "$version" "$backup" "$previous"; fi
write_status committed
committed=1
printf 'RELEASE_OK commit=%s version=%s previous=%s backup=%s\n' "$revision" "$version" "$previous" "$backup"
