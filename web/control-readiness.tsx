import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, LockKeyhole, ShieldCheck } from "lucide-react";
import { Panel, Notice, when } from "./components";
import { verificationValue, formatNumber } from "./format";
import { tr } from "./i18n";
import type { Action, ControllerStatus } from "./types";

interface ControlReadinessProps {
  controller: ControllerStatus;
  busy: boolean;
  submitting: boolean;
  command: (action: Action) => Promise<void>;
}

function verificationLabel(
  state: ControllerStatus["control"]["verificationStatus"]["state"],
): string {
  switch (state) {
    case "verified":
      return tr("Device checks passed");
    case "failed":
      return tr("Device checks failed");
    case "expired":
      return tr("Verification expired");
    case "outdated":
      return tr("Verify the current inverter again");
    case "missing":
      return tr("Not checked yet");
  }
}

function verificationHint(controller: ControllerStatus): string {
  switch (controller.control.verificationStatus.state) {
    case "missing":
      return tr(
        "Run device verification to check the rating, charging policy, clock and firmware.",
      );
    case "failed":
      return tr(
        "Review the failed checks below, address their cause and verify again.",
      );
    case "expired":
      return tr(
        "The 30-minute activation window has passed. Verify again before enabling workspace control.",
      );
    case "outdated":
      return tr(
        "This report cannot verify the current device binding. Run verification again.",
      );
    case "verified":
      return controller.control.workspaceEnabled
        ? tr(
            "Workspace control is enabled. Native checks are enforced when automation runs.",
          )
        : tr(
            "Device checks passed. Review the remaining requirements before activating.",
          );
  }
}

function blockerHelp(code: string): {
  owner: string;
  instruction: string;
  settings: boolean;
} {
  const help: Record<string, { owner: string; instruction: string }> = {
    server: {
      owner: tr("Server operator"),
      instruction: tr(
        "The server operator must enable inverter changes for this installation after commissioning.",
      ),
    },
    connection: {
      owner: tr("Workspace owner"),
      instruction: tr(
        "Test your provider connection and select an inverter in Settings.",
      ),
    },
    profile: {
      owner: tr("Workspace owner"),
      instruction: tr(
        "Choose the supported profile only when it matches your inverter model and firmware.",
      ),
    },
    verification: {
      owner: tr("Workspace owner"),
      instruction: tr(
        "Run Verify device settings. A newer telemetry upload does not renew this report.",
      ),
    },
    firmware: {
      owner: tr("Workspace owner"),
      instruction: tr(
        "Review the firmware check and verify again. Unvalidated firmware keeps hardware control unavailable.",
      ),
    },
    settings: {
      owner: tr("Workspace owner"),
      instruction: tr(
        "Refresh diagnostics to confirm the native policy. This reason alone does not prove a setting has changed.",
      ),
    },
    clock: {
      owner: tr("Workspace owner"),
      instruction: tr(
        "Compare the inverter clock with its upload time and workspace timezone, then verify again.",
      ),
    },
    clock_refresh: {
      owner: tr("Workspace owner"),
      instruction: tr(
        "Refresh diagnostics for current clock evidence. Repeated cached uploads do not count as a new observation.",
      ),
    },
    workspace: {
      owner: tr("Workspace owner"),
      instruction: tr(
        "Enable workspace control after the other requirements pass. Automation stays paused until you start it.",
      ),
    },
    capacity: {
      owner: tr("Platform administrator"),
      instruction: tr(
        "Review polling capacity in Settings. Additional control workspaces need sufficient licensed API allowance.",
      ),
    },
    cleanup: {
      owner: tr("Workspace owner"),
      instruction: tr(
        "Use Stop scheduled top-ups to confirm scheduled permission is off. Repair access to the original inverter if needed.",
      ),
    },
    suspended: {
      owner: tr("Platform administrator"),
      instruction: tr(
        "Restore workspace availability, then verify and enable control separately.",
      ),
    },
    stopping: {
      owner: tr("Server operator"),
      instruction: tr(
        "The service is stopping. Check its status again after restart.",
      ),
    },
  };
  return {
    ...(help[code] ?? {
      owner: tr("Platform administrator"),
      instruction: tr(
        "Review workspace availability before starting automation.",
      ),
    }),
    settings: ["connection", "profile", "capacity"].includes(code),
  };
}

