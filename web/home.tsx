import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BatteryCharging,
  Clock3,
  Home,
  PlugZap,
  Sun,
} from "lucide-react";
import { useWorkspace } from "./context";
import { tr, locale } from "./i18n";
import { age, energy, formatNumber, power, when } from "./format";
import {
  EmptyState,
  Heading,
  Loading,
  Notice,
  Panel,
  PowerFlow,
} from "./components";
import { GridChargeControl } from "./grid-charge";
import { readingIsStale } from "./charge-state";
import { IncidentSummary } from "./incident-summary";
import type { Analytics, ControllerStatus } from "./types";

export function appPolicyStatus(controller: ControllerStatus): string {
  if (controller.control.recovery.pending)
    return "An earlier change needs recovery. Review app controls.";
  if (controller.mode === "error")
    return "App control needs attention. Solar and native inverter settings continue.";
  if (controller.paused)
    return "App automation is paused. Solar and native inverter settings continue.";
  if (!controller.writesEnabled)
    return "App control is unavailable. Solar and native inverter settings continue.";
  return "App automation is on. Solar keeps priority and the grid supports the reserve.";
}

function BatteryTrend({
  data,
  timezone,
}: {
  data: Analytics;
  timezone: string;
}): ReactNode {
  const points = data.points.filter(
    (point) => point.soc !== null && Number.isFinite(point.at),
  );
  if (!points.length)
    return (
      <EmptyState
        icon={BatteryCharging}
        title={tr("No readings yet")}
        description={tr(
          "Charts will appear after your linked inverter returns readings.",
        )}
      />
    );
  const start = points[0].at;
  const end = points[points.length - 1].at;
  const span = Math.max(1, end - start);
  let path = "";
  let previous: number | null = null;
  const markers: { x: number; y: number }[] = [];
  for (const point of data.points) {
    if (point.soc === null || !Number.isFinite(point.at)) {
      previous = null;
      continue;
    }
    const x = 4 + Math.max(0, Math.min(1, (point.at - start) / span)) * 450;
    const y = 120 - point.soc * 1.04;
    if (previous === null) markers.push({ x, y });
    path += `${previous === null ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)} `;
    previous = point.at;
  }
  const time = (at: number): string =>
    new Intl.DateTimeFormat(locale(), {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(at);
  return (
    <>
      <svg
        className="battery-trend"
        viewBox="0 0 500 148"
        role="img"
        aria-label={tr(
          "Battery charge history; gaps indicate missing readings.",
        )}
      >
        <path className="trend-grid" d="M4 16H458M4 68H458M4 120H458" />
        <text x="467" y="20">
          100
        </text>
        <text x="467" y="72">
          50
        </text>
        <text x="467" y="124">
          0
        </text>
        <path className="trend-line" d={path} />
        {markers.map((point, index) => (
          <circle
            className="trend-point"
            key={index}
            cx={point.x}
            cy={point.y}
            r={2}
          />
        ))}
      </svg>
      <div className="trend-caption">
        <span>
          <i />
          {tr("Battery charge level")}
        </span>
        <span>
          {time(start)} – {time(end)}
        </span>
      </div>
    </>
  );
}

export default function HomePage(): ReactNode {
  const {
    overview: data,
    overviewError,
    overviewLoading,
    session,
  } = useWorkspace();
  if (!data)
    return overviewLoading ? (
      <Loading />
    ) : (
      <Notice tone="danger">
        {overviewError ?? tr("Unable to load your workspace")}
      </Notice>
    );
  const { latest, controller, today } = data;
  const criticalAlerts = data.alerts.items.some(
    (item) => item.severity === "critical",
  );
  const stale = readingIsStale(controller, latest);
  const supported = controller.profile === "bluesun-bse20kh3";
  const batteryState = latest
    ? latest.batteryW < -10
      ? "Battery charging"
      : latest.batteryW > 10
        ? "Battery supplying"
        : "Battery idle"
    : "Waiting for your inverter";
  const date = new Intl.DateTimeFormat(locale(), {
    timeZone: session.tenant.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
  return (
    <>
      <Heading
        eyebrow={tr("YOUR HOME ENERGY")}
        title={tr("Your energy, at a glance.")}
        description={tr("See what’s happening. Take the next step.")}
        action={<span className="home-date">{date}</span>}
      />
      {overviewError && <Notice tone="danger">{overviewError}</Notice>}
      {(controller.error || controller.setupError) && (
        <Notice tone="danger">
          {controller.error ?? controller.setupError}{" "}
          <Link to="/settings">{tr("Check connection")}</Link>
        </Notice>
      )}
      {(!controller.apiConfigured || !controller.deviceSelected) &&
        !controller.error &&
        !controller.setupError && (
          <Notice>
            {tr("Connect your solar system to see your home readings.")}{" "}
            <Link to="/settings">
              {tr("Continue setup")} <ArrowRight size={14} />
            </Link>
          </Notice>
        )}
      {latest && stale && (
        <Notice>
          {tr("These are saved readings, not current live values.")}{" "}
          {when(latest.at, session.tenant.timezone)}
        </Notice>
      )}
      {controller.supervision.issue && (
        <Notice tone="danger">
          {tr(controller.supervision.issue.message)}{" "}
          <Link to="/controls/advanced">{tr("Review app controls")}</Link>
        </Notice>
      )}
      {criticalAlerts && (
        <IncidentSummary
          alerts={data.alerts}
          timezone={session.tenant.timezone}
        />
      )}
      <div className="home-console-grid">
        <section
          className={`panel console-battery ${stale ? "reading-stale" : ""}`}
          aria-label={tr("Battery")}
        >
          <div className="console-card-heading">
            <span>
              <BatteryCharging size={21} />
              {tr("Battery")}
            </span>
            <span className="console-tag">
              {latest ? age(latest.at) : tr("No readings yet")}
            </span>
          </div>
          <div className="battery-display">
            <div className="battery-display-row">
              <div className="battery-digits">
                <strong>{latest ? formatNumber(latest.soc) : "—"}</strong>
                <span>%</span>
              </div>
              <div className="battery-silhouette" aria-hidden="true">
                <i style={{ height: `${latest?.soc ?? 0}%` }} />
              </div>
            </div>
            <div className="battery-segments" aria-hidden="true">
              {Array.from({ length: 20 }, (_, index) => (
                <span
                  key={index}
                  className={
                    latest && (index + 1) * 5 <= latest.soc ? "filled" : ""
                  }
                />
              ))}
            </div>
            <div className="battery-ruler">
              <span>0</span>
              <span>
                {supported
                  ? tr("{{target}}% RESERVE", {
                      target: formatNumber(controller.policy.reserveSoc),
                    })
                  : tr("State of charge")}
              </span>
              <span>100</span>
            </div>
            <div className="battery-current">
              <BatteryCharging size={16} />
              <span>
                {tr(batteryState)}
                {latest && Math.abs(latest.batteryW) > 10
                  ? ` · ${power(latest.batteryW)}`
                  : ""}
              </span>
            </div>
          </div>
          <div className="battery-meta">
            <span>
              {tr("Reserve")}{" "}
              <b>
                {supported
                  ? `${formatNumber(controller.policy.reserveSoc)}%`
                  : "—"}
              </b>
            </span>
            <span>
              {tr("Temperature")}{" "}
              <b>
                {latest ? `${formatNumber(latest.temperatureC, 1)}°C` : "—"}
              </b>
            </span>
          </div>
          <GridChargeControl />
        </section>
        <Panel
          title={tr("Where your energy goes")}
          className="console-flow"
          action={<span className="console-tag">{tr("Latest reading")}</span>}
        >
          <PowerFlow reading={latest} stale={stale} />
          <div className="console-reading-time">
            <Clock3 size={14} />
            <span>
              {latest
                ? tr("Recorded {{time}}", {
                    time: when(latest.at, session.tenant.timezone),
                  })
                : tr("Waiting for your inverter")}
            </span>
          </div>
        </Panel>
        <Panel
          title={tr("Your home policy")}
          className="console-policy"
          action={
            <Link className="text-link" to="/controls">
              {tr("View")} <ArrowRight size={14} />
            </Link>
          }
        >
          {supported ? (
            <div className="home-policy-list">
              <div>
                <Sun className="solar-ink" size={20} />
                <span>
                  <strong>{tr("Solar comes first")}</strong>
                  <small>{tr("Solar charging up to")}</small>
                </span>
                <b>{formatNumber(controller.policy.solarTargetSoc)}%</b>
              </div>
              <div>
                <PlugZap className="grid-ink" size={20} />
                <span>
                  <strong>{tr("Grid restores the reserve")}</strong>
                  <small>
                    {tr("{{target}}% target · AC charge setting", {
                      target: formatNumber(controller.policy.reserveSoc),
                    })}
                  </small>
                </span>
                <b>{formatNumber(controller.policy.acChargeKw)} kW</b>
              </div>
            </div>
          ) : (
            <p className="control-description">
              {tr(
                "Monitoring this inverter. Control policy is available for supported profiles.",
              )}
            </p>
          )}
          <div className="home-policy-status">
            <span
              className={`status-dot ${controller.mode === "active" ? "fresh" : ""}`}
            />
            <p>
              {tr(appPolicyStatus(controller))}{" "}
              {!controller.writesEnabled && (
                <Link to="/controls/setup">{tr("Continue setup")}</Link>
              )}
            </p>
          </div>
        </Panel>
        <Panel
          title={tr("Your battery today")}
          className="console-trend"
          action={
            <Link className="text-link" to="/analytics">
              {tr("Explore history")} <ArrowRight size={14} />
            </Link>
          }
        >
          <BatteryTrend data={today} timezone={session.tenant.timezone} />
        </Panel>
      </div>
      <div className="home-today">
        <div className="section-heading">
          <div>
            <h2>{tr("Today at a glance")}</h2>
            <p>{tr("Estimated energy from valid sample intervals")}</p>
          </div>
          <span className="coverage-pill">
            {Math.round(today.coverage * 100)}
            {tr("% data coverage")}
          </span>
        </div>
        <div className="daily-metrics">
          {[
            {
              label: "Solar generated",
              value: today.totals?.solarKwh,
              icon: Sun,
              color: "solar",
            },
            {
              label: "House consumption",
              value: today.totals?.loadKwh,
              icon: Home,
              color: "house",
            },
            {
              label: "Grid imported",
              value: today.totals?.importKwh,
              icon: PlugZap,
              color: "grid",
            },
            {
              label: "Battery charged",
              value: today.totals?.chargeKwh,
              icon: BatteryCharging,
              color: "battery",
            },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label}>
              <span className={`small-symbol ${color}`}>
                <Icon size={18} />
              </span>
              <div>
                <span>{tr(label)}</span>
                <strong>
                  {energy(value)} <small>{tr("kWh")}</small>
                </strong>
              </div>
            </div>
          ))}
        </div>
      </div>
      {!criticalAlerts && (
        <IncidentSummary
          alerts={data.alerts}
          timezone={session.tenant.timezone}
        />
      )}
    </>
  );
}
