# Solarman completion plan

Updated 2026-10-29. Commissioning, tenant notifications, the independent-watchdog implementation, firmware evidence reporting and archive/erasure-receipt integrity checks are deployed. The owner selected an independent host and confirmed both dashboard and separate-host iPhone tests. The installed watchdog passed real stopped-app and isolated network-loss checks; physical inverter commissioning remains open. This is the current finish plan; [dashboard-plan.md](dashboard-plan.md) retains the original requirements and historical implementation notes.

Scope update, 2026-10-29: the owner withdrew the 5 kW solar-power-cap requirement. Solar charging follows native inverter and battery limits up to the existing 100% SOC target. The 2 kW grid setting, 50% grid target and 50% reserve remain required. This supersedes the older solar-cap requirements in the historical plan.

## Homeowner interface redesign

The owner accepted the smoked-glass / 1990s hi-fi direction on October 29. The implementation replaces the six-item everyday navigation with Home, Automations, History and Settings; puts reviewed grid charging on Home; separates energy history from action history; and moves commissioning, recovery and administrator detail out of routine control flows. A guided setup links connection, read-only verification and the existing attended evidence/approval process. The production policy and all server-side write gates remain unchanged. This UI work does not grant commissioning approval or imply the remaining physical acceptance checks are complete.

Redesign verification: type/syntax checks and the production build passed; 215 local unit tests passed with three Linux-only skips; all 178 PostgreSQL integration tests and all 54 browser tests passed. Browser coverage includes the new charging dialog, blocked starts, stale-reading stops, EN/BG layouts at 320–1440 px, existing commissioning/recovery controls, account security, notifications and tenant lifecycle flows.

## What is actually locked

The quoted Bulgarian monitoring-only notice is an unused translation entry. The current Controls page already shows individual blockers, their responsible actor and next action. The selected `bluesun-bse20kh3` profile is supported for the observed protocol 2.02 / DSP 1.57 / HMI 1.45.

| Area | Verified state | Remaining work |
| --- | --- | --- |
| Native diagnostics | All nine checks last passed at 11:04:52 UTC on October 29 after the actual permission-recovery test and restart. Reports expire after 30 minutes while control is inactive. | Refresh before activation; retain explicit failure/late-response states. The initial 530 recurred before subsequent successful reads; its cause remains undiagnosed. |
| Activation | Host writes are permitted for guarded commissioning; workspace control and manual top-up are off, and automation is paused. No unattended approval has been granted. Device-bound commissioning is also required. | Commissioning software is deployed; the remaining physical acceptance checks and explicit evidence save/approval must pass. |
| Physical changes | The October 29 attended test at 57% SOC verified permission 9→25→9 with two verified application writes, preserving charging windows and limits. Restart revoked attendance and control; zero unresolved bindings. | Below-target application charging and physical recovery during an interrupted or lost write remain untested. |
| Policy observations | The continuing bound run had 176 accepted samples at 11:03 UTC on October 29. Above-50% solar charging was observed at 09:55; the 10:05 reading showed SOC 54%, PV 1,676 W, house 610 W and battery charging 1,013 W. Earlier grid charging near 2 kW remains recorded. | Discharge above 50%, a newly qualifying grid-stop transition and a full day/night cycle remain open. The successful attended recovery command is available for explicit evidence saving. The saved commissioning checklist still requires the owner's explicit action. |
| Alerts | Durable in-app incidents, browser Web Push and optional Telegram delivery are implemented. The owner selected iPhone subscriptions; server keys are configured privately. | iPhone `push_displayed` confirmed at 09:27:54 UTC on October 29; alerts enabled. Independent monitor installed on `root@89.167.46.193`; its test was confirmed and both outage/recovery pairs were accepted by Apple. Remaining device confirmations and operator handover stay explicit. |
| Hosted tenants | The connected test-database rehearsal covers attended commands and notifications. The native Chrome production audit also verified signup, actual provider discovery, duplicate protection, 22 translated page checks and real closure/removal. Production has migrations 001–022. | Complete the browser journey with a different bound home, confirm provider entitlement and perform operator handover; physical acceptance remains separate. |
| Recovery | The post-physical-test backup passed isolated restore on October 29 at 11:06:26 UTC, retaining the real write journal while quarantining controls, commissioning and notifications. Zero device or delivery calls; actual erasure receipt verified. | Maintain recurring recovery drills and perform an actual operator handover. |

