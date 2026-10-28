# Solarman dashboard implementation plan

Current status (2026-10-28): the deployed dashboard has working authenticated OpenAPI discovery, native device callbacks, stored live measurements, charts, exports and English/Bulgarian translations. The follow-up control release adds read-only device verification, individual workspace activation, immediate persisted stop intent, priority cancellation of queued starts and expiry for manual top-up intent. The original scope below remains the acceptance baseline.

Single-request telemetry now provides five-minute monitoring with actual collection timestamps, deduplication, nullable unknown AC permission and per-sample cadence. Clock comparison with the workspace timezone is included in device verification. Shared App ID budgets reserve requests atomically, check provider balance daily and preserve recovery capacity. Active supervision now uses telemetry between hourly native audits and checks earlier for starts, top-up assessments, owned schedules or observed deviations. Native charging near the 2 kW target is preserved without adding a timed window. The control journal persists write intent, acknowledgment, readback and cleanup obligations across restarts and credential repair. Controls shows the five latest write records; Activity now exposes command details and the full paginated journal, including unlinked recovery and previous bindings. Native charging has been observed to stop at 50% while scheduled AC permission was already off. Remaining delivery work: verify native behavior above the 50% boundary; establish the separate 5 kW solar charging limit; complete physical control and interrupted-command commissioning; maintain offsite backup/recovery checks and finish tenant lifecycle operations. The host write permission remains off until commissioning supports activation. Do not treat application job expiry as an expiring physical inverter schedule.

Persistent System health alerts now cover stale uploads, reported offline/alarm state, repeated failed assessments, saved control faults, unresolved cleanup and API capacity. Acknowledgments retain active conditions, and escalation requires a fresh acknowledgment of the displayed revision. The operational monitor uses PostgreSQL without extra provider calls; external notification delivery is not configured.

## Completion plan

### Audited delivery status — 2026-10-28

This audit separates deployed behavior, local work and physical evidence. The initial read-only audit of production release `e1d1508cf1222cbb01ea78dda3458fba660e8d77` found a current operational monitor. The linked account is connected, uses `bluesun-bse20kh3` and had eight passing saved device checks before the firmware gate. Host writes are disabled, workspace control is disabled and automation is paused. The production write journal contains zero application inverter writes. Passing read-only checks therefore must not be presented as commissioned control.

Latest verified deployment: `e60de949a9c07a36beda6ac2f5b445359766cab8`. Public health reports the matching release and a current operational monitor; migration `013_private_access.sql` is applied. Native Chrome shows the Bulgarian account recovery panel and invitation/recovery administration. Both the older-backup upgrade and the fresh-backup restore passed with the matching operational capsule. Production still has no application inverter writes, workspace control remains off and automation remains paused.

| Area | Current evidence | Remaining work |
| --- | --- | --- |
| Monitoring and analytics | Deployed telemetry, actual device timestamps, charts, CSV, coverage and EN/BG interface | Continue explicit unavailable/stale states; retain estimated-energy labels. No additional analytics feature blocks home commissioning. |
| Control readiness | Separate connection, profile, host, workspace, settings, clock and recovery checks | Refresh the time-limited evidence before activation and complete physical commissioning for this binding. |
| Firmware binding | Nine-check verification includes the diagnosed protocol/DSP/HMI identity. Fresh firmware/model changes revoke activation, pause intent and retain cleanup. Controls and Activity show firmware evidence. | Commission the actual charging behavior for that binding; other firmware needs a separately verified profile. |
| Automation and recovery | Serialized commands, persisted Stop cancellation, write journal, readback and restart recovery are implemented and tested | Demonstrate behavior on the real inverter, including delayed commands and repeating schedules. |
| Command audit | Activity details and complete paginated write history are deployed | Include physical commissioning records and their observations. |
| Operational alerts | Persistent in-app incidents and acknowledgments are deployed | Configure external delivery, delivery retries and recovery notifications; verify the application can report its own outage independently. |
| Backups | The root-owned daily timer is enabled. A backup through the installed service and recovery from that offsite copy passed; administrator recovery health is live in EN/BG. | Retain the separate recovery identity and run weekly drills. The initial failed restore was fixed by assigning schema ownership inside the new drill database. |
| Hosted tenants | Tenant isolation, private provider links, shared quota accounting and EN/BG account security are implemented. Private access adds saved recovery keys, expiring administrator links, operator recovery and invitation revoke/reissue with paginated history. Workspace availability adds revision-checked suspension/resumption, member-visible status and private transition history. | Offboarding and retention still need complete flows. External notification delivery remains a separate dependency. |
| Hosting capacity | Atomic admission and activation reserve the largest periodic monitoring/control workload. Waiting workspaces retain account repair and recovery, with EN/BG capacity states. Pause retains its reservation; disabling control releases it while preserving cleanup. | Keep licensed allowance current. Tenant lifecycle and physical commissioning remain separate release gates. |

