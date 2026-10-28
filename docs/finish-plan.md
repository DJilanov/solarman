# Solarman completion plan

Updated 2026-10-29. Commissioning, tenant notifications and the independent-watchdog implementation are deployed through release `af876fbde39dc2fd29ad55755cc8aae87a3536cb`. The watchdog still needs its own server and selected recipient. This is the current finish plan; [dashboard-plan.md](dashboard-plan.md) retains the original requirements and historical implementation notes.

## What is actually locked

The quoted Bulgarian monitoring-only notice is an unused translation entry. The current Controls page already shows individual blockers, their responsible actor and next action. The selected `bluesun-bse20kh3` profile is supported for the observed protocol 2.02 / DSP 1.57 / HMI 1.45.

| Area | Verified state | Remaining work |
| --- | --- | --- |
| Native diagnostics | All nine checks passed at 21:14:30 UTC on October 28 after the commissioning deployment. Reports expire after 30 minutes while control is inactive. | Refresh before activation; retain explicit failure/late-response states. Earlier 530/timeout causes remain undiagnosed. |
| Activation | Host writes and workspace control are off. Automation is paused; manual top-up is off. Device-bound commissioning is also required. | Commissioning software is deployed; physical acceptance and the independent source-limit contract remain open. |
| Physical changes | Zero application inverter-write intents and zero unresolved bindings; scheduled permission is confirmed off. | Attended write/recovery tests have not been performed. |
| Policy observations | A real, device-bound run had 36 accepted samples and no collector failure at 23:24 UTC on October 28, surviving the commissioning and notification deployments. | Above-50% solar charging/discharging, the reserve transition and a full day/night cycle remain unproven. |
| Alerts | Durable in-app incidents and tenant-configured Telegram delivery are deployed. The independent watchdog implementation adds fresh health challenges, TCP context, durable retries and restore quarantine. | Select a real destination, provide an accessible separate monitoring host and prove outage/recovery delivery. |
| Hosted tenants | Isolation, private invitations, account security/recovery, suspension, export, retention and closure/erasure are implemented. Production has migrations 001–021. | Complete a disposable-tenant rehearsal including commissioning and notifications. |
| Recovery | Notification release passed both schema-020 upgrade and fresh schema-021 restores, with zero device or delivery calls. Backup healthy; erasure-receipt service verified. | Maintain recurring recovery drills and perform an actual operator handover. |

**Baseline audit finding:** the inspected release gated starts on settings, firmware, clock, capacity and permissions without a physical-commissioning approval gate. Observation runs deliberately grant no control permission. The implementation below adds the missing gate; hardware acceptance and independent source-limit verification remain open.

## Commissioning implementation

The commissioning increment implements durable device-bound runs/events, current-password confirmation, optimistic revisions, a 30-minute attended session, explicit test-control/top-up actions, and approval checks at acceptance, capacity activation, intent persistence and inverter dispatch. Ordinary Resume stays blocked during attended testing. Session expiry, restart, connection/firmware/lifecycle changes, restore and deployment rollback revoke the applicable permission while retaining physical cleanup. Read-only observation snapshots and verified Stop evidence can be saved separately from approval.

The EN/BG commissioning page is linked from Controls. Preparation requires fresh settings checks but works with host writes off. Source-limit verification remains a blocking checklist item: neither measured low power nor a saved settings report supplies the missing firmware contract. No physical inverter write or unattended activation was performed while implementing this increment.

Commissioning checks passed: type/syntax checks, production build, 129 local unit tests with one Linux-only skip, 143 PostgreSQL integration tests and all 33 browser tests. The browser case covers lost responses, explicit attendance, Stop during pending work, EN/BG and 320 px layout. Both old/fresh offsite restore proofs passed, including attended/approved canaries, quarantine and archive checks. No production commissioning session or approval has been fabricated.

## Notification implementation

The notification increment adds an encrypted Telegram destination per tenant, password-confirmed save/test/enable/disable actions, optimistic revisions, transactional incident capture and durable delivery attempts. Retries retain ambiguity and one event reference, respect rate limits and stop at four attempts or 24 hours. Rejection disables the affected channel. Closure drains in-flight delivery; export excludes tokens; retention preserves pending work; restore quarantines every destination and proves zero external calls. The EN/BG page includes initial failures, empty state, configuration conflicts, uncertain responses, pagination and phone layouts. See [notifications.md](notifications.md) for setup and operational limits.

