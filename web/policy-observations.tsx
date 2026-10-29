import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Clock,
  RefreshCw,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { request, useData, isUnconfirmedResponse } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { Heading, Panel, Notice, Loading, when } from "./components";
import { formatNumber } from "./format";
import type {
  ObservationEvidence,
  ObservationSample,
  ObservationState,
  PolicyObservationData,
  PolicyObservationRun,
} from "./types";

function runLabel(state: ObservationState): string {
  switch (state) {
    case "observing":
      return tr("Recording observations");
    case "stopped":
      return tr("Observation run ended");
    case "invalidated":
      return tr("Observation run invalidated");
  }
}
function invalidationLabel(reason: string | null): string {
  switch (reason) {
    case "rollback":
      return tr("This run was interrupted by an application rollback.");
    case "restore":
      return tr("This run was interrupted by a database restore.");
    case "connection_changed":
      return tr(
        "Provider access or inverter settings changed. Start a new run after verification.",
      );
    case "workspace_changed":
      return tr(
        "Workspace availability changed. This run is retained as history.",
      );
    default:
      return tr(
        "The device or firmware binding changed. This evidence belongs to the earlier binding.",
      );
  }
}
function EvidenceReadings({
  evidence,
  timezone,
}: {
  evidence: ObservationEvidence;
  timezone: string;
}): ReactNode {
  const samples = [evidence.first, evidence.last].filter(
    (value): value is ObservationSample => Boolean(value),
  );
  if (!samples.length) return null;
  const distinct = samples.filter(
    (value, index) => index === 0 || value.id !== samples[0]?.id,
  );
  return (
    <details className="observation-readings">
      <summary>{tr("Show evidence readings")}</summary>
      <div
        className="readings-table"
        tabIndex={0}
        role="region"
        aria-label={tr("Evidence readings")}
      >
        <table>
          <thead>
            <tr>
              <th>{tr("Time")}</th>
              <th>{tr("Battery SOC")}</th>
              <th>{tr("Solar")}</th>
              <th>{tr("House")}</th>
              <th>{tr("Grid")}</th>
              <th>{tr("Battery")}</th>
            </tr>
          </thead>
          <tbody>
            {distinct.map((sample) => (
              <tr key={sample.id}>
                <td>{when(sample.at, timezone, "medium")}</td>
                <td>{formatNumber(sample.soc)}%</td>
                {[sample.pvW, sample.loadW, sample.gridW, sample.batteryW].map(
                  (value, index) => (
                    <td key={index}>{formatNumber(value)} W</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine-print">
        {tr(
          "Grid import and battery discharge are positive; export and charging are negative.",
        )}
      </p>
    </details>
  );
}
function EvidenceCard({
  title,
  hint,
  evidence,
  timezone,
}: {
  title: string;
  hint: string;
  evidence: ObservationEvidence;
  timezone: string;
}): ReactNode {
  const observed = Boolean(evidence.observedAt);
  return (
    <article className={`observation-card ${observed ? "observed" : ""}`}>
      <div className="observation-card-heading">
        {observed ? <CheckCircle2 size={20} /> : <Clock size={20} />}
        <div>
          <h3>{title}</h3>
          <strong>
            {tr(observed ? "Observed in readings" : "Waiting for conditions")}
          </strong>
        </div>
      </div>
      <p>{hint}</p>
      {evidence.observedAt && (
        <small>
          {tr("Observed {{time}}", {
            time: when(evidence.observedAt, timezone, "medium"),
          })}
        </small>
      )}
      <EvidenceReadings evidence={evidence} timezone={timezone} />
    </article>
  );
}
function RunEvidence({ run }: { run: PolicyObservationRun }): ReactNode {
  const { progress, window } = run,
    timezone = run.identity.timezone;
  const count =
    [
      progress.solar,
      progress.discharge,
      progress.gridCharge,
      progress.gridStop,
    ].filter((step) => step.observedAt).length + Number(window.cycleObserved);
  return (
    <>
      <Panel
        title={tr("Observed battery behavior")}
        subtitle={tr(
          "Readings are evidence for review; they do not certify unattended control.",
        )}
        action={<Activity size={22} />}
      >
        <div className="observation-progress">
          <strong>{tr("{{count}} of 5 observation signals", { count })}</strong>
          <div className="coverage-track">
            <span style={{ width: `${count * 20}%` }} />
          </div>
          <span>
            {tr("{{count}} accepted readings", { count: progress.accepted })}
          </span>
        </div>
        <div className="observation-grid">
          <EvidenceCard
            title={tr("Solar charging above 50%")}
            hint={tr(
              "Needs solar surplus, little grid import and rising SOC above the grid target.",
            )}
            evidence={progress.solar}
            timezone={timezone}
          />
          <EvidenceCard
            title={tr("Battery supporting the home above 50%")}
            hint={tr(
              "Needs battery discharge with falling SOC above the reserve. Grid support for additional house demand is allowed.",
            )}
            evidence={progress.discharge}
            timezone={timezone}
          />
          <EvidenceCard
            title={tr("Charging below 50% near 2 kW")}
            hint={tr(
              "Needs two distinct readings with little solar, battery charging near 2 kW and grid import above house demand.",
            )}
            evidence={progress.gridCharge}
            timezone={timezone}
          />
          <EvidenceCard
            title={tr("Charging transition at 50%")}
            hint={tr(
              "Needs charging below the reserve followed promptly by two 50% readings with little solar and no meaningful battery charging. The cause still needs review.",
            )}
            evidence={progress.gridStop}
            timezone={timezone}
          />
          <article
            className={`observation-card ${window.cycleObserved ? "observed" : ""}`}
          >
            <div className="observation-card-heading">
              {window.cycleObserved ? (
                <CheckCircle2 size={20} />
              ) : (
                <Sun size={20} />
              )}
              <div>
                <h3>{tr("Full day and night observation window")}</h3>
                <strong>
                  {tr(
                    window.cycleObserved
                      ? "Window recorded"
                      : "More observation time needed",
                  )}
                </strong>
              </div>
            </div>
            <p>
              {tr(
                "Needs at least 24 hours, 90% sample coverage, solar production and low-solar readings during local night hours.",
              )}
            </p>
            <dl className="command-facts">
              <div>
                <dt>{tr("Observation hours")}</dt>
                <dd>{formatNumber(window.spanSeconds / 3600, 1)}</dd>
              </div>
              <div>
                <dt>{tr("Sample coverage")}</dt>
                <dd>{formatNumber(window.coverage * 100, 1)}%</dd>
              </div>
            </dl>
          </article>
        </div>
        {progress.rejected > 0 && (
          <p className="fine-print">
            {tr(
              "{{count}} readings excluded because their values or source timing were unsuitable.",
              { count: progress.rejected },
            )}
          </p>
        )}
      </Panel>
      <Panel
        title={tr("Policy recorded at the start")}
        subtitle={tr(
          "Historical configuration remains separate from the latest device verification.",
        )}
      >
        <dl className="command-facts">
          <div>
            <dt>{tr("Inverter")}</dt>
            <dd>
              {run.identity.model} · {run.identity.device}
            </dd>
          </div>
          <div>
            <dt>{tr("Device verification")}</dt>
            <dd>{when(run.verification.checkedAt, timezone, "medium")}</dd>
          </div>
          <div>
            <dt>{tr("Firmware")}</dt>
            <dd>
              {run.identity.firmware.protocol} / {run.identity.firmware.dsp} /{" "}
              {run.identity.firmware.hmi}
            </dd>
          </div>
          <div>
            <dt>{tr("Timezone")}</dt>
            <dd>{timezone}</dd>
          </div>
        </dl>
        <div className="observation-targets">
          <span>
            {tr("Grid target")}
            <strong>50%</strong>
          </span>
          <span>
            {tr("Solar SOC target")}
            <strong>100%</strong>
          </span>
          <span>
            {tr("AC charging setting")}
            <strong>{tr("2 kW")}</strong>
          </span>
        </div>
        <Link className="text-link" to="/controls">
          {tr("Review current control readiness")}
        </Link>
      </Panel>
    </>
  );
}
export default function PolicyObservationsPage(): ReactNode {
  const { session } = useWorkspace();
  const [search, setSearch] = useSearchParams();
  const runId = search.get("run");
  const { data, error, loading, reload } = useData<PolicyObservationData>(
    `/policy-observations${runId ? `?run=${encodeURIComponent(runId)}` : ""}`,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const change = async (action: "start" | "stop" | "check"): Promise<void> => {
    setPending(action);
    setMessage(null);
    try {
      await request<PolicyObservationData>("/policy-observations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({ action, id: data?.run?.id }),
      });
      if (action === "start") setSearch({});
      setMessage({
        text:
          action === "start"
            ? "Observation run started. New stored readings will be evaluated."
            : action === "stop"
              ? "Observation run ended. Recorded evidence is retained."
              : "Stored observation evidence checked.",
        error: false,
      });
    } catch (cause) {
      setMessage({
        text: isUnconfirmedResponse(cause)
          ? "The observation change is unconfirmed. Reload its status before trying again."
          : cause instanceof Error
            ? cause.message
            : "Unable to update observations",
        error: true,
      });
    } finally {
      setPending(null);
      reload();
    }
  };
  return (
    <>
      <Heading
        eyebrow={tr("COMMISSIONING EVIDENCE")}
        title={tr("Observe the home policy")}
        description={tr(
          "Record what the battery actually does before relying on unattended automation.",
        )}
        action={
          <Link className="button secondary" to="/controls">
            <ArrowLeft size={16} />
            {tr("Back to controls")}
          </Link>
        }
      />
      <Notice>
        {tr(
          "Uses stored readings without additional SOLARMAN calls. Starting or ending observations does not activate automation.",
        )}
      </Notice>
      {message && (
        <Notice tone={message.error ? "danger" : undefined}>
          {tr(message.text)}
        </Notice>
      )}
      {error && (
        <Notice tone="danger">
          {tr(error)}{" "}
          <button className="text-link" onClick={reload}>
            {tr("Retry")}
          </button>
        </Notice>
      )}
      {!data ? (
        loading ? (
          <Loading />
        ) : null
      ) : (
        <>
          <Panel
            title={tr("Observation run")}
            subtitle={tr(
              "Each run belongs to one verified device, firmware and timezone.",
            )}
            action={<ShieldCheck size={22} />}
          >
            {data.run ? (
              <>
                <strong>{runLabel(data.run.state)}</strong>
                {data.run.state === "invalidated" && (
                  <Notice tone="danger">
                    {invalidationLabel(data.run.reason)}
                  </Notice>
                )}
                {data.run.currentBinding === false &&
                  data.run.state !== "invalidated" && (
                    <Notice>
                      {tr(
                        "This evidence belongs to an earlier device binding.",
                      )}
                    </Notice>
                  )}
                {data.run.currentBinding === null && (
                  <Notice>
                    {tr(
                      "The current device identity is unavailable. Recorded evidence is retained without assuming the binding changed.",
                    )}
                  </Notice>
                )}
                <dl className="command-facts">
                  <div>
                    <dt>{tr("Started")}</dt>
                    <dd>
                      {when(
                        data.run.startedAt,
                        data.run.identity.timezone,
                        "medium",
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{tr("Last evidence check")}</dt>
                    <dd>
                      {data.run.checkedAt
                        ? when(
                            data.run.checkedAt,
                            data.run.identity.timezone,
                            "medium",
                          )
                        : tr("Waiting for the first check")}
                    </dd>
                  </div>
                  <div>
                    <dt>{tr("Last source reading")}</dt>
                    <dd>
                      {data.run.progress.last
                        ? when(
                            data.run.progress.last.at,
                            data.run.identity.timezone,
                            "medium",
                          )
                        : tr("No new qualifying readings yet")}
                    </dd>
                  </div>
                </dl>
                {data.run.failedAt && (
                  <Notice tone="danger">
                    {tr(
                      "The latest evidence check failed. Earlier evidence is retained; retry checking stored readings.",
                    )}
                  </Notice>
                )}
              </>
            ) : (
              <p>
                {tr(
                  "No observation run yet. Verify the device in Controls, then record its normal behavior through daylight and night.",
                )}
              </p>
            )}
            <div className="readiness-actions">
              <button
                className="button primary"
                disabled={
                  Boolean(pending) ||
                  !data.canStart ||
                  Boolean(data.activeRunId)
                }
                onClick={() => {
                  void change("start");
                }}
              >
                {tr("Start observations")}
              </button>
              {data.run?.state === "observing" && (
                <>
                  <button
                    className="button secondary"
                    disabled={Boolean(pending)}
                    onClick={() => {
                      void change("check");
                    }}
                  >
                    <RefreshCw size={16} />
                    {tr("Check stored evidence")}
                  </button>
                  <button
                    className="button secondary"
                    disabled={Boolean(pending)}
                    onClick={() => {
                      void change("stop");
                    }}
                  >
                    {tr("End observation run")}
                  </button>
                </>
              )}
              <button
                className="button secondary"
                disabled={Boolean(pending)}
                onClick={reload}
              >
                {tr("Reload observation status")}
              </button>
            </div>
            {!data.canStart && !data.activeRunId && (
              <p className="fine-print">
                {tr(
                  "Fresh passing device verification and an active workspace are required to start a run. Host write permission is not needed.",
                )}
              </p>
            )}
            {data.activeRunId && data.run?.id !== data.activeRunId && (
              <button
                className="text-link"
                onClick={() => setSearch({ run: data.activeRunId! })}
              >
                {tr("View the active observation run")}
              </button>
            )}
          </Panel>
          {data.run && <RunEvidence run={data.run} />}
          <Panel title={tr("Still requires commissioning")}>
            <p>
              {tr(
                "Solar charging follows the inverter and battery limits, up to the 100% SOC target.",
              )}
            </p>
            <p>
              {tr(
                "Mixed-source charging needs separate verification of the grid contribution. Total battery power alone is insufficient.",
              )}
            </p>
            <p>
              {tr(
                "Stop, delayed commands, API outage, restart and midnight behavior require recorded recovery tests before unattended control.",
              )}
            </p>
          </Panel>
          {data.history.length > 0 && (
            <Panel
              title={tr("Recent observation runs")}
              subtitle={tr(
                "The latest 20 runs are shown. The workspace archive includes the complete history.",
              )}
            >
              <div className="readings-table">
                <table>
                  <thead>
                    <tr>
                      <th>{tr("Started")}</th>
                      <th>{tr("Status")}</th>
                      <th>{tr("Details")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((run) => (
                      <tr key={run.id}>
                        <td>
                          {when(
                            run.started_at,
                            session.tenant.timezone,
                            "medium",
                          )}
                        </td>
                        <td>{runLabel(run.state)}</td>
                        <td>
                          <button
                            className="text-link"
                            onClick={() => setSearch({ run: run.id })}
                          >
                            {tr("View observation run")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </>
  );
}
