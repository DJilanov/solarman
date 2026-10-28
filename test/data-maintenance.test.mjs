import test from "node:test";
import assert from "node:assert/strict";
import { DataMaintenance } from "../src/data-maintenance.mjs";

test("retention shutdown drains the active batch and prevents another timer or overlapping run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const maintenance = new DataMaintenance({});
  let finish;
  let batches = 0;
  maintenance.prune = async () => {
    batches++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  maintenance.start();
  maintenance.start();
  assert.equal(batches, 1);
  const pending = maintenance.runOnce();
  let stopped = false;
  const stop = maintenance.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish({ measurements: 3 });
  assert.deepEqual(await pending, { measurements: 3 });
  await stop;
  t.mock.timers.tick(120000);
  await Promise.resolve();
  assert.equal(batches, 1);
  assert.equal(await maintenance.runOnce(), null);
});
