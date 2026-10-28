import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BellRing } from "lucide-react";
import { tr } from "./i18n";
import { when } from "./format";
import { Panel } from "./components";
import type { Incident, AlertSummary } from "./types";

export function incidentTitle(item: Incident): string {
  const labels: Record<Incident["kind"], string> = {
    telemetry_stale: "Device readings are overdue",
    device_offline: "Provider reports the inverter offline or in alarm",
    request_failures: "Repeated device checks have failed",
    auth_failure: "Provider authentication was rejected",
    control_fault: "A control check needs attention",
    cleanup_pending: "Scheduled charging cleanup is unconfirmed",
    api_quota: "API capacity needs attention",
    api_capacity: "Monitoring is waiting for API capacity",
  };
  return tr(labels[item.kind]);
}

export function incidentDescription(item: Incident): string {
  if (item.kind === "api_quota")
    return tr(
      item.detailCode === "exhausted"
        ? "The tracked API allowance is exhausted. Device requests may be unavailable, including recovery."
        : item.detailCode === "recovery-only"
          ? "Routine requests are blocked to preserve remaining recovery capacity."
          : "Routine API capacity is low. Review shared usage before starting further automation.",
    );
  const descriptions: Record<Exclude<Incident["kind"], "api_quota">, string> = {
    telemetry_stale:
      "No sufficiently recent device upload is available. Cached responses do not refresh its observation time.",
    device_offline:
      "Check the logger, inverter and provider connection. This is the provider's reported status.",
    request_failures:
      "At least three consecutive device assessments failed. A successful assessment clears this condition.",
    auth_failure:
      "The provider rejected authentication. Check this workspace's SOLARMAN account and OpenAPI credentials. A successful assessment clears this condition.",
    control_fault:
      "Refresh native diagnostics and review the control settings before resuming. Monitoring alone does not clear this fault.",
    cleanup_pending:
      "The service has not confirmed scheduled charging permission off. Check Controls and the inverter; acknowledging this alert does not stop charging.",
    api_capacity:
      "Regular polling is waiting for a shared capacity slot. Account repair, manual diagnostics and scheduled-charge cleanup remain available.",
  };
  return tr(descriptions[item.kind]);
}

export function IncidentSummary({
  alerts,
  timezone,
}: {
  alerts: AlertSummary;
  timezone: string;
}): ReactNode {
  if (!alerts.active && alerts.monitor.state !== "delayed") return null;
  return (
    <Panel
      title={tr("System health")}
      subtitle={tr("{{count}} active alerts", { count: alerts.active })}
      className="incident-summary"
      action={<BellRing size={20} />}
    >
      {alerts.monitor.state === "delayed" && (
        <p className="incident-message">
          {tr(
            "The operational monitor is overdue. Alert status may be out of date.",
          )}
        </p>
      )}
      <ul className="incident-preview">
        {alerts.items.map((item) => (
          <li key={item.id} className={item.severity}>
            <strong>{incidentTitle(item)}</strong>
            <span>
              {tr(
                item.severity === "critical" ? "Critical" : "Attention needed",
              )}
              {item.acknowledgedAt ? ` · ${tr("Seen")}` : ""}
            </span>
            <small>
              {tr("Last detected {{time}}", {
                time: when(item.lastSeenAt, timezone),
              })}
            </small>
          </li>
        ))}
      </ul>
      <Link className="text-link" to="/settings/health">
        {tr("Review health and alerts")} <ArrowRight size={14} />
      </Link>
      {alerts.unseen > 0 && (
        <span className="fine-print incident-unseen">
          {tr("{{count}} unseen alerts", { count: alerts.unseen })}
        </span>
      )}
    </Panel>
  );
}
