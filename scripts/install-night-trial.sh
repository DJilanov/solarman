#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NIGHT_TRIAL_CONFIG_FILE:?Provide the absolute path to the private trial configuration.}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit the trial job before installing it.' >&2
  exit 1
fi
node scripts/night-trial.mjs check "$NIGHT_TRIAL_CONFIG_FILE"
trial_id=$(node --input-type=module - "$NIGHT_TRIAL_CONFIG_FILE" <<'LOCAL'
import {readFile} from 'node:fs/promises';
import {nightTrialConfig} from './src/night-trial.mjs';
const config=nightTrialConfig(JSON.parse(await readFile(process.argv[2],'utf8')));
if(Date.parse(config.expiresAt)<=Date.now()+300000)throw Error('The trial expiry must be in the future');
process.stdout.write(config.trialId);
LOCAL
)
release_sha=$(git rev-parse HEAD)
ssh -T -o BatchMode=yes root@92.247.242.86 "test \"\$(readlink /opt/solarman-ops/current)\" = /opt/solarman-ops/releases/$release_sha && install -d -o root -g mitko -m 0750 /etc/solarman-night-trials"
cat "$NIGHT_TRIAL_CONFIG_FILE" | ssh -T -o BatchMode=yes root@92.247.242.86 "umask 077; cat > /etc/solarman-night-trials/$trial_id.incoming.json"
ssh -T -o BatchMode=yes root@92.247.242.86 bash -s -- "$trial_id" <<'REMOTE'
set -euo pipefail
trial_id=$1
incoming=/etc/solarman-night-trials/$trial_id.incoming.json
config_file=/etc/solarman-night-trials/$trial_id.json
trap 'rm -f "$incoming"' EXIT
if [[ -e "$config_file" ]]; then
  cmp --silent "$incoming" "$config_file"
else
  install -o root -g mitko -m 0640 "$incoming" "$config_file"
fi
/opt/jilanov-node/node-v24.22.1-linux-x64/bin/node --input-type=module - "$config_file" <<'UNITS'
import {readFile,writeFile} from 'node:fs/promises';
import {nightTrialConfig} from '/opt/solarman-ops/current/src/night-trial.mjs';
const file=process.argv[2],config=nightTrialConfig(JSON.parse(await readFile(file,'utf8')));
for(const [action,time] of [['expire',config.expiresAt],['review',config.reviewAt]]){
 const name=`solarman-night-trial-${config.trialId}-${action}`;
 const date=new Date(Math.ceil(Date.parse(time)/1000)*1000).toISOString().slice(0,19).replace('T',' ')+' UTC';
 const service=`[Unit]\nDescription=Solarman night trial ${action}\nWants=network-online.target\nAfter=network-online.target postgresql.service\nStartLimitIntervalSec=0\n\n[Service]\nType=oneshot\nUser=mitko\nGroup=mitko\nExecStart=/opt/jilanov-node/node-v24.22.1-linux-x64/bin/node --env-file=/home/mitko/.config/solarman/app.env /opt/solarman-ops/current/scripts/night-trial.mjs ${action} ${file}\nRestart=on-failure\nRestartSec=300\nTimeoutStartSec=120\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\n`;
 const timer=`[Unit]\nDescription=Solarman night trial ${action} deadline\n\n[Timer]\nOnCalendar=${date}\nPersistent=true\nAccuracySec=1s\nUnit=${name}.service\n\n[Install]\nWantedBy=timers.target\n`;
 await writeFile(`/etc/systemd/system/${name}.service`,service,{mode:0o644});
 await writeFile(`/etc/systemd/system/${name}.timer`,timer,{mode:0o644});
}
UNITS
systemd-analyze verify "/etc/systemd/system/solarman-night-trial-$trial_id-expire.service" "/etc/systemd/system/solarman-night-trial-$trial_id-review.service" "/etc/systemd/system/solarman-night-trial-$trial_id-expire.timer" "/etc/systemd/system/solarman-night-trial-$trial_id-review.timer"
/opt/jilanov-node/node-v24.22.1-linux-x64/bin/node --env-file=/home/mitko/.config/solarman/app.env /opt/solarman-ops/current/scripts/night-trial.mjs register "$config_file"
systemctl daemon-reload
systemctl enable --now "solarman-night-trial-$trial_id-expire.timer" "solarman-night-trial-$trial_id-review.timer"
systemctl is-active --quiet "solarman-night-trial-$trial_id-expire.timer"
systemctl is-active --quiet "solarman-night-trial-$trial_id-review.timer"
systemctl list-timers --all "solarman-night-trial-$trial_id-*" --no-pager
REMOTE
