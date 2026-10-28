import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  chmod,
  symlink,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  erasureReceipt,
  erasureGuard,
  readErasureGuard,
} from "../src/erasure-guard.mjs";
import { publishErasures } from "../src/erasure-publisher.mjs";
import { AccountHub } from "../src/account-hub.mjs";

function receipt(patch = {}) {
  return {
    version: 1,
    id: randomUUID(),
    tenantId: randomUUID(),
    authorizedAt: new Date().toISOString(),
    ...patch,
  };
}

test("HTTPS and production hubs require a root erasure guard even without an explicit path", () => {
  for (const env of [
    { PUBLIC_URL: "https://solar.example.test" },
    { NODE_ENV: "production" },
  ]) {
    const hub = new AccountHub({}, env, Buffer.alloc(32));
    assert.equal(
      hub.offboarding.guardFile,
      "/var/lib/solarman-backup/public/erasure-guard.json",
    );
    assert.equal(hub.offboarding.requireRoot, true);
  }
  const local = new AccountHub(
    {},
    { PUBLIC_URL: "http://localhost:3000" },
    Buffer.alloc(32),
  );
  assert.equal(local.offboarding.guardFile, null);
  const alternate = new AccountHub(
    {},
    {
      PUBLIC_URL: "https://solar.example.test",
      ERASURE_GUARD_FILE: "/private/guard.json",
    },
    Buffer.alloc(32),
  );
  assert.equal(alternate.offboarding.guardFile, "/private/guard.json");
  assert.equal(alternate.offboarding.requireRoot, true);
});

test("erasure fences reject identifiers, extra personal data, noncanonical times and duplicate tenants", () => {
  const record = receipt();
  assert.deepEqual(erasureReceipt(record), record);
  for (const patch of [
    { id: "../another-object" },
    { tenantId: null },
    { authorizedAt: "2026-01-01" },
    { authorizedAt: new Date(Date.now() + 120000).toISOString() },
    { email: "private@example.test" },
  ]) {
    assert.throws(
      () => erasureReceipt({ ...record, ...patch }),
      /erasure_receipt_invalid/,
    );
  }
  const guard = {
    version: 1,
    state: "verified",
    checkedAt: new Date().toISOString(),
    records: [record],
  };
  assert.deepEqual(erasureGuard(guard).records, [record]);
  assert.throws(
    () =>
      erasureGuard({
        ...guard,
        records: [record, receipt({ tenantId: record.tenantId })],
      }),
    /conflict/,
  );
  assert.throws(
    () =>
      erasureGuard({ ...guard, records: [record, receipt({ id: record.id })] }),
    /conflict/,
  );
  assert.throws(
    () =>
      erasureGuard({
        ...guard,
        checkedAt: new Date(Date.now() - 301000).toISOString(),
      }),
    /unavailable/,
  );
  assert.throws(
    () => erasureGuard({ ...guard, state: "failed" }),
    /unavailable/,
  );
});