**Baseline audit finding:** the inspected release gated starts on settings, firmware, clock, capacity and permissions without a physical-commissioning approval gate. Observation runs deliberately grant no control permission. The implementation below adds the missing gate; hardware acceptance remains open.

## Commissioning implementation

The commissioning increment implements durable device-bound runs/events, current-password confirmation, optimistic revisions, a 30-minute attended session, explicit test-control/top-up actions, and approval checks at acceptance, capacity activation, intent persistence and inverter dispatch. Ordinary Resume stays blocked during attended testing. Session expiry, restart, connection/firmware/lifecycle changes, restore and deployment rollback revoke the applicable permission while retaining physical cleanup. Read-only observation snapshots and verified Stop evidence can be saved separately from approval.

The EN/BG commissioning page is linked from Controls. Preparation requires fresh settings checks but works with host writes off. The withdrawn solar-power-cap requirement no longer blocks approval. All six physical acceptance checks remain required. No physical inverter write or unattended activation was performed while implementing this increment.

Commissioning checks passed: type/syntax checks, production build, 129 local unit tests with one Linux-only skip, 143 PostgreSQL integration tests and all 33 browser tests. The browser case covers lost responses, explicit attendance, Stop during pending work, EN/BG and 320 px layout. Both old/fresh offsite restore proofs passed, including attended/approved canaries, quarantine and archive checks. No production commissioning session or approval has been fabricated.

## Notification implementation

The notification increment adds an encrypted Telegram destination per tenant, password-confirmed save/test/enable/disable actions, optimistic revisions, transactional incident capture and durable delivery attempts. Retries retain ambiguity and one event reference, respect rate limits and stop at four attempts or 24 hours. Rejection disables the affected channel. Closure drains in-flight delivery; export excludes tokens; retention preserves pending work; restore quarantines every destination and proves zero external calls. The EN/BG page includes initial failures, empty state, configuration conflicts, uncertain responses, pagination and phone layouts. See [notifications.md](notifications.md) for setup and operational limits.

At its initial deployment this implemented delivery software without real-destination acceptance or independent outage detection. No production bot/chat was configured or contacted. The later iPhone acceptance is recorded below.

Release `52127f0` passed an isolated upgrade of schema-020 backup `71b33aa1-e668-4673-8056-09d85e886e89` in restore run `8e7fb8df-78cb-4a73-b416-a879782ab935` (22:12 UTC, October 28). Fresh schema-021 backup `58ec89f8-a002-48b0-9e02-6260e5b63291` passed restore run `6b0800bf-a328-4d54-841e-31e5259f1491` (22:13 UTC). Both verified notification/commissioning quarantine, authentication, export, lifecycle and erasure fences, with zero device or delivery calls. Independent PostgreSQL inspection found no remaining drill databases or roles.

## Independent watchdog implementation

The watchdog has a separate filesystem journal and a Linux systemd timer, without app/database/provider credentials. Fresh random challenges reject cached health successes; direct TCP checks add context without declaring a host dead. Three consecutive failures open an incident and two fresh successes recover it. Messages keep durable attempt history, bounded retries and one event reference. File locks serialize invocations; termination drains transport; restores require quarantine and a fresh disabled/tested/enabled sequence. See [watchdog.md](watchdog.md) for installation and operator commands.

The owner subsequently selected `root@89.167.46.193`, and read-only SSH checks confirmed access. Its older system Node remains intact; a dedicated Node 24 runtime was installed under `/opt/solarman-node` after official archive checksum verification. The owner confirmed its exact independent test at 09:54 UTC; the monitor is enabled. The later live outage/recovery checks are recorded in deployed acceptance. Local proxy/socket fixtures and injected timeouts prove software behavior; the later live checks establish outside-host transport acceptance. Individual device displays remain separate from push-provider acceptance.

Verification passed: type/syntax checks, production build, 161 local unit tests with three Linux-only skips, all 24 focused watchdog tests on Linux, all 164 PostgreSQL integration tests and all 36 browser tests. The installer passed Bash syntax validation; its generated service/timer passed `systemd-analyze verify` in a temporary directory without installing either unit. Source and build artifacts passed a scan against configured local secret values. No database migration or inverter setting is changed by this increment.

