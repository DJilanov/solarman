export const CONTROL_REASONS = {
  suspended:
    "This workspace is suspended. New automation and administration are unavailable.",
  connection: "Connect your account and select an inverter first",
  profile: "This inverter profile supports monitoring only",
  server: "The administrator has disabled changes to the inverter",
  verification: "Verify the inverter settings before enabling control",
  firmware: "Verify the current firmware before enabling control",
  capacity: "Shared API capacity cannot support control for this workspace",
  workspace: "Control has not been enabled for this workspace",
  settings: "Refresh readings to confirm the current control settings",
  clock: "The inverter clock must match the workspace timezone",
  clock_refresh: "Refresh readings to confirm the current inverter clock",
  cleanup: "Scheduled charging has not been confirmed off",
  stopping: "The controller is stopping",
};

export const CONTROL_FIRMWARE = Object.freeze({
  protocol: "2.02",
  dsp: "1.57",
  hmi: "1.45",
});

/** @typedef {{protocol: string, dsp: string, hmi: string}} ControlFirmware */

/** @param {unknown} value @returns {value is ControlFirmware} */
export function supportedControlFirmware(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      "protocol" in value &&
      value.protocol === CONTROL_FIRMWARE.protocol &&
      "dsp" in value &&
      value.dsp === CONTROL_FIRMWARE.dsp &&
      "hmi" in value &&
      value.hmi === CONTROL_FIRMWARE.hmi,
  );
}

/** @param {unknown} saved @param {unknown} observed @returns {boolean} */
export function matchingControlFirmware(saved, observed) {
  return (
    supportedControlFirmware(saved) &&
    supportedControlFirmware(observed) &&
    saved.protocol === observed.protocol &&
    saved.dsp === observed.dsp &&
    saved.hmi === observed.hmi
  );
}

/** @param {{ tenantActive?: boolean, connected: boolean, supported: boolean, serverAllowed: boolean, workspaceEnabled: boolean, verified: boolean, firmwareVerified: boolean, capacityAvailable: boolean, settingsMatch: boolean, clockVerified: boolean, clockFresh: boolean, cleanupVerified: boolean, stopping: boolean }} facts @returns {{ reasons: {code: string, message: string}[], canVerify: boolean, canEnable: boolean, canStart: boolean, canStop: boolean }} */
export function controlReadiness(facts) {
  const codes = [];
  if (facts.tenantActive === false) codes.push("suspended");
  if (!facts.connected) codes.push("connection");
  if (!facts.supported) codes.push("profile");
  if (!facts.serverAllowed) codes.push("server");
  if (!facts.verified) codes.push("verification");
  if (!facts.firmwareVerified) codes.push("firmware");
  if (facts.connected && !facts.capacityAvailable) codes.push("capacity");
  if (!facts.workspaceEnabled) codes.push("workspace");
  if (!facts.settingsMatch) codes.push("settings");
  if (!facts.clockFresh) codes.push("clock_refresh");
  else if (!facts.clockVerified) codes.push("clock");
  if (!facts.cleanupVerified) codes.push("cleanup");
  if (facts.stopping) codes.push("stopping");
  const available = facts.connected && facts.supported && !facts.stopping;
  return {
    reasons: codes.map((code) => ({ code, message: CONTROL_REASONS[code] })),
    canVerify: available,
    canEnable:
      available &&
      facts.tenantActive !== false &&
      facts.serverAllowed &&
      facts.verified &&
      facts.firmwareVerified &&
      facts.capacityAvailable &&
      facts.settingsMatch &&
      facts.clockVerified &&
      facts.clockFresh &&
      facts.cleanupVerified,
    canStart: codes.length === 0,
    // Stopping must remain available when settings verification has failed.
    canStop: facts.connected && !facts.stopping,
  };
}
