import test from "node:test";
import assert from "node:assert/strict";
import { verifyRelease, assertRollbackCompatibility } from "../scripts/release.mjs";

const expected = {
  directory: "/releases/new",
  sha: "b".repeat(40),
  index: '<script src="/assets/new.js"></script>',
};

test("a rollback cannot run a release that cannot read Web Push storage", () => {
  assert.throws(() => assertRollbackCompatibility(["021_notifications.sql", "022_web_push.sql"], ["021_notifications.sql"]), /supports Web Push/);
  assert.doesNotThrow(() => assertRollbackCompatibility(["021_notifications.sql"], ["021_notifications.sql"]));
  assert.doesNotThrow(() => assertRollbackCompatibility(["021_notifications.sql", "022_web_push.sql"], ["021_notifications.sql", "022_web_push.sql"]));
});
const running = {
  cwd: "/releases/new",
  script: "/releases/new/src/server.mjs",
  status: "online",
  health: { status: "ok", release: "b".repeat(40) },
  index: expected.index,
};

test("a healthy version number cannot hide PM2 running files from the old release", () => {
  assert.throws(
    () =>
      verifyRelease(expected, {
        ...running,
        cwd: "/releases/old",
        script: "/releases/old/src/server.mjs",
      }),
    /directory/,
  );
  assert.throws(
    () =>
      verifyRelease(expected, {
        ...running,
        script: "/releases/old/src/server.mjs",
      }),
    /directory/,
  );
});

test("release verification rejects a stale served page or incorrect health", () => {
  assert.throws(
    () =>
      verifyRelease(expected, {
        ...running,
        index: '<script src="/assets/old.js"></script>',
      }),
    /served page/,
  );
  assert.throws(
    () =>
      verifyRelease(expected, {
        ...running,
        health: { status: "ok", release: "a".repeat(40) },
      }),
    /health/,
  );
});

test("matching process files, health and frontend pass release verification", () => {
  assert.doesNotThrow(() => verifyRelease(expected, running));
});
