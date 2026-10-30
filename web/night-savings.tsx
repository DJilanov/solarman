import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RefreshCw, Sun, ShieldCheck } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { request, useData, isUnconfirmedResponse } from "./api";
import { useWorkspace } from "./context";
import { Heading, Loading, Notice, Panel } from "./components";
import { tr, locale } from "./i18n";
import { formatNumber, when } from "./format";
import type { EnergyData, EnergyPlan } from "./energy-types";
import { EnergySettings } from "./energy-settings";
import { ChargeTarget } from "./charge-target";

const reasons: Record<string, string> = {
  "night-not-cheaper":
    "The night tariff is not cheaper. Extra grid charging is not recommended.",
  "no-economic-topup":
    "Expected solar and the existing reserve make an extra night top-up unnecessary.",
  "charge-at-night": "Store cheaper night electricity for the following day.",
  "preserve-for-day":
    "Keep stored energy for the more expensive daytime period.",
  "target-ceiling":
    "The recommendation reaches your configured maximum target.",
  "assumed-roof-geometry": "Roof direction or tilt is still an assumption.",
  "assumed-battery-power": "Battery power limits are planning assumptions.",
  "assumed-discharge-restart":
    "The forecast uses a conservative six-point discharge restart band above the reserve.",
  "wear-not-priced":
    "The estimate excludes battery wear because no allowance is configured.",
  "manual-target":
    "This target was selected by you. Check the revised cost and charging time.",
};
const states: Record<string, string> = {
  recommended: "Recommendation",
  scheduled: "Scheduled for tonight",
  starting: "Applying night settings",
  running: "Night savings active",
  restoring: "Returning to normal",
  completed: "Normal mode restored",
  skipped: "No extra charging needed",
  cancelled: "Plan cancelled",
  blocked: "Plan needs attention",
  failed: "Plan failed",
  quarantined: "Plan requires review",
};
const codes: Record<string, string> = {
  "readings-stale":
    "Waiting for fresh battery readings. The last forecast has not been replaced with zero production.",
  "demand-history-missing":
    "More household readings or a daily consumption estimate are required.",
  "weather-access-unconfigured":
    "Weather forecast access is not configured for this workspace",
  "controls-unavailable":
    "Verified home controls are required before a night plan can start.",
  "permission-changed": "Control permission changed. Automatic is paused.",
  "outage-priority":
    "Outage reserve has priority. The night plan was not started.",
  "recommendation-changed":
    "Conditions changed enough to need a new target. Review the recommendation again.",
  "no-topup-needed": "Updated conditions no longer justify a grid top-up.",
  "charging-window-missed":
    "There is not enough cheap time left. This plan was skipped.",
  "settings-changed":
    "Installation settings changed. Calculate a new recommendation.",
  paused: "Night savings was paused.",
  "deadline-capacity":
    "Shared command capacity cannot accept another night plan ending at this time",
  "target-unreachable":
    "The selected target cannot be reached before the cheap period ends. Choose a lower target.",
};
function money(value: number, currency: string): string {
  return new Intl.NumberFormat(locale(), {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}
function clock(value: number, timezone: string): string {
  return new Intl.DateTimeFormat(locale(), {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
function localDate(value: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}
function solarDay(
  plan: EnergyPlan,
  timezone: string,
): { low: number; expected: number; high: number; day: string } {
  const day = localDate(plan.prediction.night.end, timezone),
    slots = plan.forecast.slots.filter(
      (slot) => localDate(slot.start, timezone) === day,
    );
  const sum = (key: "lowKw" | "expectedKw" | "highKw"): number =>
    slots.reduce(
      (total, slot) => total + (slot[key] * (slot.end - slot.start)) / 3600000,
      0,
    );
  return {
    day,
    low: sum("lowKw"),
    expected: sum("expectedKw"),
    high: sum("highKw"),
  };
}
export default function NightSavingsPage(): ReactNode {
  const confirmation = useRef<HTMLFormElement>(null);
  const targetSlider = useRef<HTMLInputElement>(null);
  const { session, reload: reloadWorkspace } = useWorkspace();
  const { data, error, loading, reload } = useData<EnergyData>("/energy", 5000);
  const [pending, setPending] = useState(false),
    [actionError, setActionError] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null),
    [confirm, setConfirm] = useState<"tonight" | "automatic" | null>(null),
    [password, setPassword] = useState(""),
    [adjust, setAdjust] = useState(false),
    [target, setTarget] = useState(50),
    [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    if (confirm) {
      confirmation.current?.scrollIntoView({ block: "nearest" });
      confirmation.current?.focus();
    } else if (adjust) {
      targetSlider.current?.scrollIntoView({ block: "nearest" });
      targetSlider.current?.focus();
    }
  }, [confirm, adjust]);
  useEffect(() => {
    if (!adjust && data?.plan) setTarget(data.plan.prediction.targetSoc);
  }, [data?.plan?.id, data?.plan?.prediction.targetSoc, adjust]);
  const act = async (action: string, body: unknown): Promise<void> => {
    setPending(true);
    setActionError(null);
    setMessage(null);
    try {
      await request(`/energy/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      setPassword("");
      setConfirm(null);
      setAdjust(false);
      setUncertain(false);
      setMessage(
        action === "refresh" || action === "adjust"
          ? "Calculating the recommendation. This usually takes a few seconds."
          : action === "pause"
            ? "Night savings paused. Any active night settings are being restored."
            : "Plan saved. The inverter will be checked again before the night plan starts.",
      );
      reload();
      reloadWorkspace();
    } catch (cause) {
      setPassword("");
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Energy action could not be confirmed",
      );
      if (isUnconfirmedResponse(cause)) {
        setUncertain(true);
        reload();
      }
    } finally {
      setPending(false);
    }
  };
  if (!data)
    return loading ? (
      <Loading />
    ) : (
      <Notice tone="danger">
        {tr(error ?? "Energy planning is unavailable.")}
      </Notice>
    );
  const plan = data.plan,
    prediction = plan?.prediction,
    profile = data.profile,
    stale = plan
      ? Date.parse(plan.forecast.expiresAt) <= Date.now() ||
        Date.now() - Date.parse(plan.createdAt) > 15 * 60000
      : true,
    mismatched = plan?.settingsRevision !== data.revision;
  const canOptIn =
    plan?.state === "recommended" &&
    data.code === "ready" &&
    !stale &&
    !mismatched &&
    data.control.canActivate &&
    !uncertain;
  const actionable = canOptIn && prediction?.action === "charge-and-hold";
  const busy = pending || data.calculating;
  const solar = plan ? solarDay(plan, profile.timezone) : null;
  const chart = prediction?.selected.timeline.map((slot) => ({
    ...slot,
    label: clock(slot.start, profile.timezone),
  }));
  return (
    <>
      <Heading
        eyebrow={tr("PLAN YOUR ENERGY")}
        title={tr("Night savings")}
        description={tr(
          "Charge only what tomorrow needs. Keep space for the sun.",
        )}
      />
      {error && <Notice tone="danger">{tr(error)}</Notice>}
      {actionError && <Notice tone="danger">{tr(actionError)}</Notice>}
      {message && <Notice tone="info">{tr(message)}</Notice>}
      {uncertain && (
        <Notice tone="danger">
          {tr(
            "The result is unconfirmed. Refresh and review the saved plan before sending another action.",
          )}{" "}
          <button
            className="button secondary small"
            onClick={() => {
              reload();
              setConfirm(null);
              setUncertain(false);
            }}
          >
            {tr("Review current state")}
          </button>
        </Notice>
      )}
      {data.control.active && data.control.purpose === "outage" && (
        <Notice tone="info">
          <ShieldCheck size={18} />{" "}
          {tr("Outage reserve has priority. Night savings cannot change it.")}{" "}
          <Link to="/controls/outage">{tr("Manage outage reserve")}</Link>
        </Notice>
      )}
      {!data.providerAvailable && (
        <Notice>
          {tr("Weather forecast access is not configured for this workspace")}
          <p className="fine-print">
            {tr(
              "The operator must configure licensed weather access before forecasts are available. Monitoring and solar charging continue.",
            )}
          </p>
        </Notice>
      )}
      {data.code && data.code !== "ready" && data.code !== "calculating" && (
        <Notice tone="danger">
          {tr(
            codes[data.code] ??
              "The latest forecast or calculation is unavailable. The previous recommendation is shown for reference.",
          )}
        </Notice>
      )}
      {data.missing.length > 0 ? (
        <Panel title={tr("Start with your installation")}>
          <p>
            {tr(
              "Add your panels, battery capacity, location and electricity prices below. Recommendations use your own readings.",
            )}
          </p>
          <a href="#energy-settings" className="button primary">
            {tr("Set up energy planning")} <ArrowRight size={16} />
          </a>
        </Panel>
      ) : (
        <>
          <div className="energy-metrics">
            <Panel
              title={tr("Solar for the next day")}
              action={<Sun size={20} />}
            >
              <div className="energy-number solar-ink">
                {solar ? formatNumber(solar.expected, 1) : "—"}{" "}
                <small>kWh</small>
              </div>
              <p className="fine-print">
                {solar
                  ? `${solar.day} · ${formatNumber(solar.low, 1)}–${formatNumber(solar.high, 1)} kWh`
                  : tr("Refresh to get a solar forecast")}
              </p>
            </Panel>
            <Panel title={tr("Expected household demand")}>
              <div className="energy-number">
                {prediction
                  ? formatNumber(prediction.selected.loadKwh, 1)
                  : "—"}{" "}
                <small>kWh</small>
              </div>
              <p className="fine-print">
                {tr("Across the complete plan horizon, including tonight.")}
              </p>
            </Panel>
            <Panel title={tr("Estimated cost reduction")}>
              <div className="energy-number battery-ink">
                {prediction
                  ? money(prediction.estimatedSavings, profile.tariff.currency)
                  : "—"}
              </div>
              <p className="fine-print">
                {tr(
                  "Compared with your normal reserve policy. This is an estimate, not measured savings.",
                )}
              </p>
            </Panel>
          </div>
          <Panel
            title={tr("Tonight’s recommendation")}
            action={
              <span className="energy-mode">
                {tr(
                  states[plan?.state ?? "recommended"] ??
                    "Plan needs attention",
                )}
              </span>
            }
          >
            {prediction && plan ? (
              <>
                <div className="energy-recommendation">
                  <div>
                    <span className="eyebrow">
                      {tr(
                        prediction.action === "normal"
                          ? "KEEP YOUR NORMAL RESERVE"
                          : "NIGHT CHARGING TARGET",
                      )}
                    </span>
                    <div className="energy-target">
                      {formatNumber(prediction.targetSoc)}
                      <span>%</span>
                    </div>
                    <p>
                      {tr(
                        prediction.action === "normal"
                          ? "No extra grid top-up is recommended."
                          : "Grid charging up to {{power}} kW. Solar can still fill the battery to 100%.",
                        { power: formatNumber(prediction.maximumChargeKw, 1) },
                      )}
                    </p>
                  </div>
                  <div className="energy-next">
                    <p>
                      <span>{tr("Cheap electricity")}</span>
                      <strong>
                        {when(prediction.night.start, profile.timezone)} →{" "}
                        {clock(prediction.night.end, profile.timezone)}
                      </strong>
                    </p>
                    {prediction.chargeStart !== null && (
                      <p>
                        <span>{tr("Planned grid charging")}</span>
                        <strong>
                          {clock(prediction.chargeStart, profile.timezone)}–
                          {clock(
                            prediction.chargeEnd ?? prediction.night.end,
                            profile.timezone,
                          )}{" "}
                          · {formatNumber(prediction.chargingHours, 1)}{" "}
                          {tr("hours")}
                        </strong>
                      </p>
                    )}
                    <p>
                      <span>{tr("Return to daytime use")}</span>
                      <strong>
                        {when(prediction.night.releaseAt, profile.timezone)}
                      </strong>
                    </p>
                    <p>
                      <span>{tr("Estimated grid energy for charging")}</span>
                      <strong>
                        {formatNumber(prediction.selected.gridChargeKwh, 1)} kWh
                      </strong>
                    </p>
                  </div>
                </div>
                {(stale || mismatched) && (
                  <Notice tone="danger">
                    {tr(
                      "This recommendation is out of date. Refresh it before choosing a plan.",
                    )}
                  </Notice>
                )}
                {plan.code && (
                  <Notice>
                    {tr(
                      codes[plan.code] ??
                        "Review the current plan state before continuing.",
                    )}
                  </Notice>
                )}
                <ul className="energy-reasons">
                  {prediction.reasons.map((reason) => (
                    <li key={reason}>
                      {tr(
                        reasons[reason] ??
                          "Review the planning assumptions below.",
                      )}
                    </li>
                  ))}
                </ul>
                <div className="energy-costs">
                  <span>
                    {tr("Normal policy")}{" "}
                    <b>
                      {money(
                        prediction.baseline.totalCost,
                        profile.tariff.currency,
                      )}
                    </b>
                  </span>
                  <span>
                    {tr("Proposed plan")}{" "}
                    <b>
                      {money(
                        prediction.selected.totalCost,
                        profile.tariff.currency,
                      )}
                    </b>
                  </span>
                  <span>
                    {tr("Lower solar / higher demand savings")}{" "}
                    <b>
                      {money(
                        prediction.conservativeSavings,
                        profile.tariff.currency,
                      )}
                    </b>
                  </span>
                </div>
                {plan.state === "recommended" && (
                  <div className="energy-actions">
                    <button
                      className="button primary"
                      disabled={busy || !actionable}
                      onClick={() => setConfirm("tonight")}
                    >
                      {tr("Use tonight")}
                    </button>
                    <button
                      className="button secondary"
                      disabled={
                        busy || stale || mismatched || data.control.active
                      }
                      onClick={() => setAdjust((value) => !value)}
                    >
                      {tr("Adjust target")}
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy || !canOptIn}
                      onClick={() => setConfirm("automatic")}
                    >
                      {tr("Automatic")}
                    </button>
                  </div>
                )}
                {adjust && (
                  <div className="energy-confirm">
                    <ChargeTarget
                      id="night-target"
                      inputRef={targetSlider}
                      label={tr("Choose the maximum grid target")}
                      value={target}
                      min={profile.battery.reserveSoc}
                      max={profile.planning.maximumSoc}
                      disabled={busy}
                      onChange={setTarget}
                    />
                    <p className="fine-print">
                      {tr(
                        "Recalculate first to check charging time, solar headroom and cost. This does not send inverter commands.",
                      )}
                    </p>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => {
                        void act("adjust", {
                          revision: data.revision,
                          planId: plan.id,
                          targetSoc: target,
                        });
                      }}
                    >
                      {tr("Recalculate this target")}
                    </button>
                  </div>
                )}
                {confirm && (
                  <form
                    ref={confirmation}
                    tabIndex={-1}
                    aria-labelledby="night-confirm-title"
                    className="energy-confirm"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void act("apply", {
                        revision: data.revision,
                        planId: plan.id,
                        choice: confirm,
                        currentPassword: password,
                      });
                    }}
                  >
                    <h3 id="night-confirm-title">
                      {tr(
                        confirm === "tonight"
                          ? "Use this plan tonight?"
                          : "Enable Automatic night savings?",
                      )}
                    </h3>
                    <p>
                      {tr(
                        confirm === "tonight"
                          ? "This plan runs once. It holds the battery during the cheap period and restores normal daytime use afterward."
                          : "Each night, a fresh forecast and your household history choose a target within your settings. You can pause Automatic at any time.",
                      )}
                    </p>
                    <p className="fine-print">
                      {tr(
                        "If contact is lost, daytime discharge can remain paused and the inverter’s daily charging window can repeat the following night. The dashboard keeps restoration pending until it is verified.",
                      )}
                    </p>
                    <p className="fine-print">
                      {tr(
                        "A one-time target can decrease after a fresh forecast. An adjusted target is kept for this night; Automatic uses your configured maximum on later nights.",
                      )}
                    </p>
                    <label className="energy-field">
                      <span>{tr("Current dashboard password")}</span>
                      <input
                        required
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </label>
                    <div className="energy-actions">
                      <button
                        className="button primary"
                        disabled={
                          busy ||
                          !(confirm === "automatic" ? canOptIn : actionable)
                        }
                      >
                        {tr("Confirm night plan")}
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setConfirm(null);
                          setPassword("");
                        }}
                      >
                        {tr("Cancel")}
                      </button>
                    </div>
                  </form>
                )}
                <p className="fine-print">
                  {tr(
                    "Demand model: {{days}} observed days, {{hours}} covered hours.",
                    {
                      days: plan.demandDays,
                      hours: formatNumber(plan.demandCoveredHours, 1),
                    },
                  )}{" "}
                  {tr(
                    plan.demandQuality === "limited"
                      ? "History is limited. Missing hours use an explicit estimate or the observed average, with extra demand margin."
                      : "The model uses observed hourly household patterns.",
                  )}
                </p>
                <p className="fine-print">
                  {tr("Forecast updated {{time}}", {
                    time: when(plan.forecast.fetchedAt, profile.timezone),
                  })}{" "}
                  ·{" "}
                  <a
                    className="text-link"
                    href="https://open-meteo.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tr("Weather data by Open-Meteo")}
                  </a>
                  . {tr("Solar production is modelled, not guaranteed.")}
                </p>
                <p className="fine-print">
                  {tr(
                    plan.forecast.calibration.source === "configured-scenarios"
                      ? "The solar range is a planning margin, not a calibrated probability interval."
                      : "The solar range uses observed errors from eligible previous forecasts.",
                  )}
                </p>
              </>
            ) : (
              <p>
                {tr(
                  "Your settings are ready. Refresh the forecast to calculate tomorrow’s plan.",
                )}
              </p>
            )}
            <button
              className="button secondary"
              disabled={busy || !data.providerAvailable}
              onClick={() => {
                void act("refresh", { revision: data.revision });
              }}
            >
              <RefreshCw size={16} className={data.calculating ? "spin" : ""} />
              {tr(
                data.calculating ? "Calculating…" : "Refresh forecast and plan",
              )}
            </button>
          </Panel>
          {!data.control.canActivate && !data.control.active && (
            <Notice>
              <p>
                {tr(
                  "Forecasts and recommendations are available. Verified home controls are required before sending night charging commands.",
                )}
              </p>
              <Link className="text-link" to="/controls/setup">
                {tr("Continue setup")} <ArrowRight size={14} />
              </Link>
            </Notice>
          )}
          {(data.automatic ||
            ["scheduled", "starting", "running", "restoring"].includes(
              plan?.state ?? "",
            )) && (
            <Panel title={tr("Night savings control")}>
              <p>
                {tr(
                  data.automatic
                    ? "Automatic is enabled for future nights."
                    : "This is a one-time night plan.",
                )}
              </p>
              <button
                className="button secondary"
                disabled={pending || uncertain}
                onClick={() => {
                  void act("pause", { revision: data.revision });
                }}
              >
                {tr("Pause night savings and return to normal")}
              </button>
            </Panel>
          )}
          {prediction && (
            <Panel title={tr("Battery and energy timeline")}>
              <p className="fine-print">
                {when(prediction.horizon.start, profile.timezone)} →{" "}
                {when(prediction.horizon.end, profile.timezone)} ·{" "}
                {tr(
                  "Solar, household demand and battery charge are estimates.",
                )}
              </p>
              <div
                className="energy-chart"
                role="img"
                aria-label={tr(
                  "Forecast solar power, household demand and battery percentage",
                )}
              >
                <ResponsiveContainer width="100%" height={290}>
                  <ComposedChart
                    data={chart}
                    margin={{ left: 0, right: 0, top: 12, bottom: 5 }}
                  >
                    <Legend />
                    <CartesianGrid stroke="#78928a25" vertical={false} />
                    <XAxis
                      dataKey="label"
                      minTickGap={45}
                      tick={{ fill: "#9fb6b0", fontSize: 11 }}
                    />
                    <YAxis
                      yAxisId="power"
                      width={38}
                      unit=" kW"
                      tick={{ fill: "#9fb6b0", fontSize: 10 }}
                    />
                    <YAxis
                      yAxisId="soc"
                      orientation="right"
                      domain={[0, 100]}
                      width={40}
                      unit="%"
                      tick={{ fill: "#b9f2d3", fontSize: 10 }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#152a26",
                        border: "1px solid #536e64",
                        borderRadius: 12,
                      }}
                      labelFormatter={(_label, payload) =>
                        when(
                          Number(
                            payload[0]?.payload?.start ??
                              prediction.horizon.start,
                          ),
                          profile.timezone,
                        )
                      }
                    />
                    <Area
                      yAxisId="power"
                      type="monotone"
                      dataKey="solarKw"
                      name={tr("Solar")}
                      stroke="#f4cc86"
                      fill="#f4cc8625"
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="power"
                      type="monotone"
                      dataKey="loadKw"
                      name={tr("Household demand")}
                      stroke="#d0c4f3"
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="soc"
                      type="monotone"
                      dataKey="soc"
                      name={tr("Battery charge")}
                      stroke="#bcf9d9"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          )}
          {prediction && profile.loads.length > 0 && (
            <Panel title={tr("Good times for flexible loads")}>
              <p className="fine-print">
                {tr(
                  "Suggestions use forecast surplus after household demand and battery charging. No appliance is switched automatically.",
                )}
              </p>
              <div className="energy-loads">
                {prediction.flexibleLoads.map((load, index) => (
                  <div key={index}>
                    <strong>{load.name}</strong>
                    <span>
                      {formatNumber(load.powerKw, 1)} kW ·{" "}
                      {load.durationMinutes} {tr("minutes")}
                    </span>
                    <b>
                      {load.slot
                        ? `${when(load.slot.start, profile.timezone)}–${clock(load.slot.end, profile.timezone)}`
                        : tr("No suitable solar-surplus window")}
                    </b>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
      {data.endurance && (
        <Panel title={tr("Estimated backup endurance")}>
          <div className="energy-number">
            {formatNumber(data.endurance.lowHours, 1)}–
            {formatNumber(data.endurance.highHours, 1)}{" "}
            <small>{tr("hours")}</small>
          </div>
          <p>
            {tr(
              data.endurance.loadSource === "configured-essential-load"
                ? "Based on your essential load estimate"
                : "Based on recent household consumption",
            )}{" "}
            · {formatNumber(data.endurance.loadW)} W ·{" "}
            {tr("Protection floor {{soc}}%", {
              soc: formatNumber(data.endurance.floorSoc),
            })}
          </p>
          <p className="fine-print">
            {tr(
              "This is an energy estimate. Actual backup depends on connected circuits, peaks, battery protection and changing consumption.",
            )}
          </p>
          {data.endurance.powerLimitExceeded && (
            <Notice tone="danger">
              {tr(
                "The selected load exceeds the confirmed battery discharge power. Reduce the backup load.",
              )}
            </Notice>
          )}
        </Panel>
      )}
      <Panel title={tr("Forecast versus actual")}>
        <p className="fine-print">
          {tr(
            "Only forecasts saved before the day begins are scored. Gaps stay visible. Full-battery or limited-output days do not train solar calibration.",
          )}
        </p>
        {data.outcomes.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("Date")}</th>
                  <th>{tr("Forecast solar")}</th>
                  <th>{tr("Observed solar")}</th>
                  <th>{tr("Coverage")}</th>
                  <th>{tr("Calibration")}</th>
                </tr>
              </thead>
              <tbody>
                {data.outcomes.map((outcome) => (
                  <tr key={outcome.day}>
                    <td>{outcome.day}</td>
                    <td>{formatNumber(outcome.forecastSolarKwh, 1)} kWh</td>
                    <td>{formatNumber(outcome.actualSolarKwh, 1)} kWh</td>
                    <td>{formatNumber(outcome.coverage * 100)}%</td>
                    <td>
                      {tr(
                        outcome.coverage < 0.95
                          ? "Insufficient coverage"
                          : outcome.curtailedPossible
                            ? "Possibly curtailed"
                            : "Eligible",
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>
            {tr(
              "Completed days with enough readings will appear after the first saved forecast.",
            )}
          </p>
        )}
        {data.history.length > 0 && (
          <details>
            <summary>{tr("Previous plans and estimated savings")}</summary>
            {data.history.map((item) => (
              <div className="energy-history" key={item.id}>
                <strong>
                  {when(item.startsAt, item.timezone)} ·{" "}
                  {tr(states[item.state] ?? "Plan needs attention")}
                </strong>
                <p>
                  {tr("Predicted saving")}{" "}
                  {money(item.prediction.estimatedSavings, item.currency)} ·{" "}
                  {tr("Coverage")}{" "}
                  {formatNumber((item.assessment?.coverage ?? 0) * 100)}%
                </p>
                <p className="fine-print">
                  {item.assessment?.estimatedCounterfactualSavings !== null &&
                  item.assessment?.estimatedCounterfactualSavings !== undefined
                    ? `${tr("Estimated counterfactual saving")} ${money(item.assessment.estimatedCounterfactualSavings, item.currency)}`
                    : tr("Too little coverage to estimate the outcome.")}{" "}
                  {tr(
                    "The baseline is simulated, so this is not verified bill savings.",
                  )}
                </p>
              </div>
            ))}
          </details>
        )}
      </Panel>
      <section id="energy-settings">
        <Panel title={tr("Installation and tariff settings")}>
          <details open={data.missing.length > 0}>
            <summary className="energy-edit-settings">
              {tr("Edit installation and assumptions")}
            </summary>
            <EnergySettings data={data} onSaved={reload} />
          </details>
        </Panel>
      </section>
    </>
  );
}
