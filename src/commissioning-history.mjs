import { createHash } from "node:crypto";
import {
  advanceObservation,
  emptyObservationProgress,
  observationWindow,
} from "./policy-observations.mjs";
import { SecurityError } from "./account-security.mjs";

const MAX_HISTORY_ROWS = 5000;

/** @param {object[]} rows @param {string} binding @param {string} startedAt @param {string} timezone @returns {object} */
export function reviewHistoricalReadings(rows, binding, startedAt, timezone) {
  let progress = emptyObservationProgress(),
    excluded = 0,
    interrupted = false;
  const digest = createHash("sha256");
  digest.update(binding + "\n");
  for (const row of rows) {
    digest.update(JSON.stringify([
      String(row.id), new Date(row.observed_at).toISOString(),
      new Date(row.received_at).toISOString(), row.reading_source,
      row.sampling_seconds, row.soc, row.pv_w, row.load_w, row.grid_w,
      row.battery_w, row.control_binding,
    ]) + "\n");
    if (row.control_binding !== binding) {
      excluded++;
      // A different known policy discards older evidence. Missing binding breaks continuity.
      if (row.control_binding !== null) progress = emptyObservationProgress();
      interrupted = true;
      continue;
    }
    if (interrupted) {
      progress.last = null;
      progress.approach = null;
      for (const key of ["solar", "discharge", "gridCharge", "gridStop"])
        if (!progress[key].observedAt)
          progress[key] = { count: 0, first: null, last: null, observedAt: null };
      interrupted = false;
    }
    progress = advanceObservation(progress, row, startedAt, timezone);
  }
  return {
    progress,
    window: observationWindow(progress),
    excluded,
    sampleCount: rows.length,
    hash: digest.digest("hex"),
  };
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {object} run @param {string|null} throughId @returns {Promise<object>} */
export async function reviewCommissioningHistory(client, run, throughId = null) {
  if (throughId !== null && (!/^[1-9]\d{0,18}$/.test(throughId) || BigInt(throughId) > 9223372036854775807n))
    throw new SecurityError(400, "Choose a valid historical review boundary");
  const anchor = (await client.query(
    `WITH boundary AS (
       SELECT max(observed_at) AS last_at FROM measurements
       WHERE tenant_id=$1 AND account_id=$2 AND device=$3
         AND ($5::bigint IS NULL OR id<=$5::bigint)
     )
     SELECT r.id,GREATEST(r.started_at,b.last_at-interval '7 days') AS started_at
     FROM policy_observation_runs r CROSS JOIN boundary b
     WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND binding=$4
       AND verification->>'passed'='true'
       AND r.started_at<=b.last_at AND b.last_at>=clock_timestamp()-interval '7 days'
       AND started_at>=COALESCE((SELECT max(ended_at) FROM policy_observation_runs
         WHERE tenant_id=$1 AND state='invalidated'
           AND reason IN('restore','rollback','connection_changed','workspace_changed')),'-infinity')
       AND started_at>=COALESCE((SELECT max(ended_at) FROM control_commissioning
         WHERE tenant_id=$1 AND state='invalidated'),'-infinity')
     ORDER BY r.started_at,r.id LIMIT 1`,
    [run.tenant_id, run.account_id, run.device, run.binding, throughId],
  )).rows[0];
  if (!anchor)
    throw new SecurityError(409, "No verified measurement history is available for this device");
  const rows = (await client.query(
    `SELECT id,observed_at,received_at,reading_source,sampling_seconds,soc,pv_w,load_w,grid_w,battery_w,control_binding
     FROM measurements WHERE tenant_id=$1 AND account_id=$2 AND device=$3
       AND observed_at>=$4 AND ($5::bigint IS NULL OR id<=$5::bigint)
     ORDER BY observed_at,id LIMIT $6`,
    [run.tenant_id, run.account_id, run.device, anchor.started_at, throughId, MAX_HISTORY_ROWS + 1],
  )).rows;
  if (!rows.length || rows.length > MAX_HISTORY_ROWS)
    throw new SecurityError(409, "The historical review requires a bounded set of saved readings");
  const boundary = rows.reduce((maximum, row) => BigInt(row.id) > BigInt(maximum) ? String(row.id) : maximum, "0");
  if (throughId !== null && boundary !== throughId)
    throw new SecurityError(409, "Historical readings changed. Review them again before saving");
  const review = reviewHistoricalReadings(rows, run.binding, anchor.started_at.toISOString(), run.identity.timezone);
  if (!review.progress.accepted || !review.progress.last)
    throw new SecurityError(409, "No verified measurement history is available for this device");
  return {
    ...review,
    source: "stored-measurements",
    anchorRunId: anchor.id,
    throughId: boundary,
    startedAt: review.progress.firstAt,
    checkedAt: new Date().toISOString(),
  };
}