This implements the delivery software, not real-destination acceptance or independent outage detection. No production bot/chat has been configured and no real external message has been sent.

Release `52127f0` passed an isolated upgrade of schema-020 backup `71b33aa1-e668-4673-8056-09d85e886e89` in restore run `8e7fb8df-78cb-4a73-b416-a879782ab935` (22:12 UTC, October 28). Fresh schema-021 backup `58ec89f8-a002-48b0-9e02-6260e5b63291` passed restore run `6b0800bf-a328-4d54-841e-31e5259f1491` (22:13 UTC). Both verified notification/commissioning quarantine, authentication, export, lifecycle and erasure fences, with zero device or delivery calls. Independent PostgreSQL inspection found no remaining drill databases or roles.

## Independent watchdog implementation

The watchdog has a separate filesystem journal and a Linux systemd timer, without app/database/provider credentials. Fresh random challenges reject cached health successes; direct TCP checks add context without declaring a host dead. Three consecutive failures open an incident and two fresh successes recover it. Messages keep durable attempt history, bounded retries and one event reference. File locks serialize invocations; termination drains transport; restores require quarantine and a fresh disabled/tested/enabled sequence. See [watchdog.md](watchdog.md) for installation and operator commands.

Available keys currently authenticate only to the application host; the other configured SSH host rejected authentication. An asynchronous request for a separate always-on SSH target is pending. No independent service or real recipient has been installed, and no real message has been sent. Local proxy/socket fixtures and injected timeouts prove software behavior; real outside-host outage/recovery acceptance remains open.

Verification passed: type/syntax checks, production build, 161 local unit tests with three Linux-only skips, all 24 focused watchdog tests on Linux, all 164 PostgreSQL integration tests and all 36 browser tests. The installer passed Bash syntax validation; its generated service/timer passed `systemd-analyze verify` in a temporary directory without installing either unit. Source and build artifacts passed a scan against configured local secret values. No database migration or inverter setting is changed by this increment.

## Required home behavior

| Condition | Acceptance result |
| --- | --- |
| Solar surplus | House supplied first; battery can charge above 50% toward the separate 100% overall SOC target. Requested solar charging cap: 5 kW, subject to verified firmware support. |
| Solar deficit/night, SOC above 50% | Battery supports house consumption down to the 50% reserve. Grid can supply demand beyond available battery output. |
| SOC below 50%, insufficient solar | Grid top-up is available throughout the day, using the verified approximately 2 kW AC setting, and stops at 50%. |
| Mixed solar/grid | Solar has priority. Establish whether the AC setting limits total charging or the grid contribution before claiming an independent 2 kW grid cap. |
| Stop, failure or restart | Application intent pauses durably; possible scheduled permission is reconciled or visibly unresolved; no automatic rearming after an uncertain write. |

Stored measurements previously showed approximately 1.95 kW charging at 48%, then zero battery power at 50%, with scheduled AC permission off. Solar-surplus charging at exactly 50% was also observed. These are useful native-policy signals; they do not establish the above-50% behavior or independent source limits. Prefer native inverter behavior when it already meets the requirement.

## Firmware evidence increment

The commissioning page now provides an EN/BG firmware clarification request before a run is prepared. It uses saved numeric settings, separate observed/saved firmware identities and timestamps, and explicitly unverified raw register words. Old reports retain missing-word labels rather than inferred values. An explicit settings check saves the raw words from existing reads without additional polling. Preview/copy/download never sends a provider request or support message. Public reference provenance and contradictions are recorded in [firmware-evidence.md](firmware-evidence.md); the independent source-limit and commissioning gates remain unchanged.

Verification passed: type/syntax checks, production build, 162 local unit tests with three Linux-only skips, all 164 PostgreSQL integration tests and all 39 browser tests. The added browser cases cover saved/expired/malformed evidence, unavailable clipboard and recovery, UTF-8 download, privacy exclusions, profile specificity, EN/BG and a visually inspected 320 px layout. An initial integration assertion incorrectly expected raw words in Activity's filtered projection; the corrected test proves runtime status, durable settings and stored command evidence. The complete database rerun passed after that correction.

