# Deployment and recovery

The production instance runs as `mitko@92.247.242.86`, with the existing PostgreSQL 15 instance and an isolated `solarman` database owned by the non-superuser `solarman_app` role. It does not reuse an EU project's database or role.

## Paths

| Purpose | Path |
|---|---|
| Private application environment | `/home/mitko/.config/solarman/app.env` (0600) |
| Private database connection | `/home/mitko/.config/solarman/database.env` (0600) |
| Immutable application releases | `/home/mitko/solarman-releases/<commit>` |
| Active release pointer | `/home/mitko/solarman/current` |
| Previous release pointer | `/home/mitko/solarman/previous` after the second release |
| Application logs | `/home/mitko/solarman/logs/` |
| Nginx site | `/etc/nginx/sites-available/solarman.jilanov.com` |
| TLS certificate | `/etc/letsencrypt/live/solarman.jilanov.com/` |

The private directory is 0700. Back up the database and `CREDENTIAL_ENCRYPTION_KEY` separately and securely; a database backup alone cannot restore provider links. Do not place configuration or backups in the public repository.

Production values include `DB_HOST=127.0.0.1`, `DB_PORT=5432`, `DB_NAME=solarman`, `LISTEN_HOST=127.0.0.1`, `PORT=3230`, and both public/callback origins set to `https://solarman.jilanov.com`. `WRITES_ENABLED=false` is required until real commissioning. The supplied test dashboard credentials are stored only as a salted password hash.

## Release