The old generic Bulgarian lock notice is no longer the active component; its catalogue entry remains. The current interface links to individual readiness reasons. The latest authenticated snapshot reports `server`, `verification` and `workspace`: host permission is off, the passing report from 14:35:58 UTC has expired for activation, and workspace control is off. Fresh settings and clock evidence are also required at activation time. The supported profile is already selected; choosing it again does not remove these blockers. The saved report is historical evidence, not an authorization to resume later.

The latest inspected sample was at 16:40:25 UTC: 50% SOC, 0 W solar, 654 W house demand, 796 W grid import and 0 W battery power. Scheduled AC permission is unknown in this provider sample; it is not inferred from the power values. This is compatible with preserving a 50% reserve. It does not establish battery discharge or solar charging above 50%.

A later stored-data audit through 16:54:34 UTC found 90 samples, with SOC between 40% and 50%. None contains an above-reserve solar-charge or battery-discharge observation. Those physical acceptance checks therefore still require a suitable observation window.

The capacity gap identified in this audit is addressed by reserving every control workspace's largest periodic workload before activation, under a PostgreSQL App ID lock. Four hourly-audited workspaces previously projected 245,280 regular requests/year at the telemetry cadence cap, beyond the default 188,000 planning allowance. The new planner also includes repeated native assessments and scheduled top-ups. One home keeps five-minute telemetry, with 17-minute scheduled checks and 32-minute reserve-assessment eligibility, reserving 187,245 regular requests/year. The default allowance admits at most one full control reservation plus two monitoring-only workspaces, or ten monitoring-only workspaces. Additional capacity requires a separate App ID or a licensed allowance. These are conservative continuous-use reservations, distinct from current-mode projections and actual request enforcement.

Recovery-release checks passed: type/syntax checks, build, 95 local unit tests (one Linux-only concurrency test skipped locally and passed on the server), 55 PostgreSQL integration tests and 16 browser tests. Integration/browser suites ran sequentially against the separate test database. The real offsite restore additionally proved inventory, account decryption, authentication, paused controls, zero device access and test database/role cleanup. These checks do not establish physical inverter behavior.

The capacity follow-up passed type/syntax checks, build, 103 local unit tests (one Linux-only test skipped locally), 67 PostgreSQL integration tests and 17 browser tests. New cases cover independent concurrent admission/activation, a Stop epoch defeating delayed activation, no fake device success while waiting, capacity release with failed cleanup, recovery after restart and revocation after an allowance reduction. Browser coverage includes EN/BG capacity states, a pending retry, activation cadence preview and narrow mobile layouts. Device writes remain disabled.

Production deployment passed all 104 unit tests on Linux. After the capacity migration, a new encrypted offsite backup and restore of that exact copy passed inventory, account decryption, HTTP authentication, control quarantine and zero device access. Live Bulgarian settings show five-minute monitoring and a separate 17/32-minute activation preview; inactive control intervals are omitted.

The account-security follow-up passed type/syntax checks, build, 104 local unit tests (one Linux-only test skipped locally), 72 PostgreSQL integration tests and 19 browser tests. It covers current-password changes, secret renewal, individual/bulk browser revocation, legacy metadata, pagination, private security history, rate limits, simultaneous changes and delayed old-password logins. Real-cookie browser tests prove access renewal and revocation in EN/BG at mobile width, including an unconfirmed response. Recovery tooling now checks the original snapshot before applying migrations in isolation and exercises the new password/session contract. Production backup-upgrade and fresh-restore proofs are release gates, separate from these software tests.