## 1. Complete commissioning and activation

The commissioning lifecycle, attended-control path, dispatch gates, translated states, persistence/export and restore quarantine are implemented in the increment above. Physical acceptance remains separate.

Primary files: `src/control-readiness.mjs`, `src/tenant-runtime.mjs`, `src/control-journal.mjs`, `src/http-app.mjs`, `web/control-readiness.tsx`, `web/pages.tsx`, `web/policy-observations.tsx`.

- Refresh explicit verification when preparing an actual attended session; do not repeatedly renew an unused report.
- Resolve the independent source-limit contract before claiming full-policy approval. The pre-commissioning support report now makes that next action available without host writes or a prepared run; see [firmware-evidence.md](firmware-evidence.md).
- Complete the physical checklist below through the implemented attended path, preserving readbacks and recovery evidence. Verify the operator can follow monitoring → verified settings → attended commissioning → approved policy → enabled but paused → resumed supervision.
- Retain the implemented separation between observations and permission. A passing report or observed low charging power cannot replace physical acceptance or the missing source-limit contract.

**Exit:** valid settings alone cannot authorize unattended starts; an owner can follow the next required action; concurrent Stop, permission changes, restart and late responses cannot bypass approval or abandon cleanup.

## 2. Verify firmware capabilities and physical policy

Primary files: `src/controller.mjs`, `src/telemetry.mjs`, `src/supervision.mjs`, commissioning records; procedure: [controller.md](controller.md).

