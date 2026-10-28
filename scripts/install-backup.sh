#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit or preserve local changes before installing backup tools.' >&2
  exit 1
fi
release_sha=$(git rev-parse HEAD)
release_path=/opt/solarman-ops/releases/$release_sha
ssh -o BatchMode=yes root@92.247.242.86 "test -f /etc/solarman-backup/config.json && test ! -e $release_path && install -d -m 0755 $release_path"
git archive "$release_sha" | ssh -o BatchMode=yes root@92.247.242.86 "tar --no-same-owner -x -C $release_path"
ssh -o BatchMode=yes root@92.247.242.86 bash -s -- "$release_sha" <<'REMOTE'
set -euo pipefail
release_sha=$1
release_path=/opt/solarman-ops/releases/$release_sha
export PATH=/opt/jilanov-node/node-v24.22.1-linux-x64/bin:$PATH
cd "$release_path"
npm ci --omit=dev --ignore-scripts
chown -R root:root "$release_path"
chmod -R go-w "$release_path"
node scripts/backup.mjs check
node --input-type=module <<'VERIFY'
import { readFile } from 'node:fs/promises';
import { summarizeBackupStatus } from './src/backup-status.mjs';
const config=JSON.parse(await readFile('/etc/solarman-backup/config.json','utf8'));
const status=summarizeBackupStatus(JSON.parse(await readFile(config.stateDirectory+'/public/status.json','utf8')));
if (status.state!=='healthy') throw new Error('A current verified backup and recovery test are required before scheduling');
VERIFY
install -m 0644 deploy/solarman-backup.service /etc/systemd/system/solarman-backup.service
install -m 0644 deploy/solarman-backup.timer /etc/systemd/system/solarman-backup.timer
install -m 0644 deploy/solarman-erasure.service /etc/systemd/system/solarman-erasure.service
install -m 0644 deploy/solarman-erasure.timer /etc/systemd/system/solarman-erasure.timer
install -d -o root -g mitko -m 2750 /var/lib/solarman-backup/public
systemd-analyze verify /etc/systemd/system/solarman-backup.service /etc/systemd/system/solarman-backup.timer /etc/systemd/system/solarman-erasure.service /etc/systemd/system/solarman-erasure.timer
ln -sfn "$release_path" /opt/solarman-ops/current
systemctl daemon-reload
systemctl enable --now solarman-backup.timer
systemctl enable --now solarman-erasure.timer
systemctl start solarman-erasure.service
systemctl list-timers --all solarman-backup.timer --no-pager
echo "Installed Solarman backup tools $release_sha"
REMOTE
