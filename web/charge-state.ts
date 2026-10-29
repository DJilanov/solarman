import type { ControllerStatus, Measurement } from "./types";

export type ChargeState =
  | "ready"
  | "active"
  | "satisfied"
  | "connection"
  | "unsupported"
  | "missing"
  | "stale"
  | "setup"
  | "recovery"
  | "busy";

export function readingIsStale(
  controller: ControllerStatus,
  reading: Measurement | null,
  now: number = Date.now(),
): boolean {
  if (!reading) return true;
  const at = Date.parse(reading.at);
  return (
    !Number.isFinite(at) ||
    at > now + 60_000 ||
    now - at > (controller.pollSeconds + 180) * 1000 ||
    (controller.telemetry !== null && controller.telemetry.deviceState !== 1)
  );
}

export function chargeState(
  controller: ControllerStatus,
  reading: Measurement | null,
  busy: boolean,
  now: number = Date.now(),
): ChargeState {
  if (controller.control.recovery.pending) return "recovery";
  if (controller.control.recovery.inFlight || controller.recoveryTesting)
    return "busy";
  if (controller.manualTopup) return "active";
  if (!controller.apiConfigured || !controller.deviceSelected)
    return "connection";
  if (controller.profile !== "bluesun-bse20kh3") return "unsupported";
  if (!reading) return "missing";
  if (readingIsStale(controller, reading, now)) return "stale";
  if (reading.soc >= controller.policy.reserveSoc) return "satisfied";
  if (!controller.writesEnabled || !controller.control.canStart) return "setup";
  return busy ? "busy" : "ready";
}