- Obtain the exact firmware register contract for a separate solar charging cap: address, units, range, battery-side meaning, readback and reversal. The observed raw 100 at registers 3022–3023 is insufficient evidence. The [manufacturer datasheet](https://www.bluesunpv.com/wp-content/uploads/2024/12/BSE20-30KH3_v2406-Rev-01_EN.pdf) describes ratings without providing that firmware register contract.
- Represent verified capabilities explicitly. Display the requested 5 kW cap as unverified until demonstrated; avoid deriving a fixed power cap from variable battery voltage or unrelated BMS current telemetry.
- Keep the independent SOC settings intact: overall maximum 100%, grid target 50%, on-grid reserve 50%. Any new setting requires a named command with validated bounds, readback and the original value recorded.
- Use the existing observation run during daylight and above-reserve conditions. Complete attended cases for solar charging above 50%, discharge above 50%, below-reserve charging and stopping at 50%, then mixed sources and a full day/night cycle.
- Test Stop during pending work, delayed callbacks, lost responses, provider failure and restart. Simulate grid/battery faults, midnight/timezone changes and hard-to-produce failures in software; record which recovery outcomes were also demonstrated physically.
- If native behavior meets the policy, keep supervision as the default. Enable repeating daily charging windows only for a demonstrated gap; application request expiry does not physically expire an unreachable inverter's schedule.

**Exit:** each claimed behavior has device-bound physical evidence, no cleanup is unresolved, and the solar cap is verified or its limitation has an explicit agreed scope decision. Exact grid-versus-solar charging attribution requires suitable measurements.

## 3. Deliver external alerts and outage detection

Primary files: `src/operations.mjs`, `src/account-hub.mjs`, `src/http-app.mjs`, `web/system-health.tsx`, plus notification storage/transport and settings UI.

- The encrypted Telegram channel, transactional incident outbox, bounded retries, uncertain outcomes, closure drain, secret-free export, retention and restore quarantine are implemented and tested.
- Select a real bot/chat destination, then perform its explicit test and enable sequence. No recipient is inferred from login/provider emails.
- Install the implemented watchdog on an accessible separate, always-on host. Its SSH target is still missing; the application server cannot prove detection of its own complete outage.
- Prove real incident and recovery delivery, a stopped-app failure and an unreachable-host failure. Preserve the distinction between local software fixtures and actual outside-host acceptance.

**Exit:** a selected destination receives a real test incident and recovery; restart/retry and ambiguous-response tests pass; independent outage detection works. No real message is sent until its channel and destination are selected.

## 4. Finish the hosted product and dashboard

- Rehearse a disposable tenant through invitation → sign-in → provider link → discovery → monitoring → commissioning → activation → suspension/resumption → export → closure/erasure. Verify access isolation at every step; use fixtures for physical commands.
- Confirm the licensed shared App-ID allowance before admitting more controlled homes. Current activation preview reserves 187,245 regular requests/year against 188,000 planned. Telemetry is five minutes; scheduled checks are 17 minutes and reserve-assessment eligibility is 32 minutes. Present these cloud response intervals accurately and preserve recovery capacity.
- Complete a desktop/mobile EN/BG journey audit across setup, controls, observations, analytics, Activity, health and account administration. Verify unavailable/stale/partial data, command rejection/uncertainty, focus behavior and translated validation errors.
- Keep energy estimates and coverage visible. Tariff/savings, forecasting and time-to-full features require their own validated inputs and acceptance criteria if added later.
- Replace initial test credentials before customer hosting and verify recovery-key custody and operator handover.

**Exit:** the tenant journey passes with disposable accounts; actual provider allowance supports admission; every visible action has a complete state and translated outcome.

## 5. Validate, release and observe

For each independently reviewable release:

1. Run focused regression tests, type/syntax checks, unit tests and production build. Run complete PostgreSQL integration and EN/BG browser suites when auth, persistence, runtime or shared UI contracts change. Integration and browser suites own the same test database and run sequentially.
2. Verify permission races, idempotency, restart, uncertain writes, Stop priority, tenant isolation and cleanup. Mock transport failures; successful software tests do not count as physical commissioning.
3. Review the diff and secrets, commit/push the exact release, install matching recovery tools before dependent application migrations, prove an older-backup upgrade and deploy only the Solarman PM2 process.
4. Verify running SHA, HTTPS, migration state, EN/BG desktop/mobile behavior and a fresh post-migration backup/isolated restore. Restored controls, commissioning approval and notifications must remain inactive, with zero device or external-delivery calls.
5. After commissioning and alerts pass, activate the home and observe at least a full day/night cycle containing the relevant reserve transitions. Review write frequency, alert behavior, coverage and recovery before declaring completion.

## Execution order and dependencies

The commissioning and notification software is implemented. The remaining critical path is **exact firmware clarification → supported source-limit implementation, if required → attended physical acceptance → approved activation → full day/night observation**. Passive observations may continue while waiting for firmware evidence or suitable SOC/daylight conditions.

In parallel, select a notification destination and independent monitoring host, install/test the watchdog, and complete the disposable-tenant journey and EN/BG audit. Confirm the provider entitlement before admitting another controlled home. Independent outage monitoring and operator handover must pass before unattended completion.

The software can be completed without manufacturing physical evidence. Daylight/SOC conditions, the independent 5 kW mapping, a chosen notification destination, an independent monitoring location and the real provider entitlement are explicit external dependencies. The full home requirement remains open until these are resolved.

## Verification record

The initial planning audit used type/syntax checks, 45 focused tests, authenticated native Chrome and read-only PostgreSQL inspection. Commissioning was subsequently implemented, tested and deployed with the old/fresh restore proofs described above.

The notification increment passed type/syntax checks, the production build, 139 local unit tests with one Linux-only skip, all 140 server-side unit tests, 163 PostgreSQL integration tests and all 36 EN/BG browser tests. Both old/fresh backup proofs passed. The browser audit also found an older analytics fixture that crossed local midnight while exporting only Today; its explicit date range now covers every seeded reading. The notification phone layout was visually inspected at 320 px; the source and built files passed a scan against configured local secret values.

The post-deployment read-only production audit found 21 migrations, host/workspace writes disabled, paused intent, no manual top-up, zero inverter-write intents, zero unresolved bindings and zero commissioning runs. There were zero notification channels, jobs or attempts. The continuing device-bound observation run had 22 accepted samples and no collector failure. Native Chrome rendered the Bulgarian notification page with empty credentials and no inferred destination; public HTTPS health reported the exact release with both worker heartbeats current. No inverter settings or permissions were changed during this increment.
