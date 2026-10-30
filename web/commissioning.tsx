import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Clock, ShieldCheck } from "lucide-react";
import { useWorkspace } from "./context";
import { useData, request, isUnconfirmedResponse } from "./api";
import { tr } from "./i18n";
import {
  Heading,
  Loading,
  Notice,
  Panel,
  commandLabel,
  when,
} from "./components";
import { FirmwareEvidence } from "./firmware-evidence";
import type { CommissioningData, CommissioningHistoryReview, CommissioningRequirement } from "./types";
import { formatNumber } from "./format";

const requirements: Record<
  NonNullable<CommissioningData["run"]>["requirements"][number]["code"],
  string
> = {
  solar: "Solar charging above 50%",
  discharge: "Battery supplies the home above 50%",
  gridCharge: "Grid reserve charging near 2 kW",
  gridStop: "Grid charging stops at 50%",
  dayNight: "Complete day and night observation",
  recovery: "Verified scheduled-charge recovery",
};
const requirementHints: Record<CommissioningRequirement["code"], string> = {
  solar:
    "Needs solar surplus, little grid import and rising SOC above the grid target.",
  discharge:
    "Needs battery discharge with falling SOC above the reserve. Grid support for additional house demand is allowed.",
  gridCharge:
    "Needs two distinct readings with little solar, battery charging near 2 kW and grid import above house demand.",
  gridStop:
    "Needs charging below the reserve followed promptly by two 50% readings with little solar and no meaningful battery charging. The cause still needs review.",
  dayNight:
    "Needs at least 24 hours, 90% sample coverage, solar production and low-solar readings during local night hours.",
  recovery:
    "Needs a completed attended recovery test or Stop with a verified disable write.",
};
const states: Record<string, string> = {
  preparing: "Preparing commissioning",
  attending: "Attended commissioning",
  approved: "Commissioning approved",
  invalidated: "Commissioning invalidated",
};
const events: Record<string, string> = {
  created: "Commissioning run created",
  attended: "Attended session opened",
  ended: "Attended session ended",
  expired: "Attended session expired",
  evidence: "Commissioning evidence saved",
  approved: "Commissioning approved",
  invalidated: "Commissioning invalidated",
};

