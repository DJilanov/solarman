import { randomUUID } from "node:crypto";
import { parseFrame } from "./modbus.mjs";

/** @param {number} address @param {number[]} values @returns {'enable' | 'disable' | 'window'} */
function operation(address, values) {
  if (
    !values.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 65535,
    )
  )
    throw new Error("Invalid inverter write values");
  if (address === 206 && values.length === 2)
    return values[1] & 16 ? "enable" : "disable";
  if (address === 2509 && values.length === 8) return "window";
  throw new Error(
    "This inverter write is not supported by the control journal",
  );
}

export class ControlJournal {
  /** @param {import('pg').Pool} pool @param {{tenantId: string, accountId: string | null, device: string | null}} context */
  constructor(pool, context) {
    this.pool = pool;
    this.context = context;
    this.binding = [context.tenantId, context.accountId, context.device];
    this.state = null;
    this.writes = [];
  }

  /** @returns {boolean} */
  get pending() {
    return ["uncertain", "cleanup-required"].includes(this.state?.state);
  }

  /** @returns {boolean} */
  get owned() {
    return Boolean(this.state && this.state.state !== "clear");
  }

  /** @param {string | null} [executionId] @returns {object} */
  status(executionId = null) {
    /** @param {{execution_id: string | null, status: string}} write @returns {boolean} */
    const inFlight = (write) =>
      Boolean(
        executionId &&
          write.execution_id === executionId &&
          ["prepared", "acknowledged"].includes(write.status),
      );
    return {
      state: this.state?.state ?? "none",
      pending: this.pending,
      inFlight: this.writes.some(inFlight),
      confirmedOffAt: this.state?.confirmed_off_at ?? null,
      updatedAt: this.state?.updated_at ?? null,
      writes: this.writes.map((write) => ({
        id: write.id,
        executionId: write.execution_id,
        operation: write.operation,
        status: write.status,
        inFlight: inFlight(write),
        createdAt: write.created_at,
        acknowledgedAt: write.acknowledged_at,
        verifiedAt: write.verified_at,
        reconciledAt: write.reconciled_at,
      })),
    };
  }

  /** @param {boolean} [restarting] @returns {Promise<void>} */
  async load(restarting = false) {
    if (!this.context.accountId || !this.context.device) return;
    if (restarting)
      await this.pool.query(
        "UPDATE device_control_state SET state='cleanup-required',updated_at=now() WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND state='owned'",
        this.binding,
      );
    this.state =
      (
        await this.pool.query(
          "SELECT state,confirmed_off_at,updated_at FROM device_control_state WHERE tenant_id=$1 AND account_id=$2 AND device=$3",
          this.binding,
        )
      ).rows[0] ?? null;
    this.writes = (
      await this.pool.query(
        "SELECT id,execution_id,operation,status,created_at,acknowledged_at,verified_at,reconciled_at FROM inverter_write_intents WHERE tenant_id=$1 AND account_id=$2 AND device=$3 ORDER BY created_at DESC,id DESC LIMIT 5",
        this.binding,
      )
    ).rows;
  }

