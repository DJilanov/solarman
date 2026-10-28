# SOLARMAN workspace

A private solar monitoring and battery control dashboard, hosted at **https://solarman.jilanov.com**. React/TypeScript renders the interface; a Node.js service stores account data and measurements in PostgreSQL and runs one coordinated scheduler under PM2.

## Workspaces and accounts

Users sign in with a local email/password. Each workspace links its own SOLARMAN Smart email/password in **Settings**, tests that connection, and selects an inverter discovered for that account. The platform administrator creates private, single-use invitations under **Workspaces**; each invitation expires after 24 hours. No email is sent automatically.

Measurements, exports, jobs, automation state and API usage are scoped to the session's tenant. Composite database foreign keys enforce account ownership. Local passwords use salted scrypt hashes; provider password hashes and optional personal OpenAPI credentials use AES-256-GCM encryption bound to their tenant and account. The master encryption key stays outside PostgreSQL. Sessions use hashed opaque identifiers, HttpOnly cookies, CSRF tokens and origin checks.

SOLARMAN OpenAPI **App ID / App Secret** activation is required in addition to a Smart login. Provide licensed shared application credentials on the host, or let each tenant supply their own. Custom-command permission is additionally required for the Bluesun profile. See [SOLARMAN activation](https://helpcenter.solarmanpv.com/portal/en/kb/articles/i-want-to-open-api-how-can-i-open-api) and [control guidance](https://helpcenter.solarmanpv.com/portal/en/kb/articles/how-to-control-inverter-via-api). Personal free API limits are not a multi-user hosting licence.

## Dashboard

- **Overview:** solar, house, grid and battery flow, reserve, current controller status and daily estimates.
- **Analytics:** power/SOC charts, date ranges, daily energy estimates, data coverage and full-resolution CSV export.
- **Controls:** refresh diagnostics, top up to 50%, stop scheduled top-ups, pause/resume automation. Commands have idempotent request IDs, device acknowledgments, write readbacks and an audit trail.
- **Activity:** searchable command history with individual request, verification and write details, plus all inverter writes including unlinked recovery operations and earlier bindings.
- **System health:** persistent device, control-recovery and API-capacity alerts with seen/active/resolved states, available from Settings and an Overview alert summary.
- **Account security:** change the dashboard password, review browser sessions, sign out another browser or every other browser, and inspect recent private security events. Available from Settings in English and Bulgarian.
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

Live OpenAPI discovery, correlated callbacks and native measurements have now been verified on the installation. **Controls → Verify device settings** checks the rated-power register, charge policy and reported inverter clock, and stores nine results for that workspace. Clock verification compares the inverter's local time with the logger collection timestamp in the workspace timezone, with a two-minute tolerance. Administrator permission, device verification and workspace activation appear separately. Enabling workspace control requires a successful verification within 30 minutes, a current clock check and host permission; it leaves automation paused. Linking credentials or selecting an inverter clears that workspace's activation and verification.

Stop/Pause persists the pause immediately, prevents queued starts from enabling charging, and takes priority after an active operation. It clears scheduled AC permission only when hardware writes are permitted; the inverter's native reserve charging may continue. A one-time top-up waits through temporary solar surplus or grid loss and ends at 50%, cancellation or a six-hour application expiry. That expiry is not a physical inverter watchdog during an API outage.

The control journal stores each write's intent before dispatch, then records device acknowledgment and verified readback separately. Unfinished changes remain tied to the original tenant, account and inverter across restarts. A persisted stop cannot be overwritten by a later acknowledgment from an in-flight window change. Controls shows the last five writes and their confirmation times. A fresh flags read can confirm scheduled permission is off, while the original timed-out write retains its unknown outcome in the history.

Activity links to each command's recorded device, actor, result, decision and verification report. Write details show the requested register values and separate intent, acknowledgment, readback and cleanup times. Both command writes and the complete workspace journal use 25-record pages; the latter includes system recovery without a linked command and previous inverter bindings. New commands retain their selected device at acceptance. Historical device identity is backfilled only from unambiguous write or device-verification evidence; otherwise it remains unrecorded. Browsing or refreshing these records reads PostgreSQL and does not contact SOLARMAN or repeat a command. Search and pagination survive a round trip to command details. The detail screens load separately from the main dashboard bundle.

Credential updates pause automation and revoke its activation atomically with the credential change. They preserve any outstanding cleanup obligation. The updated credentials must discover the same inverter before recovery can continue; the host must still allow writes. This recovery authority clears scheduled permission only and does not re-enable workspace control. Inverter, profile and timezone changes are refused while any previous binding has unresolved permission. A cached selected serial is never considered ready unless the latest successful discovery still returns it.

## Account security

Settings → Account security manages the local dashboard login separately from SOLARMAN credentials. Changing a password requires the current password, accepts 8–1024 characters without trimming, renews the current browser's authentication and CSRF secrets, and invalidates every other session atomically. The new session retains its public browser ID and original sign-in time. Password checks are rate-limited. Login issuance, password changes and revocations serialize on the user row, so a delayed login using a previously verified old password cannot restore access after a change.

Browser sessions show sign-in, expiry and approximate activity times, with paginated access to every active session. Activity is recorded at most every five minutes without extending the seven-day authentication expiry. Browser descriptions come from client-provided User-Agent metadata, capped at 256 characters; old unknown activity remains unrecorded until that browser makes a request. Session lists expose public IDs and never authentication/CSRF secrets or password hashes. Users can end another browser or every other browser; the current browser uses the existing Sign out action. The latest 20 sign-in, sign-out, password-change and revocation events are private to that user.

Changing dashboard credentials or signing out browsers does not pause inverter automation or cancel accepted commands. Use Stop scheduled top-ups when charging intent must be paused. If a connection fails during a password change, the interface reports an unconfirmed outcome rather than promising failure. The bootstrap password hash in the environment is used to create the initial account; it does not replace an existing user's changed password on restart. Forgotten-password recovery remains a separate pending workflow.

Session renewal follows the [OWASP session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). Account-security requests use PostgreSQL only and do not initialize a provider runtime or dispatch inverter commands.

## Monitoring and source timestamps

While monitoring or paused, the dashboard fetches `/device/v1.0/currentData` once every five minutes by default (`TELEMETRY_POLL_SECONDS=300`). This projects to 105,120 regular requests/year, compared with the previous 175,200 baseline from five diagnostic requests every 15 minutes. The Bluesun mapping requires the selected device identity, model BSE20KH3, protocol 2.02, a 20 kW rating and the verified point keys and units. Unknown models, changed units, offline/alarm devices and uploads older than ten minutes cannot generate fresh normalized samples. Unsupported profiles retain raw provider monitoring.

Each stored sample records its source, actual observation time, server receipt time and expected polling interval. Cached uploads are deduplicated; repeated API success does not move the device timestamp forward. Logger samples do not invent an AC permission value: that setting remains unknown until a diagnostic read. The UI displays source and timing beside the power flow. Historical energy estimates use the sampling interval recorded with each sample, so changing cadence does not erase coverage from earlier 15-minute data.

Explicit Refresh diagnostics reads the native register blocks and renews the provider clock check when its evidence is missing, failed or stale. Active supervision normally uses five-minute telemetry with a full native policy audit every hour (`CONTROL_AUDIT_SECONDS=3600`). Starting or resuming a request, an owned charging schedule, a due below-reserve assessment or a persistent observed deviation triggers fresh native checks. Every scheduled charging enable still requires native settings, battery and flow checks. The controller preserves native charging already near 2 kW instead of adding a timed AC window.

The default steady supervision baseline is 148,920 regular requests/year (105,120 telemetry plus 43,800 native audit requests), before transitions, retries, authentication and recovery. With one control workspace and the default shared allowance, an app-owned timed top-up uses a 17-minute cycle (185,506/year continuous-use projection). Repeated below-reserve native assessments are eligible every 32 minutes, while hourly audits remain in force. Cadence allocation reserves the larger of these continuous workloads, including telemetry; the single-home reservation is 187,245 of 188,000 planned regular requests/year. Hardware writes remain disabled during commissioning.

Observed-behavior notices require two distinct newer device uploads; cached responses cannot count twice. They identify grid-supplied house demand above the reserve without meaningful battery support, or solar surplus without expected charging below 99% SOC. Notices include their source observation time and suggest checking inverter settings/BMS limits. They do not override battery protections. A failed active native check pauses automation and attempts cleanup; its error remains visible until a successful native check. Manual diagnostic refreshes cannot postpone a pending scheduler check.

## Operational health

An independent operational monitor checks stored state once a minute without additional SOLARMAN requests. It records persistent episodes for delayed uploads, provider-reported offline/alarm status, three consecutive failed assessments, saved control faults, unresolved scheduled-charge cleanup and low API capacity. Successful communication does not refresh the upload timestamp. Persistent stale alerts allow the effective polling interval plus one five-minute logger cycle and three minutes of delivery jitter. Acknowledging an alert does not resolve it or change inverter settings; escalation to recovery-only or exhausted API capacity makes the alert unseen again. New episodes keep separate history, and a binding change is distinguished from an observed clear condition. Control faults survive restart, force paused intent and require a successful native check before starting again. Alerts are in-app; external delivery is not configured. Encrypted offsite backup and isolated recovery tooling are available. Administrators see backup/restore health in System health; scheduled installation, recovery-key custody and the weekly drill are documented in [backup and recovery](docs/backups.md).

## Shared API budgets

Every provider request reserves capacity in PostgreSQL before HTTP dispatch, including authentication and failed submissions. The budget belongs to the App ID, so linked tenants share its allowance and rotating credentials cannot clear its history. Reservations serialize on the application's budget row; a separate App ID has a separate ledger. Existing unattributed request history is conservatively assigned to its account's current App ID during the upgrade.

`SOLARMAN_API_CALL_LIMIT` defaults to a local rolling 365-day limit of 200,000 requests. `SOLARMAN_API_RECOVERY_RESERVE=2000` prevents routine monitoring, discovery and starts from consuming the final 2,000 calls. Stop, permission removal and their authentication/readback can use that reserve. A budget error pauses active automation, attempts cleanup, and does not repeatedly spend recovery calls after cleanup is confirmed. A fully exhausted budget or unavailable provider can still prevent physical confirmation.

The documented [App ID balance endpoint](https://doc.solarmanpv.com/en/Public%20Information/13Query%20Remaining%20Call%20Quotas%20for%20APPID) is checked at most once per day per App ID. The app uses the lower of its local allowance and the provider balance, with conservative deductions for recent/in-flight and subsequent app requests. Failed checks retain the previous estimate. A daily check can use up to two balance-purpose requests (authentication plus query), even if the cached provider balance is zero, to discover replenished capacity; it cannot exceed the local rolling limit. Provider requests made elsewhere become visible at the next successful check.

Monitoring leaves an additional 5% planning margin for authentication, manual diagnostics and transitions. Two monitoring-only workspaces sharing the default allowance use six-minute intervals (175,200 regular requests/year combined); three use 8.5-minute intervals. Configured minimum intervals are never accelerated. Telemetry is capped at 30 minutes; scheduled charging checks must also fit within the configured window with more than three minutes of margin.

Admission serializes on the same PostgreSQL App ID row as request reservations. A ready linked account receives a monitoring slot only if its periodic workload fits. Enabling workspace control reserves capacity for telemetry, native assessments and continuous scheduled charging, even while paused. **Pause** keeps this reservation; **Disable workspace control** releases it and cancels starts while preserving unresolved cleanup. Under the default allowance, ten monitoring-only workspaces fit, or one control workspace plus two monitoring-only workspaces; two full control reservations do not fit. Additional workspaces need a separate App ID or appropriately licensed extra capacity.

A workspace without a monitoring slot keeps its linked account and discovered device. It retries admission through PostgreSQL without polling the inverter and shows a capacity incident instead of misleading stale/request-failure alerts. Account repair, manual diagnostics, Stop and pending cleanup remain available subject to the actual request budget. **Retry monitoring capacity** checks admission without sending device requests. Startup admits existing workspaces in creation order; insufficient capacity revokes normal activation and persists pause while retaining recovery obligations. Settings shows reserved regular workloads, a control-activation preview and allocated cadences separately from current-mode projections and actual usage. No other workspace identities are exposed. Annual projections are estimates rather than a licence entitlement; configure an increased allowance only when the provider has licensed it. The provider's own reset period is not assumed to be the calendar year.

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
