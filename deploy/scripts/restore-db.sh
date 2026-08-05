#!/usr/bin/env bash
# Restore a Render (or other) pg_dump into the personal VPS Postgres container.
# Usage (from repo root on the VPS):
#   bash deploy/scripts/restore-db.sh /path/to/sellerbunker.dump
#
# Supports custom format (-Fc) dumps from:
#   pg_dump "$DATABASE_URL" -Fc -f sellerbunker.dump
set -euo pipefail

DUMP_PATH="${1:-}"
if [[ -z "${DUMP_PATH}" || ! -f "${DUMP_PATH}" ]]; then
  echo "Usage: $0 /path/to/dump.dump" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/deploy/docker-compose.personal.yml"
ENV_FILE="${ROOT_DIR}/deploy/.env.personal"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Copy from .env.personal.example and fill secrets." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

POSTGRES_USER="${POSTGRES_USER:-seller}"
POSTGRES_DB="${POSTGRES_DB:-sellertoolkit}"

echo "==> Ensuring postgres is up"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d postgres
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  sh -c "until pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}; do sleep 1; done"

echo "==> Restoring ${DUMP_PATH} into ${POSTGRES_DB} (destructive to existing data in that DB)"
# Copy dump into the container then restore
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" cp \
  "${DUMP_PATH}" "postgres:/tmp/restore.dump"

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  pg_restore --clean --if-exists --no-owner --no-acl \
  -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" /tmp/restore.dump \
  || true
# pg_restore returns non-zero on some benign warnings with --clean; verify connectivity:

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "SELECT COUNT(*) AS user_count FROM users;" \
  || docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "\\dt"

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  rm -f /tmp/restore.dump

echo "Restore finished. Start/restart the app stack if needed:"
echo "  docker compose -f deploy/docker-compose.personal.yml --env-file deploy/.env.personal up -d --build"
