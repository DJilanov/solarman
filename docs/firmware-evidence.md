# Saved firmware and control evidence

Reviewed 2026-10-29 for the selected BSE20KH3 profile and observed protocol 2.02 / DSP 1.57 / HMI 1.45. The owner withdrew the application solar-power-cap requirement: solar charging follows native inverter and battery/BMS limits up to 100% SOC. The earlier limit research below is retained as diagnostic history and is not an approval blocker. No inverter setting was changed.

## Public references and their limits

The [Bluesun model datasheet](https://www.bluesunpv.com/wp-content/uploads/2024/12/BSE20-30KH3_v2406-Rev-01_EN.pdf) supplies electrical ratings, without a firmware register table. Ratings alone do not establish a configurable power-limit register.

The [ha-solarman documentation index](https://github.com/davidrapan/ha-solarman/wiki/Documentation) links two publicly attached workbooks. They are research leads, not confirmation that either applies to this device's exact firmware. Document revision numbers and reported protocol versions are different identifiers and must not be equated.

| Reference | Relevant entries | Limitation |
| --- | --- | --- |
| [Bluesun.xlsx](https://github.com/user-attachments/files/17939106/Bluesun.xlsx), internal history through V2.4, 2021-07-17 | 2504/2505: 0–100, percent. 3022–3023: U32 maximum charging power, watt units. 3036 lies in a reserved range. | The 2505 range excludes the observed raw 500; the table does not map the observed reserve. |
| [Afore communication protocol v1.4](https://github.com/user-attachments/files/17606882/Afore.communication.protocol.v1.4.xlsx), entry updates dated 2021-08-30 | 2504/2505: 0–1000, ratio scaled by 0.001. 3036: on-grid minimum SOC with the same ratio scale. 3022–3023: U32 maximum charging power, watt units. | The AC/SOC scaling agrees better with observed values, but applicability to this Bluesun firmware and enforcement of the power entry remain unconfirmed. |

Downloaded artifact SHA-256 values, to identify exactly what was reviewed:

```text
Bluesun.xlsx
0f8d8af936ce5ce1f544110d4e0582d987f3202521d73bee25fe740830e02204

Afore.communication.protocol.v1.4.xlsx
4ab1b17179f90f128770cdc29b5d5a858a22a49e496bcfea0230b192fa80c39d
```

Earlier device replies indicated words 3022–3023 combining to raw 100, while measured battery charging was approximately 1.95 kW. That is insufficient to treat the generic watt entry as this firmware's effective charging cap. Possible mode/BMS dependencies, ignored settings, scaling differences or another interpretation remain unresolved. Establish the supported mapping from applicable documentation and verified behavior before configuring this limit.

## Cached SOLARMAN parameters

The October 29 read-only review of stored provider metadata found `MAX_C_C_1` (Maximum Charging Current1) at 50 A and `MAX_C_V_1` at 224 V. These current/voltage fields are retained as provider data. Generic provider points `MAX_C_SOC` and `MIN_C_SOC` reported zero, while the separate native checks verified the 100% overall SOC maximum and 50% reserve. Those generic labels and zeros are not interpreted as a changed native policy.

SOLARMAN's [control FAQ](https://helpcenter.solarmanpv.com/portal/en/kb/articles/how-to-control-inverter-via-api) and [custom-command documentation](https://doc.solarmanpv.com/%E8%AE%BE%E5%A4%87%E6%8E%A5%E5%8F%A3/3.9%E8%87%AA%E5%AE%9A%E4%B9%89%E6%8C%87%E4%BB%A4%EF%BC%88%E6%8C%87%E4%BB%A4%E9%80%8F%E4%BC%A0%EF%BC%89Custom_commands) describe a transport for device commands and raw responses. This review obtained no firmware-specific charging-limit register mapping from those documents or the cached metadata. No new provider endpoint or inverter setting was used during this metadata review.

## Saved diagnostic evidence

An explicit **Verify device settings** action now saves individual holding-register words 2504, 2505, 3005, 3022, 3023 and 3036 alongside the existing nine checks. The four policy words come from the existing read of 3005–3036; this adds no Modbus request or periodic polling. Register 3022 and 3023 remain separate words: no newly assumed word order, unit or power limit influences control decisions.

Older reports have no raw-word evidence. The interface labels those words as unrecorded rather than reverse-calculating them from interpreted settings. A saved report's firmware and timestamp remain separate from the latest observed firmware and timestamp.

## Saved device report

On **Controls → Commission the home policy**, the EN/BG saved-device-evidence panel is available before a commissioning run can be prepared. It previews, copies or downloads the native solar policy, validated version strings, selected numeric checks and available raw words from the existing report. Exporting it performs no provider request or inverter command. It excludes account identifiers, serial numbers and free-form diagnostic errors. It contains no manufacturer questions or outreach instructions.

Approval requires all six physical acceptance checks: solar charging above 50%, battery support above reserve, near-2 kW grid charging, stopping at 50%, a complete day/night cycle and verified recovery. Exporting evidence grants no control permission and does not change the 100% overall SOC / 50% grid target / 50% reserve policy. See [finish-plan.md](finish-plan.md) for remaining acceptance work.

The owner cancelled the proposed manufacturer outreach on October 29, before any message was sent. The prepared draft was removed. Continue using existing documentation, saved diagnostics and collected observations; reserve vendor contact for a case the owner explicitly requests.
