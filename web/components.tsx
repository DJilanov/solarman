import { tr } from "./i18n";
import { Children, lazy, Suspense, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
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

import { power, when } from "./format";
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
        offboarding: "Workspace closing",
        removed: "Workspace removed",
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
        accepted: "Accepted",
        revoked: "Revoked",
        expired: "Expired",
        replaced: "Replaced",
        capacity: "Waiting for capacity",
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
  const nodes = [
    {
      key: "solar",
      label: "Solar",
      value: reading?.pvW,
      icon: Sun,
      detail: null,
    },
    {
      key: "house",
      label: "Your home",
      value: reading?.loadW,
      icon: Home,
      detail: null,
    },
    {
      key: "grid",
      label: "Grid",
      value: reading?.gridW,
      icon: PlugZap,
      detail: reading
        ? imported
          ? "Grid import"
          : reading.gridW < -10
            ? "Grid export"
            : "Grid idle"
        : "Awaiting a reading",
    },
    {
      key: "battery",
      label: "Battery",
      value: reading?.batteryW,
      icon: BatteryCharging,
      detail: reading
        ? batteryCharging
          ? "Battery charging"
          : reading.batteryW > 10
            ? "Battery supplying"
            : "Battery idle"
        : "Awaiting a reading",
    },
  ];
  return (
    <div
      className={`flow-diagram ${reading && !stale ? "flow-live" : ""}`}
      aria-label={tr("Solar, house, grid and battery power flow")}
    >
      <svg
        className="flow-lines"
        viewBox="0 0 420 330"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M210 35V160M67 160H353" className="flow-track" />
        <path
          d="M210 35V160"
          className={`flow-current solar ${reading && reading.pvW > 30 ? "moving" : ""}`}
        />
        <path
          d="M210 160H353"
          className={`flow-current grid ${imported ? "reverse" : ""} ${reading && Math.abs(reading.gridW) > 30 ? "moving" : ""}`}
        />
        <path
          d="M67 160H210"
          className={`flow-current battery ${batteryCharging ? "reverse" : ""} ${reading && Math.abs(reading.batteryW) > 30 ? "moving" : ""}`}
        />
      </svg>
      {nodes.map(({ key, label, value, icon: Icon, detail }) => (
        <Link to="/analytics" key={key} className={`flow-source source-${key}`}>
          <span className="source-icon">
            <Icon size={23} />
          </span>
          <span className="source-label">{tr(label)}</span>
          <strong>{power(value)}</strong>
          {detail && <small>{tr(detail)}</small>}
        </Link>
      ))}
    </div>
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

export function commandLabel(action: string): string {
  const labels: Record<string, string> = {
    outage_prepare: "Outage preparation",
    outage_restore: "Restore normal operation",
    evaluate: "Reserve evaluation",
    refresh: "Refresh diagnostics",
    verify: "Verify device settings",
    enable_controls: "Enable workspace control",
    commission_controls: "Enable attended controls",
    commission_topup: "Test grid top-up to 50%",
    commission_recovery: "Test scheduled-permission recovery",
    disable_controls: "Disable workspace control",
    retry_capacity: "Retry monitoring capacity",
    topup: "Top up to 50%",
    stop: "Stop scheduled top-ups",
    pause: "Pause automation",
    resume: "Resume automation",
  };
  return tr(labels[action] ?? action);
}

export function ActivityList({
  items,
  timezone = "Europe/Sofia",
}: {
  items: Command[];
  timezone?: string;
}): ReactNode {
  const location = useLocation();
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
              <strong>{commandLabel(item.action)}</strong>
              <StatusBadge status={item.status} />
            </div>
            <p>
              {tr(
                item.message ??
                  "Waiting for the device response and verification.",
              )}
            </p>
            <small>
              {item.actor === "Automation"
                ? tr("Automation")
                : item.actor === "Closure recovery"
                  ? tr("Closure recovery")
                  : item.actor}{" "}
              · {when(item.created_at, timezone)}
            </small>
            <Link
              className="text-link activity-detail-link"
              to={`/activity/${item.id}`}
              state={{
                returnTo:
                  location.pathname === "/activity"
                    ? location.pathname + location.search
                    : "/activity",
              }}
              aria-label={tr("View details for {{action}}", {
                action: commandLabel(item.action),
              })}
            >
              {tr("View command details")} <ArrowRight size={13} />
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
