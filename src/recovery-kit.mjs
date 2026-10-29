import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseEnv, isDeepStrictEqual } from "node:util";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  backupCredentials,
  receipt,
  validateObject,
  verifyBucket,
} from "./backup.mjs";
import {
  BackupError,
  boundedBuffer,
  MAX_RESTORE_BYTES,
  runBuffered,
  UUID,
} from "./backup-io.mjs";
import {
  erasureGuard,
  erasureReceipt,
  readErasureGuard,
  ERASURE_LIMIT,
} from "./erasure-guard.mjs";
import { validateDrill } from "./restore-drill.mjs";

export const MAX_RECOVERY_KIT_BYTES = 12 * 1024 * 1024;

/** @typedef {{key:string,versionId:string,bytes:number,sha256:string}} RecoveryObject */
/** @typedef {{version:1,id:string,state:'verified',startedAt:string,completedAt:string,databaseObject:RecoveryObject,configurationObject:RecoveryObject,manifestObject:RecoveryObject}} RecoveryReceipt */
/** @typedef {{bucket:string,region:string,recipient:string}} RecoveryLocation */
/** @typedef {{version:1,createdAt:string,location:RecoveryLocation,credentials:{accessKeyId:string,secretAccessKey:string},receipt:RecoveryReceipt,erasureReceipts:import('./erasure-guard.mjs').ErasureReceipt[]}} RecoveryKit */
/** @typedef {{version:1,state:'verified',backupId:string,kitCreatedAt:string,retrieval:'direct_s3',ciphertextChecksumsVerified:true,decryptionVerified:true,currentErasureReceipts:number,erasureBaselinePreserved:true,databaseBytes:number,postgresRestorePerformed:false,completedAt:string}} RecoveryVerification */

/** @param {unknown} value @returns {RecoveryReceipt} */
function checkedReceipt(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.state !== "verified" ||
    !UUID.test(value.id) ||
    typeof value.startedAt !== "string" ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    Date.parse(value.startedAt) > Date.parse(value.completedAt) ||
    Date.parse(value.completedAt) > Date.now() + 60000
  )
    throw new BackupError("recovery_checkpoint_invalid");
  for (const kind of ["database", "configuration", "manifest"])
    validateObject(value[`${kind}Object`], value.id, kind);
  return value;
}

/** @param {unknown} value @returns {RecoveryKit} */
export function recoveryKit(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    Date.parse(value.createdAt) > Date.now() + 60000 ||
    !/^jilanov-solarman-backups-[a-f0-9]{8}$/.test(value.location?.bucket) ||
    !/^[a-z]{2}-[a-z]+-\d$/.test(value.location?.region) ||
    !/^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(value.location?.recipient) ||
    Object.keys(value.location).sort().join(",") !==
      "bucket,recipient,region" ||
    !value.credentials ||
    typeof value.credentials !== "object" ||
    Object.keys(value.credentials).sort().join(",") !==
      "accessKeyId,secretAccessKey" ||
    ![value.credentials.accessKeyId, value.credentials.secretAccessKey].every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 256 &&
        !/\s/.test(entry),
    ) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "createdAt",
          "location",
          "credentials",
          "receipt",
          "erasureReceipts",
        ].includes(key),
    )
  )
    throw new BackupError("recovery_kit_invalid");
  checkedReceipt(value.receipt);
  try {
    erasureGuard(
      {
        version: 1,
        state: "verified",
        checkedAt: value.createdAt,
        records: value.erasureReceipts,
      },
      { fresh: false },
    );
  } catch {
    throw new BackupError("recovery_erasure_baseline_invalid");
  }
  return value;
}

/** @param {RecoveryKit} kit @param {string} age @returns {Promise<Buffer>} */
export async function encryptRecoveryKit(kit, age) {
  recoveryKit(kit);
  const plain = Buffer.from(JSON.stringify(kit));
  try {
    if (plain.length > MAX_RECOVERY_KIT_BYTES)
      throw new BackupError("recovery_kit_too_large");
    return await runBuffered(
      age,
      ["--encrypt", "--recipient", kit.location.recipient],
      plain,
      {
        maximum: MAX_RECOVERY_KIT_BYTES + 65536,
      },
    );
  } finally {
    plain.fill(0);
  }
}

/** @param {object} config @returns {Promise<Buffer>} */
export async function exportRecoveryKit(config) {
  const latest = JSON.parse(
    await readFile(path.join(config.stateDirectory, "latest.json"), "utf8"),
  );
  const recipient = (await readFile(config.recipientFile, "utf8")).trim();
  const guard = await readErasureGuard(
    path.join(config.stateDirectory, "public/erasure-guard.json"),
  );
  const kit = {
    version: 1,
    createdAt: new Date().toISOString(),
    location: { bucket: config.bucket, region: config.region, recipient },
    credentials: await backupCredentials(config),
    receipt: await receipt(config, latest.id),
    erasureReceipts: guard.records,
  };
  return encryptRecoveryKit(kit, config.age);
}