  /** @param {number} address @param {number[]} values @param {string | null} executionId @returns {Promise<string>} */
  async prepare(address, values, executionId) {
    const action = operation(address, values);
    const connection = await this.pool.connect();
    const id = randomUUID();
    try {
      await connection.query("BEGIN");
      const account = (
        await connection.query(
          `SELECT c.control_enabled,c.paused,c.manual_topup,a.profile,a.validated_at
        FROM controller_state c JOIN solarman_accounts a ON a.tenant_id=c.tenant_id
        WHERE a.tenant_id=$1 AND a.id=$2 AND a.device_sn=$3
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.discovered_devices) d WHERE d->>'deviceSn'=a.device_sn)
        FOR UPDATE OF c`,
          this.binding,
        )
      ).rows[0];
      const lease = (
        await connection.query(
          "SELECT state FROM device_control_state WHERE tenant_id=$1 AND account_id=$2 AND device=$3 FOR UPDATE",
          this.binding,
        )
      ).rows[0];
      const recovering = lease && lease.state !== "clear";
      const tenant = (
        await connection.query("SELECT lifecycle FROM tenants WHERE id=$1", [
          this.context.tenantId,
        ])
      ).rows[0];
      if (
        !account ||
        !account.validated_at ||
        account.profile !== "bluesun-bse20kh3" ||
        (action === "disable"
          ? !account.control_enabled && !recovering
          : !account.control_enabled ||
            tenant?.lifecycle !== "active" ||
            (account.paused && !account.manual_topup) ||
            ["uncertain", "cleanup-required"].includes(lease?.state))
      )
        throw new Error(
          "Inverter write blocked by the current workspace state",
        );
      await connection.query(
        `INSERT INTO device_control_state (tenant_id,account_id,device,state) VALUES ($1,$2,$3,'uncertain')
        ON CONFLICT (tenant_id,account_id,device) DO UPDATE SET state=CASE WHEN device_control_state.state='cleanup-required' THEN 'cleanup-required' ELSE 'uncertain' END,updated_at=now()`,
        this.binding,
      );
      await connection.query(
        "INSERT INTO inverter_write_intents (tenant_id,account_id,device,id,execution_id,operation,address,register_values) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          ...this.binding,
          id,
          executionId,
          action,
          address,
          JSON.stringify(values),
        ],
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    await this.load();
    return id;
  }

  /** @param {string} command @returns {Promise<void>} */
  async authorizeDispatch(command) {
    const data = parseFrame(command);
    if ([3, 4].includes(data[1])) return;
    if (
      data[1] !== 16 ||
      data.length < 11 ||
      data[6] !== data.readUInt16BE(4) * 2 ||
      data.length !== data[6] + 9
    )
      throw new Error(
        "This inverter write is not supported by the control journal",
      );
    const values = Array.from({ length: data.readUInt16BE(4) }, (_, i) =>
      data.readUInt16BE(7 + i * 2),
    );
    const action = operation(data.readUInt16BE(2), values);
    const row = (
      await this.pool.query(
        `SELECT c.control_enabled,c.paused,c.manual_topup,t.lifecycle,d.state
      FROM controller_state c JOIN tenants t ON t.id=c.tenant_id JOIN solarman_accounts a ON a.tenant_id=c.tenant_id
      LEFT JOIN device_control_state d ON d.tenant_id=a.tenant_id AND d.account_id=a.id AND d.device=a.device_sn
      WHERE a.tenant_id=$1 AND a.id=$2 AND a.device_sn=$3 AND a.validated_at IS NOT NULL AND a.profile='bluesun-bse20kh3'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.discovered_devices) v WHERE v->>'deviceSn'=a.device_sn)`,
        this.binding,
      )
    ).rows[0];
    if (
      !row ||
      (action === "disable"
        ? !row.control_enabled && (!row.state || row.state === "clear")
        : row.lifecycle !== "active" ||
          !row.control_enabled ||
          (row.paused && !row.manual_topup) ||
          row.state === "cleanup-required")
    )
      throw new Error("Inverter write blocked by the current workspace state");
  }

  /** @param {string} id @returns {Promise<void>} */
  async acknowledge(id) {
    const result = await this.pool.query(
      "UPDATE inverter_write_intents SET status='acknowledged',acknowledged_at=now() WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND id=$4 AND status='prepared'",
      [...this.binding, id],
    );
    if (result.rowCount !== 1)
      throw new Error(
        "The inverter write journal does not match this operation",
      );
    await this.load();
  }

  /** @param {string} id @returns {Promise<void>} */
  async verify(id) {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "SELECT state FROM device_control_state WHERE tenant_id=$1 AND account_id=$2 AND device=$3 FOR UPDATE",
        this.binding,
      );
      const write = (
        await connection.query(
          "UPDATE inverter_write_intents SET status='verified',acknowledged_at=COALESCE(acknowledged_at,now()),verified_at=now() WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND id=$4 AND status IN ('prepared','acknowledged') RETURNING operation",
          [...this.binding, id],
        )
      ).rows[0];
      if (!write)
        throw new Error(
          "The inverter write journal does not match this operation",
        );
      if (write.operation === "disable") {
        await connection.query(
          "UPDATE device_control_state SET state='clear',confirmed_off_at=now(),updated_at=now() WHERE tenant_id=$1 AND account_id=$2 AND device=$3",
          this.binding,
        );
        await connection.query(
          "UPDATE inverter_write_intents SET status='uncertain',reconciled_at=now() WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND status<>'verified' AND reconciled_at IS NULL",
          this.binding,
        );
      } else
        await connection.query(
          "UPDATE device_control_state SET state=CASE WHEN state='cleanup-required' THEN state ELSE 'owned' END,updated_at=now() WHERE tenant_id=$1 AND account_id=$2 AND device=$3",
          this.binding,
        );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    await this.load();
  }