## Independent iPhone delivery

The independent monitor now reuses the selected verified administrator device. Its private configuration contains the subscription, VAPID signing pair and a channel-bound read-only permission token; provider/database credentials and the application encryption key remain on the application host. Fresh permission checks follow revocation, closure and restore, with a 24-hour maximum lease during an actual app outage. A healthy app with an unreadable permission endpoint cannot authorize delivery. Push-service acceptance is separate from the operator's confirmation of the monitor's exact test.

Verification passed type/syntax checks, the production build, 190 local unit tests with three Linux-only skips, all 173 PostgreSQL integration tests and all 47 browser tests. All 30 watchdog tests passed on the selected Linux host using its separately locked 17-package dependency set. A temporary service proved that its own network access can be blocked without a system-wide firewall change. Source/build scans found no configured secrets or private phone-destination values. The existing installer's missing transitive Web Push dependency was corrected. Live installation, operator-confirmed test and both outage/recovery pairs are recorded in deployed acceptance. The follow-up installer guard rejects development health URLs before staging; its regression and all 31 Linux watchdog tests passed, along with 191 local unit tests and three Linux-only skips.

## Required home behavior

| Condition | Acceptance result |
| --- | --- |
| Solar surplus | House supplied first; battery can charge above 50% toward the separate 100% overall SOC target. Solar power follows native inverter and battery/BMS limits. |
| Solar deficit/night, SOC above 50% | Battery supports house consumption down to the 50% reserve. Grid can supply demand beyond available battery output. |
| SOC below 50%, insufficient solar | Grid top-up is available throughout the day, using the verified approximately 2 kW AC setting, and stops at 50%. |
| Mixed solar/grid | Solar has priority. Establish whether the AC setting limits total charging or the grid contribution before claiming an independent 2 kW grid cap. |
| Stop, failure or restart | Application intent pauses durably; possible scheduled permission is reconciled or visibly unresolved; no automatic rearming after an uncertain write. |

Stored measurements previously showed approximately 1.95 kW charging at 48%, then zero battery power at 50%, with scheduled AC permission off. Solar-surplus charging at exactly 50% was also observed. These are useful native-policy signals; they do not establish the above-50% behavior or exact mixed-source attribution. Prefer native inverter behavior when it already meets the requirement.

### Reserve-transition detector correction

Read-only inspection found a later native transition: 1,937 W and 1,931 W charging at 49% SOC (00:14:38 and 00:19:42 UTC, October 29), followed by zero battery power at 50% (00:24:44 and 00:29:47). Solar power was zero. The earlier detector required both stopped readings within 600 seconds of the last charging reading, so ordinary upload drift to 605 seconds incorrectly discarded its pending stop candidate.

The correction requires a recent charging approach to begin a stop candidate, then uses the existing continuous-sample rule for its second qualifying stopped reading. A gap, mixed solar, continued charging or departure from 50% still breaks the candidate. The existing per-gap time bound, physical limits, control permissions and provider polling rate are retained. A read-only replay of 55 retained measurements with the matching binding detected the transition. The persisted run is not rewritten or replayed automatically; already missed signals require a later qualifying transition. This is observational evidence and does not grant commissioning approval.

The drift regression failed against the previous detector and passed after the correction. Verification passed type/syntax checks, the production build, 164 local unit tests with three Linux-only skips, all 167 PostgreSQL integration tests and all 40 browser tests. The new database regression preserves a pending candidate across collector restart, proves repeat collection is idempotent and confirms no provider request or control activation. Source/build scanning found no configured secret values.

