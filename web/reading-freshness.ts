import type { ControllerStatus, Measurement } from "./types";

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
