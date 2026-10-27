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

Each cycle reads flags, AC configuration, battery registers 2000–2008, flow registers 507–554 and policy registers 3005–3036. Five regular custom-command requests per 15-minute cycle project to approximately 175,200 submissions per year, before authentication, transitions and recovery. Platform usage must be assessed across all linked users.

The service requests a bounded daily charging window (normally 25 minutes), verifies it, then permits AC charging below 50% when grid voltage and battery state permit it. Solar surplus above 1.8 kW prevents a new top-up; 2 kW stops an existing one. The inverter's native 50% AC target stops charging independently of the next scheduler poll. AC permission is removed at or above 50%, restoring normal battery use above the reserve. Short windows are renewed only while charging is needed.

These windows are **daily schedules, not an expiring watchdog**. Process failure, a network outage or an unreachable API can prevent cleanup; the last window may repeat on later days until AC charging is disabled. The midnight minute is excluded; a window crossing midnight uses two intervals. The inverter clock/timezone must match the linked account. Native inverter and BMS protections remain responsible for battery safety.

On errors and graceful shutdown, live mode attempts to remove timed AC permission while preserving all other flags. An API outage can prevent confirmation. Ambiguous submissions are not automatically retried as though nothing happened.

## Commissioning

1. Obtain App ID / App Secret and custom-command permission, with a licence appropriate for hosted users.
2. Verify the public HTTPS callback reaches the correct linked account. Callbacks correlate the random command URL, device, original request, timestamps, optional order ID and Modbus CRC/function/count.
3. Test account discovery and bind the actual inverter to the correct workspace and timezone.
4. Keep `WRITES_ENABLED=false`; use Refresh readings and confirm signs, values and the combined register ranges on the actual firmware.
5. Before enabling writes, verify the input 7–8 rated-power value is 20,000 W and the required holding settings match. That guard has not yet been tested on the real API/device.
6. Enable host writes, restart only the dashboard, then resume that workspace. Confirm a below-50% top-up, native stopping at 50%, AC permission removal, house supply from battery above 50%, and solar charging above 50%.

No automated physical-device commissioning has been completed. Tests use recorded replies and simulated inverter/API behavior.

## Manual recovery

Pause the workspace or stop its controller before changing the same flags manually. **Do not run two controllers for one inverter.** If the API is unavailable, this previously tested Customized Command disables AC charging with the known run/EPS flags:

```text
011000CE00020400000009BE75
```

Read flags with `010300CE0002A5F4`; the known disabled reply is `010304000000093A35`. The software normally performs a fresh read/modify/write so unrelated flag bits are preserved; the exact manual command above assumes the diagnosed flags.

The legacy single-device CLI remains available through `npm run inspect`, `npm run start:worker` and `npm run disable`, using the provider environment variables. It is separate from tenant scheduling and must not run alongside this dashboard against the same device. `inspect` never writes, even when the environment enables writes.
