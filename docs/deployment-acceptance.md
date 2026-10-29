# Deployed customer acceptance

The native Chrome audit on 2026-10-29 exercised release `ada37e326f4abcd9ddb2d9dbab0f502259c10c62` at the public HTTPS domain. A new disposable customer used a separate incognito window; the existing administrator session and home binding were retained.

## Observed results

| Area | Live evidence |
| --- | --- |
| Invitation and activation | The administrator created a private invitation through the form. Switching the activation form to Bulgarian preserved both password fields. Signup created a member with a separate, empty workspace. |
| Isolation | The customer had no administrator link; the administrator endpoint returned 403. There were no customer readings, selected device or enabled controls. |
| Provider setup | The deployed form stored credentials and cleared the password field. Actual SOLARMAN discovery returned the owner's existing inverter. Credential fields were absent from the settings response. |
| Device ownership | Saving the existing home inverter in the temporary workspace was rejected with the translated duplicate-device message. The temporary workspace stayed unbound, paused and control-disabled. |
| Page rendering | Overview, analytics, controls, observations, commissioning, Activity, Settings, security, health, notifications and workspace data rendered in Bulgarian at measured widths of 1,440 px and 500 px, with no horizontal overflow or administrator link. Chrome enforced 500 px for the requested narrow window. Local browser tests separately cover 320 px. |
| Export response | The authenticated archive contained 3,326 bytes. Its SHA-256 completion checksum matched, the workspace ID matched the customer, readings/writes were zero and credential/session secret fields were absent. |
| Closure | The administrator requested closure through the selected customer's form. The original customer session returned 401. A fresh sign-in could view the ready closure state before authorization. |
| Permanent removal | The administrator authorized the disposable workspace's erasure through the confirmation and consent controls. The actual root publisher acknowledged its offsite receipt. Removal completed at 00:18:20 UTC; customer access returned 401. |
| Post-removal data | Customer users, provider account, controller state, measurements, jobs, writes and notification settings were absent. Three discovery requests remained in anonymous shared accounting. |
| Home protection | The home remained paused and control-disabled, with zero inverter-write intents and zero unresolved bindings. Its original observation run remained bound, with 48 accepted samples and no collector failure at the post-erasure audit. |
| Test cleanup | Temporary plaintext credentials were removed from browser memory, the administrator returned to commissioning, and only the owned incognito window was closed. |

The private invitation was not emailed and no Telegram destination was configured or contacted. The discovery check reused the owner's account to test ownership protection; it did not admit a second controlled home or establish a hosted-user licence.

## Export integrity correction

The audit found that the download page accepted a correctly shaped checksum without hashing the archive bytes. The regression reproduced a false success with an invalid checksum in the previous frontend.

The correction hashes the exact NDJSON bytes before its completion record with native SHA-256 before offering a download. Missing completion, a wrong checksum or changed UTF-8 content produces a translated verification failure. A verified archive can be retried successfully. The positive notice reports that verification is complete and directs the user to browser downloads; it does not assert that the operating system saved a file.

The native audit displayed the original handoff notice but did not observe a completed OS download. The authenticated response was independently verified in the browser. Actual native OS file-save completion remains unverified; local browser tests exercise successful download events and saved file contents.

## Recovery checkpoint

Backup `721725c4-5101-43f5-81dc-bfc2a15ff4b4` completed while the disposable customer was still active, before closure and authorization. The actual offsite receipt for its later removal supplies a real pre-erasure recovery case.

The recovery verifier now checks every supplied receipt against the isolated restored database, in addition to its existing authentication fixture. It verifies receipt identity/time, closing control state and revoked sessions/recovery credentials. Missing targets are safe; already removed targets must have no users, provider account or controller. Reports include `erasureReceiptsVerified` and `restoredErasureTargets` so the operator can distinguish absent targets from targets present in the backup. The matching operational capsule and local restore command are required.

Run the standard isolated drill with this checkpoint when verifying the live receipt:

```sh
node scripts/restore-drill.mjs 721725c4-5101-43f5-81dc-bfc2a15ff4b4
```

## Attended home check

On 2026-10-29 the owner confirmed attendance, created commissioning run `31b7c811-c77e-4f4f-a7e6-5b9a972ffe9c`, opened its session and enabled attended controls. The host write permission was enabled temporarily for this check; ordinary automation remained paused and unattended approval remained blocked.

| Check | Live result |
| --- | --- |
| Native access | Initial verification returned provider callback error 530 at 04:54:19 UTC. Diagnostics then succeeded at 04:56:35, and all nine verification checks passed at 04:57:36. The owner independently supplied a valid flags reply showing raw 9. The earlier delivery failure's cause remains undiagnosed. |
| At-target API top-up | Command `d0857a85-25da-486b-ba7d-e459695facd4` completed at 05:06:20. Fresh readings showed SOC 50%, PV 0 W, battery power 0 W and flags 9. No scheduled top-up was requested; the temporary manual intent cleared. The frontend's at-target top-up button was also disabled. |
| Stop | Command `607f1789-8fd5-49dc-945a-d895e57db248` completed at 05:07:13. Scheduled charging was confirmed off and cleanup was clear. |
| Restart | After restoring the original disabled host permission, an actual PM2 restart revoked the attended session at 05:09:39. Its durable event records `expired` with `restart: true`. Workspace control and manual top-up were disabled; automation stayed paused. |
| Final readback | Read-only verification `121b603d-67b7-4c7f-b3ab-ce5c50dd8027` passed all nine checks at 05:10:38 and resolved the restart's cleanup obligation by freshly observing permission off. The 2 kW AC setting, 50% grid target, 100% overall SOC and 50% reserve remained verified. |

There were **zero application inverter-write intents** throughout this attended check. It proves the live at-target API path, Stop observation and restart revocation with charging already off. It does not prove a below-50% charging write, interrupted-write recovery, above-reserve solar/discharge behavior, a full day/night cycle or exact source attribution during mixed charging. The recovery checklist still requires its actual verified disable-write evidence; this check does not manufacture it.

Pre-test offsite checkpoint: `dd4c5ee4-0c11-479f-9dda-dbbb654a73a7`. The application source remained release `7e09c1387c7f8f813e4e7588614d9870a6d9489d`; the test changed runtime state and restored host permission without modifying application code.

Post-test backup `db1f002e-d8f9-4794-984f-8f83922d01e1` passed isolated restore `b7bb71c4-3180-45d5-9456-9bcbb429f89f` at 05:14:53 UTC. Commissioning, observations, notifications and controls were quarantined; the actual erasure receipt was verified. There were zero device or notification calls, and independent inspection found zero remaining drill databases or roles.

## Remaining acceptance

The deployed audit proves onboarding, discovery, duplicate protection, translated screens and real closure/removal. Binding and monitoring a different customer's inverter, approved physical control, day/night operation, mixed-source behavior, actual alert delivery, outside-host outage detection, entitlement and operator recovery-key handover remain open in [finish-plan.md](finish-plan.md).
