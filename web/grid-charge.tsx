import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BatteryCharging, Pause, X, Zap } from "lucide-react";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { formatNumber, age } from "./format";
import { Notice } from "./components";
import { chargeState, type ChargeState } from "./charge-state";

const explanations: Record<ChargeState, string> = {
  ready:
    "Solar keeps priority. The app requests a grid top-up only while the battery is below the reserve.",
  active:
    "Your one-time top-up request is active. Solar surplus or a grid outage can pause it; the request ends at the target or expiry.",
  satisfied:
    "Your battery already covers the grid reserve. Solar can continue charging above this level.",
  connection:
    "Connect your SOLARMAN account and choose your inverter to use charging controls.",
  unsupported:
    "This inverter supports monitoring here. Charging controls need a supported inverter profile.",
  missing: "A battery reading is needed before starting a grid top-up.",
  stale:
    "The latest battery reading is too old or the inverter is offline. Refresh device readings before starting.",
  setup: "Complete the guided control setup before starting your first top-up.",
  recovery:
    "An earlier change needs checking. Confirm scheduled charging is off before starting again.",
  busy: "A device operation is in progress. Wait for its result before starting another top-up.",
};

export function GridChargeControl(): ReactNode {
  const { overview, busy, submitting, command } = useWorkspace();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);
  if (!overview) return null;
  const { controller, latest } = overview;
  const state = chargeState(controller, latest, busy);
  const target = formatNumber(controller.policy.reserveSoc);
  const chargeKw = formatNumber(controller.policy.acChargeKw, 1, 0);
  const active = controller.manualTopup && !controller.recoveryTesting;
  const offerStop =
    controller.manualTopup ||
    controller.recoveryTesting ||
    controller.control.recovery.pending ||
    controller.control.recovery.inFlight;
  const run = (action: "topup" | "stop"): void => {
    if (action === "topup" && state !== "ready") return;
    if (action === "stop" && (submitting || !controller.control.canStop))
      return;
    setOpen(false);
    void command(action);
  };
  return (
    <div className="grid-charge-control">
      <button
        className="button primary full charge-trigger"
        onClick={() => setOpen(true)}
      >
        <Zap size={19} aria-hidden="true" />
        {tr(active ? "Manage app top-up" : "Charge from grid")}
        <ArrowRight size={17} aria-hidden="true" />
      </button>
      <p className="charge-caption">
        {tr("To {{target}}% · up to {{power}} kW from the grid", {
          target,
          power: chargeKw,
        })}
      </p>
      <dialog
        ref={dialog}
        className="charge-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "button:not(:disabled), a[href]",
            ),
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="charge-sheet">
          <div className="charge-sheet-top">
            <Zap size={27} aria-hidden="true" />
            <button
              autoFocus
              className="dialog-close"
              aria-label={tr("Close charging options")}
              onClick={() => setOpen(false)}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <h2 id={titleId}>
            {tr(active ? "Your app top-up" : "Charge from the grid")}
          </h2>
          <p id={descriptionId}>
            {tr(
              "Restore the battery reserve. Solar can continue charging up to {{target}}%.",
              { target: formatNumber(controller.policy.solarTargetSoc) },
            )}
          </p>
          <dl className="charge-summary">
            <div>
              <dt>{tr("Last recorded level")}</dt>
              <dd>{latest ? `${formatNumber(latest.soc)}%` : "—"}</dd>
            </div>
            <div>
              <dt>{tr("Grid charging target")}</dt>
              <dd>{target}%</dd>
            </div>
            <div>
              <dt>{tr("AC charge power")}</dt>
              <dd>{tr("Up to {{power}} kW", { power: chargeKw })}</dd>
            </div>
          </dl>
          {latest && (
            <p className="charge-reading-age">
              {tr("Last sample")}: {age(latest.at)}
            </p>
          )}
          <Notice tone={state === "recovery" ? "danger" : "info"}>
            {tr(explanations[state])}
          </Notice>
          {["connection", "unsupported", "setup", "recovery"].includes(
            state,
          ) && (
            <Link
              className="button secondary full"
              to={
                state === "connection" || state === "unsupported"
                  ? "/settings"
                  : state === "recovery"
                    ? "/controls/advanced"
                    : "/controls/setup"
              }
              onClick={() => setOpen(false)}
            >
              {tr(state === "recovery" ? "Review recovery" : "Continue setup")}{" "}
              <ArrowRight size={16} />
            </Link>
          )}
          {["stale", "missing"].includes(state) && (
            <button
              className="button secondary full"
              disabled={busy || !controller.control.canVerify}
              onClick={() => {
                setOpen(false);
                void command("refresh");
              }}
            >
              {tr("Refresh device readings")}
            </button>
          )}
          {offerStop ? (
            <>
              <button
                className="button secondary full"
                disabled={submitting || !controller.control.canStop}
                onClick={() => run("stop")}
              >
                <Pause size={17} /> {tr("Stop app top-ups")}
              </button>
              <p className="charge-footnote">
                {tr(
                  "Pauses app top-ups and clears scheduled permission. Solar and native reserve charging continue.",
                )}
              </p>
            </>
          ) : (
            <button
              className="button primary full"
              disabled={state !== "ready" || submitting}
              onClick={() => run("topup")}
            >
              <BatteryCharging size={18} /> {tr("Start charging request")}
            </button>
          )}
          <p className="charge-footnote">
            {tr(
              "A request is confirmed separately from battery charging. Check the device result and current readings.",
            )}
          </p>
        </div>
      </dialog>
    </div>
  );
}
