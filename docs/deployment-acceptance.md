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

## Remaining acceptance

The deployed audit proves onboarding, discovery, duplicate protection, translated screens and real closure/removal. Binding and monitoring a different customer's inverter, approved physical control, day/night operation, independent source-power limits, actual alert delivery, outside-host outage detection, entitlement and operator recovery-key handover remain open in [finish-plan.md](finish-plan.md).