export default function CommissioningPage(): ReactNode {
  const {
    session,
    overview,
    command,
    busy,
    submitting,
    reload: reloadOverview,
  } = useWorkspace();
  const { data, loading, error, reload } = useData<CommissioningData>(
    "/commissioning",
    5000,
  );
  const [password, setPassword] = useState("");
  const [attending, setAttending] = useState(false);
  const [recoveryCommandId, setRecoveryCommandId] = useState("");
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [historyReview, setHistoryReview] = useState<CommissioningHistoryReview | null>(null);
  const timezone = session.tenant.timezone;
  const run = data?.run;
  const control = overview?.controller.control;
  const selectedRecovery = data?.recoveryCommands.find(
    (command) => command.id === recoveryCommandId,
  );
  const availableCodes = new Set(
    (historyReview?.requirements ?? data?.availableObservation?.requirements ?? [])
      .filter((item) => item.passed && item.code !== "recovery")
      .map((item) => item.code),
  );
  if (selectedRecovery) availableCodes.add("recovery");
  const totalChecks = run?.requirements.length ?? 0;
  const recordedChecks =
    run?.requirements.filter((item) => item.passed).length ?? 0;
  const availableChecks =
    run?.requirements.filter(
      (item) => !item.passed && availableCodes.has(item.code),
    ).length ?? 0;
  const waitingChecks = totalChecks - recordedChecks - availableChecks;
  useEffect(() => {
    setRecoveryConfirmed(false);
  }, [run?.id, run?.state]);
  useEffect(() => {
    setHistoryReview(null);
  }, [run?.id, run?.currentBinding]);
  const change = async (action: string): Promise<void> => {
    setPending(true);
    setMessage(null);
    try {
      await request<CommissioningData>("/commissioning", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({
          action,
          currentPassword: password,
          id: run?.id,
          revision: run?.revision,
          attending,
          observationRunId: data?.availableObservation?.id,
          ...(historyReview ? {
            observationSource: historyReview.source,
            historyThroughId: historyReview.throughId,
            historyHash: historyReview.hash,
          } : {}),
          recoveryCommandId: selectedRecovery?.id,
        }),
      });
      setMessage(tr("Commissioning status updated"));
      setFailed(false);
      setAttending(false);
    } catch (cause: unknown) {
      setFailed(true);
      if (isUnconfirmedResponse(cause)) {
        setUnconfirmed(true);
        setMessage(
          tr(
            "The commissioning change is unconfirmed. Refresh its status before trying again.",
          ),
        );
      } else
        setMessage(
          cause instanceof Error
            ? tr(cause.message)
            : tr("Unable to update commissioning"),
        );
    } finally {
      setPassword("");
      setPending(false);
      reload();
      reloadOverview();
    }
  };
  const confirmStatus = async (): Promise<void> => {
    setPending(true);
    try {
      await request<CommissioningData>("/commissioning");
      setUnconfirmed(false);
      setMessage(null);
      reload();
      reloadOverview();
    } catch (cause: unknown) {
      setFailed(true);
      setMessage(
        cause instanceof Error
          ? tr(cause.message)
          : tr("Unable to update commissioning"),
      );
    } finally {
      setPending(false);
    }
  };
  const reviewHistory = async (): Promise<void> => {
    setPending(true);
    setMessage(null);
    setHistoryReview(null);
    try {
      setHistoryReview(await request<CommissioningHistoryReview>("/commissioning/history"));
      setFailed(false);
    } catch (cause: unknown) {
      setFailed(true);
      setMessage(cause instanceof Error ? tr(cause.message) : tr("Unable to review stored measurements"));
    } finally {
      setPending(false);
    }
  };
  const locked = pending || busy || unconfirmed || !password;
  if (!data)
    return loading ? <Loading /> : <Notice tone="danger">{error}</Notice>;
  return (
    <>
      <Heading
        eyebrow={tr("COMMISSIONING")}
        title={tr("Prove the home policy")}
        description={tr(
          "Settings verification, physical evidence and control approval are recorded separately.",
        )}
        action={
          <Link className="button secondary" to="/controls">
            <ArrowLeft size={16} /> {tr("Back to controls")}
          </Link>
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {message && (
        <Notice tone={failed ? "danger" : undefined}>{message}</Notice>
      )}
      {unconfirmed && (
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => {
            void confirmStatus();
          }}
        >
          {tr("Refresh commissioning status")}
        </button>
      )}
      <Panel
        title={tr(run ? states[run.state] : "No commissioning run")}
        action={<ShieldCheck size={22} />}
      >
        <p>
          {tr(
            "Unattended control needs approved physical evidence for this account, inverter, firmware, timezone and policy. A passing settings report does not grant that approval.",
          )}
        </p>
        {run && (
          <dl className="command-facts">
            <div>
              <dt>{tr("Started")}</dt>
              <dd>{when(run.createdAt, timezone, "medium")}</dd>
            </div>
            <div>
              <dt>{tr("Device")}</dt>
              <dd>{run.identity.device}</dd>
            </div>
            <div>
              <dt>{tr("Firmware")}</dt>
              <dd>
                {run.identity.firmware.protocol} / {run.identity.firmware.dsp} /{" "}
                {run.identity.firmware.hmi}
              </dd>
            </div>
            <div>
              <dt>{tr("Binding")}</dt>
              <dd>
                {tr(
                  run.currentBinding === true
                    ? "Current device binding"
                    : run.currentBinding === false
                      ? "Device binding changed"
                      : "Current device identity is unavailable",
                )}
              </dd>
            </div>
          </dl>
        )}
        <label className="field-label" htmlFor="commissioning-password">
          {tr("Current dashboard password")}
        </label>
        <input
          id="commissioning-password"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={pending}
          onChange={(event) => setPassword(event.target.value)}
        />
        {!run && (
          <button
            className="button primary"
            disabled={locked || !data.canPrepare}
            onClick={() => {
              void change("create");
            }}
          >
            {tr("Prepare commissioning")}
          </button>
        )}
        {!data.canPrepare && (!run || run.state === "preparing") && (
          <p className="fine-print">
            {tr("Pause automation and verify the device before commissioning")}
          </p>
        )}
      </Panel>
      <FirmwareEvidence controller={overview?.controller ?? null} />
      {run && (
        <>
          <Panel
            title={tr("Physical acceptance checklist")}
            subtitle={tr("Saved evidence remains distinct from approval")}
          >
            <div className="observation-progress">
              <strong>
                {tr("{{count}} of {{total}} checks recorded", {
                  count: recordedChecks,
                  total: totalChecks,
                })}
              </strong>
              <div
                className="coverage-track"
                role="progressbar"
                aria-label={tr("Recorded commissioning checks")}
                aria-valuemin={0}
                aria-valuemax={totalChecks}
                aria-valuenow={recordedChecks}
              >
                <i
                  style={{
                    width: `${totalChecks ? (recordedChecks / totalChecks) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
            <dl className="commissioning-counts">
              <div>
                <dt>{tr("Recorded")}</dt>
                <dd>{recordedChecks}</dd>
              </div>
              <div>
                <dt>
                  {tr(
                    data.availableObservation
                      ? "Available to save"
                      : "Available for review",
                  )}
                </dt>
                <dd>{availableChecks}</dd>
              </div>
              <div>
                <dt>{tr("Awaiting evidence")}</dt>
                <dd>{waitingChecks}</dd>
              </div>
            </dl>
            <ul className="commissioning-checklist">
              {run.requirements.map((item): ReactNode => {
                const available = availableCodes.has(item.code);
                return (
                  <li key={item.code}>
                    {item.passed ? (
                      <CheckCircle2 size={19} />
                    ) : (
                      <Clock size={19} />
                    )}
                    <span>
                      <strong>{tr(requirements[item.code])}</strong>
                      <small>
                        {tr(
                          item.passed
                            ? "Recorded evidence"
                            : available
                              ? data.availableObservation
                                ? "Available to save"
                                : "Available for review"
                              : "Still requires commissioning",
                        )}
                      </small>
                      {!item.passed && !available && (
                        <small className="commissioning-hint">
                          {tr(requirementHints[item.code])}
                        </small>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="fine-print">
              {tr(
                "Available evidence is not part of the saved checklist. Save it with your dashboard password; approval remains a separate action.",
              )}
            </p>
            {data.availableObservation?.checkedAt && (
              <p className="fine-print">
                {tr("Available observations checked {{time}}", {
                  time: when(
                    data.availableObservation.checkedAt,
                    timezone,
                    "medium",
                  ),
                })}
              </p>
            )}
            {!data.availableObservation && !historyReview && (
              <p className="fine-print">
                {tr(
                  "No valid observation run is available for this device. Open observations to record readings.",
                )}
              </p>
            )}
            <Link className="text-link" to="/controls/observations">
              {tr("Observe the home policy")}
            </Link>
            <button
              className="button secondary"
              disabled={pending || run.currentBinding !== true || run.state === "approved"}
              onClick={() => { void reviewHistory(); }}
            >
              {tr("Review stored measurements")}
            </button>
            {historyReview && (
              <Notice>
                <p>{tr("Reviewed {{count}} saved readings with {{coverage}}% coverage. {{excluded}} readings outside the normal policy were excluded.", {
                  count: historyReview.sampleCount,
                  coverage: formatNumber(historyReview.window.coverage * 100, 1),
                  excluded: historyReview.excluded,
                })}</p>
                <p>{when(historyReview.startedAt, timezone, "medium")} → {when(historyReview.progress.last?.at ?? historyReview.checkedAt, timezone, "medium")}</p>
                <p>{tr("This review uses measured values and the existing acceptance thresholds. It sends no inverter commands. Saving evidence and approving controls remain separate actions.")}</p>
              </Notice>
            )}
            <label className="field-label" htmlFor="recovery-command">
              {tr("Verified recovery result (optional)")}
            </label>
            <select
              id="recovery-command"
              value={recoveryCommandId}
              disabled={
                pending ||
                run.state === "approved" ||
                run.currentBinding !== true ||
                (!data.recoveryCommands.length && !recoveryCommandId)
              }
              onChange={(event) => setRecoveryCommandId(event.target.value)}
            >
              <option value="">
                {tr(
                  run.evidence.recovery
                    ? "Keep saved recovery evidence"
                    : "Choose a verified recovery result",
                )}
              </option>
              {recoveryCommandId && !selectedRecovery && (
                <option value={recoveryCommandId} disabled>
                  {tr("Selected recovery result is unavailable")}
                </option>
              )}
              {data.recoveryCommands.map((command) => (
                <option key={command.id} value={command.id}>
                  {commandLabel(command.action)} ·{" "}
                  {when(command.completedAt, timezone, "medium")}
                </option>
              ))}
            </select>
            {!data.recoveryCommands.length && (
              <p className="fine-print">
                {tr(
                  "No verified recovery result is available from this commissioning run yet. A Stop that only confirms charging was already off does not qualify.",
                )}
              </p>
            )}
            {selectedRecovery && (
              <Link
                className="text-link"
                to={`/activity/${selectedRecovery.id}`}
              >
                {tr("Review selected recovery result")}
              </Link>
            )}
            {run.evidence.recovery && (
              <p className="fine-print">
                <Link
                  className="text-link"
                  to={`/activity/${run.evidence.recovery.commandId}`}
                >
                  {tr("Review saved recovery result")}
                </Link>{" "}
                {when(run.evidence.recovery.completedAt, timezone, "medium")}
              </p>
            )}
            <p className="fine-print">
              {tr(
                "Recovery evidence must belong to this commissioning run and include a verified disable write.",
              )}
            </p>
            <div className="readiness-actions">
              <button
                className="button secondary"
                disabled={
                  locked ||
                  (!data.availableObservation && !historyReview) ||
                  run.currentBinding !== true ||
                  run.state === "approved" ||
                  Boolean(recoveryCommandId && !selectedRecovery)
                }
                onClick={() => {
                  void change("evidence");
                }}
              >
                {tr("Save current observation evidence")}
              </button>
              <button
                className="button primary"
                disabled={
                  locked ||
                  !data.canPrepare ||
                  run.currentBinding !== true ||
                  run.state !== "preparing" ||
                  run.requirements.some((item) => !item.passed)
                }
                onClick={() => {
                  void change("approve");
                }}
              >
                {tr("Approve unattended control")}
              </button>
            </div>
            {run.evidence.observation && (
              <p className="fine-print">
                {tr("Evidence last checked {{time}}", {
                  time: when(
                    run.evidence.observation.checkedAt,
                    timezone,
                    "medium",
                  ),
                })}
              </p>
            )}
          </Panel>
          <Panel
            title={tr("Attended tests")}
            subtitle={tr(
              "Explicit tests while normal automation remains paused",
            )}
          >
            {overview?.controller.recoveryTesting && (
              <Notice>
                {tr(
                  "The attended permission-recovery test is running. Stop scheduled top-ups remains available; unattended automation stays paused.",
                )}
              </Notice>
            )}
            <p>
              {tr(
                "A session lasts {{count}} minutes. Application expiry cannot guarantee physical cleanup while the provider or inverter is unreachable; stored charging windows repeat daily.",
                { count: data.attendedMinutes },
              )}
            </p>
            {run.state === "preparing" && (
              <>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={attending}
                    disabled={pending}
                    onChange={(event) => setAttending(event.target.checked)}
                  />
                  {tr(
                    "I am attending the inverter test and can verify its physical behavior and recovery.",
                  )}
                </label>
                <button
                  className="button secondary"
                  disabled={
                    locked ||
                    !attending ||
                    !data.canPrepare ||
                    !control?.canCommission
                  }
                  onClick={() => {
                    void change("attend");
                  }}
                >
                  {tr("Open attended session")}
                </button>
                {!control?.serverAllowed && (
                  <p className="fine-print">
                    {tr(
                      "The server operator must enable inverter writes before attended tests are available.",
                    )}
                  </p>
                )}
              </>
            )}
            {run.state === "attending" && (
              <>
                <p>
                  {tr("Session expires {{time}}", {
                    time: when(run.attendedUntil ?? "", timezone, "medium"),
                  })}
                </p>
                <div className="readiness-actions">
                  <button
                    className="button secondary"
                    disabled={
                      pending ||
                      busy ||
                      unconfirmed ||
                      !control?.canCommission ||
                      !control.commissioning.attended ||
                      control.workspaceEnabled
                    }
                    onClick={() => {
                      void command("commission_controls");
                    }}
                  >
                    {tr("Enable attended controls")}
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      pending ||
                      busy ||
                      unconfirmed ||
                      !control?.canCommission ||
                      !control.commissioning.attended ||
                      !control.workspaceEnabled ||
                      (overview?.latest?.soc ?? 100) >= 50
                    }
                    onClick={() => {
                      void command("commission_topup");
                    }}
                  >
                    {tr("Test grid top-up to 50%")}
                  </button>
                  <button
                    className="button secondary"
                    disabled={submitting || !control?.canStop}
                    onClick={() => {
                      void command("stop");
                    }}
                  >
                    {tr("Stop scheduled top-ups")}
                  </button>
                  <button
                    className="button secondary"
                    disabled={locked}
                    onClick={() => {
                      void change("end");
                    }}
                  >
                    {tr("End attended session")}
                  </button>
                </div>
                <p className="fine-print">
                  {tr(
                    "At 52% battery or above, this briefly enables scheduled AC charging permission, then verifies it off. SOC targets, power settings and charging windows are preserved.",
                  )}
                </p>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={recoveryConfirmed}
                    disabled={pending || busy || submitting || unconfirmed}
                    onChange={(event) =>
                      setRecoveryConfirmed(event.target.checked)
                    }
                  />
                  {tr(
                    "I understand that scheduled charging permission will be enabled briefly during this attended test.",
                  )}
                </label>
                <button
                  className="button secondary"
                  disabled={
                    pending ||
                    busy ||
                    submitting ||
                    unconfirmed ||
                    !recoveryConfirmed ||
                    !control?.canCommission ||
                    !control.commissioning.attended ||
                    !control.workspaceEnabled ||
                    (overview?.latest?.soc ?? 0) < 52
                  }
                  onClick={() => {
                    setRecoveryConfirmed(false);
                    void command("commission_recovery");
                  }}
                >
                  {tr("Test scheduled-permission recovery")}
                </button>
              </>
            )}
            <Link className="text-link" to="/activity">
              {tr("Review command history")}
            </Link>
          </Panel>
          <Panel title={tr("Recent commissioning events")}>
            <ul className="commissioning-events">
              {run.events.map((item) => (
                <li key={item.revision}>
                  <strong>
                    {tr(events[item.action] ?? "Commissioning status updated")}
                  </strong>
                  <time>{when(item.created_at, timezone, "medium")}</time>
                </li>
              ))}
            </ul>
            <button
              className="button secondary"
              disabled={locked}
              onClick={() => {
                void change("invalidate");
              }}
            >
              {tr("Invalidate this commissioning run")}
            </button>
          </Panel>
        </>
      )}
      {data.history.length > 0 && (
        <Panel
          title={tr("Commissioning history")}
          subtitle={tr(
            "Latest 20 runs. Complete records are included in the workspace archive.",
          )}
        >
          <ul className="commissioning-events">
            {data.history.map((item) => (
              <li key={item.id}>
                <strong>{tr(states[item.state])}</strong>
                <time>{when(item.created_at, timezone, "medium")}</time>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
