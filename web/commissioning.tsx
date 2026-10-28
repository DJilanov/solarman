import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Clock, ShieldCheck } from "lucide-react";
import { useWorkspace } from "./context";
import { useData, request, isUnconfirmedResponse } from "./api";
import { tr } from "./i18n";
import { Heading, Loading, Notice, Panel, when } from "./components";
import type { CommissioningData, PolicyObservationData } from "./types";

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
  sourceLimits: "Independent grid and solar power limits",
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
  const observations = useData<PolicyObservationData>(
    "/policy-observations",
    15000,
  );
  const [password, setPassword] = useState("");
  const [attending, setAttending] = useState(false);
  const [recoveryCommandId, setRecoveryCommandId] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const timezone = session.tenant.timezone;
  const run = data?.run;
  const control = overview?.controller.control;
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
          observationRunId: observations.data?.run?.id,
          recoveryCommandId: recoveryCommandId || undefined,
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
            {tr("Back to controls")}
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
        {!data.canPrepare && !run && (
          <p className="fine-print">
            {tr("Pause automation and verify the device before commissioning")}
          </p>
        )}
      </Panel>
      {run && (
        <>
          <Panel
            title={tr("Physical acceptance checklist")}
            subtitle={tr("Saved evidence remains distinct from approval")}
          >
            <ul className="commissioning-checklist">
              {run.requirements.map((item) => (
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
                          : "Still requires commissioning",
                      )}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
            <Notice>
              {tr(
                "The firmware mapping for independent source limits is unverified. Approval stays blocked until the requested 2 kW grid and 5 kW solar limits are established.",
              )}
            </Notice>
            <Link className="text-link" to="/controls/observations">
              {tr("Observe the home policy")}
            </Link>
            <label className="field-label" htmlFor="recovery-command">
              {tr("Verified recovery command ID (optional)")}
            </label>
            <input
              id="recovery-command"
              value={recoveryCommandId}
              maxLength={36}
              disabled={pending}
              onChange={(event) => setRecoveryCommandId(event.target.value)}
            />
            <p className="fine-print">
              {tr(
                "Recovery evidence requires a successful Stop command with a verified disable write from this commissioning run.",
              )}
            </p>
            <div className="readiness-actions">
              <button
                className="button secondary"
                disabled={
                  locked ||
                  !observations.data?.run ||
                  run.currentBinding !== true
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