The subsequent [attended home check](deployment-acceptance.md#attended-home-check) exercised a real API top-up request at 50%, confirmed Stop and verified that an actual restart revokes the attended session. Host permission was restored to disabled and all nine checks passed afterward. This performed no inverter write and supplies no below-target charging or interrupted-write recovery approval.

## Firmware evidence increment

The commissioning page provides an EN/BG saved-device-evidence report before a run is prepared. It uses saved numeric settings, separate observed/saved firmware identities and timestamps, and explicitly unverified raw register words. Old reports retain missing-word labels rather than inferred values. An explicit settings check saves the raw words from existing reads without additional polling. Preview/copy/download never sends a provider request or support message. The report contains diagnostic evidence rather than manufacturer questions. Public reference provenance and contradictions are recorded in [firmware-evidence.md](firmware-evidence.md); the physical commissioning gates remain required.

Verification passed: type/syntax checks, production build, 162 local unit tests with three Linux-only skips, all 164 PostgreSQL integration tests and all 39 browser tests. The added browser cases cover saved/expired/malformed evidence, unavailable clipboard and recovery, UTF-8 download, privacy exclusions, profile specificity, EN/BG and a visually inspected 320 px layout. An initial integration assertion incorrectly expected raw words in Activity's filtered projection; the corrected test proves runtime status, durable settings and stored command evidence. The complete database rerun passed after that correction.

## Read-only delivery recovery

The transport now retries a valid function-3/4 read once after a correlated provider delivery error 530, with a one-second delay and a separate callback identity. Each attempt repeats pacing, quota reservation and authorization with its original purpose. Invalid/nonstandard frames, failed order correlation, other errors and writes are excluded. Client shutdown prevents a pending retry from dispatching; the existing snapshot and attendance deadlines remain enforced.

The connected tenant rehearsal injects one such failure during settings verification, then verifies all nine checks, seven accounted native attempts and zero writes. Unit regressions also cover late callbacks from the first attempt, exhausted retries, routine/recovery accounting, quota/authorization revocation, both shutdown timings and single/multiple-register writes. No polling cadence, configured charging limit or control permission is changed by this increment.

Verification passed type/syntax checks, production build, 176 local unit tests with three Linux-only skips, all 167 PostgreSQL integration tests and all 40 browser tests. The focused retry regression failed against the previous transport. Source/build scanning found no configured secret values. A disconnected test-database tunnel was re-established after confirming its listener was absent; the focused and complete database runs then passed.

## Native solar policy

The owner withdrew the application solar-power cap. Runtime status now identifies solar power limits as `native`; the old unverified-cap flag and permanently failing source-limit requirement are removed. Controls, Settings, observations and diagnostic exports explain the native inverter/battery limits and the 100% SOC target in English and Bulgarian. The 2 kW AC setting, 50% grid target and 50% reserve are unchanged. Existing observation bindings are retained because no physical setting or control mapping changed.

Approval still requires all four physical signals, a complete day/night cycle and verified scheduled-charge recovery. The database regression exercises simulated register writes through the real controller and journal, records observations, rejects incomplete recovery evidence and a wrong password, and proves that approval leaves controls disabled and automation paused. Activation and Resume remain explicit separate actions. Production approval and physical recovery evidence are not fabricated.

Verification passed type/syntax checks, the production build, 176 local unit tests with three Linux-only skips, all 168 PostgreSQL integration tests and all 41 browser tests. The focused commissioning regression failed against the previous permanent gate. The browser suite covers consistent EN/BG policy text across Controls, Settings and observations, diagnostic exports without outreach questions, missing evidence, clipboard recovery and the inspected 320 px Bulgarian layout. Source/build scanning found no configured secret values.

## Commissioning evidence selection

The commissioning checklist now distinguishes newly available observations from evidence explicitly saved by the owner. Its password-confirmed form offers the latest 20 eligible recovery commands by action and completion time, with links to their Activity details. Both listing and saving use the same tenant/account/inverter/run-scoped verification query. Failed commands, missing completion times, older commands and unverified disable writes do not qualify. A disappeared selection blocks saving until the owner selects another result or keeps the existing saved evidence. Approval still requires fresh settings, the complete saved checklist and a separate action.

The combined commissioning response supplies the current valid observation preview, replacing the page's separate observation polling. Missing, failed or mismatched observations are unavailable for saving. Previewing, choosing and language switching send no inverter command; password and selection drafts survive translation changes. No production evidence, recovery result or approval is fabricated.

Verification passed type/syntax checks, the production build, 176 local unit tests with three Linux-only skips, all 168 PostgreSQL integration tests and all 42 browser tests. The database regression failed against the previous response contract and now covers available-versus-saved evidence, failed collectors, mismatched bindings, tenant isolation, missing completion times, older commands and unverified recovery. The browser case covers explicit selection and saving, retained EN/BG drafts, stale selections, missing observations, disabled approval, no separate observation request and an inspected 320 px layout. Source/build scanning found no configured secret values.

## iPhone Web Push

The owner selected browser subscriptions instead of Telegram setup. Settings → Notifications now offers Home Screen installation guidance, explicit device permission, password-confirmed enrollment, a displayed-test receipt and per-device test/removal controls in English and Bulgarian. The existing durable notification queue supports multiple encrypted browser targets alongside the optional Telegram channel. Registration preserves request identity, rejects another account's endpoint, limits devices/churn and cancels only the changed target. A push-service acceptance alone cannot activate an unverified device. Expiry, changed VAPID keys, early receipts, late receipts and restore are handled explicitly.

The application uses `web-push` for standards-based encryption/signatures. One persistent key pair is stored in the private local/server environment without printing it. The service worker shows generic event text, opens same-origin read-only pages and never caches readings, pages or commands. Backup upgrades and new-schema restores include active/pending browser canaries, stale receipts and zero forbidden device/delivery calls. Schema 022 requires a compatible rollback target and quarantines notification intent before fallback.

No production browser permission or device receipt is fabricated, and deployment sends no notification. The owner completed Home Screen opt-in; the stored receipt at 09:27:54 UTC on October 29 proves display, and the channel is enabled. The independent watchdog now has a Web Push transport, a channel-bound permission lease and explicit operator confirmation of its own separate test; deployment and both live outage/recovery checks are recorded in deployed acceptance. Normal dashboard alerts do not require a Telegram bot or separate server.

Verification passed type/syntax checks, the production build, 184 local unit tests with three Linux-only skips, all 172 PostgreSQL integration tests and all 47 browser tests. New cases cover endpoint/curve validation, encrypted context binding, provider acceptance versus display, early/replayed/stale receipts, slot/churn limits, expiry renewal, lost browser responses, user gestures, cross-account isolation, per-target cancellation, archive secrecy and restore quarantine. The complete database run found an inconsistent decryption error contract; the corrected full rerun passed. The Bulgarian 320 px installation view was inspected. Source/build scanning found no configured secret values, including the new private push key.

## Attended recovery test

The normal top-up path deliberately avoids enabling a schedule at or above 50%, and leaves sufficient native charging alone below the reserve. It therefore cannot always exercise the actual enable/disable recovery path. The commissioning page now offers a separate explicit recovery test at SOC 52% or above, using fresh native preflight, the current password-confirmed attended session and existing host/workspace/dispatch guards.

The test changes only the scheduled-permission flag and verifies both transitions. Its `finally` path persists pause/cancellation and uses the normal recovery budget, journal and off readback. Existing windows, SOC targets and charging power settings remain unchanged. Stop, session expiry, suspension, old revisions, uncertain writes and a changed device binding retain the existing protections. A recovery test can be selected as evidence only after a verified enable precedes its verified disable within the same successful command; the other physical policy and day/night requirements remain separate.

The EN/BG page includes explicit per-test consent and a running-test notice. It does not label this temporary check as a normal top-up. The server continues to require fresh attendance before a physical test. No production inverter write has been performed while implementing this path.

Verification passed type/syntax checks, production build, 199 local unit tests with three Linux-only skips, all 178 PostgreSQL integration tests and all 47 browser tests. Focused cases exercise unchanged limits/windows, paired readbacks, ambiguous enable, Stop priority, suspended queued work, expired dispatch, native SOC preflight and unconfirmed cleanup. The browser case verifies the 52% boundary, separate consent, EN/BG draft retention and a visually reviewed 320 px layout. Its discovered checkbox sizing issue was corrected and verified with a focused rerun. Source/build scanning found no configured secret values.

## Startup session recovery

A native Chrome reload during a real restart exposed a temporary session-check failure that rendered the sign-in form despite the existing cookie remaining valid. The startup flow now distinguishes an unavailable check from a confirmed 401, offers a translated Retry action and retains account recovery access. Requests are cancelled on cleanup, and identity generations prevent a delayed response from replacing activation, expiry or completed recovery. A successful password reset also exits the failed-check state.

The new regression reproduced the previous behavior. Focused browser checks cover HTTP 503, transport failure, malformed responses, HTTP 401, successful password recovery with revoked cookies, delayed identity, language switching and a reviewed 320 px Bulgarian layout. Final checks passed: type/syntax, production build, 199 local unit tests with three Linux-only skips, all 178 PostgreSQL integration tests and all 50 browser tests. Source/build scanning found no configured secret values.

## Commissioning progress and pending conditions

The commissioning page now counts recorded, available and missing evidence separately. Selecting a verified recovery result only changes the preview; recorded progress advances after a successful evidence save. Each missing check explains the required physical conditions in English and Bulgarian. If observations become unavailable, a verified recovery result remains available for review while saving stays blocked. Saved results are not counted a second time as available evidence.

The observation progress bar previously used an inline element that did not match its fill styles, producing zero visible width even with a recorded signal. It now uses the existing styled fill and exposes its value to assistive technology. The browser regression reproduced the zero-width failure before the correction. The recovery-result type now includes the attended recovery action returned by the existing API. Verification passed type/syntax checks, production build, 200 local unit tests with three Linux-only skips and all 50 browser tests. The final short-label layout and available-versus-saved states also passed a focused 320 px rerun, and the seven translation checks passed again. The 178-test PostgreSQL integration pass belongs to the preceding release; this increment changes only frontend types, rendering, styles, tests and documentation. Source/build scanning found no configured secret values.

## Independent offsite retrieval

The operator audit found a real lost-host dependency: the trusted Mac had recovery metadata and the original age identity, but no independent offsite access credential; the normal drill retrieves encrypted objects through the application host. The operator-kit command adds a private, owner-key-encrypted bootstrap containing only the backup storage pair and recovery references. Verification reads exact S3 versions directly, authenticates every decrypt and checks the current erasure prefix, preserving the exported baseline. It performs no PostgreSQL restore, promotion or provider work; those remain separate acceptance steps. See [backups.md](backups.md#independent-operator-kit). Verification passed type/syntax checks, production build, 211 local unit tests with three Linux-only skips, all 178 PostgreSQL integration tests and all 11 focused recovery-kit cases. The rebuilt frontend tree is byte-for-byte unchanged, retaining its preceding 50-browser-test acceptance. New tests use fresh disposable SSH identities and actual age encryption with read-only S3 fixtures, including ciphertext/version substitution, missing or changed erasures, size bounds, permissions, overwrite refusal and diagnostic redaction. Live independent retrieval still requires the owner-encrypted kit and its direct-storage report.

## 1. Complete commissioning and activation

The commissioning lifecycle, attended-control path, dispatch gates, translated states, persistence/export and restore quarantine are implemented in the increment above. Physical acceptance remains separate.

Primary files: `src/control-readiness.mjs`, `src/tenant-runtime.mjs`, `src/control-journal.mjs`, `src/http-app.mjs`, `web/control-readiness.tsx`, `web/pages.tsx`, `web/policy-observations.tsx`.

- Refresh explicit verification when preparing an actual attended session; do not repeatedly renew an unused report.
- Solar charging follows native inverter and battery limits up to 100% SOC. The owner withdrew the application solar-power-cap requirement. Review or export saved diagnostics without vendor outreach; see [firmware-evidence.md](firmware-evidence.md).
- The owner requested minimal vendor interaction and cancelled the proposed firmware-clarification message before sending. Use existing documentation and collected evidence for further investigation; contact the manufacturer only for a case explicitly requested by the owner.
- Complete the physical checklist below through the implemented attended path, preserving readbacks and recovery evidence. Verify the operator can follow monitoring → verified settings → attended commissioning → approved policy → enabled but paused → resumed supervision.
- Retain the implemented separation between observations and permission. A passing settings report cannot replace physical acceptance and verified recovery.

**Exit:** valid settings alone cannot authorize unattended starts; an owner can follow the next required action; concurrent Stop, permission changes, restart and late responses cannot bypass approval or abandon cleanup.

## 2. Verify firmware capabilities and physical policy

Primary files: `src/controller.mjs`, `src/telemetry.mjs`, `src/supervision.mjs`, commissioning records; procedure: [controller.md](controller.md).

- Retain the verified 2 kW AC charging setting. Solar charging uses native inverter and battery/BMS limits; the application writes no solar power-limit register.
- Present native solar power limits explicitly, separately from the 100% SOC target. Do not derive a fixed power cap from variable battery voltage or unrelated BMS current telemetry.
- Keep the independent SOC settings intact: overall maximum 100%, grid target 50%, on-grid reserve 50%. Any new setting requires a named command with validated bounds, readback and the original value recorded.
- Use the existing observation run during daylight and above-reserve conditions. Complete attended cases for solar charging above 50%, discharge above 50%, below-reserve charging and stopping at 50%, then mixed sources and a full day/night cycle.
- Test Stop during pending work, delayed callbacks, lost responses, provider failure and restart. Simulate grid/battery faults, midnight/timezone changes and hard-to-produce failures in software; record which recovery outcomes were also demonstrated physically.
- If native behavior meets the policy, keep supervision as the default. Enable repeating daily charging windows only for a demonstrated gap; application request expiry does not physically expire an unreachable inverter's schedule.

**Exit:** each claimed behavior has device-bound physical evidence, no cleanup is unresolved, and the native solar policy is explicit. Exact grid-versus-solar charging attribution requires suitable measurements.

## 3. Deliver external alerts and outage detection

Primary files: `src/operations.mjs`, `src/account-hub.mjs`, `src/http-app.mjs`, `web/system-health.tsx`, plus notification storage/transport and settings UI.

- Encrypted browser subscriptions and the optional Telegram channel share the transactional outbox, bounded retries, uncertain outcomes, closure drain, secret-free export, retention and restore quarantine.
- The selected iPhone Home Screen subscription and displayed test passed on October 29. Telegram is optional; no bot/chat setup is needed for normal dashboard alerts. No recipient is inferred from login/provider emails.
- The watchdog is installed and enabled on `root@89.167.46.193`, with its own persistent state and confirmed iPhone test. Its live app-outage and reachability-loss pairs were accepted; preserve the distinction between provider acceptance and operator-confirmed display.
- Prove real incident and recovery delivery, a stopped-app failure and an unreachable-host failure. Preserve the distinction between local software fixtures and actual outside-host acceptance.

**Exit:** a selected destination receives a real test incident and recovery; restart/retry and ambiguous-response tests pass; independent outage detection works. No real message is sent until its channel and destination are selected.

## 4. Finish the hosted product and dashboard

- The [connected tenant rehearsal](tenant-rehearsal.md) exercises invitation → sign-in → provider link → discovery → monitoring → attended commissioning → blocked unattended activation → notifications → suspension/resumption → export → closure/erasure through real application HTTP and database records. Provider/hardware/delivery/receipt boundaries use fixtures; no approval is manufactured. The [deployed audit](deployment-acceptance.md) adds native Chrome signup, discovery, duplicate protection, translated screens and actual offsite-fenced removal. Complete the different-home browser journey and approved activation after the firmware and physical requirements pass.
- Confirm the licensed shared App-ID allowance before admitting more controlled homes. Current activation preview reserves 187,245 regular requests/year against 188,000 planned. Telemetry is five minutes; scheduled checks are 17 minutes and reserve-assessment eligibility is 32 minutes. Present these cloud response intervals accurately and preserve recovery capacity.
- Complete a desktop/mobile EN/BG journey audit across setup, controls, observations, analytics, Activity, health and account administration. Verify unavailable/stale/partial data, command rejection/uncertainty, focus behavior and translated validation errors.
- Keep energy estimates and coverage visible. Tariff/savings, forecasting and time-to-full features require their own validated inputs and acceptance criteria if added later.
- Replace initial test credentials before customer hosting and verify recovery-key custody and operator handover.

**Exit:** the tenant journey passes with disposable accounts; actual provider allowance supports admission; every visible action has a complete state and translated outcome.

The connected rehearsal increment passed its focused run and the complete 165-test PostgreSQL integration suite. Its CSV range covers a possible local-midnight boundary. Type/syntax checks and 162 local unit tests passed, with three Linux-only skips. That increment changed tests and documentation; the 39 browser cases were not repeated for that release.

The subsequent live-customer audit and archive/receipt-verifier changes passed type/syntax checks, the production build, 162 local unit tests with three Linux-only skips, all 166 PostgreSQL integration tests and all 40 browser tests. The new archive regression fails against the previous frontend and passes with byte verification. Focused tests also cover absent/mismatched erasure receipts, revoked access and receipt targets absent from a restored snapshot. The actual deployed audit, cleanup and retained pre-closure checkpoint are documented in [deployment-acceptance.md](deployment-acceptance.md).

## 5. Validate, release and observe

For each independently reviewable release:

1. Run focused regression tests, type/syntax checks, unit tests and production build. Run complete PostgreSQL integration and EN/BG browser suites when auth, persistence, runtime or shared UI contracts change. Integration and browser suites own the same test database and run sequentially.
2. Verify permission races, idempotency, restart, uncertain writes, Stop priority, tenant isolation and cleanup. Mock transport failures; successful software tests do not count as physical commissioning.
3. Review the diff and secrets, commit/push the exact release, install matching recovery tools before dependent application migrations, prove an older-backup upgrade and deploy only the Solarman PM2 process.
4. Verify running SHA, HTTPS, migration state, EN/BG desktop/mobile behavior and a fresh post-migration backup/isolated restore. Restored controls, commissioning approval and notifications must remain inactive, with zero device or external-delivery calls.
5. After commissioning and alerts pass, activate the home and observe at least a full day/night cycle containing the relevant reserve transitions. Review write frequency, alert behavior, coverage and recovery before declaring completion.

## Execution order and dependencies

The commissioning and notification software is implemented. The remaining critical path is **remaining physical observations → explicit evidence saving and approved activation → continued day/night observation**. Passive observations may continue while waiting for suitable SOC/daylight conditions.

The selected iPhone channel and independent monitoring host are installed and tested. Complete the remaining different-home journey, device confirmations and operator handover alongside physical commissioning. Confirm the provider entitlement before admitting another controlled home. Independent outage monitoring and operator handover must pass before unattended completion.

The software can be completed without manufacturing physical evidence. Daylight/SOC conditions, a chosen notification destination, an independent monitoring location and the real provider entitlement are explicit external dependencies. The full home requirement remains open until these are resolved.

## Verification record

The initial planning audit used type/syntax checks, 45 focused tests, authenticated native Chrome and read-only PostgreSQL inspection. Commissioning was subsequently implemented, tested and deployed with the old/fresh restore proofs described above.

The notification increment passed type/syntax checks, the production build, 139 local unit tests with one Linux-only skip, all 140 server-side unit tests, 163 PostgreSQL integration tests and all 36 EN/BG browser tests. Both old/fresh backup proofs passed. The browser audit also found an older analytics fixture that crossed local midnight while exporting only Today; its explicit date range now covers every seeded reading. The notification phone layout was visually inspected at 320 px; the source and built files passed a scan against configured local secret values.

The post-deployment read-only production audit found 21 migrations, host/workspace writes disabled, paused intent, no manual top-up, zero inverter-write intents, zero unresolved bindings and zero commissioning runs. There were zero notification channels, jobs or attempts. The continuing device-bound observation run had 22 accepted samples and no collector failure. Native Chrome rendered the Bulgarian notification page with empty credentials and no inferred destination; public HTTPS health reported the exact release with both worker heartbeats current. No inverter settings or permissions were changed during this increment.

## Earlier operational checkpoint, October 29

At this earlier checkpoint, application, root recovery tools and the independent monitor all ran code release `944c73bdfdf576a3515c9902911ef837bda4cdeb`. Production passed all 194 Linux unit tests and the standalone installer passed all 31 Linux watchdog tests; the unchanged application HTTP/browser contracts retain their 173 PostgreSQL and 47 browser passes. Fresh backup `7b94971c-c9f0-4d9a-ab92-d89f6a782832` passed isolated restore `6cc0cf5a-ec06-44bc-8e71-87571f71804d`, with all quarantines, one actual erasure receipt and zero device/delivery calls. No drill databases or roles remain.

The independent monitor is enabled, verified and healthy, with no pending deliveries. Its exact test was confirmed by the owner; four live incident messages were accepted by Apple. A separate encrypted operator copy of its configuration, journal and two acceptance reports was saved under `~/.local/share/solarman-backup/watchdog/` and verified by an exact decrypt round trip. Temporary plaintext exports, fault filters and automatic test-recovery timers were removed. Application controls remain paused, host/workspace writes disabled, with zero inverter-write intents or unresolved bindings.
