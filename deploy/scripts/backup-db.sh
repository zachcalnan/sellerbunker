#!/usr/bin/env bash
# Nightly (or manual) Postgres backup for the personal VPS stack.
# Usage:
#   bash deploy/scripts/backup-db.sh
# Cron example (as deploy user):
#   15 3 * * * /opt/seller-dashboard/deploy/scripts/backup-db.sh >> /var/log/sellerbunker-backup.log 2>&1
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/deploy/docker-compose.personal.yml"
ENV_FILE="${ROOT_DIR}/deploy/.env.personal"
BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/deploy/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

POSTGRES_USER="${POSTGRES_USER:-seller}"
POSTGRES_DB="${POSTGRES_DB:-sellertoolkit}"
mkdir -p "${BACKUP_DIR}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/sellerbunker-${STAMP}.dump"

echo "==> Dumping ${POSTGRES_DB} -> ${OUT}"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -Fc \
  >"${OUT}"

echo "==> Pruning backups older than ${KEEP_DAYS} days in ${BACKUP_DIR}"
find "${BACKUP_DIR}" -type f -name 'sellerbunker-*.dump' -mtime "+${KEEP_DAYS}" -delete || true

ls -lh "${OUT}"
echo "Backup OK"
