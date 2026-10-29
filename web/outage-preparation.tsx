import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  BatteryCharging,
  Check,
  PlugZap,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { isUnconfirmedResponse, request, useData } from "./api";
import { useWorkspace } from "./context";
import { Heading, Loading, Notice, Panel } from "./components";
import { age, formatNumber, when } from "./format";
import { tr } from "./i18n";
import type { Command, OutageData, OutagePreparation } from "./types";
import { readingIsStale } from "./reading-freshness";

const openStates = new Set([
  "queued",
  "applying",
  "active",
  "restoring",
  "recovery-required",
  "quarantined",
]);
const stateLabels: Record<OutagePreparation["state"], string> = {
  queued: "Preparation requested",
  applying: "Applying your reserve",
  active: "Outage reserve is set",
  restoring: "Returning to normal",
  "recovery-required": "Restoration needs attention",
  restored: "Normal settings restored",
  failed: "Preparation did not start",
  quarantined: "Review the saved reserve",
};

export default function OutagePreparationPage(): ReactNode {
  const { overview, session, reload: reloadOverview, busy } = useWorkspace();
  const {
    data,
    error: loadError,
    loading,
    reload,
  } = useData<OutageData>("/outage", 5000);
  const [target, setTarget] = useState(90);
  const [confirm, setConfirm] = useState<"prepare" | "test" | "restore" | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Command | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [password, setPassword] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const requestLock = useRef(false);
  const confirmation = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!confirm) return;
    confirmation.current?.scrollIntoView({ block: "nearest" });
    confirmation.current?.focus({ preventScroll: true });
  }, [confirm]);
  const completed = useData<Command | OutageData>(
    result ? `/commands/${result.id}` : "/outage",
    3000,
  );
  const preparation = data?.preparation;
  const active = Boolean(
    preparation &&
    preparation.purpose !== "night" &&
    openStates.has(preparation.state),
  );
  const currentJob =
    completed.data &&
    "status" in completed.data &&
    completed.data.id === result?.id
      ? completed.data
      : result;
  const outstanding =
    currentJob?.status === "queued" || currentJob?.status === "running";
  const locked =
    pending || Boolean(outstanding) || uncertain || Boolean(loadError);
  const refresh = (): void => {
    reload();
    reloadOverview();
    completed.reload();
  };
  const save = async (): Promise<void> => {
    if (!data || !confirm || requestLock.current) return;
    if (
      confirm === "restore"
        ? !data.canRestore
        : confirm === "test"
          ? !data.canTest
          : !data.canPrepare
    )
      return;
    requestLock.current = true;
    setPending(true);
    setError(null);
    setUncertain(false);
    try {
      const command = await request<Command>(
        confirm === "restore" ? "/outage/restore" : "/outage/prepare",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": session.csrfToken,
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify(
            confirm === "restore"
              ? { revision: preparation?.revision }
              : { targetSoc: target, test: confirm === "test" },
          ),
        },
      );
      setResult(command);
      setConfirm(null);
      refresh();
    } catch (cause) {
      setUncertain(isUnconfirmedResponse(cause));
      setError(
        cause instanceof Error
          ? cause.message
          : "Outage request could not be confirmed",
      );
      setConfirm(null);
      refresh();
    } finally {
      requestLock.current = false;
      setPending(false);
    }
  };
  const approve = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!preparation?.canApprove || !reviewed || requestLock.current) return;
    requestLock.current = true;
    setPending(true);
    setError(null);
    try {
      await request<OutageData>("/outage/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({
          revision: preparation.revision,
          currentPassword: password,
          confirmed: reviewed,
        }),
      });
      setPassword("");
      setReviewed(false);
      refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Outage test approval could not be confirmed",
      );
    } finally {
      requestLock.current = false;
      setPending(false);
    }
  };
  if (!data)
    return loading ? (
      <Loading />
    ) : (
      <Notice tone="danger">
        {tr(loadError ?? "Unable to load outage controls")}{" "}
        <button className="button secondary" onClick={reload}>
          {tr("Refresh")}
        </button>
      </Notice>
    );
  const sample = overview?.latest;
  const fresh =
    sample && overview && !readingIsStale(overview.controller, sample);
  return (
    <div className="outage-page">
      <Link className="text-link" to="/">
        <ArrowLeft size={15} />
        {tr("Back to home")}
      </Link>
      <Heading
        eyebrow={tr("BATTERY RESERVE")}
        title={tr("Prepare for an outage")}
        description={tr(
          "Charge your battery now and keep its energy ready for a power cut.",
        )}
      />
      {preparation?.purpose === "night" &&
        openStates.has(preparation.state) && (
          <Notice tone="info">
            {tr(
              "Night savings is active. Confirming an outage reserve will end the night plan and keep your battery reserved until you return to normal.",
            )}{" "}
            <Link to="/controls/night-savings">
              {tr("Review night savings")}
            </Link>
          </Notice>
        )}
      {loadError && <Notice tone="danger">{tr(loadError)}</Notice>}
      {error && <Notice tone="danger">{tr(error)}</Notice>}
      {uncertain && (
        <Notice tone="danger">
          {tr(
            "The request may have reached the inverter. Check the saved state before sending another request.",
          )}{" "}
          <button
            className="button secondary"
            onClick={() => {
              refresh();
              setUncertain(false);
            }}
          >
            {tr("Check saved state")}
          </button>
        </Notice>
      )}
      {currentJob && (
        <Notice
          tone={
            currentJob.status === "failed" ||
            currentJob.status === "interrupted"
              ? "danger"
              : "info"
          }
        >
          {tr(
            currentJob.message ??
              "Your request is in progress. Settings are not confirmed yet.",
          )}{" "}
          <Link className="text-link" to={`/activity/${currentJob.id}`}>
            {tr("View command")}
          </Link>
        </Notice>
      )}
      {active && preparation ? (
        <Panel
          title={tr(stateLabels[preparation.state])}
          className="outage-active"
          action={<ShieldCheck size={24} />}
        >
          <div className="outage-target">
            <span>{tr("Grid charging target")}</span>
            <strong>
              {formatNumber(preparation.targetSoc)}
              <small>%</small>
            </strong>
          </div>
          <p>
            {tr(
              preparation.state === "active"
                ? "All stored energy stays reserved while the grid is available, including solar energy above your target. Return to normal when you no longer need the reserve."
                : "Check the confirmed state here. The saved reserve stays visible until restoration is verified.",
            )}
          </p>
          {preparation.error && (
            <Notice tone="danger">
              {tr(
                "The latest settings could not be confirmed. Check the inverter before relying on this reserve.",
              )}
            </Notice>
          )}
          <div className="outage-facts">
            <span>
              <BatteryCharging size={17} />
              {tr("Last recorded level")}:{" "}
              {sample ? `${formatNumber(sample.soc)}%` : "—"}
            </span>
            <span>
              {tr("Last verified")}: {age(preparation.lastVerifiedAt)}
            </span>
          </div>
          {!fresh && (
            <Notice tone="info">
              {tr(
                "Live readings are unavailable or old. The saved target is not a current battery reading.",
              )}
            </Notice>
          )}
          {preparation.test && (
            <Notice tone="info">
              {tr(
                "Supervised test: return to normal before the attended session ends. The app attempts restoration when the session expires.",
              )}
              <br />
              {tr("Session ends")}:{" "}
              {preparation.attendedUntil
                ? when(preparation.attendedUntil, overview?.controller.timezone)
                : "—"}
            </Notice>
          )}
          {preparation.test && (
            <ul className="outage-proof">
              <li>
                {preparation.proof.gridChargingObservedAt ? (
                  <Check size={16} />
                ) : (
                  <span className="proof-pending" />
                )}
                {tr("Grid charging observed below target")}
              </li>
              <li>
                {preparation.proof.targetHoldObservedAt ? (
                  <Check size={16} />
                ) : (
                  <span className="proof-pending" />
                )}
                {tr("Charging stopped and reserve held at target")}
              </li>
              <li>
                {preparation.proof.backupUseObservedAt ? (
                  <Check size={16} />
                ) : (
                  <span className="proof-pending" />
                )}
                {tr("Backup use during a power cut observed separately")}
              </li>
            </ul>
          )}
          <button
            className="button secondary full"
            disabled={
              pending ||
              preparation.state === "restoring" ||
              !data.canRestore ||
              Boolean(loadError)
            }
            onClick={() => setConfirm("restore")}
          >
            {tr("Return to normal")}
          </button>
          {!data.canRestore && (
            <Notice tone="info">
              {tr(
                "Reconnect the original inverter to restore its saved settings.",
              )}
            </Notice>
          )}
        </Panel>
      ) : (
        <Panel
          title={tr("How much should we keep ready?")}
          className="outage-selector"
          action={<ShieldCheck size={24} />}
        >
          <div className="outage-dial" aria-hidden="true">
            <div>
              <strong>
                {formatNumber(target)}
                <small>%</small>
              </strong>
              <span>{tr("YOUR TARGET")}</span>
            </div>
          </div>
          <label className="outage-range-label" htmlFor="outage-target">
            {tr("Battery target")}:{" "}
            <output htmlFor="outage-target">{formatNumber(target)}%</output>
          </label>
          <input
            id="outage-target"
            className="outage-range"
            type="range"
            min={data.minTarget}
            max={data.maxTarget}
            step="1"
            value={target}
            disabled={pending}
            onChange={(event) => {
              setTarget(Number(event.target.value));
              setConfirm(null);
            }}
            aria-valuetext={`${target}%`}
          />
          <div className="outage-range-limits">
            <span>50%</span>
            <span>100%</span>
          </div>
          <div className="outage-presets" aria-label={tr("Suggested targets")}>
            {[80, 90, 100].map((value) => (
              <button
                key={value}
                className={`button ${target === value ? "primary" : "secondary"}`}
                aria-pressed={target === value}
                disabled={pending}
                onClick={() => {
                  setTarget(value);
                  setConfirm(null);
                }}
              >
                {value}%
              </button>
            ))}
          </div>
          <div className="outage-current">
            <span>{tr("Last recorded level")}</span>
            <strong>{sample ? `${formatNumber(sample.soc)}%` : "—"}</strong>
            <small>{sample ? age(sample.at) : tr("No readings yet")}</small>
          </div>
          <p className="muted">
            {tr(
              "Changing this slider does not send a command. Review and save to apply your target.",
            )}
          </p>
          <button
            className="button primary full"
            disabled={locked || busy || !data.canPrepare}
            onClick={() => setConfirm("prepare")}
          >
            {tr("Review and save")}
          </button>
        </Panel>
      )}
      <div className="outage-explainer">
        <div>
          <PlugZap size={22} />
          <strong>{tr("Charge from the grid")}</strong>
          <p>
            {tr(
              "Up to 2 kW until your target is reached. The inverter may reduce power near full charge.",
            )}
          </p>
        </div>
        <div>
          <Sun size={22} />
          <strong>{tr("Keep the sunshine")}</strong>
          <p>
            {tr(
              "Solar can continue charging up to 100%. That extra energy also stays reserved.",
            )}
          </p>
        </div>
        <div>
          <ShieldCheck size={22} />
          <strong>{tr("Ready for a power cut")}</strong>
          <p>
            {tr(
              "Native backup mode supplies the backup circuit during an outage. Your inverter wiring and battery protection limits still apply.",
            )}
          </p>
        </div>
      </div>
      {!active && preparation?.state === "restored" && (
        <Notice tone="info">
          {tr(
            "Normal settings are restored: grid target 50%, solar ceiling 100%. App automation remains paused.",
          )}
        </Notice>
      )}
      {!active && !data.capabilityApproved && (
        <Panel title={tr("First-use verification")}>
          <p>
            {tr(
              "This firmware needs one supervised check before everyday outage preparation is available. Keep SOLARMAN Smart open so you can stop charging if needed.",
            )}
          </p>
          <p>
            {tr(
              "For the test, choose a target just above the current battery level and test without significant solar production. Wait for grid charging, then two readings showing charging stopped at the target, and return to normal.",
            )}
          </p>
          {!data.supported ? (
            <Link className="button secondary" to="/settings">
              {tr("Choose a supported inverter")}
            </Link>
          ) : !data.canTest && !preparation?.canApprove ? (
            <Link className="button secondary" to="/controls/commissioning">
              {tr("Open attended controls")}
            </Link>
          ) : null}
          {data.canTest && (
            <button
              className="button secondary"
              disabled={locked || busy || target < 52}
              onClick={() => setConfirm("test")}
            >
              {tr("Review supervised test")}
            </button>
          )}
          {preparation?.canApprove && (
            <form
              className="outage-approval"
              onSubmit={(event) => {
                void approve(event);
              }}
            >
              <Notice tone="info">
                {tr(
                  "Charging, target hold and restoration were verified. Backup discharge during an actual outage is recorded separately.",
                )}
              </Notice>
              <label>
                {tr("Current dashboard password")}
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                {tr(
                  "I reviewed the test results and approve everyday outage preparation for this inverter.",
                )}
              </label>
              <button
                className="button primary"
                disabled={pending || !reviewed || !password.trim()}
              >
                {tr("Approve outage control")}
              </button>
            </form>
          )}
        </Panel>
      )}
      {!active && data.capabilityApproved && !data.canPrepare && (
        <Notice tone="info">
          {tr(
            "Outage control is verified. Restore the connection and complete home control setup before starting.",
          )}{" "}
          <Link className="text-link" to="/controls/setup">
            {tr("Continue setup")}
          </Link>
        </Notice>
      )}
      {confirm && (
        <section
          ref={confirmation}
          tabIndex={-1}
          className="outage-confirm"
          role="region"
          aria-label={tr("Confirm battery control")}
        >
          <h2>
            {tr(
              confirm === "restore"
                ? "Return to normal?"
                : confirm === "test"
                  ? "Start a supervised reserve test?"
                  : "Charge and reserve {{target}}%?",
              { target: formatNumber(target) },
            )}
          </h2>
          <p>
            {tr(
              confirm === "restore"
                ? "Restore the saved 50% grid target and normal battery use. Solar can still charge to 100%. App automation will stay paused."
                : confirm === "test"
                  ? "Apply the selected target during your attended session. Return to normal after the readings confirm charging and holding."
                  : "This stays active until you return to normal. Reaching the target, midnight or a dashboard restart will not end the reserve.",
            )}
          </p>
          <div className="outage-confirm-actions">
            <button
              className="button secondary"
              disabled={pending}
              onClick={() => setConfirm(null)}
            >
              {tr("Cancel")}
            </button>
            <button
              className="button primary"
              disabled={pending || Boolean(loadError)}
              onClick={() => {
                void save();
              }}
            >
              {tr(
                pending
                  ? "Saving…"
                  : confirm === "restore"
                    ? "Restore normal settings"
                    : "Confirm and apply",
              )}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
