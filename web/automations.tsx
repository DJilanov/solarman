import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BatteryCharging,
  Check,
  Pause,
  Play,
  PlugZap,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { formatNumber } from "./format";
import { Heading, Loading, Notice, Panel, StatusBadge } from "./components";
import { GridChargeControl } from "./grid-charge";
import { appPolicyStatus } from "./home";
import { ControlReadinessPanel } from "./control-readiness";

export default function AutomationsPage(): ReactNode {
  const {
    overview,
    overviewLoading,
    overviewError,
    busy,
    submitting,
    command,
  } = useWorkspace();
  if (!overview)
    return overviewLoading ? (
      <Loading />
    ) : (
      <Notice tone="danger">
        {overviewError ?? tr("Unable to load your workspace")}
      </Notice>
    );
  const { controller } = overview;
  const { policy, control } = controller;
  const supported = controller.profile === "bluesun-bse20kh3";
  const needsStop =
    !controller.paused ||
    controller.manualTopup ||
    control.recovery.pending ||
    control.recovery.inFlight;
  return (
    <>
      <Heading
        eyebrow={tr("YOUR HOME POLICY")}
        title={tr("Automations")}
        description={tr("Solar first. Use stored energy. Keep a reserve.")}
      />
      {overviewError && <Notice tone="danger">{overviewError}</Notice>}
      {controller.error && <Notice tone="danger">{controller.error}</Notice>}
      {controller.supervision.issue && (
        <Notice tone="danger">
          {tr(controller.supervision.issue.message)}
        </Notice>
      )}
      {!control.canStart && !controller.outage?.active && (
        <div className="setup-prompt">
          <ShieldCheck size={24} />
          <div>
            <strong>{tr("Finish setting up app controls")}</strong>
            <p>
              {tr(
                "Monitoring and native solar charging continue while app control is being set up.",
              )}
            </p>
          </div>
          <Link className="button secondary" to="/controls/setup">
            {tr("Continue setup")} <ArrowRight size={16} />
          </Link>
        </div>
      )}
      {controller.outage?.active ? (
        <Notice tone="info">
          {tr(
            "Outage reserve is active. Return to normal when you no longer need it.",
          )}{" "}
          <Link className="text-link" to="/controls/outage">
            {tr("Manage outage reserve")}
          </Link>
        </Notice>
      ) : supported ? (
        <div className="home-rules-grid">
          <Panel
            title={tr("Solar comes first")}
            action={<Sun className="solar-ink" size={23} />}
          >
            <div className="rule-number solar-ink">
              {formatNumber(policy.solarTargetSoc)}
              <span>%</span>
            </div>
            <p className="control-description">
              {tr(
                "Surplus solar can charge above the grid reserve. The inverter and battery determine solar charging power.",
              )}
            </p>
          </Panel>
          <Panel
            title={tr("Grid restores the reserve")}
            action={<PlugZap className="grid-ink" size={23} />}
          >
            <div className="rule-number grid-ink">
              {formatNumber(policy.reserveSoc)}
              <span>% · {formatNumber(policy.acChargeKw)} kW</span>
            </div>
            <p className="control-description">
              {tr(
                "When solar is insufficient, grid charging can restore the reserve. The AC limit applies to battery charging, not the home’s total grid consumption.",
              )}
            </p>
          </Panel>
          <Panel
            title={tr("Use your stored energy")}
            action={<BatteryCharging size={23} />}
          >
            <div className="rule-number">
              {formatNumber(policy.reserveSoc)}
              <span>% {tr("reserve")}</span>
            </div>
            <p className="control-description">
              {tr(
                "Above the reserve, the battery can supply your home when solar is insufficient. Native inverter settings remain responsible for this behavior.",
              )}
            </p>
          </Panel>
        </div>
      ) : (
        <Notice>
          {tr(
            "Monitoring this inverter. Control policy is available for supported profiles.",
          )}
        </Notice>
      )}
      <div className="automation-actions-grid">
        {!controller.outage?.active && (
          <Panel
            title={tr("App automation")}
            action={<StatusBadge status={controller.mode} />}
          >
            <p className="control-description">
              {tr(appPolicyStatus(controller))}
            </p>
            <p className="fine-print">
              {tr(
                "Pausing the app does not disable solar charging or the inverter’s native reserve policy.",
              )}
            </p>
            <button
              className="button secondary full"
              disabled={
                submitting ||
                (controller.paused
                  ? busy || !control.canStart
                  : !control.canStop)
              }
              onClick={() => {
                void command(controller.paused ? "resume" : "pause");
              }}
            >
              {controller.paused ? <Play size={17} /> : <Pause size={17} />}
              {tr(controller.paused ? "Resume automation" : "Pause automation")}
            </button>
            {needsStop && (
              <>
                <button
                  className="button secondary full"
                  disabled={submitting || !control.canStop}
                  onClick={() => {
                    void command("stop");
                  }}
                >
                  <Pause size={17} />
                  {tr("Stop app top-ups")}
                </button>
                <p className="fine-print">
                  {tr(
                    "Pauses app top-ups and clears scheduled permission. Solar and native reserve charging continue.",
                  )}
                </p>
              </>
            )}
          </Panel>
        )}
        <Panel
          title={tr("Prepare for an outage")}
          subtitle={tr("Choose a level. Charge and keep it ready.")}
        >
          <p className="control-description">
            {tr(
              "Review the target and charging limit before sending a request. Current device checks still apply.",
            )}
          </p>
          <GridChargeControl />
        </Panel>
      </div>
      <div className="advanced-link-row">
        <Link className="text-link" to="/controls/advanced">
          {tr("Advanced controls and diagnostics")} <ArrowRight size={15} />
        </Link>
        <Link className="text-link" to="/controls/observations">
          {tr("View observed behavior")} <ArrowRight size={15} />
        </Link>
      </div>
    </>
  );
}

