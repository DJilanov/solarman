# Solarman dashboard implementation plan

## Completion audit — 2026-10-28

This is the current execution plan. The original requirements below remain the acceptance baseline. Home control and hosted-tenant readiness have separate completion gates.

### Verified production state

Read-only inspection at 19:27 UTC (21:27 Europe/Sofia), against release `f75a2094b4c328822ec7133d6ef781513e163260`:

| Area | Observed state | Implication |
| --- | --- | --- |
| Application | HTTPS health and operational-monitor heartbeat are current; migrations 001–016 are applied | The deployed monitoring service is working. |
| Connection/profile | A device is selected; profile is `bluesun-bse20kh3`; observed protocol/DSP/HMI are 2.02 / 1.57 / 1.45 | Selecting the supported profile is already complete for this home. |
| Automation | Host writes disabled; workspace control disabled; persisted pause; no manual top-up | Nothing has been silently activated. |
| Current verification | No current saved report; last two attempts failed with acknowledgment timeout and provider code 530 | Fresh successful native verification is a prerequisite for activation. |
| Clock | Latest source upload at 19:20:16 UTC passes with 60 seconds difference against the 120-second limit | A passing telemetry clock does not replace the missing native verification. |
| Readiness blockers | `server`, `verification`, `firmware`, `workspace`, `settings` | Current firmware matches the supported identity, but lacks a current verification report. The settings blocker means unconfirmed settings, not proof of a changed setting. |
| Control recovery | Zero application inverter-write intents; zero unresolved control bindings | There is no application-created physical write to reconcile in this deployment. |
| Latest sample | SOC 50%; PV 0 W; house 3,274 W; grid import 3,425 W; battery 0 W | This is compatible with preserving a 50% reserve. Household grid import is separate from grid battery charging. |
| Physical evidence | 119 stored samples in the preceding 24-hour query, spanning 09:25–19:20 UTC; SOC range 40–50%; no above-50% charging/discharging observations | The data is not a complete day/night acceptance run and cannot prove the above-reserve outcomes. |
| Recoverability | Backup health is healthy; last verified backup 18:48:49 UTC, isolated restore 18:49:22 UTC | Keep these checks current through subsequent migrations and releases. |

The quoted Bulgarian notice, “Наблюдението е достъпно. Командите към инвертора остават изключени, докато не бъде избран поддържан профил и не бъдат разрешени промените.”, remains in the translation catalogue but is no longer the active Controls component. The deployed panel already presents individual blockers, responsible actors, next actions, report expiry and clock evidence. Replacing the notice or flipping `WRITES_ENABLED` alone does not finish automation.

The latest native verification failures occurred at 18:36–18:37 UTC (timeout) and 18:39–18:40 UTC (530). SOLARMAN documents 530 as failed platform-to-device command delivery. Earlier callback observations reached the application; this does not establish reliable end-to-end device communication. Follow the provider's recommendation to first establish successful custom-command exchange through its own interface, then through OpenAPI. Use read commands during diagnosis. [SOLARMAN custom-command documentation](https://doc.solarmanpv.com/%E8%AE%BE%E5%A4%87%E6%8E%A5%E5%8F%A3/3.9%E8%87%AA%E5%AE%9A%E4%B9%89%E6%8C%87%E4%BB%A4%EF%BC%88%E6%8C%87%E4%BB%A4%E9%80%8F%E4%BC%A0%EF%BC%89Custom_commands).

### Implemented versus unfinished

| Capability | Current implementation | What remains |
| --- | --- | --- |
| Monitoring and analytics | Stored genuine telemetry, actual upload/receipt timestamps, cached/deduplicated uploads, charts, estimated energy with coverage, CSV, EN/BG | Preserve unavailable/stale/gap states and mobile usability. Additional analytics features do not block the requested home policy. |
| Guarded control | Nine native checks, exact firmware binding, separate host/workspace activation, serialized named commands, idempotency, immediate persisted Stop intent | Reliable real-device verification; commissioning records; attended physical testing before unattended activation. |
| Reserve supervision | Solar-first decisions, native charging preservation, guarded scheduled top-up, one-time intent expiry, automatic pause on control failures | Demonstrate the real transitions, mixed-source power-limit meaning, recovery and day/night behavior. |
| Write recovery and audit | Persisted intent/acknowledgment/readback/uncertainty, retained cleanup obligations, full paginated history | Physical interrupted-command proof and a commissioning evidence view; never turn an ambiguous write into assumed success. |
| Requested power limits | AC setting checked against approximately 2 kW; grid SOC 50%, overall SOC 100%, reserve 50% are checked | Separate 5 kW solar power cap has no verified mapping. Establish whether the AC setting caps grid contribution or combined charging. |
| Operational alerts | Durable in-app incidents, revision-aware acknowledgment/escalation, operational heartbeat | External delivery, retries/recovery notifications, and independent detection of app/host outages. |
| Tenant security and lifecycle | Private invitations/provider links, isolation, password/session/recovery management, suspension/resumption, archives, opt-in retention | Finish and release closure/credential/data erasure with old-backup safeguards; rehearse the complete tenant lifecycle. |
| Capacity | Atomic shared-App-ID request accounting and conservative monitoring/control admission | Maintain licensed allowance and make response-time/capacity implications explicit before activating more homes. |
| Backup/recovery | Encrypted offsite copies, root-owned daily schedule, isolated restore and administrator health | Validate every schema upgrade and the new erasure receipts with matching recovery tools; retain separate recovery-key custody. |

