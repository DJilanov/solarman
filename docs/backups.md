# Backup and recovery

Solarman backs up its own PostgreSQL database and matching private application configuration to a dedicated private S3 bucket. It does not change the EU applications' databases or backup jobs. The AWS SDK is a production dependency for authenticated uploads, version selection, protection checks and download verification.

## Contents and protection

Each run creates three client-encrypted `age` objects under `runs/<run UUID>/`: a custom-format PostgreSQL dump, application environment and manifest. A read-only exported PostgreSQL snapshot binds table counts, migration versions and password-hash fingerprints to the dump. Every linked account must decrypt with the saved application key before backup succeeds. Configuration is checked again after the dump to detect concurrent configuration/key changes.

The database streams directly through encryption. Plaintext dumps and environment files are not written to the work directory. The environment includes the credential encryption key and provider credentials and receives the same encryption as the database. Only the owner's public Ed25519 recipient is installed on the server. Keep an independent secure copy of the original private identity; a replacement SSH key cannot decrypt earlier backups.

The dedicated bucket has all public-access blocks enabled, bucket-owner enforced ownership, AES256 server-side encryption and versioning. Current objects become eligible for expiry after 30 days; older versions become eligible 30 days after becoming noncurrent. This is not a strict 30-day purge guarantee or Object Lock. Each uploaded version is checked with HeadObject and downloaded again to verify encrypted length and SHA256. The encrypted manifest records exact database/configuration object versions and checksums.

