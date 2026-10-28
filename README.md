# SOLARMAN workspace

A private solar monitoring and battery control dashboard, hosted at **https://solarman.jilanov.com**. React/TypeScript renders the interface; a Node.js service stores account data and measurements in PostgreSQL and runs one coordinated scheduler under PM2.

## Workspaces and accounts

Users sign in with a local email/password. Each workspace links its own SOLARMAN Smart email/password in **Settings**, tests that connection, and selects an inverter discovered for that account. The platform administrator creates private, single-use invitations under **Workspaces**; each invitation expires after 24 hours. No email is sent automatically.

Measurements, exports, jobs, automation state and API usage are scoped to the session's tenant. Composite database foreign keys enforce account ownership. Local passwords use salted scrypt hashes; provider password hashes and optional personal OpenAPI credentials use AES-256-GCM encryption bound to their tenant and account. The master encryption key stays outside PostgreSQL. Sessions use hashed opaque identifiers, HttpOnly cookies, CSRF tokens and origin checks.

SOLARMAN OpenAPI **App ID / App Secret** activation is required in addition to a Smart login. Provide licensed shared application credentials on the host, or let each tenant supply their own. Custom-command permission is additionally required for the Bluesun profile. See [SOLARMAN activation](https://helpcenter.solarmanpv.com/portal/en/kb/articles/i-want-to-open-api-how-can-i-open-api) and [control guidance](https://helpcenter.solarmanpv.com/portal/en/kb/articles/how-to-control-inverter-via-api). Personal free API limits are not a multi-user hosting licence.

## Dashboard

- **Overview:** solar, house, grid and battery flow, reserve, current controller status and daily estimates.
- **Analytics:** power/SOC charts, date ranges, daily energy estimates, data coverage and full-resolution CSV export.
- **Controls:** refresh diagnostics, top up to 50%, stop grid charging, pause/resume automation. Commands have idempotent request IDs, device acknowledgments, write readbacks and an audit trail.
- **Activity:** searchable, paginated command and automation history.
- **Settings:** private provider link, optional personal API keys, device discovery, compatibility profile, timezone, API usage and raw provider readings.

Missing data stays unavailable rather than becoming zero. Estimated energy excludes gaps longer than twice the sampling interval and honors the selected timezone and daylight-saving boundaries. Browser refreshes read the database; explicit **Refresh readings** requests contact the inverter.

Normalized analytics and guarded controls currently support the **Bluesun BSE20KH3** profile diagnosed in this project. Other inverters can display read-only provider parameters in Settings; their normalized power charts require a verified model mapping.

## Languages

English and Bulgarian are available from the language selector on the login, invitation and dashboard screens. The first visit follows the browser language, with English as the fallback. A selected language is remembered in that browser and survives sign-out. Switching languages preserves the current session and unsaved form fields.

Dates, decimal values, energy units, counts and application messages follow the selected language. Native date-picker controls retain the browser's own date format. The account's inverter timezone still controls local-day calculations. Workspace names, account addresses, device identifiers and raw provider parameters retain their original values; the machine-readable CSV schema and UTC timestamps remain stable.

Translations live in `web/locales/en.json` and `web/locales/bg.json`, with i18next handling interpolation and plural forms. Catalogue tests check matching keys and variables; browser tests cover both languages, mobile layouts, persistence, forms and disabled browser storage. Unknown third-party diagnostics retain their original text and error codes.

## Battery policy

The supported Bluesun policy retains the existing **100% overall solar SOC target**, **50% on-grid reserve**, and **2 kW AC charging setting with a 50% target**. Below 50%, grid top-up is eligible when solar surplus is insufficient. At or above 50%, timed AC permission is removed so native SelfUse can supply the home. The controller verifies configuration and changes only the AC flag and short charging windows.

**Writes are disabled by default.** The requested **5 kW solar charging power cap remains unverified and is not written**. Physical charging behavior still requires commissioning. Daily charge windows are not an expiring watchdog and can repeat after an outage until AC permission is cleared. See [controller details and recovery](docs/controller.md).

Live OpenAPI discovery, correlated callbacks and native measurements have now been verified on the installation. **Controls → Verify device settings** checks the rated-power register, charge policy and reported inverter clock, and stores eight results for that workspace. Clock verification compares the inverter's local time with the logger collection timestamp in the workspace timezone, with a two-minute tolerance. Administrator permission, device verification and workspace activation appear separately. Enabling workspace control requires a successful verification within 30 minutes, a current clock check and host permission; it leaves automation paused. Linking credentials or selecting an inverter clears that workspace's activation and verification.

Stop/Pause persists the pause immediately, prevents queued starts from enabling charging, and takes priority after an active operation. It clears scheduled AC permission only when hardware writes are permitted; the inverter's native reserve charging may continue. A one-time top-up waits through temporary solar surplus or grid loss and ends at 50%, cancellation or a six-hour application expiry. That expiry is not a physical inverter watchdog during an API outage.

## Monitoring and source timestamps

While monitoring or paused, the dashboard fetches `/device/v1.0/currentData` once every five minutes by default (`TELEMETRY_POLL_SECONDS=300`). This projects to 105,120 regular requests/year, compared with the previous 175,200 baseline from five diagnostic requests every 15 minutes. The Bluesun mapping requires the selected device identity, model BSE20KH3, protocol 2.02, a 20 kW rating and the verified point keys and units. Unknown models, changed units, offline/alarm devices and uploads older than ten minutes cannot generate fresh normalized samples. Unsupported profiles retain raw provider monitoring.

Each stored sample records its source, actual observation time, server receipt time and expected polling interval. Cached uploads are deduplicated; repeated API success does not move the device timestamp forward. Logger samples do not invent an AC permission value: that setting remains unknown until a diagnostic read. The UI displays source and timing beside the power flow. Historical energy estimates use the sampling interval recorded with each sample, so changing cadence does not erase coverage from earlier 15-minute data.

Explicit Refresh diagnostics still reads the native register blocks. The current active control path additionally checks provider metadata and clock before its native control cycle. Its continuous-use projection at 15 minutes is 210,240 regular requests/year before writes and recovery; state-driven control optimization and per-application budget enforcement remain required before unattended activation under the reference free allowance. The host write permission remains disabled during commissioning.

## Local setup

Use Node.js 22+ and PostgreSQL 15+. Install with `npm ci`. Copy `.env.example` to `.env` only if a populated file does not exist, and restrict it with `chmod 600 .env`.

Configure `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD` for a separate database. The EU applications use the same host/user/password convention. `DB_DATABASE` is accepted as an alternative name; optional `DB_SSL=true` validates the server certificate.

Set `DASHBOARD_ADMIN_EMAIL`. Run `node scripts/hash-password.mjs` in a terminal and put its result in `DASHBOARD_ADMIN_PASSWORD_HASH`. Generate a private 32-byte base64 `CREDENTIAL_ENCRYPTION_KEY` as shown in `.env.example`; retain a separate secure backup. Changing this key without re-encryption makes existing provider links unreadable.

`PUBLIC_URL` is the browser origin. Local development permits `http://localhost:3000`; production requires HTTPS. Set `CALLBACK_PUBLIC_URL` to the public HTTPS origin used for SOLARMAN callbacks. Optional `SOLARMAN_EMAIL` and password bootstrap only the first administrator's provider link; other users never inherit them. Bootstrap does not reset an existing user's password.

```sh
npm run build
npm start
```

Startup applies versioned migrations to the configured database. For frontend development, run `npm run dev` alongside the API; Vite proxies API requests. Keep one scheduler per database. Do not run the legacy standalone worker alongside the dashboard against the same inverter.

## Verification and deployment

```sh
npm run check
npm test
npm run build
npm run test:integration
npm run test:e2e
```

Integration tests exclusively use **solarman_test** on the configured PostgreSQL host and reset that test database's tenant data. Never point them at a database containing valuable test records. Browser tests also use solarman_test, require a completed build, and bootstrap a dedicated fixture owner with a test-only provider link and hardware writes disabled. Production login credentials are not needed. Optional `E2E_EMAIL` / `E2E_PASSWORD` values in private `.env.e2e` override that fixture login. Run database and browser suites sequentially; both own the isolated test database. Install a browser once with `npx playwright install chromium`.

See [deployment and recovery](docs/deployment.md) for immutable releases, private environment files, PM2, HTTPS and rollback. After committing and pushing the intended release, `bash scripts/deploy.sh` builds and verifies that exact commit on the server, migrates the application database, and updates only the `solarman` PM2 process. The broader [design plan](docs/dashboard-plan.md) records the product and isolation requirements.
