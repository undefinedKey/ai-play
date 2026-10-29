#!/usr/bin/env bash
# Consistent single-instance snapshot, including SQLite WAL files and demo checkpoints.
# Run with: sudo bash /opt/ai-plaza/deploy/backup.sh
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then
  printf '%s\n' 'Run with sudo bash /opt/ai-plaza/deploy/backup.sh.' >&2
  exit 1
fi
if [[ ! -d /var/lib/ai-plaza || ! -f /etc/ai-plaza/server.env ]]; then
  printf '%s\n' 'Expected /var/lib/ai-plaza and /etc/ai-plaza/server.env before backing up.' >&2
  exit 1
fi
install -d -m 0700 /var/backups/ai-plaza
backup_path="/var/backups/ai-plaza/ai-plaza-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
was_active=0
if systemctl is-active --quiet ai-plaza.service; then was_active=1; fi
restore_service() {
  if [[ "${was_active}" == 1 ]]; then systemctl start ai-plaza.service; fi
}
trap restore_service EXIT
systemctl stop ai-plaza.service
umask 0077
tar --create --gzip --file "${backup_path}.partial" --directory / \
  var/lib/ai-plaza etc/ai-plaza/server.env
mv -- "${backup_path}.partial" "${backup_path}"
tar --list --gzip --file "${backup_path}" >/dev/null
printf 'Backup created: %s\nContains credentials; keep it private.\n' "${backup_path}"