export function ControlSetupPage(): ReactNode {
  const {
    overview,
    overviewLoading,
    overviewError,
    busy,
    submitting,
    command,
  } = useWorkspace();
  if (!overview)
    return overviewLoading ? (
      <Loading />
    ) : (
      <Notice tone="danger">
        {overviewError ?? tr("Unable to load your workspace")}
      </Notice>
    );
  const { controller } = overview;
  const { control } = controller;
  const connected = controller.apiConfigured && controller.deviceSelected;
  const supported = controller.profile === "bluesun-bse20kh3";
  const verified = control.verificationStatus.state === "verified";
  const approved = control.commissioning.approved;
  const step = !connected || !supported ? 0 : !verified ? 1 : !approved ? 2 : 3;
  const steps = [
    tr("Connect your inverter"),
    tr("Check device settings"),
    tr("Approve home controls"),
  ];
  return (
    <>
      <Heading
        eyebrow={tr("GUIDED SETUP")}
        title={tr("Set up app controls")}
        description={tr(
          "Three steps to prepare your home controls. Solar and monitoring can continue throughout.",
        )}
        action={
          <Link className="button secondary small" to="/controls">
            {tr("Back to automations")}
          </Link>
        }
      />
      <ol className="setup-steps" aria-label={tr("Control setup progress")}>
        {steps.map((label, index) => (
          <li
            key={label}
            className={
              index < step ? "complete" : index === step ? "current" : ""
            }
            aria-current={index === step ? "step" : undefined}
          >
            <span>{index < step ? <Check size={19} /> : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <Panel
        className="setup-current"
        title={
          control.canStart && approved
            ? tr("Your app controls are ready")
            : step === 3
              ? tr("Finish app activation")
              : steps[step]
        }
      >
        {step === 0 ? (
          <>
            <p className="control-description">
              {tr(
                connected
                  ? "This inverter supports monitoring here. Charging controls need a supported inverter profile."
                  : "Connect your SOLARMAN account and choose your inverter to use charging controls.",
              )}
            </p>
            <Link className="button primary" to="/settings">
              {tr("Connection settings")} <ArrowRight size={17} />
            </Link>
          </>
        ) : step === 1 ? (
          <>
            <p className="control-description">
              {tr(
                "Check the inverter’s charging settings, firmware and clock. This reads settings without changing them.",
              )}
            </p>
            <button
              className="button primary"
              disabled={
                busy ||
                !control.canVerify ||
                !controller.paused ||
                controller.manualTopup
              }
              onClick={() => {
                void command("verify");
              }}
            >
              <ShieldCheck size={18} />
              {tr("Check device settings")}
            </button>
            {control.verificationStatus.state === "failed" && (
              <Notice tone="danger">
                {tr(
                  "Some settings need attention. Open the device check details below to see what needs fixing.",
                )}
              </Notice>
            )}
          </>
        ) : step === 2 ? (
          <>
            <p className="control-description">
              {tr(
                "Review the observed home behavior and complete the attended checks. The final approval requires your dashboard password.",
              )}
            </p>
            <Link className="button primary" to="/controls/commissioning">
              {tr("Review and approve controls")} <ArrowRight size={17} />
            </Link>
            <Link className="text-link" to="/controls/observations">
              {tr("View observed behavior")}
            </Link>
          </>
        ) : control.canStart ? (
          <>
            <p className="control-description">
              {tr(
                "You can now request a top-up or resume app automation. These are separate actions.",
              )}
            </p>
            <Link className="button primary" to="/">
              {tr("Go to Home")} <ArrowRight size={17} />
            </Link>
          </>
        ) : (
          <>
            <p className="control-description">
              {tr(
                "Approval is saved. Enable app control once the device requirements below pass.",
              )}
            </p>
            {control.workspaceEnabled ? (
              <Link className="button secondary" to="/controls/advanced">
                {tr("Review app controls")} <ArrowRight size={16} />
              </Link>
            ) : (
              <button
                className="button primary"
                disabled={busy || !control.canEnable}
                onClick={() => {
                  void command("enable_controls");
                }}
              >
                {tr("Enable workspace control")}
              </button>
            )}
          </>
        )}
      </Panel>
      {control.reasons.length > 0 && (
        <div className="setup-reason">
          <strong>{tr("Next requirement")}</strong>
          <p>
            {tr(
              control.reasons.find(
                (reason) =>
                  !["workspace", "commissioning"].includes(reason.code),
              )?.message ?? control.reasons[0].message,
            )}
          </p>
        </div>
      )}
      <details
        className="advanced-disclosure"
        open={control.verificationStatus.state === "failed" ? true : undefined}
      >
        <summary>{tr("Device check details and advanced actions")}</summary>
        <ControlReadinessPanel
          controller={controller}
          busy={busy}
          submitting={submitting}
          command={command}
        />
      </details>
    </>
  );
}
