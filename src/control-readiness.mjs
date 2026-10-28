export const CONTROL_REASONS = {
  connection: "Connect your account and select an inverter first",
  profile: "This inverter profile supports monitoring only",
  server: "The administrator has disabled changes to the inverter",
  verification: "Verify the inverter settings before enabling control",
  workspace: "Control has not been enabled for this workspace",
  settings: "Refresh readings to confirm the current control settings",
  clock: "The inverter clock must match the workspace timezone",
  cleanup: "Scheduled charging has not been confirmed off",
  stopping: "The controller is stopping",
};

/** @param {{ connected: boolean, supported: boolean, serverAllowed: boolean, workspaceEnabled: boolean, verified: boolean, settingsMatch: boolean, clockVerified: boolean, cleanupVerified: boolean, stopping: boolean }} facts @returns {{ reasons: {code: string, message: string}[], canVerify: boolean, canEnable: boolean, canStart: boolean, canStop: boolean }} */
export function controlReadiness(facts) {
  const codes = [];
  if (!facts.connected) codes.push("connection");
  if (!facts.supported) codes.push("profile");
  if (!facts.serverAllowed) codes.push("server");
  if (!facts.verified) codes.push("verification");
  if (!facts.workspaceEnabled) codes.push("workspace");
  if (!facts.settingsMatch) codes.push("settings");
  if (!facts.clockVerified) codes.push("clock");
  if (!facts.cleanupVerified) codes.push("cleanup");
  if (facts.stopping) codes.push("stopping");
  const available = facts.connected && facts.supported && !facts.stopping;
  return {
    reasons: codes.map((code) => ({ code, message: CONTROL_REASONS[code] })),
    canVerify: available,
    canEnable:
      available &&
      facts.serverAllowed &&
      facts.verified &&
      facts.settingsMatch &&
      facts.clockVerified &&
      facts.cleanupVerified,
    canStart: codes.length === 0,
    // Stopping must remain available when settings verification has failed.
    canStop: facts.connected && !facts.stopping,
  };
}
