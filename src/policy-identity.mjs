import { createHash } from "node:crypto";
import { supportedControlFirmware } from "./control-readiness.mjs";
import { BLUESUN_MAPPING } from "./telemetry.mjs";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** @typedef {{accountId:string,device:string,profile:string,timezone:string,firmware:{protocol:string,dsp:string,hmi:string}}} ObservationIdentityInput */
/** @typedef {{accountId:string,device:string,profile:'bluesun-bse20kh3',model:'BSE20KH3',timezone:string,mapping:string,policy:string,firmware:{protocol:string,dsp:string,hmi:string}}} ObservationIdentity */
/** @param {ObservationIdentityInput} input @returns {ObservationIdentity|null} */
export function observationIdentity(input) {
  if (
    !input ||
    !UUID.test(input.accountId) ||
    typeof input.device !== "string" ||
    !input.device ||
    input.device.length > 200 ||
    input.profile !== "bluesun-bse20kh3" ||
    !supportedControlFirmware(input.firmware) ||
    typeof input.timezone !== "string"
  )
    return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
  } catch {
    return null;
  }
  return {
    accountId: input.accountId,
    device: input.device,
    profile: "bluesun-bse20kh3",
    model: "BSE20KH3",
    timezone: input.timezone,
    mapping: BLUESUN_MAPPING,
    policy: "reserve-50/ac-2kw/solar-100/v1",
    firmware: {
      protocol: input.firmware.protocol,
      dsp: input.firmware.dsp,
      hmi: input.firmware.hmi,
    },
  };
}

/** @param {ObservationIdentityInput} input @returns {string|null} */
export function observationBinding(input) {
  const identity = observationIdentity(input);
  return identity
    ? createHash("sha256").update(JSON.stringify(identity)).digest("hex")
    : null;
}
