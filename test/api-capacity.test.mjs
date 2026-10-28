import test from "node:test";
import assert from "node:assert/strict";
import { allocateCapacity } from "../src/api-capacity.mjs";
import { pollingConfig } from "../src/config.mjs";

const policy = { limit: 200000, reserve: 2000 };
const cadence = pollingConfig({});
const year = 365 * 86400_000;

test("one home preserves five-minute telemetry and fits every continuous assessment mode", () => {
  const plan = allocateCapacity({ monitors: 0, controls: 1 }, policy, cadence);
  assert.equal(plan.fits, true);
  assert.equal(plan.monitorMs, 300000);
  assert.equal(plan.scheduledMs, 1020000);
  assert.equal(plan.assessmentMs, 1920000);
  assert.equal(plan.reservedAnnual, 187245);
  assert.ok(plan.scheduledMs + 180000 < cadence.chargeWindowMinutes * 60000);
});

test("monitor and control admission refuses populations that cannot fit at their slowest allowed cadences", () => {
  assert.equal(
    allocateCapacity({ monitors: 10, controls: 0 }, policy, cadence).fits,
    true,
  );
  assert.equal(
    allocateCapacity({ monitors: 11, controls: 0 }, policy, cadence).fits,
    false,
  );
  assert.equal(
    allocateCapacity({ monitors: 2, controls: 1 }, policy, cadence).fits,
    true,
  );
  assert.equal(
    allocateCapacity({ monitors: 3, controls: 1 }, policy, cadence).fits,
    false,
  );
  assert.equal(
    allocateCapacity({ monitors: 0, controls: 2 }, policy, cadence).fits,
    false,
  );
  assert.equal(
    allocateCapacity(
      { monitors: 0, controls: 2 },
      { limit: 500000, reserve: 2000 },
      cadence,
    ).fits,
    true,
  );
});

test("every admitted mixture fits monitoring, native retry and scheduled bounds", () => {
  for (const limit of [100000, 200000, 500000])
    for (let monitors = 0; monitors < 12; monitors++)
      for (let controls = 0; controls < 5; controls++) {
        const p = { limit, reserve: 2000 };
        const plan = allocateCapacity({ monitors, controls }, p, cadence);
        if (!plan.fits) continue;
        const native =
          year / plan.monitorMs +
          (5 * year) / Math.min(plan.assessmentMs, cadence.controlAuditMs);
        const scheduled = (6 * year) / plan.scheduledMs;
        assert.ok(
          (monitors * year) / plan.monitorMs +
            controls * Math.max(native, scheduled) <=
            plan.planningLimit,
        );
        assert.ok(
          plan.monitorMs >= cadence.telemetryPollMs &&
            plan.monitorMs <= 1800000,
        );
        assert.ok(
          plan.scheduledMs >= cadence.pollMs &&
            plan.scheduledMs + 180000 < cadence.chargeWindowMinutes * 60000,
        );
      }
});

test("custom minimum cadences and short windows are preserved", () => {
  const custom = pollingConfig({
    POLL_SECONDS: "60",
    CHARGE_WINDOW_MINUTES: "5",
    TELEMETRY_POLL_SECONDS: "903",
  });
  const plan = allocateCapacity(
    { monitors: 0, controls: 1 },
    { limit: 3000000, reserve: 2000 },
    custom,
  );
  assert.equal(plan.fits, true);
  assert.ok(plan.monitorMs >= 903000);
  assert.ok(plan.scheduledMs + 180000 < 300000);
  assert.throws(() =>
    allocateCapacity({ monitors: -1, controls: 0 }, policy, cadence),
  );
});
