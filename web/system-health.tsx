import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { request, useData } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { formatNumber, when } from "./format";
import { Heading, Loading, Notice, Panel } from "./components";
import { incidentDescription, incidentTitle } from "./incident-summary";
import type { OperationsData } from "./types";
import { BackupHealth } from "./backup-health";
import { ErasureHealth } from "./workspace-offboarding";

export default function SystemHealthPage(): ReactNode {
  const { session } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const filterParam = params.get("filter");
  const filter =
    filterParam && ["active", "resolved", "all"].includes(filterParam)
      ? filterParam
      : "active";
  const offsetText = params.get("offset") ?? "0";
  const offset = /^\d{1,6}$/.test(offsetText) ? Number(offsetText) : 0;
  const { data, error, loading, reload } = useData<OperationsData>(
    `/operations?filter=${filter}&offset=${offset}`,
    5000,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const timezone = session.tenant.timezone;
  const date = (value: string | null): string =>
    value ? when(value, timezone, "medium") : tr("Not recorded");
  const acknowledge = async (id: string, revision: number): Promise<void> => {
    setPending(id);
    setActionError(null);
    try {
      await request(`/incidents/${id}/acknowledge`, {
        method: "POST",
        headers: {
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision }),
      });
      reload();
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Unable to update the alert",
      );
    } finally {
      setPending(null);
    }
  };
  return (
    <>
      <Heading
        eyebrow={tr("RELIABLE MONITORING")}
        title={tr("System health")}
        description={tr(
          "Device freshness, control recovery and persistent alerts for this workspace.",
        )}
        action={
          <button
            className="button secondary small"
            onClick={reload}
            disabled={loading}
          >
            <RefreshCw size={15} />
            {tr("Refresh status")}
          </button>
        }
      />
      <Link className="text-link command-back" to="/settings">
        <ArrowLeft size={15} />
        {tr("Back to settings")}
      </Link>
      {(error || actionError) && (
        <Notice tone="danger">{error || actionError}</Notice>
      )}
      {!data && loading && <Loading />}
      {data && (
        <>
          {data.monitor.state === "delayed" && (
            <Notice tone="danger">
              {tr(
                "The operational monitor is overdue. Alert status may be out of date.",
              )}
            </Notice>
          )}
          <Panel title={tr("Monitoring status")} className="health-facts">
            {data.deviceHealth?.capacityWaiting && (
              <Notice>
                {tr("Monitoring is waiting for shared API capacity")}
              </Notice>
            )}
            <dl className="command-facts">
              <div>
                <dt>{tr("Last operational check")}</dt>
                <dd>{date(data.monitor.checkedAt)}</dd>
              </div>
              {data.deviceHealth && (
                <>
                  <div>
                    <dt>{tr("Inverter")}</dt>
                    <dd>
                      <code>{data.deviceHealth.device}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{tr("Last device assessment")}</dt>
                    <dd>{date(data.deviceHealth.attemptedAt)}</dd>
                  </div>
                  <div>
                    <dt>{tr("Last successful assessment")}</dt>
                    <dd>{date(data.deviceHealth.succeededAt)}</dd>
                  </div>
                  <div>
                    <dt>{tr("Last device upload")}</dt>
                    <dd>{date(data.deviceHealth.uploadedAt)}</dd>
                  </div>
                  <div>
                    <dt>{tr("Persistent delay threshold")}</dt>
                    <dd>
                      {tr("{{value}} minutes", {
                        value: formatNumber(
                          data.deviceHealth.staleAfterSeconds / 60,
                          1,
                          0,
                        ),
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{tr("Consecutive assessment failures")}</dt>
                    <dd>{formatNumber(data.deviceHealth.failures)}</dd>
                  </div>
                </>
              )}
            </dl>
            <p className="fine-print">
              {tr(
                data.deviceHealth
                  ? "Successful communication and fresh device uploads are separate. This status does not prove physical charging behavior."
                  : "Select an inverter to begin device health monitoring.",
              )}
            </p>
            <p className="fine-print">
              <Link className="text-link" to="/settings/notifications">
                {tr("Review notification delivery and settings")}
              </Link>
            </p>
          </Panel>
          {session.user.platformAdmin && data.backup && (
            <BackupHealth status={data.backup} timezone={timezone} />
          )}
          {session.user.platformAdmin && data.erasure && (
            <ErasureHealth status={data.erasure} />
          )}
          <div className="activity-toolbar">
            <label className="health-filter">
              {tr("Show alerts")}
              <select
                value={filter}
                onChange={(event) =>
                  setParams({ filter: event.target.value, offset: "0" })
                }
              >
                <option value="active">{tr("Active")}</option>
                <option value="resolved">{tr("Resolved alerts")}</option>
                <option value="all">{tr("All alerts")}</option>
              </select>
            </label>
            <span className="fine-print">
              {tr("{{count}} matching alerts", { count: data.total })}
            </span>
          </div>
          {data.items.length ? (
            <div className="incident-list">
              {data.items.map((item) => (
                <Panel
                  key={item.id}
                  title={incidentTitle(item)}
                  className={`incident-card ${item.severity}`}
                  action={
                    <span
                      className={`badge ${item.resolvedAt ? "succeeded" : item.severity === "critical" ? "failed" : "pending"}`}
                    >
                      {tr(
                        item.resolvedAt
                          ? "Resolved"
                          : item.severity === "critical"
                            ? "Critical"
                            : "Attention needed",
                      )}
                    </span>
                  }
                >
                  <p className="command-result">
                    {item.resolvedAt
                      ? tr("Recorded condition: {{description}}", {
                          description: incidentDescription(item),
                        })
                      : incidentDescription(item)}
                  </p>
                  <dl className="command-facts">
                    <div>
                      <dt>{tr("Inverter")}</dt>
                      <dd>
                        <code>{item.device}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{tr("First detected")}</dt>
                      <dd>{date(item.firstSeenAt)}</dd>
                    </div>
                    <div>
                      <dt>{tr("Last detected")}</dt>
                      <dd>{date(item.lastSeenAt)}</dd>
                    </div>
                    {item.acknowledgedAt && (
                      <div>
                        <dt>{tr("Marked as seen")}</dt>
                        <dd>{date(item.acknowledgedAt)}</dd>
                      </div>
                    )}
                    {item.resolvedAt && (
                      <div>
                        <dt>{tr("Resolved")}</dt>
                        <dd>
                          {date(item.resolvedAt)} ·{" "}
                          {tr(
                            item.resolutionReason === "binding_changed"
                              ? "Monitoring binding changed"
                              : "Condition no longer detected",
                          )}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {!item.resolvedAt && !item.acknowledgedAt && (
                    <button
                      className="button secondary small"
                      disabled={pending !== null}
                      onClick={() => {
                        void acknowledge(item.id, item.revision);
                      }}
                    >
                      <Check size={15} />
                      {tr(pending === item.id ? "Saving…" : "Mark as seen")}
                    </button>
                  )}
                  {item.acknowledgedAt && !item.resolvedAt && (
                    <p className="fine-print">
                      {tr("Seen; the condition is still active.")}
                    </p>
                  )}
                  {item.kind === "cleanup_pending" && (
                    <Link
                      className="text-link incident-controls"
                      to="/controls"
                    >
                      {tr("Review control readiness")}
                    </Link>
                  )}
                </Panel>
              ))}
            </div>
          ) : (
            <Panel>
              <p className="command-empty">
                {tr(
                  filter === "active"
                    ? "No active workspace alerts recorded."
                    : "No alerts match this filter.",
                )}
              </p>
            </Panel>
          )}
          {(offset > 0 || data.hasMore) && (
            <div className="pagination">
              <span>
                {data.items.length > 0 &&
                  tr("Showing entries {{from}}–{{to}}", {
                    from: formatNumber(offset + 1),
                    to: formatNumber(offset + data.items.length),
                  })}
              </span>
              <div>
                <button
                  className="button secondary small"
                  disabled={!offset}
                  onClick={() =>
                    setParams({
                      filter,
                      offset: String(Math.max(0, offset - 25)),
                    })
                  }
                >
                  <ChevronLeft size={15} />
                  {tr("Previous")}
                </button>
                <button
                  className="button secondary small"
                  disabled={!data.hasMore}
                  onClick={() =>
                    setParams({ filter, offset: String(offset + 25) })
                  }
                >
                  {tr("Next")}
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
