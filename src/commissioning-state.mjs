import { observationBinding } from "./policy-identity.mjs";

/** @param {{id:string,device_sn:string,profile:string,timezone:string}|null} account @param {{firmware:object,passed:boolean}|null} verification @returns {string|null} */
export function commissioningBinding(account, verification) {
  if (!account || !verification?.passed) return null;
  return observationBinding({
    accountId: account.id,
    device: account.device_sn,
    profile: account.profile,
    timezone: account.timezone,
    firmware: verification.firmware,
  });
}

/** @param {{state:string,binding:string,attended_until?:Date|string|null}|null} run @param {string|null} binding @param {'approved'|'attended'} mode @param {number} [now] @returns {boolean} */
export function commissioningAllowed(run, binding, mode, now = Date.now()) {
  if (!run || !binding || run.binding !== binding) return false;
  if (mode === "approved") return run.state === "approved";
  const until = run.attended_until && new Date(run.attended_until).getTime();
  return run.state === "attending" && Number.isFinite(until) && until > now;
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {string} tenantId @returns {Promise<object|null>} */
export async function currentCommissioning(client, tenantId) {
  return (
    (
      await client.query(
        "SELECT * FROM control_commissioning WHERE tenant_id=$1 AND state<>'invalidated'",
        [tenantId],
      )
    ).rows[0] ?? null
  );
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {string|null} tenantId @param {string} reason @returns {Promise<void>} */
export async function invalidateCommissioning(client, tenantId, reason) {
  await client.query(
    `WITH changed AS (
      UPDATE control_commissioning SET state='invalidated',attended_until=null,reason=$2,
        revision=revision+1,updated_at=clock_timestamp(),ended_at=clock_timestamp()
      WHERE ($1::uuid IS NULL OR tenant_id=$1) AND state<>'invalidated' RETURNING tenant_id,id,revision)
    INSERT INTO commissioning_events(id,tenant_id,run_id,revision,action,detail)
      SELECT gen_random_uuid(),tenant_id,id,revision,'invalidated',jsonb_build_object('reason',$2::text) FROM changed`,
    [tenantId, reason],
  );
}