Private-access software checks passed: type/syntax checks, build, 105 local unit tests (one Linux-only test skipped locally), 82 PostgreSQL integration tests and 23 browser tests. All 106 unit tests passed during Linux deployment. The release covers single-use recovery, replacement keys, administrator restrictions, expiry after lock waits, stale-browser rejection, invitation migration/revoke/reissue and activation races. Browser tests cover saved-key downloads in Bulgarian, fragment removal, replacement links in the same tab, delayed initial identity responses and recovery while another account is signed in. The operator command was exercised interactively against the test database with hidden input and a trailing space. The recovery receiver now seeds two isolated recovery grants, proves their quarantine and exercises saved-key reset/revocation. Restore `d0ef26da-02a9-4253-90f6-0463d65e6bea` upgraded older backup `863f6ec6-131b-4884-92fd-5cd0b165647e` through migration 013; restore `dcbd6c04-e83f-45de-9374-7f2f3485f24f` verified fresh backup `59d0c452-592a-4dee-95c6-54acfbb77804` without additional migrations. Both passed inventory, credential, authentication, account security/recovery, recovery quarantine and control quarantine checks with zero device access. No temporary drill database or role remained. The daily backup timer is active and administrator recovery health is healthy.

### Required physical outcomes

Workspace-availability checks passed: type/syntax checks, build, 106 local unit tests with one Linux-only skip, 90 PostgreSQL integration tests and the 24-test browser suite. The final history/status query and operator-only administrator labels also passed a fresh full integration run and focused real-cookie browser run. Regression coverage includes independent administrators racing for one revision, numeric history ordering, queued-start cancellation, late readback, cleanup after restart and suspended administrator actions. The restore receiver now requires explicit tenant-lifecycle verification, using a suspended fixture through password and saved-key recovery. Matching older-backup upgrade and fresh-backup restore remain release gates.

| Situation | Required result | Evidence still needed |
| --- | --- | --- |
| Solar surplus, battery above 50% | House supplied first; remaining solar may charge toward 100% | Time-aligned native settings, PV/load/battery power and SOC observations. |
| Solar deficit or night, battery above 50% | Battery supports the house down to the on-grid reserve; grid may cover demand beyond available battery power | Sustained battery discharge above the reserve, followed by transition at 50%. Grid house import alone does not identify battery charging. |
| Battery below 50%, little solar | Grid top-up available at any time, approximately 2 kW AC setting, stopping at 50% | Native reserve charging and stopping have been observed without application writes; repeat across the relevant day/night conditions. |
| Solar and grid available below 50% | Solar retains priority; any grid contribution respects the requested limit | Establish whether this firmware's AC setting limits grid contribution or combined battery charging. Aggregate battery power cannot resolve that alone. |
| Solar battery charging | Independent requested 5 kW maximum | Exact firmware mapping, units, bounds, reversible setting/readback and observed power. This remains unverified. |
| Stop/Pause | Cancel application top-ups and remove scheduled AC permission, with an explicit confirmed/unknown outcome | Verify the physical result. Native reserve charging may continue; the current action cannot promise to disable every grid-charging mechanism. |

Use the verified native inverter policy as the primary behavior wherever it already satisfies these outcomes. The application should supervise and intervene only for a demonstrated gap. A permanently enabled daily AC schedule is not the acceptance target.

### Delivery batches and release gates

