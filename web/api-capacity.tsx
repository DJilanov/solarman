import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Notice } from "./components";
import { formatNumber } from "./format";
import { tr } from "./i18n";
import type { ApiCapacity } from "./types";

export function CapacityNotice({
  capacity,
}: {
  capacity?: ApiCapacity | null;
}): ReactNode {
  if (!capacity || capacity.admitted) return null;
  return (
    <Notice>
      {tr("Monitoring is waiting for shared API capacity")}{" "}
      <Link to="/settings" className="text-link">
        {tr("Review polling capacity")}
      </Link>
    </Notice>
  );
}

export function CapacityDetails({
  capacity,
  onRetry,
  disabled,
}: {
  capacity: ApiCapacity;
  onRetry: () => void;
  disabled: boolean;
}): ReactNode {
  const minutes = (milliseconds: number): string =>
    tr("{{value}} minutes", {
      value: formatNumber(milliseconds / 60000, 1, 0),
    });
  const preview = capacity.activation;
  return (
    <details
      className="capacity-details"
      open={!capacity.admitted || !capacity.controlAvailable ? true : undefined}
    >
      <summary>
        <strong>{tr("Polling capacity")}</strong>
        <span>
          {formatNumber(capacity.reservedAnnual)} /{" "}
          {formatNumber(capacity.planningLimit)}
        </span>
      </summary>
      {!capacity.admitted && (
        <Notice>
          {tr(
            "Regular monitoring has no capacity slot. The service will retry without making device requests.",
          )}
          <button
            className="button secondary small"
            disabled={disabled}
            onClick={onRetry}
          >
            {tr("Retry monitoring capacity")}
          </button>
        </Notice>
      )}
      {capacity.admitted && !capacity.controlAvailable && (
        <Notice>
          {tr(
            "Monitoring is available, but full control cannot fit this shared allowance. Use a separate App ID or ask the administrator about licensed capacity.",
          )}
        </Notice>
      )}
      <dl className="command-facts">
        <div>
          <dt>{tr("Admitted monitoring workspaces")}</dt>
          <dd>{formatNumber(capacity.monitoringWorkspaces)}</dd>
        </div>
        <div>
          <dt>{tr("Reserved control workspaces")}</dt>
          <dd>{formatNumber(capacity.controlWorkspaces)}</dd>
        </div>
        <div>
          <dt>{tr("Waiting workspaces")}</dt>
          <dd>{formatNumber(capacity.waitingWorkspaces)}</dd>
        </div>
        <div>
          <dt>{tr("Regular calls reserved per year")}</dt>
          <dd>
            {formatNumber(capacity.reservedAnnual)} /{" "}
            {formatNumber(capacity.planningLimit)}
          </dd>
        </div>
        <div>
          <dt>{tr("Telemetry interval")}</dt>
          <dd>{minutes(capacity.monitorMs)}</dd>
        </div>
        {capacity.controlWorkspaces > 0 && (
          <>
            <div>
              <dt>{tr("Scheduled charging interval")}</dt>
              <dd>{minutes(capacity.scheduledMs)}</dd>
            </div>
            <div>
              <dt>{tr("Below-reserve assessment interval")}</dt>
              <dd>{minutes(capacity.assessmentMs)}</dd>
            </div>
          </>
        )}
      </dl>
      {preview && (
        <p className="fine-print">
          {tr(
            "With control enabled: {{calls}} calls/year reserved; telemetry {{monitor}}, scheduled checks {{scheduled}}, reserve assessments {{assessment}}.",
            {
              calls: formatNumber(preview.reservedAnnual),
              monitor: minutes(preview.monitorMs),
              scheduled: minutes(preview.scheduledMs),
              assessment: minutes(preview.assessmentMs),
            },
          )}
        </p>
      )}
      <p className="fine-print">
        {tr(
          "Control capacity covers continuous monitoring, native assessments and scheduled charging. Pause keeps this reservation. Disable workspace control to release it; unresolved cleanup remains protected.",
        )}
      </p>
      <p className="fine-print">
        {tr(
          "Manual diagnostics, authentication and transitions use the planning margin. Actual requests still obey the rolling limit and recovery reserve.",
        )}
      </p>
    </details>
  );
}