The 19:27 audit found substantial **uncommitted, undeployed** offboarding work, including migrations 017–018, a root-owned erasure receipt service, credential removal, bounded data deletion, EN/BG UI and dedicated tests. The follow-up below records its subsequent validation. The new HTTPS startup guard is an operational dependency: install and verify its receipt service before deploying the dependent application.

For this audit, `npm run check` passed and `npm test` passed 117 tests with one Linux-only skip (118 total). Integration/browser suites and real-device commands were not rerun in this audit; their previous results are not evidence for the latest complete working tree. No inverter write, production migration, commit or deployment was performed during this audit.

### Implementation follow-up

Read-only native verification subsequently passed all nine checks at 19:31:14 and 19:34:03 UTC, each in approximately nine seconds. The saved control fault cleared and readiness reduced to host permission and workspace activation. This is evidence of successful exchanges, not a diagnosis or guarantee that the earlier delivery problem cannot recur. Restart and physical commissioning remain required; no inverter write was issued.

The offboarding candidate passed type/syntax checks, production build, a complete 122-test PostgreSQL integration run and all 30 browser tests. A further focused integration test proves anonymous API accounting ages out only after 366 days without requiring a tenant retention policy. Eight erasure unit tests pass, including HTTPS startup guard requirements in the absence of an explicit path. The full integration run caught and fixed unintended polling on ordinary suspension; the lock-wait expiry regression now observes the actual blocking PostgreSQL backend instead of depending on SQL text. EN/BG real-cookie tests cover closure, cancellation into suspension, an unconfirmed response, recovery, irreversible authorization, receipt download and private receipt health on mobile.

A real isolated S3 proof passed encrypted/versioned readback, cache reuse, durable-guard-before-acknowledgment ordering and root permissions. All proof object versions and temporary state were removed, with no production database access. Release acceptance still requires installing the root receipt service before the application, proving an older backup upgrade, and verifying a fresh post-migration backup/restore with erased-account access blocked and zero device calls.

The offboarding release `fd33e8752b68ee1530b86fc6469ccd437e0a156f` was subsequently pushed and deployed with migrations 017–018, after installing its root receipt timer. All 119 Linux unit tests passed. Older-backup restore `0db68a36-a2f1-44c3-bd68-4621b20b86fd` and fresh-backup restore `feee42ea-e144-42d2-9ea9-4be0cd11224c` passed erased-access fences, authentication, archive and control quarantine, with zero device access and no remaining temporary databases/roles. The fresh backup is `799174e8-d393-4e4f-ac65-55e001e8099e`. Native verification also passed after the PM2 restart at 19:43:46 UTC. Receipt and backup health were verified in native Chrome in Bulgarian; the protected home remained active, paused, control-disabled, with host writes off and zero application inverter writes.

The next home-control increment adds prospective policy-observation runs. Their device/firmware/timezone-bound evidence survives ordinary restarts and measurement pruning, is archived, invalidates on configuration/lifecycle changes and restore, and is removed with its workspace. This uses stored readings only. A recorded signal is explicitly distinct from physical commissioning and grants no additional write permission; the attended-control path, independent solar-limit mapping and physical recovery matrix below remain open.

Policy-observation software validation passed type/syntax checks, build, 125 local unit tests with one Linux-only skip, the full 132-test integration run and all 32 browser tests. Final focused integration cases additionally reject malformed saved progress and distinguish unavailable current identity from an observed binding change. A final two-test browser run covers that distinction, unconfirmed start, immutable history and the Bulgarian mobile layout. Sample coverage does not count a missing expected upload as complete coverage. Recovery tooling now seeds an active observation fixture, invalidates it and checks its archived state; matching older/fresh offsite restore proofs remain release gates.

## Ordered finish plan

