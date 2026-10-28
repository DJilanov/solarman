/** @param {{device?: string, collectedAt?: number, state?: number, values?: Record<string, string>}} [options] @returns {{deviceSn: string, deviceType: string, deviceState: number, collectionTime: number, dataList: {key: string, name: string, value: string, unit: string | null}[]}} */
export function providerPayload({
  device = "TEST-BLUESUN",
  collectedAt = Date.now(),
  state = 1,
  values = {},
} = {}) {
  const fields = [
    ["MMN", "Machine Model (New)", "BSE20KH3", null],
    ["Pr1", "Rated Power", "20000", "W"],
    ["PTCv1", "Protocol Version", "2.02", null],
    ["DSP_V_M", "Main DSP Software Version Number", "1.57", null],
    ["HMIVN", "HMI Software Version Number", "1.45", null],
    [
      "SYSTIM1",
      "System Time",
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Sofia",
        dateStyle: "short",
        timeStyle: "medium",
      }).format(collectedAt),
      null,
    ],
    ["PVTP", "PV Total Power", "494", "W"],
    ["EP", "Electric Power", "304", "W"],
    ["PG_Pt1", "Total Grid Power", "1779", "W"],
    ["B_P1", "Battery Power", "-1945", "W"],
    ["B_left_cap1", "SoC", "45", "%"],
    ["B_T1", "Temperature- Battery", "16.00", "℃"],
  ];
  return {
    deviceSn: device,
    deviceType: "INVERTER",
    deviceState: state,
    collectionTime: Math.floor(collectedAt / 1000),
    dataList: fields.map(([key, name, value, unit]) => ({
      key,
      name,
      value: values[key] ?? value,
      unit,
    })),
  };
}
