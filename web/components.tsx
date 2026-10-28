import { tr } from "./i18n";
import { Children, lazy, Suspense, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BatteryCharging,
  CheckCircle2,
  Clock3,
  Home,
  Info,
  Loader2,
  PlugZap,
  Sun,
  type LucideIcon,
} from "lucide-react";
import type {
  Analytics,
  Command,
  ControllerStatus,
  Measurement,
} from "./types";

import { power, when, formatNumber } from "./format";
export { COLORS, power, energy, when, age } from "./format";

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "danger" | "success";
}): ReactNode {
  const Icon =
    tone === "danger" ? AlertCircle : tone === "success" ? CheckCircle2 : Info;
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon size={18} aria-hidden="true" />
      <div>
        {Children.map(children, (child) =>
          typeof child === "string" ? tr(child) : child,
        )}
      </div>
    </div>
  );
}
export function Loading(): ReactNode {
  return (
    <div className="loading-state" role="status">
      <Loader2 className="spin" size={23} />
      <span>{tr("Loading your workspace…")}</span>
    </div>
  );
}
export function EmptyState({
  title,
  description,
  icon: Icon = Activity,
  children,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={27} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function StatusBadge({ status }: { status: string }): ReactNode {
  const label =
    (
      {
        setup: "Setup needed",
        "read-only": "Read-only",
        active: "Automation on",
        paused: "Automation paused",
        error: "Needs attention",
        stopping: "Stopping",
        succeeded: "Completed",
        failed: "Failed",
        queued: "Queued",
        running: "In progress",
        interrupted: "Unconfirmed",
        connected: "Connected",
        pending: "Pending",
      } as Record<string, string>
    )[status] ?? status;
  return (
    <span className={`badge ${status}`}>
      <span className="status-dot" />
      {tr(label)}
    </span>
  );
}
export function SetupNotice({
  controller,
}: {
  controller: ControllerStatus;
}): ReactNode {
  if (controller.error)
    return (
      <Notice tone="danger">
        {controller.error}{" "}
        <Link to="/settings">
          {tr("Check connection")} <ArrowRight size={13} />
        </Link>
      </Notice>
    );
  if (controller.setupError)
    return (
      <Notice>
        {controller.setupError}.{" "}
        <Link to="/settings">
          {tr("Connection settings")} <ArrowRight size={13} />
        </Link>
      </Notice>
    );
  if (!controller.writesEnabled)
    return (
      <Notice>
        {tr(
          "Monitoring is active. Control readiness is shown in System controls.",
        )}{" "}
        <Link to="/controls">
          {tr("Review control readiness")} <ArrowRight size={13} />
        </Link>
      </Notice>
    );
  return null;
}
export function Metric({
  label,
  value,
  detail,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  color: string;
}): ReactNode {
  return (
    <div className="metric">
      <div className="metric-top">
        <span>{label}</span>
        <Icon size={19} style={{ color }} strokeWidth={1.6} />
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function PowerFlow({
  reading,
  stale,
}: {
  reading: Measurement | null;
  stale: boolean;
}): ReactNode {
  const batteryCharging = reading ? reading.batteryW < -10 : false;
  const imported = reading ? reading.gridW > 10 : true;
  const active = Boolean(reading && !stale);
  return (
    <div
      className={`flow-diagram ${active ? "flow-live" : ""}`}
      aria-label={tr("Solar, house, grid and battery power flow")}
    >
      <svg
        className="flow-lines"
        viewBox="0 0 700 300"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M185 92 H267" className="flow-track" />
        <path d="M434 92 H516" className="flow-track" />
        <path d="M350 205 V137" className="flow-track" />
        <path
          d="M185 92 H267"
          className={`flow-current solar ${reading && reading.pvW > 30 ? "moving" : ""}`}
        />
        <path
          d="M434 92 H516"
          className={`flow-current grid ${imported ? "reverse" : ""} ${reading && Math.abs(reading.gridW) > 30 ? "moving" : ""}`}
        />
        <path
          d="M350 205 V137"
          className={`flow-current battery ${batteryCharging ? "reverse" : ""} ${reading && Math.abs(reading.batteryW) > 30 ? "moving" : ""}`}
        />
      </svg>
      <Link to="/analytics" className="flow-source source-solar">
        <span className="source-icon">
          <Sun size={23} />
        </span>
        <span className="source-label">{tr("Solar production")}</span>
        <strong>{power(reading?.pvW)}</strong>
        <small>{tr("Photovoltaic input")}</small>
      </Link>
      <Link to="/analytics" className="flow-source source-house">
        <span className="source-icon">
          <Home size={23} />
        </span>
        <span className="source-label">{tr("Your home")}</span>
        <strong>{power(reading?.loadW)}</strong>
        <small>{tr("House consumption")}</small>
      </Link>
      <Link to="/analytics" className="flow-source source-grid">
        <span className="source-icon">
          <PlugZap size={23} />
        </span>
        <span className="source-label">
          {reading
            ? imported
              ? tr("Grid import")
              : reading.gridW < -10
                ? tr("Grid export")
                : tr("Grid idle")
            : tr("Grid power")}
        </span>
        <strong>{power(reading?.gridW)}</strong>
        <small>
          {reading
            ? imported
              ? tr("Supporting your home")
              : tr("Connection to the grid")
            : tr("Awaiting a reading")}
        </small>
      </Link>
      <Link to="/analytics" className="flow-source source-battery">
        <span className="source-icon">
          <BatteryCharging size={22} />
        </span>
        <span className="source-label">
          {reading
            ? batteryCharging
              ? tr("Battery charging")
              : reading.batteryW > 10
                ? tr("Battery supplying")
                : tr("Battery idle")
            : tr("Battery power")}
        </span>
        <strong>{power(reading?.batteryW)}</strong>
        <small>
          {reading
            ? tr("{{soc}}% state of charge", { soc: reading.soc })
            : tr("Awaiting a reading")}
        </small>
      </Link>
    </div>
  );
}

export function BatteryReserve({
  reading,
  controller,
}: {
  reading: Measurement | null;
  controller: ControllerStatus;
}): ReactNode {
  const soc = reading?.soc ?? 0;
  return (
    <Panel
      title={tr("Battery reserve")}
      subtitle={tr("Use solar. Keep a backup.")}
      className="reserve-panel"
    >
      <div className="soc-ring">
        <svg viewBox="0 0 180 180" aria-hidden="true">
          <circle className="ring-track" cx="90" cy="90" r="72" />
          <circle
            className="ring-progress"
            cx="90"
            cy="90"
            r="72"
            strokeDasharray={`${(soc / 100) * 452.4} 452.4`}
          />
        </svg>
        <div>
          <strong>{reading ? `${soc}%` : "—"}</strong>
          <span>{tr("State of charge")}</span>
        </div>
      </div>
      <div className="reserve-scale">
        <div className="scale-label">
          <span>{tr("Grid reserve")}</span>
          <strong>50%</strong>
        </div>
        <div className="reserve-track">
          <span style={{ width: `${soc}%` }} />
          <i />
        </div>
        <div className="scale-ends">
          <span>0%</span>
          <span>100%</span>
        </div>
      </div>
      <div className="reserve-facts">
        <div>
          <span>{tr("Solar SOC target")}</span>
          <strong>100%</strong>
        </div>
        <div>
          <span>{tr("Grid top-up setting")}</span>
          <strong>{tr("2 kW → 50%")}</strong>
        </div>
        <div>
          <span>{tr("Battery temperature")}</span>
          <strong>
            {reading ? `${formatNumber(reading.temperatureC, 1)}°C` : "—"}
          </strong>
        </div>
      </div>
      <p className="fine-print">
        {controller.writesEnabled
          ? tr(
              "The controller removes grid-charging permission at 50% so stored solar energy can supply your home.",
            )
          : tr(
              "These are the supported control policy targets. Hardware writes are currently disabled.",
            )}
      </p>
    </Panel>
  );
}

const LazyPowerChart = lazy(() =>
  import("./charts").then((module) => ({ default: module.PowerChartContent })),
);
const LazyDailyChart = lazy(() =>
  import("./charts").then((module) => ({ default: module.DailyChartContent })),
);

export function PowerChart({
  data,
  timezone = "Europe/Sofia",
}: {
  data: Analytics;
  timezone?: string;
}): ReactNode {
  if (!data.points.length)
    return (
      <EmptyState
        icon={Activity}
        title={tr("Your energy story starts here")}
        description={tr(
          "Charts will appear after your linked inverter sends its first readings. Missing readings are never shown as zero.",
        )}
      >
        <Link className="text-link" to="/settings">
          {tr("Set up your connection")} <ArrowRight size={14} />
        </Link>
      </EmptyState>
    );
  return (
    <Suspense fallback={<Loading />}>
      <LazyPowerChart data={data} timezone={timezone} />
    </Suspense>
  );
}

export function DailyChart({ data }: { data: Analytics }): ReactNode {
  if (!data.daily.length)
    return (
      <EmptyState
        title={tr("Daily totals need more readings")}
        description={tr(
          "Energy estimates use consecutive samples. Gaps are excluded from the calculation.",
        )}
        icon={Sun}
      />
    );
  return (
    <Suspense fallback={<Loading />}>
      <LazyDailyChart data={data} />
    </Suspense>
  );
}

export function ActivityList({
  items,
  timezone = "Europe/Sofia",
}: {
  items: Command[];
  timezone?: string;
}): ReactNode {
  if (!items.length)
    return (
      <EmptyState
        icon={Clock3}
        title={tr("A clear record of every action")}
        description={tr(
          "Commands and automation evaluations will appear here with their requested action and verified result.",
        )}
      />
    );
  const labels: Record<string, string> = {
    evaluate: "Reserve evaluation",
    refresh: "Refresh diagnostics",
    verify: "Verify device settings",
    enable_controls: "Enable workspace control",
    topup: "Top up to 50%",
    stop: "Stop grid charging",
    pause: "Pause automation",
    resume: "Resume automation",
  };
  return (
    <div className="activity-list">
      {items.map((item) => (
        <div className="activity-row" key={item.id}>
          <span className={`activity-icon ${item.status}`}>
            {item.status === "succeeded" ? (
              <CheckCircle2 size={17} />
            ) : item.status === "failed" ? (
              <AlertCircle size={17} />
            ) : (
              <Clock3 size={17} />
            )}
          </span>
          <div className="activity-copy">
            <div>
              <strong>{tr(labels[item.action] ?? item.action)}</strong>
              <StatusBadge status={item.status} />
            </div>
            <p>
              {tr(
                item.message ??
                  "Waiting for the device response and verification.",
              )}
            </p>
            <small>
              {item.actor === "Automation" ? tr("Automation") : item.actor} ·{" "}
              {when(item.created_at, timezone)}
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}
