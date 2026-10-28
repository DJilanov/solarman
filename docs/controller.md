# Bluesun controller and commissioning

The supported profile is the Bluesun **BSE20KH3**, 20 kW, protocol 2.02, main DSP 1.57 / HMI 1.45, diagnosed through manually supplied SOLARMAN Customized Command replies. A write acknowledgment alone does not confirm a setting; every software write is read back.

## Required settings

| Holding register | Required value |
|---|---|
| 206–207 | 32-bit flags 0x00000009 normally; 0x00000019 during timed AC charging |
| 2500 | SelfUse, raw 0 |
| 2504 | AC charging ratio raw 100, 10% of 20 kW (approximately 2 kW) |
| 2505 | AC target raw 500, 50% |
| 3005 | Overall maximum SOC raw 1000, 100% |
| 3036 | On-grid reserve raw 500, 50% |

Monitoring can display plausible native readings with different control settings, but hardware controls remain blocked. The controller never silently corrects these settings. It never writes the global SOC target, current limit, BMS protections or off-grid reserve.

The requested 5 kW solar power cap is **not configured**: registers 3022–3023 returned raw 100, inconsistent with interpreting the generic protocol's watt scaling as the effective limit. The AC setting is not a separately verified grid-contribution limit during mixed PV/grid charging.

## Runtime behavior

Monitoring uses one provider telemetry request every five minutes for a single workspace, projecting to 105,120 regular requests/year. Shared App IDs receive slower monitoring intervals to preserve aggregate capacity, with a 5% planning margin. Native diagnostics read flags, AC configuration, battery registers 2000–2008, flow registers 507–554 and policy registers 3005–3036. The active control path also checks fresh provider metadata and clock, making six regular requests per control cycle. At 15 minutes, continuous active control projects to 210,240 requests/year before authentication, transitions and recovery. State-driven control must be completed before unattended activation under a 200,000-request allowance. PostgreSQL reservations enforce shared usage before HTTP dispatch; routine requests cannot consume the default 2,000-call recovery reserve. Stop, cleanup authentication and readback use recovery capacity. A quota failure pauses active intent and attempts cleanup once, with retries only while cleanup remains unconfirmed.

The service requests a bounded daily charging window (normally 25 minutes), verifies it, then permits AC charging below 50% when grid voltage and battery state permit it. Solar surplus above 1.8 kW prevents a new top-up; 2 kW stops an existing one. The inverter's native 50% AC target stops charging independently of the next scheduler poll. AC permission is removed at or above 50%, restoring normal battery use above the reserve. Short windows are renewed only while charging is needed.

These windows are **daily schedules, not an expiring watchdog**. Process failure, a network outage or an unreachable API can prevent cleanup; the last window may repeat on later days until AC charging is disabled. The midnight minute is excluded; a window crossing midnight uses two intervals. The inverter clock/timezone must match the linked account. Native inverter and BMS protections remain responsible for battery safety.

On errors and graceful shutdown, live mode attempts to remove timed AC permission while preserving all other flags. An API outage can prevent confirmation. Paused monitoring retries an unconfirmed stop before fetching telemetry; starting remains blocked until cleanup succeeds. An armed runtime also reconciles scheduled permission once after restarting. Ambiguous submissions are not automatically retried as though nothing happened.

## Durable recovery

`device_control_state` retains ownership of possible scheduled permission for each tenant/account/inverter binding. `inverter_write_intents` stores the requested register values and originating command job before dispatch, followed by separate acknowledgment and readback timestamps. The write guard checks the current database activation, pause intent and discovered device immediately before preparing a change. A stop arriving during an in-flight write keeps cleanup pending even when that write's late readback succeeds. Unknown outcomes are retained until reconciliation and are never relabeled as verified original writes.