1. **Maintain tested recoverability — initial delivery complete.** The installed Solarman-only daily backup and real offsite restore passed. The test restores matching database/configuration into isolation, proves inventory, authentication and linked-account decryption without a device scheduler, and drops its temporary database/role. Safe failure-stage codes, administrator health and key/retention documentation are implemented. Ongoing gate: retain the separate recovery identity, keep backup health current and run weekly recovery drills.
2. **Retain precise control outcomes in EN/BG — software delivery complete.** Controls, Activity and command details distinguish Stop scheduled top-ups from native reserve charging, show individual readiness reasons, recorded firmware verification and unresolved cleanup. The cadence release adds the next assessment, reserved capacity and activation preview. Gate: maintain mobile/desktop coverage of locked, pending, confirmed and unknown outcomes; the actual physical result remains part of commissioning below.
3. **Resolve firmware limits.** Obtain documentation or a verified vendor control mapping for this exact firmware. Capture original settings, units, range and readback before a reversible power-limit test. Establish the independent 5 kW solar limit and the AC setting's meaning with mixed sources. Include model, protocol, DSP/HMI and mapping revision in commissioning evidence; changed firmware must require fresh verification before normal control. Gate: all requested limits are demonstrated, or a specific firmware limitation is documented and explicitly accepted. Never write `5000` to a guessed register or lower the global SOC maximum to impose the grid target.
4. **Commission the physical policy and interruption behavior.** Run the scenario matrix below in attended steps. Keep ordinary automation paused while enabling only the commissioned workspace for a controlled test. Record command intent, acknowledgment, readback and actual power/SOC separately. Gate: normal transitions and recovery pass for this device; there is no unresolved scheduled permission or competing controller. A failed test returns to paused intent and requires reconciliation.
5. **Release home automation and observe a full day/night cycle.** Refresh device checks, enable the host permission for the installation and activate the workspace separately. Prefer native supervision and retain guarded top-ups only where commissioning shows a need. Check SOC-boundary stability and write volume without silently changing the requested 50% target. Add external alert delivery through a durable outbox with bounded retries, episode deduplication and recovery messages; configure an independent service-health check. Gate: the policy holds through solar changes, a reserve crossing, midnight and a service restart; Stop remains available during pending work and the recorded outcome matches physical observations. External alerts must reach the selected private channel before unattended operation is declared ready. Selecting and testing that channel is a configuration dependency; do not send to an assumed recipient.
6. **Complete hosted-tenant operations before opening hosting.** Retain implemented password change, browser-session renewal/revocation, private security history, saved-key/administrator/operator recovery, invitation lifecycle and workspace suspension/resumption. Add offboarding. Suspension cancels starts, preserves monitoring/recovery access needed for unresolved device cleanup and prevents new automation. Deletion cannot discard a pending cleanup obligation. Retain the implemented atomic capacity admission for activation and mode changes. Define data/export retention and provider credential removal; replace initial test credentials before onboarding. Gate: two independent accounts remain isolated across the entire lifecycle, concurrent activations cannot overbook shared capacity and unsupported devices stay monitor-only. Broader roles or multiple inverters per workspace are separate scope decisions.

Batches 1–2 can proceed without inverter writes. Batch 6 can proceed while weather and SOC conditions needed for physical tests are unavailable. Do not block recoverability or tenant work on the unverified solar-limit mapping, and do not use that parallel progress to declare home control commissioned.

### Next implementation order

