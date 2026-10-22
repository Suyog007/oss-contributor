#!/usr/bin/env bash
# One-command local setup: Postgres in Docker, .env, migrations, health check.
#
#   pnpm local          # set everything up
#   pnpm local --run    # also start the worker
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Add GITHUB_TOKEN and FIREWORKS_API_KEY, then re-run."
fi

if ! docker ps --format '{{.Names}}' | grep -q '^oss-contributor-db$'; then
  docker rm -f oss-contributor-db >/dev/null 2>&1 || true
  docker run -d --name oss-contributor-db \
    -e POSTGRES_USER=oss_contributor -e POSTGRES_PASSWORD=oss_contributor \
    -e POSTGRES_DB=oss_contributor -p 5432:5432 postgres:17 >/dev/null
  echo "Started Postgres container oss-contributor-db"
fi

for _ in $(seq 1 30); do
  docker exec oss-contributor-db pg_isready -U oss_contributor >/dev/null 2>&1 && break
  sleep 1
done
docker exec oss-contributor-db psql -U oss_contributor -tc \
  "SELECT 1 FROM pg_database WHERE datname='oss_contributor_test'" | grep -q 1 \
  || docker exec oss-contributor-db createdb -U oss_contributor oss_contributor_test

pnpm install --frozen-lockfile
pnpm db:deploy
pnpm doctor || echo "doctor reported problems above; fix them before running the pipeline"

if [ "${1:-}" = "--run" ]; then
  exec pnpm worker
fi