test("the local guard is a sealed regular file and cannot follow a symbolic link", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "solarman-erasure-guard-"),
  );
  const file = path.join(directory, "guard.json");
  const guard = {
    version: 1,
    state: "verified",
    checkedAt: new Date().toISOString(),
    records: [receipt()],
  };
  try {
    await writeFile(file, JSON.stringify(guard), { mode: 0o600 });
    assert.deepEqual(
      (await readErasureGuard(file, { requireRoot: false })).records,
      guard.records,
    );
    if (process.getuid?.() !== 0)
      await assert.rejects(readErasureGuard(file), /permissions/);
    await symlink(file, path.join(directory, "link"));
    await assert.rejects(
      readErasureGuard(path.join(directory, "link"), { requireRoot: false }),
    );
    await chmod(file, 0o644);
    await assert.rejects(
      readErasureGuard(file, { requireRoot: false }),
      /permissions/,
    );
    await chmod(file, 0o600);
    await writeFile(
      file,
      JSON.stringify({
        ...guard,
        checkedAt: new Date(Date.now() - 301000).toISOString(),
      }),
    );
    await assert.rejects(
      readErasureGuard(file, { requireRoot: false }),
      /unavailable/,
    );
    assert.equal(
      (await readErasureGuard(file, { requireRoot: false, fresh: false }))
        .records.length,
      1,
    );
    await writeFile(file, "invalid json");
    await assert.rejects(readErasureGuard(file, { requireRoot: false }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function publisherFixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "solarman-erasure-publisher-"),
  );
  const objects = new Map();
  const calls = [];
  const pending = [];
  const acknowledged = [];
  const rules = [
    {
      Status: "Enabled",
      Filter: { Prefix: "runs/" },
      Expiration: { Days: 30 },
    },
  ];
  const fixture = {
    directory,
    objects,
    calls,
    pending,
    acknowledged,
    rules,
    available: true,
    getPatch: {},
    putConflict: false,
  };
  const put = (key, record) => {
    const body = Buffer.from(JSON.stringify(record));
    objects.set(key, {
      body,
      Metadata: { sha256: createHash("sha256").update(body).digest("hex") },
      ETag: '"' + createHash("md5").update(body).digest("hex") + '"',
      ServerSideEncryption: "AES256",
      VersionId: randomUUID(),
    });
  };
  const client = {
    send: async (command) => {
      const name = command.constructor.name;
      const input = command.input;
      calls.push(name);
      if (name === "GetBucketLifecycleConfigurationCommand")
        return { Rules: rules };
      if (name === "ListObjectsV2Command")
        return {
          Contents: [...objects]
            .filter(([key]) => key.startsWith(input.Prefix))
            .map(([Key, value]) => ({ Key, ETag: value.ETag })),
          IsTruncated: false,
        };
      if (name === "PutObjectCommand") {
        assert.equal(input.IfNoneMatch, "*");
        assert.equal(input.ServerSideEncryption, "AES256");
        assert.equal(
          input.Metadata.sha256,
          createHash("sha256").update(input.Body).digest("hex"),
        );
        if (fixture.putConflict) {
          put(input.Key, JSON.parse(input.Body.toString()));
          throw { $metadata: { httpStatusCode: 412 } };
        }
        if (objects.has(input.Key))
          throw { $metadata: { httpStatusCode: 412 } };
        put(input.Key, JSON.parse(input.Body.toString()));
        return {};
      }
      if (name === "GetObjectCommand") {
        const value = objects.get(input.Key);
        if (!value) throw new Error("missing fixture object");
        return {
          ...value,
          ...fixture.getPatch,
          Body: Readable.from([value.body]),
        };
      }
      throw new Error("unexpected object operation");
    },
  };
  const database = {
    query: async (sql, values) => {
      if (sql.includes("to_regclass"))
        return { rows: [{ available: fixture.available }] };
      if (sql.startsWith("SELECT id,tenant_id")) return { rows: pending };
      if (sql.startsWith("UPDATE workspace_offboarding")) {
        const guard = await readErasureGuard(
          path.join(directory, "public/erasure-guard.json"),
          { requireRoot: false },
        );
        assert.ok(
          guard.records.some(
            (r) =>
              r.id === values[0] &&
              r.tenantId === values[1] &&
              r.authorizedAt === values[2],
          ),
        );
        assert.equal(
          (await stat(path.join(directory, "erasure-cache.json"))).mode & 0o777,
          0o600,
        );
        acknowledged.push(values);
        return { rowCount: 1 };
      }
      throw new Error("unexpected database operation");
    },
  };
  return {
    ...fixture,
    state: fixture,
    put,
    client,
    database,
    config: { bucket: "isolated-fixture-bucket", stateDirectory: directory },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

test("publication acknowledges only verified offsite receipts and durable matching local fences", async () => {
  const f = await publisherFixture();
  const record = receipt();
  f.pending.push({
    id: record.id,
    tenant_id: record.tenantId,
    erasure_authorized_at: new Date(record.authorizedAt),
  });
  try {
    assert.deepEqual(await publishErasures(f.client, f.config, f.database), {
      state: "verified",
      receipts: 1,
      published: 1,
    });
    const file = path.join(f.directory, "public/erasure-guard.json");
    assert.deepEqual(
      (await readErasureGuard(file, { requireRoot: false })).records,
      [record],
    );
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    assert.equal(f.acknowledged.length, 1);
    assert.equal(
      (await readdir(path.join(f.directory, "public"))).filter((x) =>
        x.endsWith(".tmp"),
      ).length,
      0,
    );
    const downloads = f.calls.filter((x) => x === "GetObjectCommand").length;
    assert.deepEqual(await publishErasures(f.client, f.config, f.database), {
      state: "verified",
      receipts: 1,
      published: 0,
    });
    assert.equal(
      f.calls.filter((x) => x === "GetObjectCommand").length,
      downloads,
    );
    f.objects.clear();
    await assert.rejects(
      publishErasures(f.client, f.config, f.database),
      /erasure_receipt_missing/,
    );
  } finally {
    await f.dispose();
  }
});

test("the publisher can establish the startup guard before the offboarding migration exists", async () => {
  const f = await publisherFixture();
  f.state.available = false;
  try {
    assert.equal(
      (await publishErasures(f.client, f.config, f.database)).receipts,
      0,
    );
    assert.equal(f.acknowledged.length, 0);
  } finally {
    await f.dispose();
  }
});

test("a conditional publication race verifies the existing receipt before acknowledgment", async () => {
  const f = await publisherFixture();
  const record = receipt();
  f.pending.push({
    id: record.id,
    tenant_id: record.tenantId,
    erasure_authorized_at: new Date(record.authorizedAt),
  });
  f.state.putConflict = true;
  try {
    assert.equal(
      (await publishErasures(f.client, f.config, f.database)).receipts,
      1,
    );
    assert.equal(f.acknowledged.length, 1);
  } finally {
    await f.dispose();
  }
});

test("an unverified or conflicting offsite object never grants erasure acknowledgment", async () => {
  for (const patch of [
    { ServerSideEncryption: undefined },
    { VersionId: "" },
    { Metadata: { sha256: "wrong" } },
  ]) {
    const f = await publisherFixture();
    const record = receipt();
    f.put(`erasures/${record.id}.json`, record);
    f.state.getPatch = patch;
    try {
      await assert.rejects(
        publishErasures(f.client, f.config, f.database),
        /erasure_offsite_verification/,
      );
      assert.equal(f.acknowledged.length, 0);
      await assert.rejects(
        readFile(path.join(f.directory, "public/erasure-guard.json")),
        { code: "ENOENT" },
      );
    } finally {
      await f.dispose();
    }
  }
  const f = await publisherFixture();
  const record = receipt();
  f.put(`erasures/${record.id}.json`, record);
  f.pending.push({
    id: record.id,
    tenant_id: randomUUID(),
    erasure_authorized_at: new Date(record.authorizedAt),
  });
  try {
    await assert.rejects(
      publishErasures(f.client, f.config, f.database),
      /erasure_receipt_conflict/,
    );
    assert.equal(f.acknowledged.length, 0);
  } finally {
    await f.dispose();
  }
});

test("erasure receipts cannot share expiring storage rules or silently discard a duplicate workspace", async () => {
  const f = await publisherFixture();
  f.rules.push({
    Status: "Enabled",
    Filter: { Prefix: "erasures/" },
    Expiration: { Days: 30 },
  });
  try {
    await assert.rejects(
      publishErasures(f.client, f.config, f.database),
      /erasure_expiration_forbidden/,
    );
    f.rules.pop();
    const one = receipt();
    const two = receipt({ tenantId: one.tenantId });
    f.put(`erasures/${one.id}.json`, one);
    f.put(`erasures/${two.id}.json`, two);
    await assert.rejects(
      publishErasures(f.client, f.config, f.database),
      /erasure_receipt_conflict/,
    );
    assert.equal(f.acknowledged.length, 0);
  } finally {
    await f.dispose();
  }
});
