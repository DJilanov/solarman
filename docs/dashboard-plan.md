# Solarman dashboard implementation plan

Current status (2026-10-28): the deployed dashboard has working authenticated OpenAPI discovery, native device callbacks, stored live measurements, charts, exports and English/Bulgarian translations. The follow-up control release adds read-only device verification, individual workspace activation, immediate persisted stop intent, priority cancellation of queued starts and expiry for manual top-up intent. The original scope below remains the acceptance baseline.

Single-request telemetry now provides five-minute monitoring with actual collection timestamps, deduplication, nullable unknown AC permission and per-sample cadence. Clock comparison with the workspace timezone is included in device verification. Shared App ID budgets now reserve requests atomically, check provider balance daily, preserve recovery capacity and slow shared monitoring automatically. Native charging has been observed to stop at 50% while scheduled AC permission was already off. Remaining delivery work: verify native behavior above the 50% boundary; establish the separate 5 kW solar charging limit; complete physical control commissioning; optimize active control around observed state changes; finish uncertain-write reconciliation, credential maintenance, operational monitoring and tested backup restoration. The host write permission remains off until commissioning supports activation. Do not treat application job expiry as an expiring physical inverter schedule.

Build a private control panel at **https://solarman.jilanov.com** for the Bluesun BSE20KH3. It must explain where household power comes from, show battery behavior over time, and make the tested commands understandable. The application will run under PM2 on the existing server and store its own data in PostgreSQL.

## Tenant ownership

Each workspace is a tenant. Users sign in with a local email/password and link their own SOLARMAN email/password separately. The initial test account owns its workspace; its provider credentials are not defaults for other users. Additional users join through private invitations and connect their own accounts.

Every linked account, reading, command, automation setting and usage record belongs to a tenant. Resolve that tenant from the authenticated session. Scope reads, exports, job lookups and writes to it, with composite foreign keys for account ownership. Test isolation with two database tenants, including attempted cross-tenant command IDs and exports.

Store local passwords as salted scrypt hashes. Encrypt API-equivalent SOLARMAN password hashes with AES-256-GCM and bind ciphertext to tenant/account identity. Keep the encryption key outside PostgreSQL. Provider tokens and callback nonces remain isolated per account.

Discover devices using that user's provider token and only bind an inverter returned for their account. Allow one workspace binding per device to avoid independent controllers issuing conflicting commands. Use explicit compatibility profiles: guarded Bluesun commands are available for the verified family; unsupported devices remain in read-only monitoring.

SOLARMAN activation is still necessary. Shared platform APP credentials must respect licensed user, plant and request limits; tenants can alternatively supply their own OpenAPI credentials. Track usage per account and tenant rather than assuming unlimited users under a personal free plan.

## Battery behavior

Solar supplies the house and charges the battery toward 100%. With insufficient solar, the battery supplies the house above the 50% on-grid reserve. Grid charging is permitted below 50% at the existing 2 kW setting, and AC permission is removed at 50% so the earlier all-day charging problem does not recur. Grid power can support house demand independently of battery charging.

The 5 kW solar charging cap stays visibly unverified and unavailable as a control until its firmware-specific register and units are established. The UI must distinguish a configured target from observed power and a successful write from a verified readback.

## Screens

| Screen | Main task and content |
|---|---|
| Overview | Solar, house, battery and grid power; a directional flow diagram; SOC and its 50% reserve line; controller state; last device update; current reason for grid charging or its absence. |
| Analytics | Today, yesterday, 7 days, 30 days and custom date range; aligned power and SOC charts; daily energy totals; grid imports/exports; battery charge/discharge; solar production; data coverage and missing intervals. |
| Controls | Verified status beside each action; start a top-up to 50%; stop grid charging and resume battery use; enable or pause automation; refresh diagnostics. |
| Activity | Searchable command and automation history with timestamps, actor, reason, requested value, device acknowledgment, readback result and failure details. |
| Settings | Connection and quota status, sampling interval, timezone, reserve policy, API readiness and account/logout controls. Secrets remain server-side. |

Use a restrained dark interface with readable typography, high-contrast numbers and consistent source colors. The flow diagram is the visual focus of Overview. Charts have a shared time cursor, units, legends, keyboard-readable values, range controls and CSV export. Controls stay usable on a narrow phone screen. Status is conveyed by text and icons as well as color.

Show dedicated loading, no-history, API-unconfigured, device-offline, stale-data, command-pending and command-failed states. Missing readings are gaps, not zeroes. Do not fill an empty deployment with demonstration measurements.

## Analytics definitions

For provider readings, retain device collection time separately from server receipt time. Native Modbus measurements use the server time of a fresh, verified command snapshot as their observation time; they do not claim a separate device sampling timestamp. Normalize display directions: grid import and battery discharge are positive; export and charging are negative. Display charging/discharging labels so sign conventions are not required knowledge.