/** @param {string} file @param {number} [maximum] @returns {Promise<Buffer>} */
export async function readPrivateRecoveryFile(
  file,
  maximum = MAX_RECOVERY_KIT_BYTES + 65536,
) {
  let handle;
  try {
    if (!path.isAbsolute(file)) throw new BackupError("recovery_file_invalid");
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      info.size < 1 ||
      info.size > maximum
    )
      throw new BackupError("recovery_file_permissions");
    const body = await handle.readFile();
    if (body.length > maximum) throw new BackupError("recovery_kit_too_large");
    return body;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("recovery_file_unavailable");
  } finally {
    await handle?.close();
  }
}

/** @param {string} file @param {Buffer} encrypted @returns {Promise<void>} */
export async function writePrivateRecoveryFile(file, encrypted) {
  let handle;
  let created = false;
  try {
    if (
      !path.isAbsolute(file) ||
      encrypted.length < 1 ||
      encrypted.length > MAX_RECOVERY_KIT_BYTES + 65536
    )
      throw new BackupError("recovery_file_invalid");
    const parent = path.dirname(file);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(parent);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.uid !== process.getuid() ||
      (directoryInfo.mode & 0o077) !== 0
    )
      throw new BackupError("recovery_directory_permissions");
    handle = await open(file, "wx", 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(encrypted);
    await handle.sync();
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (created) await rm(file, { force: true });
    if (error instanceof BackupError) throw error;
    throw new BackupError("recovery_file_not_created");
  } finally {
    await handle?.close();
  }
}

/** @param {S3Client} client @param {string} bucket @param {object} object @param {number} maximum @returns {Promise<Buffer>} */
async function offsiteObject(client, bucket, object, maximum) {
  if (object.bytes > maximum + 65536)
    throw new BackupError("recovery_object_too_large");
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: object.key,
      VersionId: object.versionId,
    }),
    { abortSignal: AbortSignal.timeout(30000) },
  );
  try {
    if (
      response.VersionId !== object.versionId ||
      response.ServerSideEncryption !== "AES256" ||
      response.ContentLength !== object.bytes ||
      response.Metadata?.sha256 !== object.sha256
    )
      throw new BackupError("recovery_object_metadata_mismatch");
    const bytes = await boundedBuffer(response.Body, maximum + 65536);
    if (
      bytes.length !== object.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== object.sha256
    )
      throw new BackupError("recovery_object_checksum_mismatch");
    return bytes;
  } finally {
    response.Body?.destroy?.();
  }
}

