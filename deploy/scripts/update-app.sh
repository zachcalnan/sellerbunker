#!/usr/bin/env bash
# Pull latest code and rebuild/restart the personal VPS stack.
# Usage (from repo root on the VPS):
#   bash deploy/scripts/update-app.sh
# Optional:
#   BRANCH=startup-edits bash deploy/scripts/update-app.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/deploy/docker-compose.personal.yml"
ENV_FILE="${ROOT_DIR}/deploy/.env.personal"
BRANCH="${BRANCH:-}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

cd "${ROOT_DIR}"

echo "==> git fetch / pull"
git fetch --all --prune
if [[ -n "${BRANCH}" ]]; then
  git checkout "${BRANCH}"
  git pull --ff-only origin "${BRANCH}"
else
  git pull --ff-only
fi

echo "==> Rebuild and restart"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --build

echo "==> Recent backend logs (Ctrl+C to stop following is not needed; showing last 80 lines)"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" logs --tail=80 backend frontend caddy

echo "Update complete. Smoke-test https://\${SITE_ADDRESS:-your-domain} on your phone."