### 1. Restore reliable native diagnostics — first home-control blocker

Relevant code: `src/solarman.mjs`, `src/telemetry.mjs`, `src/tenant-runtime.mjs`, `src/control-readiness.mjs`.

- Compare the same known read command in native SOLARMAN and through the existing authenticated OpenAPI path, with command IDs, dispatch/callback timing and sanitized error codes.
- Distinguish provider-to-device delivery, logger/inverter communication and application callback handling. Investigate the observed 530/timeout without assuming that Wi-Fi, credentials or Cloudflare is the root cause.
- Obtain several consecutive complete read-only verification reports, including after a service restart. A successful submission or one successful telemetry upload is insufficient.
- Investigate upload time versus the reported inverter clock where they disagree; preserve source timestamps and the two-minute validated check. Do not widen the threshold just to pass.
- Preserve command deduplication, late-callback handling and explicit unknown outcomes. Do not automatically resend an ambiguous write or increase timeouts without measured justification and a regression case.

**Exit:** fresh complete native checks pass for this exact device/firmware, original flags/settings are recorded, and a failed/late response still leaves starts blocked and Stop available.

### 2. Finish the commissioning and activation experience

Relevant code: `web/control-readiness.tsx`, `web/pages.tsx`, `web/system-health.tsx`, `src/control-readiness.mjs`, `src/tenant-runtime.mjs`, `src/http-app.mjs`.

- Keep the existing per-blocker panel; add the missing durable distinction between settings verification and demonstrated physical behavior. Bind commissioning evidence to tenant, inverter, model, firmware, timezone and mapping revision.
- Show monitoring freshness independently of control health. Production currently reports current telemetry alongside a saved control fault and overall `mode: error`; the user must be able to see that monitoring works while automation remains blocked.
- Make the activation sequence explicit: connect/select → verify settings → operator enables attended commissioning → test physical policy → record results → enable unattended control. Workspace enablement remains separate from Resume, and enabling control leaves automation paused.
- Permit attended tests only on the selected workspace and the supported command set after fresh diagnostics; incomplete commissioning must not expose normal unattended Resume. Firmware/binding changes invalidate the applicable evidence.
- Maintain distinct requested, accepted, acknowledged, read-back and physically observed outcomes, with Activity links and a clear retry/reconcile path after a lost response.
- Preserve the precise Stop label: it cancels app top-ups and clears scheduled AC permission. It does not promise to suppress every native reserve-charging mechanism. Keep it available during pending device work.
- Cover these states in EN/BG and at phone widths. Remove obsolete generic catalogue text only after confirming it has no consumers.

**Exit:** an owner can identify the current blocker and next action; settings checks alone cannot be presented as physical commissioning; interrupted activation cannot bypass pause/cleanup.

### 3. Establish exact firmware capabilities and commission the requested policy

Relevant code: `src/controller.mjs`, `src/control-journal.mjs`, `src/supervision.mjs`, `src/tenant-runtime.mjs`; operational procedure: [controller notes](controller.md).

The requested behavior remains:

| Situation | Required result |
| --- | --- |
| Solar surplus | Supply the house first; charge toward 100% SOC, including above 50%; separately enforce the requested 5 kW solar charging cap once validated. |
| Solar deficit/night above 50% | Battery supports house demand down to the 50% on-grid reserve; grid may cover demand beyond available battery output. |
| Below 50% | Grid battery top-up is available at any time of day at the verified approximately 2 kW setting and stops at 50%. |
| Mixed solar/grid | Solar has priority; observations establish what the firmware's AC setting actually limits. |
| Stop, communication failure or restart | App intent is paused/cancelled durably; physical scheduled permission is verified or explicitly unresolved; no competing controller or silent rearming. |

- Obtain manufacturer documentation or a verified control mapping for BSE20KH3 / protocol 2.02 / DSP 1.57 / HMI 1.45. For the solar cap, establish register, units, bounds, battery-side meaning, readback and reversibility before any write. Raw 100 at 3022–3023 does not establish a watt-scaled 5 kW limit.
- Keep the overall SOC maximum at 100%, grid target at 50%, and on-grid reserve at 50%; never use the global SOC maximum to impose the grid threshold.
- Prefer the inverter's native reserve policy where it satisfies the requirement. Native charging near 2 kW and stopping at 50% have already been observed with scheduled AC permission off, so a new daily schedule must solve a demonstrated gap.
- Run attended tests with original values and a recovery path recorded. Keep ordinary automation paused while commissioning; return to paused intent and reconcile after a failed test.
- Store requested values, readbacks and time-aligned actual PV/load/grid/battery/SOC observations separately. Aggregate battery power alone cannot establish exact grid-versus-solar charging attribution.
- Prove above-50% solar charging, above-50% discharge, below-reserve recovery and stopping at 50%, then repeat through mixed sources and a full day/night cycle.
- Exercise Stop during pending work, delayed callbacks, provider outage, restart, midnight/timezone transition, grid loss and battery-not-ready states. Software fixtures cover unsafe/hard-to-produce failures; an actual timed schedule must never be called a one-shot physical watchdog.

