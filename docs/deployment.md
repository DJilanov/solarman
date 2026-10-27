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

The active symlink changes after health reports the expected commit. PM2's process working directory points directly to that immutable release. Build or migration failures occur before the running process is replaced. If process health fails, the script restarts the previous release when available. Schema migrations are not automatically reversed: keep upgrades compatible or plan a database restore explicitly.

The checked-in `deploy/nginx.conf` proxies only to loopback port 3230, including account-specific callbacks, and redirects HTTP to HTTPS except ACME challenges. Install `deploy/cloudflare.conf` as `/etc/nginx/snippets/solarman-cloudflare.conf`, install the site with root access, validate with `nginx -t`, then reload Nginx. Certbot webroot renewal uses `/var/www/letsencrypt`. Access logging is disabled to keep callback and invitation tokens out of request logs. The application trusts forwarded client IP only from loopback; Nginx overwrites that header and accepts Cloudflare client IPs only from [published IPv4](https://www.cloudflare.com/ips-v4) and [IPv6](https://www.cloudflare.com/ips-v6) proxy networks.

PM2 has a six-minute graceful stop allowance because outstanding API acknowledgments and attempted AC cleanup may take time. Persist the process list with `pm2 save`. The checked-in `deploy/pm2-mitko.service` restores that user's saved process list at boot; enabling the unit does not restart the existing daemon. Production log rotation uses `deploy/logrotate.conf` under `/etc/logrotate.d/solarman`.

## Verify

```sh
ssh mitko@92.247.242.86 'pm2 describe solarman'
curl --fail https://solarman.jilanov.com/healthz
```

Check release SHA, HTTPS login, settings and tenant access. A healthy HTTP process does not prove provider access or successful inverter commissioning. Real device monitoring remains unavailable without activated OpenAPI credentials.

## Rollback

Read `/home/mitko/solarman/previous` and confirm the desired release and schema compatibility before switching. Set `RELEASE_SHA` to that release's commit and run `pm2 startOrReload <release>/ecosystem.config.cjs --only solarman --update-env`. Verify health, update the `current` symlink, then run `pm2 save`. Do not restart other applications.

If hardware writes were enabled and the API is unavailable, process shutdown cannot guarantee AC permission was cleared. Check the inverter in SOLARMAN and follow [manual recovery](controller.md#manual-recovery).
