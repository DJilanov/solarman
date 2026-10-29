#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WATCHDOG_SSH_TARGET:?Select a separate root SSH target outside the application host.}"
: "${WATCHDOG_CONFIG_FILE:?Provide an absolute path to the private watchdog configuration.}"
watchdog_node=${WATCHDOG_NODE_BINARY:-/usr/bin/node}
if [[ ! "$WATCHDOG_SSH_TARGET" =~ ^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$ || ! "$watchdog_node" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
  echo 'Invalid watchdog target or Node path.' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit or preserve local changes before installing the watchdog.' >&2
  exit 1
fi
node --input-type=module <<'VERIFY'
import {readWatchdogConfig,assertWatchdogInstallationTarget} from './src/watchdog-config.mjs';
import {spawnSync} from 'node:child_process';
import {lookup} from 'node:dns/promises';
try {
  const config=await readWatchdogConfig(process.env.WATCHDOG_CONFIG_FILE);
  const settings=spawnSync('ssh',['-G',process.env.WATCHDOG_SSH_TARGET],{encoding:'utf8'});
  if(settings.status!==0)throw new Error();
  const host=settings.stdout.split('\n').find(line=>line.startsWith('hostname '))?.slice(9).trim();
  if(!host)throw new Error();
  const addresses=await lookup(host,{all:true});
  assertWatchdogInstallationTarget(config,host,addresses);
}catch{console.error('The private configuration and a separate monitoring host must be verified before installation.');process.exitCode=1;}
VERIFY
release_sha=$(git rev-parse HEAD)
release_path=/opt/solarman-watchdog/releases/$release_sha
watchdog_staged=false
cleanup_staging() {
  if [[ "$watchdog_staged" != true ]]; then return; fi
  ssh -o BatchMode=yes "$WATCHDOG_SSH_TARGET" bash -s -- "$release_sha" <<'CLEANUP' || echo 'Remote staging cleanup could not be confirmed.' >&2
set -euo pipefail
release_path=/opt/solarman-watchdog/releases/$1
rm -f "/etc/solarman-watchdog/incoming-$1.json"
if [[ "$(readlink /opt/solarman-watchdog/current || true)" != "$release_path" ]]; then
  rm -rf -- "$release_path"
fi
CLEANUP
}
trap cleanup_staging EXIT
ssh -o BatchMode=yes "$WATCHDOG_SSH_TARGET" bash -s -- "$release_path" "$watchdog_node" <<'PREFLIGHT'
set -euo pipefail
test "$(id -u)" = 0
test "$(uname -s)" = Linux
test -x /usr/bin/flock
command -v systemctl >/dev/null
"$2" -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
test ! -e "$1"
install -d -m 0755 "$1"
PREFLIGHT
watchdog_staged=true
git archive "$release_sha" src/watchdog-config.mjs src/watchdog-probes.mjs src/watchdog-state.mjs src/watchdog-store.mjs src/watchdog.mjs src/watchdog-permission.mjs src/web-push.mjs src/telegram.mjs src/notification-secrets.mjs src/stored-secret.mjs scripts/watchdog.mjs test/watchdog.test.mjs deploy/watchdog/package.json deploy/watchdog/package-lock.json deploy/solarman-watchdog.service deploy/solarman-watchdog.timer | ssh -o BatchMode=yes "$WATCHDOG_SSH_TARGET" "tar --no-same-owner -x -C $release_path"
ssh -o BatchMode=yes "$WATCHDOG_SSH_TARGET" bash -s <<'DIRECTORY'
set -euo pipefail
if ! id solarman-watchdog >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin solarman-watchdog
fi
test "$(id -u solarman-watchdog)" != 0
install -d -o root -g solarman-watchdog -m 0750 /etc/solarman-watchdog
install -d -o solarman-watchdog -g solarman-watchdog -m 0700 /var/lib/solarman-watchdog
DIRECTORY
cat "$WATCHDOG_CONFIG_FILE" | ssh -o BatchMode=yes "$WATCHDOG_SSH_TARGET" "umask 077; cat > /etc/solarman-watchdog/incoming-$release_sha.json"
ssh -o BatchMode=yes "$WATCHDOG_SSH_TARGET" bash -s -- "$release_sha" "$watchdog_node" <<'INSTALL'
set -euo pipefail
release_sha=$1
watchdog_node=$2
release_path=/opt/solarman-watchdog/releases/$release_sha
incoming=/etc/solarman-watchdog/incoming-$release_sha.json
trap 'rm -f "$incoming"' EXIT
chown root:solarman-watchdog "$incoming"
chmod 0640 "$incoming"
cd "$release_path"
cp deploy/watchdog/package.json package.json
cp deploy/watchdog/package-lock.json package-lock.json
PATH="$(dirname "$watchdog_node"):$PATH" npm ci --omit=dev --ignore-scripts
"$watchdog_node" --test test/watchdog.test.mjs
runuser -u solarman-watchdog -- "$watchdog_node" scripts/watchdog.mjs probe "$incoming"
runuser -u solarman-watchdog -- "$watchdog_node" scripts/watchdog.mjs status "$incoming" >/dev/null
"$watchdog_node" --input-type=module - "$watchdog_node" <<'UNIT'
import {readFile,writeFile} from 'node:fs/promises';
const service=await readFile('deploy/solarman-watchdog.service','utf8');
await writeFile('deploy/solarman-watchdog.service',service.replace('@NODE@',process.argv[2]),{mode:0o644});
UNIT
systemd-analyze verify deploy/solarman-watchdog.service deploy/solarman-watchdog.timer
if systemctl cat solarman-watchdog.timer >/dev/null 2>&1; then systemctl stop solarman-watchdog.timer; fi
if systemctl cat solarman-watchdog.service >/dev/null 2>&1; then systemctl stop solarman-watchdog.service; fi
mv "$incoming" /etc/solarman-watchdog/config.json
chown -R root:root "$release_path"
chmod -R go-w "$release_path"
install -m 0644 deploy/solarman-watchdog.service /etc/systemd/system/solarman-watchdog.service
install -m 0644 deploy/solarman-watchdog.timer /etc/systemd/system/solarman-watchdog.timer
ln -sfn "$release_path" /opt/solarman-watchdog/current
systemctl daemon-reload
systemctl enable --now solarman-watchdog.timer
systemctl start solarman-watchdog.service
systemctl is-active --quiet solarman-watchdog.timer
runuser -u solarman-watchdog -- "$watchdog_node" scripts/watchdog.mjs status
echo "Installed independent Solarman watchdog $release_sha"
INSTALL