  /** @param {string} id @returns {Promise<void>} */
  async uncertain(id) {
    await this.pool.query(
      "UPDATE inverter_write_intents SET status='uncertain' WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND id=$4 AND status<>'verified'",
      [...this.binding, id],
    );
    await this.load();
  }

  /** @param {{pause?: boolean, cancelStarts?: boolean, revokeControl?: boolean}} [options] @returns {Promise<void>} */
  async requestCleanup({
    pause = false,
    cancelStarts = false,
    revokeControl = false,
  } = {}) {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      const control = (
        await connection.query(
          `SELECT c.control_enabled,a.id AS account_id,a.device_sn
          FROM controller_state c LEFT JOIN solarman_accounts a ON a.tenant_id=c.tenant_id
          WHERE c.tenant_id=$1 FOR UPDATE OF c`,
          [this.context.tenantId],
        )
      ).rows[0];
      const currentBinding =
        control?.account_id === this.context.accountId &&
        control?.device_sn === this.context.device;
      if (revokeControl && !currentBinding)
        throw new Error(
          "The inverter binding changed before verification was revoked",
        );
      if (pause || revokeControl)
        await connection.query(
          `UPDATE controller_state SET control_epoch=control_epoch+CASE WHEN $2 OR $3 OR NOT paused OR manual_topup THEN 1 ELSE 0 END,
          paused=true,manual_topup=false,topup_expires_at=null,
          control_enabled=CASE WHEN $3 THEN false ELSE control_enabled END,
          verification=CASE WHEN $3 THEN null ELSE verification END,updated_at=now() WHERE tenant_id=$1`,
          [this.context.tenantId, cancelStarts, revokeControl],
        );
      if (this.context.accountId && this.context.device) {
        const lease = (
          await connection.query(
            "SELECT state FROM device_control_state WHERE tenant_id=$1 AND account_id=$2 AND device=$3 FOR UPDATE",
            this.binding,
          )
        ).rows[0];
        if (
          (currentBinding && control.control_enabled) ||
          (lease && lease.state !== "clear")
        )
          await connection.query(
            `INSERT INTO device_control_state (tenant_id,account_id,device,state) VALUES ($1,$2,$3,'cleanup-required')
            ON CONFLICT (tenant_id,account_id,device) DO UPDATE SET state='cleanup-required',updated_at=now()`,
            this.binding,
          );
      }
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    await this.load();
  }

  /** @param {number} flags @returns {Promise<boolean>} */
  async confirmOff(flags) {
    if (
      !Number.isSafeInteger(flags) ||
      flags < 0 ||
      flags > 0xffffffff ||
      flags & 16
    )
      return false;
    if (!this.context.accountId || !this.context.device) return false;
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        `INSERT INTO device_control_state (tenant_id,account_id,device,state,confirmed_off_at) VALUES ($1,$2,$3,'clear',now())
        ON CONFLICT (tenant_id,account_id,device) DO UPDATE SET state='clear',confirmed_off_at=now(),updated_at=now()`,
        this.binding,
      );
      await connection.query(
        "UPDATE inverter_write_intents SET status='uncertain',reconciled_at=now() WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND status<>'verified' AND reconciled_at IS NULL",
        this.binding,
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    await this.load();
    return true;
  }
}