/** @param {S3Client} client @param {RecoveryKit} kit @returns {Promise<import('./erasure-guard.mjs').ErasureReceipt[]>} */
async function currentErasures(client, kit) {
  const records = new Map();
  const tokens = new Set();
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: kit.location.bucket,
        Prefix: "erasures/",
        MaxKeys: 1000,
        ...(token ? { ContinuationToken: token } : {}),
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    if (
      !Array.isArray(page.Contents ?? []) ||
      (page.Contents?.length ?? 0) > 1000
    )
      throw new BackupError("recovery_erasure_listing_invalid");
    for (const object of page.Contents ?? []) {
      if (
        typeof object.Key !== "string" ||
        !/^erasures\/[a-f0-9-]{36}\.json$/.test(object.Key) ||
        !UUID.test(object.Key.slice(9, -5))
      )
        throw new BackupError("recovery_erasure_key_invalid");
      const response = await client.send(
        new GetObjectCommand({ Bucket: kit.location.bucket, Key: object.Key }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      let body;
      try {
        body = await boundedBuffer(response.Body, 4096);
      } finally {
        response.Body?.destroy?.();
      }
      if (
        response.ServerSideEncryption !== "AES256" ||
        typeof response.VersionId !== "string" ||
        !response.VersionId ||
        typeof response.ETag !== "string" ||
        response.Metadata?.sha256 !==
          createHash("sha256").update(body).digest("hex")
      )
        throw new BackupError("recovery_erasure_metadata_invalid");
      const record = erasureReceipt(JSON.parse(body.toString("utf8")));
      if (object.Key !== `erasures/${record.id}.json` || records.has(record.id))
        throw new BackupError("recovery_erasure_key_invalid");
      records.set(record.id, record);
      if (records.size > ERASURE_LIMIT)
        throw new BackupError("recovery_erasure_limit");
    }
    if (
      page.IsTruncated &&
      (typeof page.NextContinuationToken !== "string" ||
        !page.NextContinuationToken ||
        tokens.has(page.NextContinuationToken))
    )
      throw new BackupError("recovery_erasure_listing_invalid");
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (token) tokens.add(token);
  } while (token);
  const result = [...records.values()];
  erasureGuard({
    version: 1,
    state: "verified",
    checkedAt: new Date().toISOString(),
    records: result,
  });
  for (const baseline of kit.erasureReceipts)
    if (!isDeepStrictEqual(records.get(baseline.id), baseline))
      throw new BackupError("recovery_erasure_baseline_missing");
  return result;
}

/** @param {Buffer} encrypted @param {{age:string,identity:string,checkpoint?:unknown}} options @returns {Promise<RecoveryVerification>} */
export async function verifyRecoveryKit(
  encrypted,
  { age, identity, checkpoint },
) {
  let client;
  let plain;
  try {
    if (encrypted.length > MAX_RECOVERY_KIT_BYTES + 65536)
      throw new BackupError("recovery_kit_too_large");
    plain = await runBuffered(
      age,
      ["--decrypt", "--identity", identity],
      encrypted,
      { maximum: MAX_RECOVERY_KIT_BYTES },
    );
    const kit = recoveryKit(JSON.parse(plain.toString("utf8")));
    let reference = kit.receipt;
    if (checkpoint !== undefined) {
      if (
        checkpoint?.version !== 1 ||
        !isDeepStrictEqual(checkpoint.location, kit.location)
      )
        throw new BackupError("recovery_checkpoint_location_mismatch");
      reference = checkedReceipt(checkpoint.receipt);
    }
    client = new S3Client({
      region: kit.location.region,
      credentials: kit.credentials,
      maxAttempts: 3,
      ignoreConfiguredEndpointUrls: true,
      requestHandler: {
        connectionTimeout: 5000,
        requestTimeout: 30000,
        throwOnRequestTimeout: true,
      },
    });
    await verifyBucket(client, { bucket: kit.location.bucket });
    const decrypt = async (kind, maximum) => {
      const bytes = await offsiteObject(
        client,
        kit.location.bucket,
        reference[`${kind}Object`],
        maximum,
      );
      return runBuffered(age, ["--decrypt", "--identity", identity], bytes, {
        maximum,
      });
    };
    const manifest = JSON.parse(
      (await decrypt("manifest", 1024 * 1024)).toString("utf8"),
    );
    if (
      manifest.version !== 1 ||
      manifest.id !== reference.id ||
      manifest.database !== "solarman" ||
      !Number.isSafeInteger(manifest.plainBytes) ||
      manifest.plainBytes < 5 ||
      manifest.plainBytes > MAX_RESTORE_BYTES ||
      !isDeepStrictEqual(manifest.databaseObject, reference.databaseObject) ||
      !isDeepStrictEqual(
        manifest.configurationObject,
        reference.configurationObject,
      )
    )
      throw new BackupError("recovery_manifest_invalid");
    const configuration = parseEnv(
      (await decrypt("configuration", 65536)).toString("utf8"),
    );
    const database = await decrypt("database", MAX_RESTORE_BYTES);
    if (database.subarray(0, 5).toString() !== "PGDMP")
      throw new BackupError("recovery_archive_invalid");
    const erasures = await currentErasures(client, kit);
    validateDrill(
      {
        version: 1,
        backupId: reference.id,
        database: manifest.database,
        plainBytes: manifest.plainBytes,
        plainSha256: createHash("sha256").update(database).digest("hex"),
        contents: manifest.contents,
        accountCount: manifest.accountCount,
        credentialKey: configuration.CREDENTIAL_ENCRYPTION_KEY,
        erasureReceipts: erasures,
      },
      database,
    );
    return {
      version: 1,
      state: "verified",
      backupId: reference.id,
      kitCreatedAt: kit.createdAt,
      retrieval: "direct_s3",
      ciphertextChecksumsVerified: true,
      decryptionVerified: true,
      currentErasureReceipts: erasures.length,
      erasureBaselinePreserved: true,
      databaseBytes: database.length,
      postgresRestorePerformed: false,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    if (error?.$metadata?.httpStatusCode === 403)
      throw new BackupError("recovery_offsite_access_denied");
    if (["NoSuchKey", "NoSuchVersion"].includes(error?.name))
      throw new BackupError("recovery_checkpoint_unavailable");
    if (["AbortError", "TimeoutError"].includes(error?.name))
      throw new BackupError("recovery_offsite_timeout");
    throw new BackupError("recovery_verification_failed");
  } finally {
    plain?.fill(0);
    client?.destroy();
  }
}
