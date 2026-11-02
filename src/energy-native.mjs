import { energyLocalTime, energyNativeTime } from "./energy-time.mjs";
import { validateChargeWindows } from "./outage-policy.mjs";

/** @param {{fresh:boolean,passed:boolean,skewSeconds:number|null}|null} clock @param {object} profile @returns {boolean} */
export function nightClockAllowed(clock, profile) {
  if (!clock?.fresh || !Number.isFinite(clock.skewSeconds)) return false;
  const buffer = profile.planning.nightBufferMinutes ?? 0;
  const maximum = Math.max(120, Math.min(3600, buffer * 60));
  return clock.skewSeconds >= 0 && clock.skewSeconds <= maximum;
}

/** @param {object} plan @param {string} timezone @returns {number[]} */
export function nightNativeWindows(plan, timezone) {
  const start = plan.chargeStart,
    end = plan.chargeEnd;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 12 * 3600000
  )
    throw new Error("The native charging window must fit within twelve hours");
  const first = energyLocalTime(start, timezone),
    last = energyLocalTime(end, timezone);
  const from = Math.max(1, energyNativeTime(start, timezone)),
    to = energyNativeTime(end, timezone);
  const windows =
    first.day === last.day
      ? [from, to, 0, 0, 0, 0, 0, 0]
      : [from, 0x173b, 1, to, 0, 0, 0, 0];
  validateChargeWindows(windows);
  return windows;
}