On restart, owned permission becomes cleanup-required before evaluation. A successful off read/modify/write and readback, or a fresh diagnostic flags read showing permission off, confirms its observed state and resolves the cleanup obligation. The original uncertain write remains marked uncertain, with a separate reconciliation timestamp. This is a point-in-time observation, not proof that a delayed vendor command can never arrive later; interruption and late-command behavior still require physical commissioning.

Credential repair preserves the original cleanup target while pausing and revoking normal control. Once discovery with the new credentials confirms ownership of that same inverter, recovery can remove scheduled permission under the existing host permission without rearming the workspace. Normal starts remain disabled until fresh verification and activation. Changing the selected inverter, compatibility profile or timezone cannot abandon an unresolved binding. Host write permission, valid account access and the recovery API budget remain necessary for physical changes.

Controls displays the five latest write records with intent, acknowledgment, readback and reconciliation times. In-flight writes display a waiting state; an interrupted or failed write displays an unknown outcome until its cleanup is observed. The full journal remains in PostgreSQL and is linked to each command's audit ID.

## Commissioning

1. Obtain App ID / App Secret and custom-command permission, with a licence appropriate for hosted users.
2. Verify the public HTTPS callback reaches the correct linked account. Callbacks correlate the random command URL, device, original request, timestamps, optional order ID and Modbus CRC/function/count.
3. Test account discovery and bind the actual inverter to the correct workspace and timezone.
4. Keep `WRITES_ENABLED=false`; use Refresh readings and confirm signs, values and the combined register ranges on the actual firmware.
5. In Controls, run **Verify device settings** while automation is paused. This reads input 7–8, the existing diagnostics and provider metadata, checks 20,000 W rating, six policy settings and the reported inverter clock, and persists eight results. The clock must match the workspace timezone within two minutes of the logger collection time. This operation never enables writes. A failed verification invalidates the previous report before device requests begin.
6. Confirm charging-window timing and physical behavior. Enable host writes, restart only the dashboard, then use **Enable workspace control** after a successful verification within 30 minutes. This does not resume automation or enable any other workspace. Confirm a below-50% top-up, native stopping at 50%, AC permission removal, house supply from battery above 50%, and solar charging above 50% before unattended operation.

Real OpenAPI discovery, HTTPS callbacks, combined diagnostic register reads and the 20 kW rated-power register have been verified. Physical write commissioning and the separate solar charging limit remain outstanding. Reported clock comparison is now part of preflight and monitoring. Recorded production measurements show battery charging while timed AC permission is off: this flag is not proof that every native grid charging mechanism has stopped.

Observed native behavior on 2026-10-28: at 10:15 UTC, SOC was 48% and battery charging was 1,947 W with scheduled AC permission off. At 10:31 and 10:34 UTC, SOC was 50% and battery power was 0 W, with house demand supplied by solar and grid. No application writes were enabled. This supports native reserve charging and stopping at 50% for those observations; it does not yet establish solar charging or house supply from the battery above 50%.

Workspace control is stored separately from the host permission in `controller_state.control_enabled`; new workspaces default to disabled. Device verification is bound to the selected serial number and profile. Credential updates and inverter selection revoke the old verification and activation. Stop/Pause records its intent before waiting for device work, cancels older queued starts and allows cleanup even after a settings verification error. The six-hour expiry of a manual request bounds application intent, not the daily schedule stored inside an unreachable inverter.

## Manual recovery

Pause the workspace or stop its controller before changing the same flags manually. **Do not run two controllers for one inverter.** If the API is unavailable, this previously tested Customized Command disables AC charging with the known run/EPS flags:

```text
011000CE00020400000009BE75
```

Read flags with `010300CE0002A5F4`; the known disabled reply is `010304000000093A35`. The software normally performs a fresh read/modify/write so unrelated flag bits are preserved; the exact manual command above assumes the diagnosed flags.

The legacy single-device CLI remains available through `npm run inspect`, `npm run start:worker` and `npm run disable`, using the provider environment variables. It is separate from tenant scheduling and must not run alongside this dashboard against the same device. `inspect` never writes, even when the environment enables writes.