**Exit:** each claimed SOC/power behavior and recovery result has device-bound evidence, no cleanup remains unresolved, and the 5 kW requirement is verified. If this firmware cannot independently enforce a requested limit, document that limitation and obtain an explicit scope decision before calling the full request complete.

### 4. Deliver alerts and resilient unattended operation

Relevant code: `src/operations.mjs`, `web/system-health.tsx`, backup status tooling and deployment configuration.

- Add a tenant-scoped durable notification outbox for one selected private channel, with bounded retries, episode/revision deduplication, visible delivery status and resolution messages.
- Cover stale/offline telemetry, persistent native-command failures, authentication failure, control faults, unresolved cleanup and API exhaustion. Keep platform backup/restore/erasure-service incidents administrator-scoped.
- Preserve pending notifications through restarts. A request timeout must not be displayed as confirmed delivery; apply the chosen channel's deduplication capabilities where available.
- Configure an independent check for an unreachable host or failed `/healthz`; an app cannot reliably report its own complete outage.
- Select/verify the channel and destination before any real send. No recipient is inferred from dashboard or provider account emails.
- Keep daily encrypted backups and weekly isolated recovery drills, including verification that no restore starts a device scheduler or regains erased customer access.

**Exit:** the selected destination receives a test incident and recovery; retries survive restart; an independent outage check works; backups and restores remain current.

### 5. Finish the existing offboarding release for hosted tenants

Relevant code: `src/workspace-offboarding.mjs`, `src/erasure-*.mjs`, `web/workspace-offboarding.tsx`, migrations 017–018, `scripts/install-backup.sh`, restore tooling.

- Complete review and regression coverage of archive → close → cleanup → authorize erasure → verified offsite receipt → bounded removal. Cancellation before authorization returns to suspension; authorization disables customer access and is irreversible.
- Prove that unresolved writes/cleanup retain only the original credentials/binding needed for recovery, block deletion, and never rearm normal automation. Drain concurrent runtime loading and preserve fairness when one tenant is blocked.
- Prove credential removal, bounded data deletion, rollback/restart, isolation, legacy-login races and retention of anonymous shared-App-ID accounting.
- Exercise the publisher against an isolated proof prefix in the real private offsite store; prove readback and acknowledgments without creating fake fences for real tenants. Remove only the proof artifacts afterward.
- Restore a pre-017 backup with the new operational tools; replay durable erasure receipts before customer access and prove that deleted accounts cannot return. Existing encrypted backups retain their documented expiry; receipts do not instantly remove their bytes.
- Install and verify the root receipt timer/permissions and fresh startup guard before application deployment. Test stale/missing receipts: running monitoring can continue, erasure waits, and cold startup remains fail-closed as designed. Document that availability tradeoff and recovery procedure.
- After deploying, create a fresh backup and restore that exact copy with all erasure/access/quarantine checks. Never use the real protected administrator workspace as an erasure fixture.

**Exit:** full software checks and real old/fresh-backup recovery pass; receipt health is visible in EN/BG; no temporary proof databases/roles/objects remain; hosting lifecycle is demonstrated with disposable tenants.

### 6. Release, observe and hand over

For each independent software release:

1. Review only the intended diff and scan secret handling. Keep existing unrelated work intact.
2. Run type/syntax checks, focused regressions, unit tests and build; then full PostgreSQL integration and EN/BG browser checks where shared contracts/auth/runtime are affected. Database and browser suites exclusively own `solarman_test` and run sequentially.
3. Commit/push the reviewed release, install matching operational tools when required, verify an older backup upgrade, and deploy only the Solarman PM2 process. Verify the actual running SHA, HTTPS, migrations, private file permissions and rollback compatibility.
4. Verify a fresh backup/restore after schema changes and inspect live EN/BG desktop/mobile behavior. Application deployment and physical inverter activation remain separate operations.
5. Activate only the commissioned home after alerts are proven; observe a full day/night cycle, including a reserve crossing, and review write frequency, false alerts and response times.
6. Before admitting hosted customers, replace the initial test credentials, retain recovery keys securely, rehearse invitation → link → monitor → activate → suspend → restore → export → close/erase, and confirm licensed shared capacity.

