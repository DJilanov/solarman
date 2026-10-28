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

`/healthz` continues to check the database and scheduler shutdown state, and now reports the operational monitor heartbeat. A heartbeat delayed by more than three minutes returns HTTP 503 with generic `monitoring: delayed`; it exposes no tenant details. Device conditions live in the authenticated health page and do not change a healthy process response into a claim that inverter behavior has been commissioned. Fault records remain available across process restarts. The in-app channel is implemented; external notification delivery, scheduled private backups and a verified restore are still required work.

## Rollback

Read `/home/mitko/solarman/previous` and confirm the desired release and schema compatibility before switching. Delete only the `solarman` PM2 process, then set `RELEASE_SHA` to the desired commit and run `pm2 start <release>/ecosystem.config.cjs --only solarman --update-env`. Verify health and the actual process working directory and frontend, update the `current` symlink, then run `pm2 save`. Do not restart other applications.

If hardware writes were enabled and the API is unavailable, process shutdown cannot guarantee AC permission was cleared. Check the inverter in SOLARMAN and follow [manual recovery](controller.md#manual-recovery).
