# Solarman completion plan

Updated 2026-10-28, from source release `a843cbd8e3afa337b091ec4457002caab4f18a03` and read-only production inspection at 20:41–20:42 UTC (22:41–22:42 Europe/Sofia). This is the current finish plan; [dashboard-plan.md](dashboard-plan.md) retains the original requirements and historical implementation notes.

## What is actually locked

The quoted Bulgarian monitoring-only notice is an unused translation entry. The current Controls page already shows individual blockers, their responsible actor and next action. The selected `bluesun-bse20kh3` profile is supported for the observed protocol 2.02 / DSP 1.57 / HMI 1.45.

| Area | Verified state | Remaining work |
| --- | --- | --- |
| Native diagnostics | All nine checks passed at 20:21:25 UTC. Earlier successful checks include a process restart. The report expires at 20:51:25 UTC while control is inactive. | Refresh before activation; retain explicit failure/late-response states. Earlier 530/timeout causes remain undiagnosed. |
| Activation | Current blocker codes are `server` and `workspace`: host writes off and workspace control off. Automation is paused; manual top-up is off. | Implement commissioning permission and approval before exposing unattended activation. |
| Physical changes | Zero application inverter-write intents and zero unresolved bindings; scheduled permission is confirmed off. | Attended write/recovery tests have not been performed. |
| Policy observations | A real, device-bound run is collecting existing readings: three accepted samples, no collector failure, ten minutes of covered intervals. | Above-50% solar charging/discharging, the reserve transition and a full day/night cycle remain unproven. |
| Alerts | Operational monitor current; zero active incidents. Durable in-app incident history exists. | External delivery and an independent host-outage check are missing. |
| Hosted tenants | Isolation, private invitations, account security/recovery, suspension, export, retention and closure/erasure are implemented. Production has migrations 001–019. | Complete a disposable-tenant rehearsal including future commissioning and notifications. |
| Recovery | Backup healthy; last verified backup 20:23:16 UTC and isolated restore 20:24:11 UTC. Erasure-receipt service verified. | Maintain old/fresh-backup upgrade proofs for subsequent schema changes and a recurring recovery-drill procedure. |

**Baseline audit finding:** the inspected release gated starts on settings, firmware, clock, capacity and permissions without a physical-commissioning approval gate. Observation runs deliberately grant no control permission. The implementation below adds the missing gate; hardware acceptance and independent source-limit verification remain open.

## Commissioning implementation

The commissioning increment implements durable device-bound runs/events, current-password confirmation, optimistic revisions, a 30-minute attended session, explicit test-control/top-up actions, and approval checks at acceptance, capacity activation, intent persistence and inverter dispatch. Ordinary Resume stays blocked during attended testing. Session expiry, restart, connection/firmware/lifecycle changes, restore and deployment rollback revoke the applicable permission while retaining physical cleanup. Read-only observation snapshots and verified Stop evidence can be saved separately from approval.

The EN/BG commissioning page is linked from Controls. Preparation requires fresh settings checks but works with host writes off. Source-limit verification remains a blocking checklist item: neither measured low power nor a saved settings report supplies the missing firmware contract. No physical inverter write or unattended activation was performed while implementing this increment.

Software checks passed: type/syntax checks, production build, 129 local unit tests with one Linux-only skip, 143 PostgreSQL integration tests and all 33 browser tests. The browser case covers lost responses, explicit attendance, Stop during pending work, EN/BG and 320 px layout. Recovery tools add attended/approved canaries, quarantine and archive checks; matching old/fresh offsite restore proofs are required for release.

## Required home behavior

| Condition | Acceptance result |
| --- | --- |
| Solar surplus | House supplied first; battery can charge above 50% toward the separate 100% overall SOC target. Requested solar charging cap: 5 kW, subject to verified firmware support. |
| Solar deficit/night, SOC above 50% | Battery supports house consumption down to the 50% reserve. Grid can supply demand beyond available battery output. |
| SOC below 50%, insufficient solar | Grid top-up is available throughout the day, using the verified approximately 2 kW AC setting, and stops at 50%. |
| Mixed solar/grid | Solar has priority. Establish whether the AC setting limits total charging or the grid contribution before claiming an independent 2 kW grid cap. |
| Stop, failure or restart | Application intent pauses durably; possible scheduled permission is reconciled or visibly unresolved; no automatic rearming after an uncertain write. |

