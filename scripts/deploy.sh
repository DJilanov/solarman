#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit or preserve local changes before deploying.' >&2
  exit 1
fi
release_sha=$(git rev-parse HEAD)
ssh mitko@92.247.242.86 "test ! -e /home/mitko/solarman-releases/$release_sha && mkdir -p /home/mitko/solarman-releases/$release_sha /home/mitko/solarman/logs" || {
  echo 'Cannot create release: check SSH access and whether that commit is already deployed.' >&2
  exit 1
}
git archive "$release_sha" | ssh mitko@92.247.242.86 "tar -x -C /home/mitko/solarman-releases/$release_sha"
ssh mitko@92.247.242.86 bash -s -- "$release_sha" <<'REMOTE'
set -euo pipefail
release_sha=$1
export PATH=/opt/jilanov-node/node-v24.22.1-linux-x64/bin:$PATH
release_path=/home/mitko/solarman-releases/$release_sha
test -r /home/mitko/.config/solarman/app.env
cd "$release_path"
npm ci
npm run check
npm test
npm run build
node --env-file=/home/mitko/.config/solarman/app.env --input-type=module <<'MIGRATE'
import { dashboardConfig } from './src/dashboard-config.mjs';
import { createPool, migrate } from './src/database.mjs';
const pool = createPool(dashboardConfig(process.env).database);
try { await migrate(pool); } finally { await pool.end(); }
MIGRATE
previous_path=$(readlink /home/mitko/solarman/current || true)
export RELEASE_SHA=$release_sha
if pm2 describe solarman >/dev/null 2>&1; then
  pm2 delete solarman
fi
pm2 start "$release_path/ecosystem.config.cjs" --only solarman --update-env
healthy=false
for attempt in $(seq 1 30); do
  if node scripts/check-release.mjs 2>/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  if pm2 describe solarman >/dev/null 2>&1; then
    pm2 delete solarman
  fi
  node --env-file=/home/mitko/.config/solarman/app.env scripts/quarantine-rollback.mjs
  if [[ -n "$previous_path" ]]; then
    RELEASE_SHA=$(basename "$previous_path") pm2 start "$previous_path/ecosystem.config.cjs" --only solarman --update-env
  fi
  echo 'Release health check failed; previous process restored when available.' >&2
  exit 1
fi
if [[ -n "$previous_path" && "$previous_path" != "$release_path" ]]; then
  ln -sfn "$previous_path" /home/mitko/solarman/previous
fi
ln -sfn "$release_path" /home/mitko/solarman/current
pm2 save
echo "Deployed $release_sha"
REMOTE
