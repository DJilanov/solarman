# Prepare for an outage

Home → **Prepare for an outage** opens the reserve panel. Choose 50–100%, review, and confirm. The saved setting persists until **Return to normal**, across midnight, reaching the target, and application restarts. The selected percentage is the grid-charging target, not a live SOC reading. Native solar charging can continue to 100%; all stored energy is held while grid is present.

Grid charging retains the verified 2 kW setting. Native backup mode supplies the wired EPS circuit when grid is absent, within existing battery protection limits. This feature cannot change which circuits are wired to EPS or guarantee an outage duration.

## Installed-firmware verification

The manufacturer-authored [BSE-family manual, printed page 11](https://saftronics.co.za/wp-content/uploads/2022/09/EU-standard-BSE-series-3-phases-user-manual.pdf) describes backup mode holding the battery on grid and supplying EPS off grid. Both the Bluesun BSE and related Afore register workbooks map holding 2500 mode 3 to Maintain/backup. These are candidate family-level evidence; the installed protocol 2.02 / DSP 1.57 / HMI 1.45 must pass an attended test before everyday activation is available.

After the existing guided verification and attended controls are open, choose a target slightly above current SOC, with negligible PV, and start **Review supervised test**. The app records native grid-charging evidence below target and two distinct samples at least 30 seconds apart showing charging stopped at target while the house imports power. Return to normal, verify restoration, then approve with the current dashboard password. Ordinary activation also retains the existing home commissioning approval requirement. Merely acknowledging register writes never approves physical behavior. Off-grid battery discharge is recorded separately; a power-cut test has not been implied by on-grid evidence.

Attended tests attempt restoration on session expiry or interrupted restart. Restoration still needs host write permission, account access, API capacity, original firmware and a live grid. Actual persistent holds have no automatic expiry. A missing/cloud-stale reading does not undo a verified hold. No new hold is activated by deploying this feature.

## Native settings and recovery

The paused normal baseline must be verified: flags 9, SelfUse mode 0, AC ratio 100 (2 kW on the verified 20 kW model), AC target 500 (50%), overall SOC ceiling 1000 (100%), and on-grid reserve 500 (50%). Existing disabled charging windows are captured exactly.

Apply writes mode 3, AC target X×10, the known 00:01–23:59 full-day charging window, and flags 25. The native clock boundary leaves a short midnight charging gap; backup mode still holds the battery. Each write has durable intent, dispatch authorization, acknowledgement and readback. The solar ceiling, charge-power ratio, battery minimum, on-grid reserve and protection settings are not changed.

Return to normal disables scheduled charging, restores the saved windows and AC target, then restores SelfUse last. Fresh reads refuse conflicting outside changes; uncertain writes are read back and restored rather than replayed. The original uncertain audit entry remains uncertain with a separate reconciliation time. Normal app automation stays paused after restoration; native SelfUse resumes using battery energy according to its existing reserve.

An active preparation blocks device/profile/timezone changes and competing ordinary controls. Credential repair remains available. Suspension, database restore and rollback quarantine outage state and revoke saved approvals. Quarantined state never automatically activates or restores an inverter; an explicit restoration remains available for the original device. Account erasure waits for full restoration, and account exports include the preparation and write journal. Approved test evidence is retained until account erasure; other completed history follows the workspace retention policy.

The target selector shows a preview ring and matching slider colour as the chosen percentage changes. A white marker identifies the most recent fresh battery level; stale readings are labelled and have no marker. Presets, keyboard arrows and one-point tap controls change only the preview. The review step summarizes the grid target, 100% solar ceiling and reserve duration before confirmation. The optional duration calculator sits below the primary control. Reduced-motion preferences disable decorative transitions. The restored-state message follows the current automation pause state.
