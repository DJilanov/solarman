# Firmware power-limit evidence

Reviewed 2026-10-29 for the selected BSE20KH3 profile and observed protocol 2.02 / DSP 1.57 / HMI 1.45. This review did not establish a manufacturer-confirmed independent grid/solar charging contract. No inverter setting was changed.

## Public references and their limits

The [Bluesun model datasheet](https://www.bluesunpv.com/wp-content/uploads/2024/12/BSE20-30KH3_v2406-Rev-01_EN.pdf) supplies electrical ratings, without a firmware register table. Neither the inverter rating nor the battery current rating establishes the requested 5 kW solar charging setting.

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

Earlier device replies indicated words 3022–3023 combining to raw 100, while measured battery charging was approximately 1.95 kW. That is insufficient to treat the generic watt entry as this firmware's effective charging cap. Possible mode/BMS dependencies, ignored settings, scaling differences or another interpretation must be resolved by the manufacturer rather than selected by guesswork.

## Saved diagnostic evidence

An explicit **Verify device settings** action now saves individual holding-register words 2504, 2505, 3005, 3022, 3023 and 3036 alongside the existing nine checks. The four policy words come from the existing read of 3005–3036; this adds no Modbus request or periodic polling. Register 3022 and 3023 remain separate words: no newly assumed word order, unit or power limit influences control decisions.

Older reports have no raw-word evidence. The interface labels those words as unrecorded rather than reverse-calculating them from interpreted settings. A saved report's firmware and timestamp remain separate from the latest observed firmware and timestamp.

## Manufacturer request

On **Controls → Commission the home policy**, the EN/BG support-request panel is available before a commissioning run can be prepared. It previews, copies or downloads the requested home behavior, validated version strings, selected numeric checks and available raw words from the existing report. Preparing it performs no provider request or inverter command. It excludes account identifiers, serial numbers and free-form diagnostic errors. Sharing the report is a separate owner action; the application does not send it automatically.

The requested clarification must establish:

1. Exact addresses, types, word order, units, ranges, readback and restoration for the observed firmware.
2. Whether the AC setting limits the grid contribution or combined battery charging, including native reserve charging with scheduled permission off.
3. A supported 5 kW solar charging cap, its total-versus-solar scope, and enforcement in SelfUse mode with a lithium BMS.
4. Required modes/flags and settings that require stopping the inverter before changing them.

The existing physical-commissioning gate stays blocked on independent source limits. This evidence collection does not approve control, enable host writes, or change the 100% overall SOC / 50% grid target / 50% reserve policy. See [finish-plan.md](finish-plan.md) for the remaining physical and operational acceptance work.