The initial implementation integrates power over valid adjacent samples and labels the result as an estimate. Do not integrate across a gap greater than twice the configured sampling interval. Show coverage beside estimated totals, use UTC storage and the account's timezone for presentation, and honor local-day boundaries including daylight-saving changes. Verified cumulative energy counters and reset handling can be added after their firmware mapping is established.

Battery energy charged is not automatically solar energy stored. Mixed-source charging cannot support an exact attribution without suitable metering. Do not invent a solar self-consumption percentage, savings estimate, battery capacity or time-to-full when the needed inputs are absent. Tariff-based cost estimates require an explicit tariff and coverage indicator.

All browser viewers use the application's cached data. Opening a page or chart does not start extra SOLARMAN polling. The existing raw-command worker uses five regular requests per cycle; its 15-minute default is approximately 175,200 calls/year before transitions. A later verified single-request telemetry mapping can improve sampling without multiplying command calls. Faster settings must show projected usage against SOLARMAN's quota.

## Login and sessions

Use the supplied test email as the login and the entire supplied test password, including its equals sign. Do not put either password or API credentials in source files, examples, Git history or browser storage. Bootstrap the administrator from private environment configuration and store a salted scrypt password hash in PostgreSQL.

Use opaque sessions with HttpOnly, Secure and SameSite cookies, expiry and logout revocation. Hash session identifiers in the database. Protect modifying requests with session-bound CSRF tokens and an origin check. Rate-limit login attempts and return the same invalid-login message for an unknown account or wrong password. There is no public registration page.

## Application structure

Keep the existing Node.js controller and callback transport. Add a React and TypeScript frontend built with Vite, Recharts for time-series charts, and a Node HTTP API that serves the built frontend. Use the existing callback listener and a single serialized command queue for both manual commands and automation.

Add PostgreSQL through a bounded `pg.Pool`. The EU applications use PostgreSQL through `pg`/TypeORM, with connection values loaded from client configuration and `DB_USERNAME`/`DB_PASSWORD`. Follow their environment-based connection convention, while using a separate `solarman` database and role. Do not enable automatic schema synchronization against shared production databases; apply versioned migrations to Solarman only.

Persist tenants, users, sessions, linked accounts, measurements, command executions and controller state. Index measurements and activity by tenant and time. Use one PM2 scheduler leader protected by a PostgreSQL advisory lock, with per-account command queues, bounded concurrency and shared request pacing. Do not hold a database connection open for each tenant. A database outage disables state-changing API actions and is visible in health status.

## Command behavior

Expose named actions instead of an unrestricted hex terminal. Each write requires authentication, valid fresh readings and the applicable policy constraints. One browser action creates one command record and is idempotent on retry. A pending command disables conflicting controls. Record the intent before dispatch, then device acknowledgment, readback and final result.

Manual top-up has the same 2 kW and 50% guards as automation and uses short charging windows. Pause first removes AC permission and verifies that result. Resume re-evaluates current SOC and solar conditions; it does not blindly enable charging. Loss of the browser connection does not cancel an already-dispatched device command or imply success.

## Deployment

Use the existing PostgreSQL instance on `92.247.242.86`, with an isolated database and application role. Keep configuration in a private shared environment file outside the Git checkout. Deploy immutable releases under the user's home directory and switch a `current` symlink only after build and migration checks pass.

Run the application as `mitko` under PM2 with one process, an explicit supported Node interpreter, graceful shutdown, readiness and log rotation. Nginx terminates HTTPS for solarman.jilanov.com and proxies the application and callback path. The application port is private. Configure the domain's DNS and certificate before exposing login or enabling real API callbacks.

After successful checks, commit and push to the supplied GitHub repository, deploy the exact commit, verify the running release, and retain the previous release for rollback. Persist PM2 configuration without restarting unrelated applications.

## Delivery and acceptance

1. Finish the PostgreSQL connection and migrations, credential bootstrap, session API and authenticated application shell.
2. Build Overview and telemetry persistence with genuine unavailable/empty states and sampling timestamps.
3. Add analytics, activity and guarded manual commands using the existing command queue.
4. Verify password handling, sessions/CSRF, command authorization/idempotency, energy calculations, source signs, data gaps and controller regression cases.
5. Verify desktop/mobile layout and browser flows, build production assets, commit and push, then deploy with PM2 and HTTPS.
6. With OpenAPI credentials available, verify the real callback path, live diagnostics, one below-50% top-up, AC removal at 50%, battery use above 50%, and solar charging above 50%. Keep writes disabled until the real connection checks pass.

API activation is still required: the supplied Smart email/password alone do not provide an APP ID or APP SECRET. The dashboard must show this setup state without pretending to have live telemetry.

Implementation references: [React](https://react.dev/learn), [Vite](https://vite.dev/guide/), [Recharts](https://recharts.github.io/en-US/), [node-postgres connection configuration](https://node-postgres.com/features/connecting), and [SOLARMAN API activation](https://helpcenter.solarmanpv.com/portal/en/kb/articles/i-want-to-open-api-how-can-i-open-api).
