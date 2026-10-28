import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rename, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  GetBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import {
  erasureReceipt,
  ERASURE_LIMIT,
  ErasureGuardError,
} from "./erasure-guard.mjs";
import { boundedBuffer } from "./backup-io.mjs";

/** @param {string} file @param {object} value @param {number} mode @returns {Promise<void>} */
async function durableJson(file, value, mode) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.chmod(mode);
      await handle.writeFile(JSON.stringify(value) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** @param {object} client @param {string} bucket @param {string} key @returns {Promise<{record:import('./erasure-guard.mjs').ErasureReceipt,etag:string}>} */
async function download(client, bucket, key) {
  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const body = await boundedBuffer(result.Body, 4096);
  if (
    result.ServerSideEncryption !== "AES256" ||
    typeof result.VersionId !== "string" ||
    !result.VersionId ||
    typeof result.ETag !== "string" ||
    result.Metadata?.sha256 !== createHash("sha256").update(body).digest("hex")
  )
    throw new ErasureGuardError("erasure_offsite_verification");
  return {
    record: erasureReceipt(JSON.parse(body.toString("utf8"))),
    etag: result.ETag,
  };
}

/** @param {object} client @param {{bucket:string,stateDirectory:string}} config @param {import('pg').PoolClient} database @param {{prefix?:string}} [options] @returns {Promise<{state:'verified',receipts:number,published:number}>} */
export async function publishErasures(
  client,
  config,
  database,
  { prefix = "erasures/" } = {},
) {
  if (!/^erasures\/$|^proof\/erasures\/[a-f0-9-]{36}\/$/.test(prefix))
    throw new ErasureGuardError("erasure_prefix_invalid");
  const lifecycle = await client.send(
    new GetBucketLifecycleConfigurationCommand({ Bucket: config.bucket }),
  );
  for (const rule of lifecycle.Rules ?? []) {
    const filter =
      rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? "";
    if (
      rule.Status === "Enabled" &&
      (rule.Expiration || rule.NoncurrentVersionExpiration) &&
      (prefix.startsWith(filter) || filter.startsWith(prefix))
    )
      throw new ErasureGuardError("erasure_expiration_forbidden");
  }
  const cacheFile = path.join(config.stateDirectory, "erasure-cache.json");
  let cache = {};
  try {
    const saved = JSON.parse(await readFile(cacheFile, "utf8"));
    if (
      saved.version === 1 &&
      saved.prefix === prefix &&
      saved.objects &&
      typeof saved.objects === "object"
    )
      cache = saved.objects;
  } catch (error) {
    if (error.code !== "ENOENT") cache = {};
  }
  const objects = {};
  const records = new Map();
  let token;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    );
    for (const object of listed.Contents ?? []) {
      const key = object.Key;
      if (
        typeof key !== "string" ||
        !key.startsWith(prefix) ||
        !/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/.test(
          key.slice(prefix.length),
        )
      )
        throw new ErasureGuardError("erasure_offsite_key_invalid");
      const saved = cache[key];
      let entry;
      if (saved && saved.etag === object.ETag) {
        try {
          entry = { record: erasureReceipt(saved.record), etag: saved.etag };
        } catch {
          entry = null;
        }
      }
      if (!entry) entry = await download(client, config.bucket, key);
      if (key !== prefix + entry.record.id + ".json")
        throw new ErasureGuardError("erasure_offsite_key_invalid");
      objects[key] = entry;
      records.set(entry.record.id, entry.record);
      if (records.size > ERASURE_LIMIT)
        throw new ErasureGuardError("erasure_receipt_limit");
    }
    if (listed.IsTruncated && !listed.NextContinuationToken)
      throw new ErasureGuardError("erasure_listing_incomplete");
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  for (const key of Object.keys(cache))
    if (!objects[key]) throw new ErasureGuardError("erasure_receipt_missing");
  const table = (
    await database.query(
      "SELECT to_regclass('public.workspace_offboarding') IS NOT NULL AS available",
    )
  ).rows[0].available;
  const pending = table
    ? (
        await database.query(
          "SELECT id,tenant_id,erasure_authorized_at FROM workspace_offboarding WHERE erasure_authorized_at IS NOT NULL",
        )
      ).rows
    : [];
  let published = 0;
  for (const row of pending) {
    const record = erasureReceipt({
      version: 1,
      id: row.id,
      tenantId: row.tenant_id,
      authorizedAt: new Date(row.erasure_authorized_at).toISOString(),
    });
    const existing = records.get(record.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record))
        throw new ErasureGuardError("erasure_receipt_conflict");
      continue;
    }
    const body = Buffer.from(JSON.stringify(record));
    const key = prefix + record.id + ".json";
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          IfNoneMatch: "*",
          ServerSideEncryption: "AES256",
          ContentType: "application/json",
          Metadata: { sha256: createHash("sha256").update(body).digest("hex") },
        }),
      );
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 412) throw error;
    }
    const entry = await download(client, config.bucket, key);
    if (JSON.stringify(entry.record) !== JSON.stringify(record))
      throw new ErasureGuardError("erasure_receipt_conflict");
    records.set(record.id, record);
    objects[key] = entry;
    published++;
    if (records.size > ERASURE_LIMIT)
      throw new ErasureGuardError("erasure_receipt_limit");
  }
  const tenants = new Set();
  for (const record of records.values()) {
    if (tenants.has(record.tenantId))
      throw new ErasureGuardError("erasure_receipt_conflict");
    tenants.add(record.tenantId);
  }
  await mkdir(path.join(config.stateDirectory, "public"), {
    recursive: true,
    mode: 0o750,
  });
  const guard = {
    version: 1,
    state: "verified",
    checkedAt: new Date().toISOString(),
    records: [...records.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  await durableJson(
    path.join(config.stateDirectory, "public/erasure-guard.json"),
    guard,
    0o640,
  );
  await durableJson(cacheFile, { version: 1, prefix, objects }, 0o600);
  // Acknowledgment is committed only after the offsite object and the local recovery fence are durable.
  if (table)
    for (const record of records.values())
      await database.query(
        "UPDATE workspace_offboarding SET offsite_acknowledged_at=COALESCE(offsite_acknowledged_at,clock_timestamp()) WHERE id=$1 AND tenant_id=$2 AND erasure_authorized_at=$3",
        [record.id, record.tenantId, record.authorizedAt],
      );
  return { state: "verified", receipts: records.size, published };
}