Encrypted temporary files are removed after success or failure. Private receipts remain under `/var/lib/solarman-backup`. Concurrent status updates use a [Linux descriptor lock](https://man7.org/linux/man-pages/man2/flock.2.html) to preserve both backup and restore results.

## Installation and schedule

Root operational code runs from `/opt/solarman-ops/releases/<commit>` through `/opt/solarman-ops/current`, separately from the PM2 application's `mitko`-owned releases. Never run root tooling from an application-owned checkout.

The existing protected server setup uses:

- `/etc/solarman-backup/config.json`, root mode 0600: database `solarman`, AWS region, dedicated bucket, retention 30 and absolute `appEnv`, `awsEnv`, `recipientFile`, `age`, `stateDirectory` paths.
- `/etc/solarman-backup/recipient.pub`, root mode 0600: public Ed25519 recipient without a comment. No private identity is installed on the server.
- `/opt/solarman-tools/age-v1.3.2/age`: the verified Linux binary from the [official release](https://github.com/FiloSottile/age/releases/tag/v1.3.2). The matching Mac binary is under `~/.local/share/solarman-tools/age-v1.3.2/age`.
- `/var/lib/solarman-backup/public`, root:mitko mode 2750, with a root-owned mode 0640 status receipt. The application can read it and cannot modify it. Private work and receipts remain root-only.

AWS values are read in memory from the existing protected environment named by `awsEnv`: `MINIO_ENDPOINT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`. The endpoint must identify AWS S3. Secrets are not duplicated into source or command arguments. Recovering a lost host requires independently available AWS read credentials and the original local age identity; the local recovery record contains neither credential.

After a verified backup and real restore test, install from a clean committed checkout:

```sh
bash scripts/install-backup.sh
```

The installer creates a root-owned capsule for the exact commit, installs production dependencies without lifecycle scripts, checks bucket protections and current recovery evidence, validates the Solarman-only units and enables the timer. Other services and timers are untouched. The schedule is 03:17 Europe/Sofia with up to two minutes of jitter and catch-up after downtime. The job has a 30-minute timeout and restricted filesystem writes.

```sh
ssh root@92.247.242.86 systemctl list-timers --all solarman-backup.timer
ssh root@92.247.242.86 systemctl start solarman-backup.service
ssh root@92.247.242.86 journalctl -u solarman-backup.service -n 20 --no-pager
```

## Recovery tests

Run at least weekly from the trusted Mac, with the original private identity available:

```sh
node scripts/restore-drill.mjs
```

An optional first argument selects an earlier successful run UUID. Optional private environment overrides are `BACKUP_SSH_TARGET`, `BACKUP_REMOTE_SCRIPT`, `BACKUP_AGE_BINARY`, `BACKUP_RECOVERY_IDENTITY`. Installed defaults need no overrides. The private key is never uploaded.

The test downloads exact encrypted versions, checks hashes, and fully authenticates each age decryption locally before passing data through encrypted SSH. Plaintext stays in bounded memory. The current drill limit is 256 MiB of custom archive data; exceeding it fails explicitly and requires a reviewed streaming implementation before increasing capacity.

The receiver creates a unique temporary database and unprivileged role. It assigns public-schema ownership explicitly for older cluster templates, restores without original ownership/ACLs, checks the exact original inventory/migrations/password-hash fingerprints and decrypts all restored provider links. Only after that comparison, it applies the capsule's migrations inside the isolated database, so an older backup can prove recovery with the current authentication code. The report records migrations applied. It pauses restored controllers, disables workspace activation, cancels manual intent, preserves unresolved cleanup and revokes copied sessions and recovery credentials. A fresh isolated fixture supplies two active recovery grants so the quarantine check must revoke real rows. That fixture then exercises HTTP login, current-password change, token renewal, other-browser revocation, saved-key recovery, replacement-key revocation, private security history and logout. The hub refuses device access; no provider client or scheduler starts. Finally the database and role are dropped. Cleanup failure makes the test fail.

After an authentication/schema release, install an operational capsule for that release and prove both an older backup's isolated upgrade and a fresh backup's restore. The local drill requires explicit schema-upgrade and account-security verification flags; an older receiver's basic login proof cannot stand in for these checks.

Success prints one nonsecret report and saves mode 0600 local recovery metadata:

```text
~/.local/share/solarman-backup/recovery-pack.json
```

This records bucket/region, public recipient, exact object-version/checksum references and restore proof. It contains no private key, passwords or decrypted configuration. Retain it independently of the server. Failure prints a fixed stage code; subprocess diagnostics and plaintext are never logged.

## Health and failures

Platform administrators see Backup and recovery under Settings → System health and an Overview attention notice. Other tenants receive no platform backup details. The application reads a sanitized root-owned receipt, never AWS credentials or the recovery identity. `BACKUP_STATUS_FILE` can select another absolute path for a controlled installation.

Status separates the latest attempt from previous success. A backup older than 26 hours, restore test older than eight days, operation running over 35 minutes, or latest failed attempt requires attention. Missing files mean not configured; bad ownership, permissions, links, oversized files or malformed receipts mean unavailable. Success requires verification flags. `/healthz` describes process/database and monitor availability, not backup or physical charging success. External notifications remain unconfigured.

## Lost-host recovery

The drill verifies data recovery and deletes its database. It does not overwrite production. A full rebuild also needs PostgreSQL roles, the application release, private configuration, HTTPS/proxy and PM2 setup from [deployment instructions](deployment.md).

1. Recover the local metadata record, original age identity and independent AWS read credentials. Recorded bucket/version IDs allow retrieval without the lost host's `latest.json` or private receipts. Check encrypted hashes and authenticate every decryption.
2. Provision an isolated PostgreSQL 15+ database and non-superuser owner, assigning ownership of its public schema. Restore the custom archive without original ownership/ACLs. Use dump/configuration from the same manifest. Keep recovered configuration private and set `WRITES_ENABLED=false` before starting any application process.
3. Before starting a scheduler, pause controllers, cancel manual requests/expiry, disable controls, clear saved verification, advance cancellation epochs, preserve non-clear device ownership as cleanup-required and revoke sessions and unused recovery credentials. Compare inventory and decrypt provider links before promotion. Use server-operator account recovery if needed, then prepare a new saved key. Restored acknowledgments are historical records, not the inverter's current state.
4. Reconcile device ownership using fresh diagnostics. Resume writes only through commissioning and separate activation. Reinstall backup tooling and repeat an isolated offsite recovery test on the rebuilt host.

On 2026-10-28, offsite decryption, restored PostgreSQL inventory, linked-account decryption, authentication, disabled controls, zero device access and temporary database/role cleanup passed. The initial failure was public-schema ownership in the server template; the fix applies only to the newly created drill database.