Stored measurements previously showed approximately 1.95 kW charging at 48%, then zero battery power at 50%, with scheduled AC permission off. Solar-surplus charging at exactly 50% was also observed. These are useful native-policy signals; they do not establish the above-50% behavior or independent source limits. Prefer native inverter behavior when it already meets the requirement.

## 1. Complete commissioning and activation

Software implemented in the commissioning increment above; physical acceptance and release proofs remain separate.

Primary files: `src/control-readiness.mjs`, `src/tenant-runtime.mjs`, `src/control-journal.mjs`, `src/http-app.mjs`, `web/control-readiness.tsx`, `web/pages.tsx`, `web/policy-observations.tsx`.

- Add durable commissioning runs and steps, bound to tenant, account, inverter, model, firmware, timezone, mapping and policy revision. Record baseline settings, initiating user, command IDs, readbacks, observations and result separately.
- Make the lifecycle explicit: monitoring → verified settings → attended commissioning → approved policy → workspace enabled but paused → resumed supervision.
- Provide a restricted attended-test path using the existing journal, queue, cancellation and allowlist. It must not start the unattended scheduler. Recheck permission and binding immediately before every dispatch; interrupted tests remain paused with cleanup retained.
- Require current commissioning approval for ordinary Resume and top-up actions. Enforce this in the backend and at dispatch, including stale browsers and queued jobs. A firmware/account/device/timezone/mapping/policy change invalidates approval. Unavailable current identity blocks starts without relabeling historical evidence as a confirmed identity change.
- Preserve read-only diagnostics and Stop when starts are blocked. Label Stop accurately: it cancels app top-ups and clears scheduled AC permission; native reserve charging can continue.
- Show monitoring freshness, settings verification, physical evidence and activation as distinct states. Preserve the observed/received timestamps and report expiry. Finish EN/BG loading, error, unknown-outcome and phone layouts; remove the obsolete notice after confirming all consumers.
- Include the new records in tenant export, retention, erasure and restore quarantine. Restore must invalidate approval and keep all restored control paused.

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

- Implement one tenant-configured private channel first, with encrypted credentials, a verified destination and an explicit test. Channel selection remains open; no recipient is inferred from login/provider emails.
- Add a transactional notification outbox tied to incident opening, escalation and recovery. Preserve pending work across restarts, deduplicate incident revisions and bound retries. Show pending, confirmed, rejected and unconfirmed outcomes honestly.
- Cover stale/offline readings, repeated native failures, authentication/control faults, unresolved cleanup and API exhaustion. Backup, recovery and erasure-service alerts are administrator-scoped.
- Cancel future delivery when a destination changes or a workspace closes; drain in-flight work before erasure. Export metadata without secrets, prune terminal history safely and disable all delivery on restore.
- Place the reachability and `/healthz` check outside the application host. Prove that it detects a stopped app and an unreachable host, and reports recovery without depending on that same process.

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

Start with **commissioning/activation**, while continuing passive observations. Implement **notification delivery** while waiting for daylight, SOC transitions or manufacturer evidence. Complete **firmware mapping and attended physical acceptance**, then **unattended observation and the hosted-tenant rehearsal**. Independent outage monitoring must be in place before unattended handover.

The software can be completed without manufacturing physical evidence. Daylight/SOC conditions, the independent 5 kW mapping, a chosen notification destination, an independent monitoring location and the real provider entitlement are explicit external dependencies. The full home requirement remains open until these are resolved.

## Checks performed for this planning update

- `npm run check`: passed.
- Focused control-readiness, controller, supervision, policy-observation and translation tests: 45 passed.
- Native Chrome authenticated GET inspection and read-only PostgreSQL audit: current release, 19 migrations, two activation blockers, no application inverter writes or unresolved bindings, healthy backup and verified receipt service.
- No source behavior, inverter settings, permissions, migrations or production processes changed. Integration/browser suites were not rerun for this documentation-only update.