For schema or recovery releases, install the matching root capsule with `bash scripts/install-backup.sh` before the application deploy. Verify `solarman-erasure.timer` and a fresh root-owned `/var/lib/solarman-backup/public/erasure-guard.json`, then prove an older backup upgrade using that capsule. Policy-observation releases additionally require `observationsQuarantined` in the restore report. The application fails HTTPS startup without the erasure recovery fence. See [erasure receipts](backups.md#erasure-receipts-and-restored-access); do not bypass it with a fabricated empty file. After the application upgrade, prove a fresh backup/restore as well.

Run local checks, inspect changes and commit/push the intended release, then:

```sh
bash scripts/deploy.sh
```

The script archives the current clean Git commit and builds it on the server with Node 24.22.1 from `/opt/jilanov-node/node-v24.22.1-linux-x64/bin`. It runs syntax/type checks, unit tests and a production build, applies versioned migrations to Solarman, and updates only the `solarman` PM2 process. A PostgreSQL advisory lock prevents duplicate schedulers. Never use PM2 cluster mode for this service.

The active symlink changes after the PM2 working directory and entry point, health response and served frontend all match the new release. The script deletes and recreates only the `solarman` process so PM2 cannot retain the previous release's working directory. This single-process deployment has a brief restart interval. Build or migration failures occur before the running process is replaced. If process verification fails, the script restarts the previous release when available. Schema migrations are not automatically reversed: keep upgrades compatible or plan a database restore explicitly.

The checked-in `deploy/nginx.conf` proxies only to loopback port 3230, including account-specific callbacks, and redirects HTTP to HTTPS except ACME challenges. Install `deploy/cloudflare.conf` as `/etc/nginx/snippets/solarman-cloudflare.conf`, install the site with root access, validate with `nginx -t`, then reload Nginx. Certbot webroot renewal uses `/var/www/letsencrypt`. Access logging is disabled to keep callback and invitation tokens out of request logs. The application trusts forwarded client IP only from loopback; Nginx overwrites that header and accepts Cloudflare client IPs only from [published IPv4](https://www.cloudflare.com/ips-v4) and [IPv6](https://www.cloudflare.com/ips-v6) proxy networks.

PM2 has a six-minute graceful stop allowance because outstanding API acknowledgments and attempted AC cleanup may take time. Persist the process list with `pm2 save`. The checked-in `deploy/pm2-mitko.service` restores that user's saved process list at boot; enabling the unit does not restart the existing daemon. Production log rotation uses `deploy/logrotate.conf` under `/etc/logrotate.d/solarman`.

## Verify

```sh
ssh mitko@92.247.242.86 'pm2 describe solarman'
curl --fail https://solarman.jilanov.com/healthz
```

Check release SHA, HTTPS login, settings and tenant access. A healthy HTTP process does not prove provider access or successful inverter commissioning. Real device monitoring remains unavailable without activated OpenAPI credentials.

## Operational monitoring

Settings → **System health** shows durable, tenant-scoped alerts and separate timestamps for attempts, successful assessments and device uploads. Overview shows up to three active alerts and the unseen count. The monitor reads PostgreSQL once a minute; it does not increase provider polling. Refresh status reloads stored state rather than issuing a device command. Alert history includes active, seen and resolved episodes, with explicit resolution when a monitored binding changes. Marking an alert as seen does not suppress the underlying condition or confirm a hardware stop. Severity escalation clears the acknowledgment so an exhausted allowance is not hidden by an earlier acknowledgment of low capacity. Acknowledgments include the displayed revision; a delayed acknowledgment for an older warning cannot hide its newer critical revision. Monitor transactions have bounded lock/query timeouts, and draining the monitor does not postpone inverter cleanup during shutdown.

Persistent stale-data detection allows the effective device poll interval plus eight minutes for a five-minute logger cycle and delivery jitter (13 minutes at the default cadence). Three consecutive failed assessments open a separate alert; quota refusal does not count as a failed device communication. Offline/alarm assertions retain the time of the last provider report. Uncertain or cleanup-required control ownership older than two minutes opens a critical alert, including obligations on previous bindings. Stored control faults force paused intent on restart; provider telemetry alone cannot clear them.

`/healthz` checks the database and scheduler shutdown state and reports operational-monitor and notification-worker heartbeats. Operational monitoring delayed by more than three minutes, or delivery work delayed by more than one minute, returns HTTP 503 with a generic status and no tenant details. Device conditions live in the authenticated health page and do not turn process health into evidence of physical commissioning. Fault records remain available across process restarts. Tenant-configured iPhone/browser and optional Telegram delivery are described in [notifications](notifications.md). The independent monitor uses a separate host and does not run under the application PM2 process. Encrypted offsite backup, separate root-owned scheduling tools, administrator recovery health and the verified isolated restore are described in [backup and recovery](backups.md).

## Independent outage monitor

An optional 32-character lowercase hexadecimal `probe` on `/healthz` is echoed in its no-store response. Invalid or repeated probes return 400. The [independent watchdog](watchdog.md) uses a fresh challenge so cached responses cannot count as current health. Its installer targets a separate host; the main PM2 deployment does not start it.

## Rollback

Read `/home/mitko/solarman/previous` and confirm the desired release and schema compatibility before switching. Delete only the `solarman` PM2 process, then set `RELEASE_SHA` to the desired commit and run `pm2 start <release>/ecosystem.config.cjs --only solarman --update-env`. Verify health and the actual process working directory and frontend, update the `current` symlink, then run `pm2 save`. Do not restart other applications.

If hardware writes were enabled and the API is unavailable, process shutdown cannot guarantee AC permission was cleared. Check the inverter in SOLARMAN and follow [manual recovery](controller.md#manual-recovery).

## Commissioning and rollback

Migration 020 revokes previous activation while retaining cleanup obligations; activation alone cannot replace commissioning approval. Ordinary starts and enabling writes check approved device-bound commissioning. Attended sessions require current-password confirmation and end on expiry or service restart. Keep host writes disabled until an attended physical test is ready. Approval requires all six physical acceptance checks. Solar charging follows native inverter and battery limits; the withdrawn application solar-cap requirement is not an approval blocker.

If the new release fails health checks, deployment stops that process and runs `scripts/quarantine-rollback.mjs` before starting the previous release. Quarantine pauses/revokes all workspace controls, invalidates commissioning and observations, cancels queued starts and preserves physical cleanup. If quarantine fails, the previous application is not started. This prevents older software, which lacks the new commissioning gate, from inheriting an attended session.

Migration 022 adds multiple notification channels and browser subscriptions. It requires a release containing `022_web_push.sql`; automatic fallback refuses an older application that cannot read this storage. Rollback also quarantines all notification delivery and pending browser activation. If the previous release predates 022, repair with a compatible release or explicitly restore a pre-upgrade checkpoint through the documented recovery procedure. Deployment does not automatically discard new data to reverse the schema. Keep the persistent Web Push key pair in the private environment; the encrypted configuration backup includes it.

Recovery tooling invalidates both active attended sessions and approval fixtures after restoring a backup. Its `commissioningQuarantined` proof includes archived invalidation records and must pass before a restore is accepted.

Migration 025 adds energy-assistant preferences, appliance plans and briefing receipts. Install the matching root-owned recovery capsule before upgrading the app, and verify an isolated restore from an older checkpoint. Restores/rollbacks disable daily briefings and appliance reminders in addition to the existing control and notification quarantine. Rollback requires a release containing 025 so archive/erasure handling cannot silently omit the new records; otherwise restore a pre-upgrade checkpoint. A fresh post-deployment backup and drill must report `energyExperienceQuarantined: true`. Ordinary deployments do not enable notifications for other workspaces or change an approved night trial.