1. **Tenant suspension and resumption — software implemented.** Active and suspended states reuse persisted pause, cancellation epochs and the device cleanup journal. Lifecycle is checked at command acceptance, activation, write preparation and immediately before dispatch after provider pacing/quota reservation. Suspended actors cannot start automation, issue invitations or create administrator recovery links. Monitoring, credential repair, exports, security and Stop remain available. Normal control capacity is released without discarding recovery obligations. Making a tenant available still requires fresh verification and separate control activation. EN/BG owner/admin flows cover pending, failed, confirmed and unknown outcomes, member messages and the latest 20 changes. Administrator workspace availability is reserved for the operator. Gate: retain suspend-versus-delayed-start/write, restart, cross-tenant, revision-conflict and real-cookie browser coverage. Verify older-backup upgrade and fresh-backup restore with the matching capsule; its isolated fixture must retain suspension through account recovery. Do not describe this software gate as physical commissioning.
2. **Offboarding and retention.** Offer export before revoking browser sessions, recovery grants and applicable invitations, and stop normal collection. Keep the original encrypted provider credentials and authenticated command callbacks available only as long as an unresolved physical cleanup obligation requires them. Show offboarding as pending while cleanup is unknown; deletion cannot cascade away its journal. Once cleanup is confirmed, retire provider callback access and remove credentials. Define configurable telemetry, audit and export retention, then remove eligible tenant data in bounded jobs. Document backup expiry and ensure restoring an older snapshot cannot silently reactivate an offboarded workspace. Gate: two independent tenant fixtures prove isolation, interrupted cleanup, retry/restart behavior, capacity release and eventual credential/data removal. Do not delete the home workspace to test this.
3. **External alerts and independent availability monitoring.** Extend the existing incident lifecycle in `src/operations.mjs` with a durable delivery outbox, bounded retries, episode/revision deduplication, resolution messages and visible delivery failure. Keep destinations private and tenant-scoped. Preserve pending delivery across restart and test provider timeouts without claiming exactly-once delivery. An independently hosted check must detect failure of `/healthz`, including a stopped application or unreachable host. Delivery to a real recipient waits for the already-requested channel/destination selection; implementation and isolated transport tests can proceed meanwhile.
4. **Commissioning evidence for the existing policy.** Reuse `src/control-readiness.mjs`, `src/controller.mjs`, `src/supervision.mjs` and the existing Activity journal. Record the device/firmware binding, original settings, observation times and physical outcome for each test below. Refresh the nine checks before an attended activation; leave other workspaces inactive. Resolve the separate solar-limit mapping and mixed-source AC-limit meaning before claiming the full requested policy. Capture rollback/readback evidence and retain an explicit unknown outcome whenever a command cannot be reconciled.
5. **Home release, then hosting release.** After the physical matrix passes, observe at least one full day/night cycle including a reserve crossing, midnight, Stop and restart; verify the selected alerts actually arrive. Then complete a two-account onboarding-to-offboarding rehearsal with licensed API capacity and updated owner credentials. Keep exact source attribution, tariffs/savings, arbitrary register commands, extra inverter profiles and multiple devices outside these completion gates.

The next software batch is offboarding and retention. The next hardware task is read-only evidence gathering and obtaining the exact firmware power-limit mapping. These can progress independently. A suitable solar/SOC observation window and a selected alert destination are external dependencies, not reasons to weaken verification or postpone the remaining software.

### Physical commissioning matrix

| Test | Pass condition |
| --- | --- |
| Solar surplus above 50% | Battery charges above the grid target toward the overall 100% target; requested solar power limit is independently verified. |
| Deficit above 50% | Battery contributes to house demand and approaches the reserve; any grid support is explained by measured demand and limits. |
| Below-reserve recovery | Approximately 2 kW AC setting and 50% target are preserved; top-up remains available outside a fixed time-of-day window. |
| Reaching 50% | Grid battery top-up stops at its target while solar charging remains possible above it. |
| Mixed solar/grid | Observations establish the AC-limit meaning and confirm solar priority rather than attributing aggregate battery power to one source. |
| Start followed by Stop | Persisted pause wins over queued starts and late responses; physical scheduled permission is checked again. |
| API/callback interruption | Ambiguous writes remain unknown, normal starts stay blocked and cleanup is reconciled after recovery. |
| Service restart while permission may be owned | Saved ownership survives; cleanup completes before another start. No automatic rearming after credential repair. |
| Midnight and clock change | Windows and clock checks behave correctly; a daily repeating window is never described as a physical expiry timer. |
| Grid unavailable or BMS not ready | No new top-up is enabled; native inverter/BMS protections remain effective. |

For each test, retain the device/firmware binding, initial settings, observation timestamps, requested action, readback, actual power/SOC result and recovery outcome. Software fixture tests complement this record but cannot replace it.

### Scope of completion

Home readiness requires recoverable data, the demonstrated power/SOC policy, physical recovery tests, accurate control labels, accessible write history and operational alerts. Hosted readiness additionally requires complete tenant lifecycle operations and appropriately licensed provider capacity. Configurable tariffs, savings, exact source attribution, time-to-full, new inverter profiles and multi-device workspaces are future features until their inputs and mappings exist.

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
