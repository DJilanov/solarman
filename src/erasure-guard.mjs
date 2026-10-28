import { open, constants } from "node:fs/promises";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const ERASURE_LIMIT = 50000;
export const ERASURE_MAX_AGE_MS = 300000;

export class ErasureGuardError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** @typedef {{version:1,id:string,tenantId:string,authorizedAt:string}} ErasureReceipt */

/** @param {unknown} value @returns {ErasureReceipt} */
export function erasureReceipt(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !UUID.test(value.id) ||
    !UUID.test(value.tenantId) ||
    typeof value.authorizedAt !== "string" ||
    !Number.isFinite(Date.parse(value.authorizedAt)) ||
    new Date(value.authorizedAt).toISOString() !== value.authorizedAt ||
    Date.parse(value.authorizedAt) > Date.now() + 60000 ||
    Object.keys(value).some(
      (key) => !["version", "id", "tenantId", "authorizedAt"].includes(key),
    )
  )
    throw new ErasureGuardError("erasure_receipt_invalid");
  return {
    version: 1,
    id: value.id,
    tenantId: value.tenantId,
    authorizedAt: value.authorizedAt,
  };
}

/** @param {unknown} value @param {{fresh?:boolean,now?:number}} [options] @returns {{version:1,state:'verified',checkedAt:string,records:ErasureReceipt[]}} */
export function erasureGuard(value, { fresh = true, now = Date.now() } = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    value.state !== "verified" ||
    typeof value.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    Date.parse(value.checkedAt) > now + 60000 ||
    (fresh && now - Date.parse(value.checkedAt) > ERASURE_MAX_AGE_MS) ||
    !Array.isArray(value.records) ||
    value.records.length > ERASURE_LIMIT
  )
    throw new ErasureGuardError("erasure_guard_unavailable");
  const records = value.records.map(erasureReceipt);
  const ids = new Set(),
    tenants = new Set();
  for (const row of records) {
    if (ids.has(row.id) || tenants.has(row.tenantId))
      throw new ErasureGuardError("erasure_receipt_conflict");
    ids.add(row.id);
    tenants.add(row.tenantId);
  }
  return { version: 1, state: "verified", checkedAt: value.checkedAt, records };
}

/** @param {string} file @param {{requireRoot?:boolean,fresh?:boolean}} [options] @returns {Promise<ReturnType<typeof erasureGuard>>} */
export async function readErasureGuard(
  file,
  { requireRoot = true, fresh = true } = {},
) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 8 * 1024 * 1024 ||
      (info.mode & 0o027) !== 0 ||
      (requireRoot && info.uid !== 0)
    )
      throw new ErasureGuardError("erasure_guard_permissions");
    return erasureGuard(JSON.parse(await handle.readFile("utf8")), { fresh });
  } finally {
    await handle?.close();
  }
}