**Exit:** the agreed home behavior holds on the real inverter through the observation cycle; operational recovery and alerts work; the hosted lifecycle and allowance are proven before hosting is opened.

### Priority and dependencies

The home-control critical path is **reliable native commands → settings/commissioning workflow → verified firmware limits and physical policy → alerts/outage detection → attended activation and full-cycle observation**. Alert software and tenant work can proceed while daylight, SOC or manufacturer evidence is unavailable. Offboarding must not become a prerequisite for a separately reviewed home-control release, but its partially integrated code cannot be included accidentally.

Capacity is already a constraint that the plan must respect: the current home has five-minute telemetry (105,120 regular requests/year). Control activation previews 187,245 reserved regular requests/year against 188,000 planned, with 17-minute scheduled checks and 32-minute reserve-assessment eligibility. These are cloud supervision intervals, not a promise of immediate SOC-triggered intervention. The continuously available 50% policy should rely on verified native behavior wherever possible. Preserve recovery quota; increase the allowance only against a real provider entitlement.

No arbitrary rule builder, unrestricted hex console, new inverter profile or multi-inverter workspace is needed to finish the agreed home policy. Tariffs, forecasts, savings, exact source attribution and time-to-full need validated inputs before they can be offered accurately. The existing analytics must retain actual timestamps, gaps and energy/coverage labels.

## Original scope

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

| Screen    | Main task and content                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview  | Solar, house, battery and grid power; a directional flow diagram; SOC and its 50% reserve line; controller state; last device update; current reason for grid charging or its absence.                             |
| Analytics | Today, yesterday, 7 days, 30 days and custom date range; aligned power and SOC charts; daily energy totals; grid imports/exports; battery charge/discharge; solar production; data coverage and missing intervals. |
| Controls  | Verified status beside each action; start a top-up to 50%; stop grid charging and resume battery use; enable or pause automation; refresh diagnostics.                                                             |
| Activity  | Searchable command and automation history with timestamps, actor, reason, requested value, device acknowledgment, readback result and failure details.                                                             |
| Settings  | Connection and quota status, sampling interval, timezone, reserve policy, API readiness and account/logout controls. Secrets remain server-side.                                                                   |

Use a restrained dark interface with readable typography, high-contrast numbers and consistent source colors. The flow diagram is the visual focus of Overview. Charts have a shared time cursor, units, legends, keyboard-readable values, range controls and CSV export. Controls stay usable on a narrow phone screen. Status is conveyed by text and icons as well as color.

Show dedicated loading, no-history, API-unconfigured, device-offline, stale-data, command-pending and command-failed states. Missing readings are gaps, not zeroes. Do not fill an empty deployment with demonstration measurements.

## Analytics definitions

For provider readings, retain device collection time separately from server receipt time. Native Modbus measurements use the server time of a fresh, verified command snapshot as their observation time; they do not claim a separate device sampling timestamp. Normalize display directions: grid import and battery discharge are positive; export and charging are negative. Display charging/discharging labels so sign conventions are not required knowledge.

The initial implementation integrates power over valid adjacent samples and labels the result as an estimate. Do not integrate across a gap greater than twice the configured sampling interval. Show coverage beside estimated totals, use UTC storage and the account's timezone for presentation, and honor local-day boundaries including daylight-saving changes. Verified cumulative energy counters and reset handling can be added after their firmware mapping is established.

Battery energy charged is not automatically solar energy stored. Mixed-source charging cannot support an exact attribution without suitable metering. Do not invent a solar self-consumption percentage, savings estimate, battery capacity or time-to-full when the needed inputs are absent. Tariff-based cost estimates require an explicit tariff and coverage indicator.

All browser viewers use the application's cached data. Opening a page or chart does not start extra SOLARMAN polling. The tenant scheduler uses the verified single-request telemetry mapping between native audits. Its steady active baseline is approximately 148,920 regular calls/year for one workspace, before transitions and recovery. Faster settings must show projected usage against SOLARMAN's quota; shared App IDs account for every active workspace.

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

New installations still require activated OpenAPI credentials: a Smart email/password alone does not provide an APP ID or APP SECRET. The existing installation has working credentials and live telemetry. New tenants must see their actual setup state until their own account is connected.

Implementation references: [React](https://react.dev/learn), [Vite](https://vite.dev/guide/), [Recharts](https://recharts.github.io/en-US/), [node-postgres connection configuration](https://node-postgres.com/features/connecting), and [SOLARMAN API activation](https://helpcenter.solarmanpv.com/portal/en/kb/articles/i-want-to-open-api-how-can-i-open-api).