export function ControlReadinessPanel({
  controller,
  busy,
  submitting,
  command,
}: ControlReadinessProps): ReactNode {
  const { control } = controller;
  const report = control.verificationStatus;
  const clock = control.clock;
  return (
    <Panel
      className="readiness-panel"
      title={tr("Control readiness")}
      subtitle={tr("Verify the device without changing inverter settings")}
      action={<ShieldCheck size={22} />}
    >
      {controller.supervision.issue && (
        <Notice tone="danger">
          <span>{tr(controller.supervision.issue.message)}</span>
          <small className="observation-time">
            {tr("Observed {{time}}", {
              time: when(
                controller.supervision.issue.observedAt,
                controller.timezone,
              ),
            })}
          </small>
        </Notice>
      )}
      {controller.control.recovery.inFlight && (
        <Notice>
          {tr(
            "Waiting for device acknowledgment and readback before confirming the change.",
          )}
        </Notice>
      )}
      {controller.control.recovery.pending &&
        !controller.control.recovery.inFlight && (
          <Notice tone="danger">
            {tr(
              "An earlier inverter change needs recovery. Confirm scheduled charging is off before starting again. Updated credentials can recover the same inverter after connection discovery.",
            )}
          </Notice>
        )}
      <div className="readiness-status">
        <span>
          {tr("Supported profile")}{" "}
          <strong>
            {controller.profile === "bluesun-bse20kh3"
              ? "Bluesun BSE20KH3"
              : tr("Monitoring only")}
          </strong>
        </span>
        <span>
          {tr("Administrator permission")}{" "}
          <strong>
            {tr(controller.control.serverAllowed ? "Enabled" : "Disabled")}
          </strong>
        </span>
        <span>
          {tr("Workspace control")}{" "}
          <strong>
            {tr(controller.control.workspaceEnabled ? "Enabled" : "Disabled")}
          </strong>
        </span>
        <span>
          {tr("Device verification")}{" "}
          <strong>{verificationLabel(report.state)}</strong>
        </span>
      </div>
      <div
        className="verification-evidence"
        role="group"
        aria-label={tr("Verification evidence")}
      >
        <section
          className={`verification-evidence-card ${report.state === "verified" ? "verified" : "attention"}`}
          aria-label={tr("Saved device verification")}
        >
          <span className="evidence-label">
            {tr("Saved device verification")}
          </span>
          <strong>{verificationLabel(report.state)}</strong>
          {report.checkedAt && (
            <time dateTime={report.checkedAt}>
              {when(report.checkedAt, controller.timezone, "medium")}
            </time>
          )}
          {report.expiresAt && (
            <small>
              {tr("Activation deadline: {{time}}", {
                time: when(report.expiresAt, controller.timezone, "medium"),
              })}
            </small>
          )}
          <p>{verificationHint(controller)}</p>
        </section>
        <section
          className={`verification-evidence-card ${clock?.fresh && clock.passed ? "verified" : "attention"}`}
          aria-label={tr("Latest inverter clock check")}
        >
          <span className="evidence-label">
            {tr("Latest inverter clock check")}
          </span>
          <strong>
            {!clock
              ? tr("Not checked yet")
              : !clock.fresh
                ? tr("Clock evidence expired")
                : clock.passed
                  ? tr("Within clock tolerance")
                  : tr("Clock needs attention")}
          </strong>
          {clock && (
            <>
              <time dateTime={clock.collectedAt}>
                {tr("Device upload: {{time}}", {
                  time: when(clock.collectedAt, controller.timezone, "medium"),
                })}
              </time>
              <small>
                {tr("Clock difference: {{value}} s (maximum {{maximum}} s)", {
                  value: formatNumber(clock.skewSeconds ?? NaN),
                  maximum: formatNumber(clock.maximumSkewSeconds),
                })}
              </small>
              {clock.reportedTime && (
                <small>
                  {tr("Reported inverter time: {{time}}", {
                    time: clock.reportedTime,
                  })}
                </small>
              )}
            </>
          )}
          <p>
            {tr("Clock evidence uses the workspace timezone: {{timezone}}.", {
              timezone: controller.timezone,
            })}
          </p>
          {clock?.fresh &&
            clock.passed &&
            ["failed", "expired", "outdated"].includes(report.state) && (
              <p className="evidence-explanation">
                {tr(
                  "A passing clock observation does not replace a failed or expired device verification.",
                )}
              </p>
            )}
        </section>
      </div>
      {controller.control.firmware && (
        <p className="fine-print">
          {tr(
            "Observed firmware: protocol {{protocol}}, DSP {{dsp}}, HMI {{hmi}}",
            {
              protocol:
                controller.control.firmware.protocol ?? tr("Unavailable"),
              dsp: controller.control.firmware.dsp ?? tr("Unavailable"),
              hmi: controller.control.firmware.hmi ?? tr("Unavailable"),
            },
          )}{" "}
          {tr("Observed {{time}}", {
            time: when(
              controller.control.firmware.collectedAt,
              controller.timezone,
            ),
          })}
        </p>
      )}
      <div className="readiness-actions">
        <button
          className="button secondary"
          disabled={
            busy ||
            !controller.control.canVerify ||
            !controller.paused ||
            controller.manualTopup
          }
          onClick={() => {
            void command("verify");
          }}
        >
          <ShieldCheck size={17} /> {tr("Verify device settings")}
        </button>
        <button
          className="button secondary"
          disabled={busy || !control.canVerify}
          onClick={() => {
            void command("refresh");
          }}
        >
          <ShieldCheck size={17} /> {tr("Refresh diagnostics")}
        </button>
        {!controller.control.workspaceEnabled && (
          <button
            className="button primary"
            disabled={busy || !controller.control.canEnable}
            onClick={() => {
              void command("enable_controls");
            }}
          >
            <LockKeyhole size={17} /> {tr("Enable workspace control")}
          </button>
        )}
        {controller.control.workspaceEnabled && (
          <button
            className="button secondary"
            disabled={submitting || !controller.control.canStop}
            onClick={() => {
              void command("disable_controls");
            }}
          >
            <LockKeyhole size={17} />
            {tr("Disable workspace control")}
          </button>
        )}
      </div>
      {controller.control.verification && (
        <details
          className={
            report.state === "verified"
              ? "readiness-details"
              : "readiness-details attention"
          }
          open={controller.control.verification.passed ? undefined : true}
        >
          <summary>
            <strong>
              {tr("{{passed}} of {{total}} checks verified", {
                passed: controller.control.verification.checks.filter(
                  (check) => check.passed,
                ).length,
                total: controller.control.verification.checks.length,
              })}
            </strong>
            <span>{tr("View verification details")}</span>
          </summary>
          <div className="readiness-checks" role="list">
            {controller.control.verification.checks.map((check) => (
              <div
                className={
                  check.passed
                    ? "readiness-check passed"
                    : "readiness-check attention"
                }
                role="listitem"
                key={check.label}
              >
                {check.passed ? (
                  <Check size={17} aria-hidden="true" />
                ) : (
                  <ShieldCheck size={17} aria-hidden="true" />
                )}
                <span>{tr(check.label)}</span>
                <strong>{verificationValue(check, check.actual)}</strong>
                <small>
                  {tr(
                    check.comparison === "at_most"
                      ? "Maximum {{value}}"
                      : "Expected {{value}}",
                    {
                      value: verificationValue(check, check.expected),
                    },
                  )}
                </small>
                <span className="sr-only">
                  {tr(check.passed ? "Verified" : "Needs attention")}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
      {(!controller.paused || controller.manualTopup) && (
        <p className="fine-print">
          {tr(
            "Stop scheduled top-ups before running full device verification. Refresh diagnostics remains available.",
          )}
        </p>
      )}
      {controller.control.reasons.length > 0 && (
        <ul
          className="readiness-reasons"
          aria-label={tr("Requirements before starting")}
        >
          {controller.control.reasons.map((reason) => {
            const help = blockerHelp(reason.code);
            return (
              <li key={reason.code}>
                <div>
                  <strong>{tr(reason.message)}</strong>
                  <span className="blocker-owner">
                    {tr("Handled by {{owner}}", { owner: help.owner })}
                  </span>
                </div>
                <p>{help.instruction}</p>
                {help.settings && (
                  <Link className="text-link" to="/settings">
                    {tr("Review settings")}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="fine-print">
        {tr(
          "Verification checks the inverter rating, charge settings and clock. Physical charging behavior and the separate solar power limit require additional verification.",
        )}
      </p>
    </Panel>
  );
}
