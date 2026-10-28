import { tr, locale } from "./i18n";
import { formatNumber } from "./format";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BatteryCharging,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Home,
  Link2,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
  Unplug,
  Zap,
} from "lucide-react";
import { dateKey, offsetDay, request, useData } from "./api";
import { useWorkspace } from "./context";
import {
  ActivityList,
  age,
  BatteryReserve,
  COLORS,
  DailyChart,
  EmptyState,
  energy,
  Heading,
  Loading,
  Metric,
  Notice,
  Panel,
  power,
  PowerChart,
  PowerFlow,
  SetupNotice,
  StatusBadge,
  when,
} from "./components";
import type {
  ActivityData,
  Analytics,
  SettingsData,
  ControllerStatus,
} from "./types";
import { WriteHistory } from "./write-history";
import { ControlReadinessPanel } from "./control-readiness";
import { IncidentSummary } from "./incident-summary";
import { BackupNotice } from "./backup-health";
import { CapacityNotice, CapacityDetails } from "./api-capacity";
import AccessAdministration from "./access-admin";
import {
  TenantAdministration,
  WorkspaceLifecyclePanel,
} from "./tenant-lifecycle";
import type { TenantMetadata } from "./types";

export function Overview(): ReactNode {
  const {
    overview: data,
    overviewError: error,
    overviewLoading: loading,
    session,
    command,
    busy,
  } = useWorkspace();
  if (!data)
    return loading ? (
      <Loading />
    ) : (
      <Notice tone="danger">
        {error ?? tr("Unable to load your workspace")}
      </Notice>
    );
  const { latest, controller, today, recent } = data;
  const stale =
    (controller.telemetry?.deviceState !== undefined &&
      controller.telemetry.deviceState !== 1) ||
    (latest
      ? Date.now() - new Date(latest.at).getTime() >
        (controller.pollSeconds + 180) * 1000
      : true);
  const date = new Intl.DateTimeFormat(locale(), {
    timeZone: session.tenant.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
  return (
    <>
      <Heading
        eyebrow={date.toUpperCase()}
        title={tr("Energy overview")}
        description={tr("A clear view of your solar, battery, and home.")}
        action={
          <button
            className="button secondary"
            disabled={
              busy || !controller.apiConfigured || !controller.deviceSelected
            }
            onClick={() => {
              void command("refresh");
            }}
          >
            <RefreshCw size={16} className={busy ? "spin" : ""} />
            {tr("Refresh readings")}
          </button>
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <SetupNotice controller={controller} />
      {session.user.platformAdmin && <BackupNotice status={data.backup} />}
      <CapacityNotice capacity={controller.capacity} />
      <IncidentSummary
        alerts={data.alerts}
        timezone={session.tenant.timezone}
      />
      {controller.supervision.issue && (
        <Notice tone="danger">
          <span>{tr(controller.supervision.issue.message)}</span>
          <small className="observation-time">
            {tr("Observed {{time}}", {
              time: when(
                controller.supervision.issue.observedAt,
                session.tenant.timezone,
              ),
            })}
          </small>
        </Notice>
      )}
      {latest && stale && (
        <Notice>
          {tr("These are the last available readings from")}{" "}
          {when(latest.at, session.tenant.timezone)}
          {tr(". They are not current live values.")}
        </Notice>
      )}
      <div className="metrics-grid">
        <Metric
          label={tr("Solar production")}
          value={power(latest?.pvW)}
          detail={
            latest
              ? tr("Available solar power")
              : tr("Waiting for your inverter")
          }
          icon={Sun}
          color={COLORS.solar}
        />
        <Metric
          label={tr("House consumption")}
          value={power(latest?.loadW)}
          detail={
            latest
              ? tr("Current household demand")
              : tr("Waiting for your inverter")
          }
          icon={Home}
          color={COLORS.house}
        />
        <Metric
          label={
            latest && latest.gridW < 0 ? tr("Grid export") : tr("Grid import")
          }
          value={power(latest?.gridW)}
          detail={
            latest
              ? latest.gridW < 0
                ? tr("Power sent to the grid")
                : tr("Power drawn from the grid")
              : tr("Waiting for your inverter")
          }
          icon={PlugZap}
          color={COLORS.grid}
        />
        <Metric
          label={
            latest && latest.batteryW < 0
              ? tr("Battery charging")
              : tr("Battery output")
          }
          value={power(latest?.batteryW)}
          detail={
            latest
              ? tr("{{soc}}% state of charge", { soc: latest.soc })
              : tr("Waiting for your inverter")
          }
          icon={BatteryCharging}
          color={COLORS.battery}
        />
      </div>
      <div className="overview-main">
        <Panel
          title={tr("Where your power flows")}
          subtitle={tr("The latest readings from your selected inverter")}
          action={
            <span className={`live-label ${latest && !stale ? "fresh" : ""}`}>
              <span className="status-dot" />
              {age(latest?.at)}
            </span>
          }
        >
          <PowerFlow reading={latest} stale={stale} />
          <div className="flow-footnote">
            <Clock3 size={14} />
            <span>
              {tr(
                "Checking for device uploads every {{count}} minutes. Refreshing this page uses stored data.",
                { count: controller.pollSeconds / 60 },
              )}
            </span>
          </div>
          {latest && (
            <div className="reading-provenance">
              <span className={`reading-source ${latest.source}`}>
                {tr(
                  latest.source === "provider"
                    ? "Logger readings"
                    : "Live diagnostics",
                )}
              </span>
              <span>
                {tr("Collected {{time}} · Received {{received}}", {
                  time: when(latest.at, session.tenant.timezone),
                  received: age(latest.receivedAt),
                })}
              </span>
            </div>
          )}
        </Panel>
        {controller.profile === "bluesun-bse20kh3" ? (
          <BatteryReserve reading={latest} controller={controller} />
        ) : (
          <Panel
            title={tr("Your connected system")}
            subtitle={tr("Account-specific monitoring")}
          >
            <div className="connection-summary">
              <span className="summary-symbol">
                <Sun size={35} />
              </span>
              <h3>
                {controller.deviceSelected
                  ? tr("Read-only monitoring")
                  : tr("Connect your solar system")}
              </h3>
              <p>
                {controller.deviceSelected
                  ? tr(
                      "View the readings returned by your inverter in Connection settings. Hardware controls require a verified device profile.",
                    )
                  : tr(
                      "Link your own SOLARMAN account, then choose an inverter from your plants.",
                    )}
              </p>
              <Link className="button secondary" to="/settings">
                {tr("Connection settings")} <ArrowRight size={15} />
              </Link>
            </div>
          </Panel>
        )}
      </div>
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
        <div>
          <span className="small-symbol solar">
            <Sun size={18} />
          </span>
          <div>
            <span>{tr("Solar generated")}</span>
            <strong>
              {energy(today.totals?.solarKwh)} <small>{tr("kWh")}</small>
            </strong>
          </div>
        </div>
        <div>
          <span className="small-symbol house">
            <Home size={18} />
          </span>
          <div>
            <span>{tr("House consumption")}</span>
            <strong>
              {energy(today.totals?.loadKwh)} <small>{tr("kWh")}</small>
            </strong>
          </div>
        </div>
        <div>
          <span className="small-symbol grid">
            <ArrowDownLeft size={18} />
          </span>
          <div>
            <span>{tr("Grid imported")}</span>
            <strong>
              {energy(today.totals?.importKwh)} <small>{tr("kWh")}</small>
            </strong>
          </div>
        </div>
        <div>
          <span className="small-symbol battery">
            <BatteryCharging size={18} />
          </span>
          <div>
            <span>{tr("Battery charged")}</span>
            <strong>
              {energy(today.totals?.chargeKwh)} <small>{tr("kWh")}</small>
            </strong>
          </div>
        </div>
      </div>
      <Panel
        title={tr("Your energy through the day")}
        subtitle={tr("Power and battery state of charge")}
        action={
          <Link className="text-link" to="/analytics">
            {tr("Explore analytics")} <ArrowRight size={14} />
          </Link>
        }
      >
        <PowerChart data={today} timezone={session.tenant.timezone} />
      </Panel>
      <Panel
        title={tr("Recent activity")}
        subtitle={tr("Your commands and scheduled checks")}
        action={
          <Link className="text-link" to="/activity">
            {tr("View all activity")} <ArrowRight size={14} />
          </Link>
        }
      >
        <ActivityList items={recent} timezone={session.tenant.timezone} />
      </Panel>
    </>
  );
}

export function AnalyticsPage(): ReactNode {
  const { session } = useWorkspace();
  const today = dateKey(new Date(), session.tenant.timezone);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [preset, setPreset] = useState("Today");
  const { data, loading, error } = useData<Analytics>(
    `/analytics?from=${from}&to=${to}`,
    60_000,
  );
  const pick = (name: string, days: number): void => {
    setPreset(name);
    setFrom(offsetDay(today, name === "Yesterday" ? -1 : -(days - 1)));
    setTo(name === "Yesterday" ? offsetDay(today, -1) : today);
  };
  return (
    <>
      <Heading
        eyebrow={tr("KNOW YOUR PATTERNS")}
        title={tr("Energy analytics")}
        description={tr(
          "Understand generation, consumption, and your battery over time.",
        )}
        action={
          <a
            className="button secondary"
            href={`/api/export.csv?from=${from}&to=${to}`}
          >
            <Download size={16} />
            {tr("Export CSV")}
          </a>
        }
      />
      <div className="range-toolbar">
        <div className="segmented">
          {[
            ["Today", 1],
            ["Yesterday", 1],
            ["7 days", 7],
            ["30 days", 30],
          ].map(([name, days]) => (
            <button
              key={name}
              className={preset === name ? "selected" : ""}
              onClick={() => pick(String(name), Number(days))}
            >
              {tr(String(name))}
            </button>
          ))}
        </div>
        <div className="date-inputs">
          <label>
            <span>{tr("From")}</span>
            <input
              aria-label={tr("From date")}
              type="date"
              value={from}
              max={to}
              onChange={(event) => {
                setFrom(event.target.value);
                setPreset("Custom");
              }}
            />
          </label>
          <span className="date-separator">—</span>
          <label>
            <span>{tr("To")}</span>
            <input
              aria-label={tr("To date")}
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(event) => {
                setTo(event.target.value);
                setPreset("Custom");
              }}
            />
          </label>
        </div>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {!data ? (
        loading ? (
          <Loading />
        ) : null
      ) : (
        <>
          <div className="analytics-metrics">
            <Metric
              label={tr("Solar energy")}
              value={`${energy(data.totals?.solarKwh)} ${tr("kWh")}`}
              detail={tr("Estimated generation")}
              icon={Sun}
              color={COLORS.solar}
            />
            <Metric
              label={tr("House energy")}
              value={`${energy(data.totals?.loadKwh)} ${tr("kWh")}`}
              detail={tr("Estimated consumption")}
              icon={Home}
              color={COLORS.house}
            />
            <Metric
              label={tr("Grid import")}
              value={`${energy(data.totals?.importKwh)} ${tr("kWh")}`}
              detail={tr("Estimated energy purchased")}
              icon={ArrowDownLeft}
              color={COLORS.grid}
            />
            <Metric
              label={tr("Grid export")}
              value={`${energy(data.totals?.exportKwh)} ${tr("kWh")}`}
              detail={tr("Estimated energy exported")}
              icon={ArrowUpRight}
              color={COLORS.battery}
            />
          </div>
          <Panel
            title={tr("Power and state of charge")}
            subtitle={tr("Compare the sources supplying your home")}
            action={
              <span className="coverage-pill">
                {tr("{{count}} readings", { count: data.sampleCount })}
              </span>
            }
          >
            <PowerChart data={data} timezone={session.tenant.timezone} />
          </Panel>
          <div className="analytics-bottom">
            <Panel
              title={tr("Daily energy balance")}
              subtitle={tr("Solar production, consumption, and grid import")}
            >
              <DailyChart data={data} />
            </Panel>
            <Panel
              title={tr("Battery energy")}
              subtitle={tr("Estimated over the selected range")}
            >
              <div className="energy-breakdown">
                <div>
                  <span className="small-symbol battery">
                    <BatteryCharging size={20} />
                  </span>
                  <span>{tr("Charged into battery")}</span>
                  <strong>
                    {energy(data.totals?.chargeKwh)} <small>{tr("kWh")}</small>
                  </strong>
                </div>
                <div>
                  <span className="small-symbol house">
                    <Zap size={20} />
                  </span>
                  <span>{tr("Supplied by battery")}</span>
                  <strong>
                    {energy(data.totals?.dischargeKwh)}{" "}
                    <small>{tr("kWh")}</small>
                  </strong>
                </div>
              </div>
              <div className="coverage-block">
                <div>
                  <span>{tr("Data coverage")}</span>
                  <strong>{Math.round(data.coverage * 100)}%</strong>
                </div>
                <div className="coverage-track">
                  <i style={{ width: `${data.coverage * 100}%` }} />
                </div>
                <p>
                  {tr(
                    "Power is integrated only across valid neighboring samples. Missing intervals are excluded. These are estimates, not billing-meter totals.",
                  )}
                </p>
              </div>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

interface ControlRecoveryProps {
  recovery: ControllerStatus["control"]["recovery"];
  timezone: string;
}

function ControlRecovery({
  recovery,
  timezone,
}: ControlRecoveryProps): ReactNode {
  const states: Record<typeof recovery.state, string> = {
    none: "No pending app changes",
    clear: "Scheduled charging confirmed off",
    owned: "App control session recorded",
    uncertain: "Write outcome unknown",
    "cleanup-required": "Cleanup pending",
  };
  return (
    <Panel
      title={tr("Recovery and write history")}
      subtitle={tr(
        "Intent, device acknowledgment and readback are recorded separately",
      )}
      className="write-recovery"
    >
      <div className="diagnostic-values">
        <div>
          <span>{tr("Recovery status")}</span>
          <strong>{tr(states[recovery.state])}</strong>
        </div>
        <div>
          <span>{tr("Last off confirmation")}</span>
          <strong>
            {recovery.confirmedOffAt
              ? when(recovery.confirmedOffAt, timezone)
              : tr("Not checked yet")}
          </strong>
        </div>
      </div>
      {recovery.writes.length ? (
        <WriteHistory
          writes={recovery.writes}
          timezone={timezone}
          linkToCommand
        />
      ) : (
        <p className="fine-print">
          {tr("No inverter writes have been recorded for this binding.")}
        </p>
      )}
    </Panel>
  );
}

export function Controls(): ReactNode {
  const {
    overview: data,
    overviewLoading,
    overviewError,
    busy,
    submitting,
    command,
  } = useWorkspace();
  if (!data)
    return overviewLoading ? (
      <Loading />
    ) : (
      <Notice tone="danger">{overviewError}</Notice>
    );
  const { controller, latest } = data;
  return (
    <>
      <Heading
        eyebrow={tr("YOUR BATTERY, YOUR CONTROL")}
        title={tr("System controls")}
        description={tr(
          "Clear actions with device acknowledgments and readback verification.",
        )}
        action={
          <button
            className="button secondary controls-stop"
            aria-label={tr("Stop scheduled top-ups now")}
            disabled={submitting || !controller.control.canStop}
            onClick={() => {
              void command("stop");
            }}
          >
            <Pause size={16} /> {tr("Stop scheduled top-ups")}
          </button>
        }
      />
      <SetupNotice controller={controller} />
      <CapacityNotice capacity={controller.capacity} />
      <ControlReadinessPanel
        controller={controller}
        busy={busy}
        submitting={submitting}
        command={command}
      />
      <Panel
        title={tr("Commissioning evidence")}
        subtitle={tr(
          "Compare the configured policy with observed battery behavior",
        )}
      >
        <p>
          {tr(
            "Record solar charging above 50%, battery use above the reserve and the grid charging transition using existing readings.",
          )}
        </p>
        <Link className="button secondary" to="/controls/observations">
          {tr("Observe the home policy")}
        </Link>
      </Panel>
      <div className="controls-grid">
        <Panel
          title={tr("Grid top-up")}
          subtitle={tr("Restore the reserve when solar is insufficient")}
          action={
            <span className="small-symbol grid">
              <PlugZap size={20} />
            </span>
          }
        >
          <div className="topup-target">
            <strong>
              50<span>%</span>
            </strong>
            <div>
              <span>{tr("Battery SOC target")}</span>
              <small>{tr("2 kW AC charge setting")}</small>
            </div>
          </div>
          <p className="control-description">
            {tr(
              "Top up from the grid below 50%. The controller removes AC permission at the target, and leaves charging to solar when surplus is sufficient.",
            )}
          </p>
          <button
            className="button primary full"
            disabled={
              busy ||
              !controller.writesEnabled ||
              !controller.deviceSelected ||
              Boolean(latest && latest.soc >= 50)
            }
            onClick={() => {
              void command("topup");
            }}
          >
            <BatteryCharging size={17} />
            {latest && latest.soc >= 50
              ? tr("Battery is already above the reserve")
              : tr("Top up to 50%")}
          </button>
          <p className="button-helper">
            {!controller.writesEnabled
              ? tr(
                  "A verified compatible profile and enabled hardware writes are required.",
                )
              : tr(
                  "The inverter’s native 50% charging target remains in control.",
                )}
          </p>
        </Panel>
        <Panel
          title={tr("Stop scheduled top-ups")}
          subtitle={tr("Pause app top-ups and clear scheduled permission")}
          action={
            <span className="small-symbol battery">
              <Unplug size={20} />
            </span>
          }
        >
          <div className="control-large-icon">
            <Unplug size={39} strokeWidth={1.2} />
          </div>
          <p className="control-description">
            {tr(
              "Pause application top-ups and remove scheduled AC permission. Solar and the inverter's native reserve policy continue; native grid charging may still run below the reserve.",
            )}
          </p>
          <button
            className="button secondary full"
            disabled={submitting || !controller.control.canStop}
            onClick={() => {
              void command("stop");
            }}
          >
            <Pause size={17} />
            {tr("Stop scheduled top-ups")}
          </button>
          <p className="button-helper">
            {tr("Stops are queued after an in-progress device operation.")}
          </p>
        </Panel>
        <Panel
          title={tr("Reserve automation")}
          subtitle={tr("Evaluate the reserve throughout the day")}
          action={<StatusBadge status={controller.mode} />}
        >
          <div className="automation-route">
            <span>{tr("Solar first")}</span>
            <ArrowRight size={15} />
            <span>{tr("Battery to 50%")}</span>
            <ArrowRight size={15} />
            <span>{tr("Grid support")}</span>
          </div>
          <p className="control-description">
            {tr(
              "Automatic checks use this workspace’s linked account and selected inverter. No other tenant’s account or commands are used.",
            )}
          </p>
          <div className="diagnostic-values supervision-facts">
            <div>
              <span>{tr("Control strategy")}</span>
              <strong>
                {tr(
                  controller.supervision.mode === "native"
                    ? "Native policy supervision"
                    : controller.supervision.mode === "scheduled"
                      ? "Guarded scheduled top-up"
                      : "Monitoring existing inverter policy",
                )}
              </strong>
            </div>
            {controller.supervision.lastNativeAt && (
              <div>
                <span>{tr("Last native policy check")}</span>
                <strong>{age(controller.supervision.lastNativeAt)}</strong>
              </div>
            )}
            {controller.nextPollAt && (
              <div>
                <span>{tr("Next assessment")}</span>
                <strong>
                  {when(controller.nextPollAt, controller.timezone, "medium")}
                </strong>
              </div>
            )}
          </div>
          <p className="fine-print">
            {tr(
              "Full native checks every {{count}} minutes during supervision, and before enabling scheduled charging. Existing native charging is preserved when it already meets the target.",
              { count: controller.supervision.auditSeconds / 60 },
            )}
          </p>
          <button
            className="button secondary full"
            disabled={
              submitting ||
              (controller.paused
                ? busy || !controller.control.canStart
                : !controller.control.canStop)
            }
            onClick={() => {
              void command(controller.paused ? "resume" : "pause");
            }}
          >
            {controller.paused ? <Play size={16} /> : <Pause size={16} />}
            {controller.paused
              ? tr("Resume automation")
              : tr("Pause automation")}
          </button>
          <p className="button-helper">
            {controller.writesEnabled
              ? tr("Evaluation every {{count}} minutes.", {
                  count: controller.pollSeconds / 60,
                })
              : tr(
                  "The server’s read-only setting prevents physical writes even when evaluations resume.",
                )}
          </p>
        </Panel>
        <Panel
          title={tr("Refresh diagnostics")}
          subtitle={tr("Request fresh readings from your device")}
          action={
            <span className="small-symbol solar">
              <RefreshCw size={20} />
            </span>
          }
        >
          <div className="diagnostic-values">
            <div>
              <span>{tr("Last sample")}</span>
              <strong>{age(latest?.at)}</strong>
            </div>
            <div>
              <span>{tr("Scheduled AC permission")}</span>
              <strong>
                {latest && latest.acEnabled !== null
                  ? latest.acEnabled
                    ? tr("Enabled")
                    : tr("Disabled")
                  : tr("Not read yet")}
              </strong>
            </div>
            <div>
              <span>{tr("Battery temperature")}</span>
              <strong>
                {latest
                  ? `${formatNumber(latest.temperatureC, 1)}°C`
                  : tr("Not read yet")}
              </strong>
            </div>
          </div>
          <button
            className="button secondary full"
            disabled={
              busy || !controller.apiConfigured || !controller.deviceSelected
            }
            onClick={() => {
              void command("refresh");
            }}
          >
            <RefreshCw size={16} className={busy ? "spin" : ""} />
            {tr("Read current state")}
          </button>
          <p className="button-helper">
            {tr(
              "Uses provider API calls. Displayed values update after a successful device response.",
            )}
          </p>
        </Panel>
      </div>
      <ControlRecovery
        recovery={controller.control.recovery}
        timezone={controller.timezone}
      />
      {controller.manualTopup && (
        <Notice>
          {tr(
            "One-time top-up is active until 50%, cancellation or expiry. Temporary solar surplus or grid loss pauses the request.",
          )}
          {controller.topupExpiresAt && (
            <>
              {" "}
              {tr("Expires {{time}}", {
                time: when(controller.topupExpiresAt, controller.timezone),
              })}
            </>
          )}
        </Notice>
      )}
      {controller.profile === "bluesun-bse20kh3" && (
        <Notice>
          {tr(
            "Manual request expiry limits this application's intent. Inverter schedules repeat daily and may remain enabled while the API is unreachable.",
          )}{" "}
          {tr(
            "The separate 5 kW solar power cap is not configured or verified. Existing inverter and battery limits continue to apply.",
          )}
        </Notice>
      )}
      <Panel
        title={tr("How the reserve works")}
        subtitle={tr("The intended behavior of the supported battery profile")}
      >
        <div className="policy-explainer">
          <div>
            <span>01</span>
            <h3>{tr("Capture the sunshine")}</h3>
            <p>
              {tr(
                "Solar supplies your home and charges the battery toward 100% SOC.",
              )}
            </p>
          </div>
          <div>
            <span>02</span>
            <h3>{tr("Use stored energy")}</h3>
            <p>
              {tr(
                "With low solar, use battery energy above the configured 50% reserve.",
              )}
            </p>
          </div>
          <div>
            <span>03</span>
            <h3>{tr("Keep the reserve")}</h3>
            <p>
              {tr(
                "Grid power supports the home at the reserve. Below 50%, a guarded top-up can restore it.",
              )}
            </p>
          </div>
        </div>
      </Panel>
    </>
  );
}

export function ActivityPage(): ReactNode {
  const { session } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const query = (params.get("search") ?? "").slice(0, 100);
  const offsetText = params.get("offset") ?? "0";
  const offset = /^\d{1,6}$/.test(offsetText) ? Number(offsetText) : 0;
  const [search, setSearch] = useState(query);
  useEffect(() => {
    setSearch(query);
  }, [query]);
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      setParams({ search, offset: "0" }, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [search, query, setParams]);
  const { data, loading, error } = useData<ActivityData>(
    `/activity?search=${encodeURIComponent(query)}&offset=${offset}`,
    5000,
  );
  return (
    <>
      <Heading
        eyebrow={tr("A RECORD YOU CAN TRUST")}
        title={tr("System activity")}
        description={tr(
          "Your commands, scheduled checks, and the result of each request.",
        )}
        action={
          <Link className="button secondary small" to="/activity/writes">
            {tr("All inverter writes")}
          </Link>
        }
      />
      <div className="activity-toolbar">
        <div className="input-with-icon search-box">
          <Search size={17} />
          <input
            aria-label={tr("Search activity")}
            placeholder={tr("Search commands, results, or actor…")}
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="fine-print">
          {tr("Only this workspace’s activity")}
        </span>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <Panel>
        {!data ? (
          loading ? (
            <Loading />
          ) : null
        ) : data.items.length ? (
          <ActivityList items={data.items} timezone={session.tenant.timezone} />
        ) : (
          <EmptyState
            icon={Activity}
            title={query ? tr("No matching activity") : tr("No activity yet")}
            description={
              query
                ? tr("Try a different search or clear the filter.")
                : tr(
                    "Completed commands and scheduled checks will appear here.",
                  )
            }
          />
        )}
      </Panel>
      <div className="pagination">
        <span>
          {offset
            ? tr("Showing entries {{from}}–{{to}}", {
                from: formatNumber(offset + 1),
                to: formatNumber(offset + (data?.items.length ?? 0)),
              })
            : tr("{{count}} recent entries", {
                count: data?.items.length ?? 0,
              })}
        </span>
        <div>
          <button
            className="button secondary small"
            disabled={!offset}
            onClick={() =>
              setParams({
                search: query,
                offset: String(Math.max(0, offset - 25)),
              })
            }
          >
            <ChevronLeft size={15} />
            {tr("Previous")}
          </button>
          <button
            className="button secondary small"
            disabled={!data?.hasMore}
            onClick={() =>
              setParams({ search: query, offset: String(offset + 25) })
            }
          >
            {tr("Next")}
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </>
  );
}

export function SettingsPage(): ReactNode {
  const { session, refreshSession, command, busy } = useWorkspace();
  const { data, error, loading, reload } = useData<SettingsData>("/settings");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [device, setDevice] = useState("");
  const [profile, setProfile] = useState("monitor-only");
  const [timezone, setTimezone] = useState(session.tenant.timezone);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const [pointSearch, setPointSearch] = useState("");
  useEffect(() => {
    if (data?.account) {
      setEmail(data.account.email);
      setDevice(data.account.device_sn ?? "");
      setProfile(data.account.profile);
      setTimezone(data.account.timezone);
    }
  }, [
    data?.account?.email,
    data?.account?.device_sn,
    data?.account?.profile,
    data?.account?.timezone,
  ]);
  const update = async (
    action: "link" | "discover" | "device",
    body: object,
  ): Promise<void> => {
    setPending(action);
    setMessage(null);
    try {
      await request(`/account/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify(body),
      });
      if (action === "link") {
        setPassword("");
        setAppSecret("");
        setAppId("");
      }
      setMessage({
        text:
          action === "link"
            ? "Your account credentials are saved privately. Test the connection to discover your inverters."
            : action === "discover"
              ? "Connection verified. Choose one of the inverters returned for your account."
              : "Inverter selected. Automation is paused until you choose to resume it.",
        error: false,
      });
      reload();
      await refreshSession();
    } catch (cause) {
      setMessage({
        text:
          cause instanceof Error
            ? cause.message
            : "Unable to update the connection",
        error: true,
      });
    } finally {
      setPending(null);
    }
  };
  const submitLink = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void update("link", {
      email,
      password,
      appId: appId || undefined,
      appSecret: appSecret || undefined,
    });
  };
  const submitDevice = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void update("device", { deviceSn: device, profile, timezone });
  };
  if (!data)
    return loading ? (
      <Loading />
    ) : (
      <Notice tone="danger">{error ?? tr("Unable to load settings")}</Notice>
    );
  const points =
    data.readings?.data_list.filter((p) =>
      `${p.name} ${p.key}`.toLowerCase().includes(pointSearch.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Heading
        eyebrow={tr("CONNECTED TO YOUR ACCOUNT")}
        title={tr("Workspace settings")}
        description={tr(
          "Manage the provider account and inverter belonging to your workspace.",
        )}
        action={
          <div className="settings-actions">
            <Link className="button secondary small" to="/settings/security">
              {tr("Account security")}
            </Link>
            <Link className="button secondary small" to="/settings/health">
              {tr("System health")}
            </Link>
            <Link className="button secondary small" to="/settings/data">
              {tr("Data and privacy")}
            </Link>
          </div>
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {message && (
        <Notice tone={message.error ? "danger" : "success"}>
          {message.text}
        </Notice>
      )}
      <WorkspaceLifecyclePanel />
      <div className="settings-grid">
        <Panel
          title={tr("SOLARMAN account")}
          subtitle={tr(
            "Your provider login is separate from your dashboard login",
          )}
          action={
            <span className="small-symbol solar">
              <Link2 size={20} />
            </span>
          }
        >
          <form onSubmit={submitLink}>
            <label>
              {tr("SOLARMAN email")}
              <input
                type="email"
                required
                autoComplete="off"
                placeholder={tr("Your SOLARMAN Smart email")}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              {tr("SOLARMAN password")}
              <input
                type="password"
                required
                autoComplete="off"
                placeholder={
                  data.account
                    ? tr("Enter password to update the link")
                    : tr("Your SOLARMAN Smart password")
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <details className="advanced-fields">
              <summary>
                {tr("Personal OpenAPI credentials")} <ChevronRight size={14} />
              </summary>
              <p>
                {tr(
                  "Optional if the host provides licensed API access. Leave blank to keep existing app credentials or use the platform default.",
                )}
              </p>
              <label>
                {tr("App ID")}
                <input
                  autoComplete="off"
                  value={appId}
                  onChange={(event) => setAppId(event.target.value)}
                />
              </label>
              <label>
                {tr("App Secret")}
                <input
                  type="password"
                  autoComplete="off"
                  value={appSecret}
                  onChange={(event) => setAppSecret(event.target.value)}
                />
              </label>
            </details>
            <div className="privacy-note">
              <LockKeyhole size={15} />
              <span>
                {tr(
                  "Provider credentials are encrypted for this workspace. They are never sent back to your browser.",
                )}
              </span>
            </div>
            <button className="button primary full" disabled={Boolean(pending)}>
              {pending === "link" ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <>
                  <Link2 size={16} />
                  {data.account
                    ? tr("Update account credentials")
                    : tr("Link my SOLARMAN account")}
                </>
              )}
            </button>
          </form>
        </Panel>
        <Panel
          title={tr("Connection status")}
          subtitle={tr("Verify access before choosing an inverter")}
          action={
            <StatusBadge
              status={data.account?.connection_status ?? "pending"}
            />
          }
        >
          <div className="diagnostic-values connection-details">
            <div>
              <span>{tr("Linked account")}</span>
              <strong>{data.account?.email ?? tr("Not connected")}</strong>
            </div>
            <div>
              <span>{tr("Device selected")}</span>
              <strong>{data.account?.device_sn ?? tr("Not selected")}</strong>
            </div>
            <div>
              <span>{tr("API readiness")}</span>
              <strong>
                {data.controller.apiConfigured
                  ? tr("App credentials configured")
                  : tr("OpenAPI access required")}
              </strong>
            </div>
            <div>
              <span>{tr("Hardware writes")}</span>
              <strong>
                {data.controller.writesEnabled
                  ? tr("Enabled for compatible profile")
                  : tr("Disabled")}
              </strong>
            </div>
          </div>
          {data.account?.connection_message && (
            <Notice tone="danger">{data.account.connection_message}</Notice>
          )}
          {!data.controller.apiConfigured && (
            <div className="api-help">
              <InfoBlock />
              <a
                className="text-link"
                href="https://helpcenter.solarmanpv.com/portal/en/kb/articles/i-want-to-open-api-how-can-i-open-api"
                target="_blank"
                rel="noreferrer"
              >
                {tr("SOLARMAN API activation")} <ExternalLink size={13} />
              </a>
            </div>
          )}
          <button
            className="button secondary full"
            type="button"
            disabled={Boolean(pending) || !data.controller.apiConfigured}
            onClick={() => {
              void update("discover", {});
            }}
          >
            {pending === "discover" ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            {tr("Test connection & discover devices")}
          </button>
        </Panel>
      </div>
      <Panel
        title={tr("Select your inverter")}
        subtitle={tr(
          "Only devices returned for your linked provider account can be selected",
        )}
      >
        <form className="device-form" onSubmit={submitDevice}>
          <label>
            {tr("Inverter")}
            <select
              value={device}
              required
              onChange={(event) => setDevice(event.target.value)}
            >
              <option value="">{tr("Choose a discovered inverter")}</option>
              {data.account?.discovered_devices.map((d) => (
                <option key={d.deviceSn} value={d.deviceSn}>
                  {d.stationName} · {d.deviceSn}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr("Compatibility profile")}
            <select
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
            >
              <option value="monitor-only">
                {tr("Read-only provider readings")}
              </option>
              <option value="bluesun-bse20kh3">
                {tr("Bluesun BSE20KH3 · guarded 50% reserve")}
              </option>
            </select>
          </label>
          <label>
            {tr("Inverter timezone")}
            <input
              list="timezones"
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
            <datalist id="timezones">
              <option value="Europe/Sofia" />
              <option value="Europe/London" />
              <option value="Europe/Berlin" />
              <option value="Europe/Athens" />
              <option value="UTC" />
            </datalist>
          </label>
          <button
            className="button secondary"
            disabled={
              Boolean(pending) || !device || !data.account?.validated_at
            }
          >
            {pending === "device" ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}
            {tr("Save inverter")}
          </button>
        </form>
        <p className="fine-print">
          {tr(
            "The timezone must match the inverter clock. The Bluesun profile checks SelfUse, 2 kW / 50% AC charging, 100% overall SOC and a 50% on-grid reserve. Other models remain read-only.",
          )}
        </p>
      </Panel>
      <div className="settings-grid">
        <Panel
          title={tr("Battery policy")}
          subtitle={tr("Supported targets for the Bluesun profile")}
        >
          <div className="settings-policy">
            <div>
              <span className="small-symbol battery">
                <ShieldCheck size={18} />
              </span>
              <div>
                <strong>{tr("50% grid-connected reserve")}</strong>
                <p>{tr("Use battery energy above the reserve.")}</p>
              </div>
              <span className="setting-value">50%</span>
            </div>
            <div>
              <span className="small-symbol solar">
                <Sun size={18} />
              </span>
              <div>
                <strong>{tr("Solar SOC target")}</strong>
                <p>{tr("Solar can charge above the grid target.")}</p>
              </div>
              <span className="setting-value">100%</span>
            </div>
            <div>
              <span className="small-symbol grid">
                <PlugZap size={18} />
              </span>
              <div>
                <strong>{tr("AC charging setting")}</strong>
                <p>{tr("Verified before any hardware write.")}</p>
              </div>
              <span className="setting-value">{tr("2 kW")}</span>
            </div>
          </div>
          <Notice>
            {tr(
              "The separate 5 kW solar power cap remains unverified and is not changed by this application.",
            )}
          </Notice>
        </Panel>
        <Panel
          title={tr("API usage")}
          subtitle={tr("Budget shared by accounts using the same App ID")}
          className="api-budget"
        >
          {data.budget ? (
            <>
              {data.budget.capacity && (
                <CapacityDetails
                  capacity={data.budget.capacity}
                  disabled={
                    Boolean(pending) || busy || !data.controller.deviceSelected
                  }
                  onRetry={() => {
                    void command("retry_capacity").then(reload);
                  }}
                />
              )}
              <p className="fine-print">
                {tr("Connected workspaces sharing this budget: {{count}}", {
                  count: data.budget.workspaces,
                })}
              </p>
              <div className="usage-number">
                {formatNumber(data.budget.routineRemaining)}
                <span>{tr("calls available for routine use")}</span>
              </div>
              <div
                className={`coverage-track ${data.budget.state !== "available" ? "budget-limited" : ""}`}
                role="meter"
                aria-label={tr("API budget used")}
                aria-valuemin={0}
                aria-valuemax={data.budget.limit}
                aria-valuenow={data.budget.limit - data.budget.remaining}
              >
                <i
                  style={{
                    width: `${Math.min(100, (1 - data.budget.remaining / data.budget.limit) * 100)}%`,
                  }}
                />
              </div>
              {data.budget.state !== "available" && (
                <Notice tone="danger">
                  {tr(
                    data.budget.state === "exhausted"
                      ? "The API request budget is exhausted"
                      : "The remaining API budget is reserved for stopping and recovery",
                  )}
                </Notice>
              )}
              {data.budget.balanceAttemptedAt &&
                Date.now() -
                  new Date(data.budget.balanceAttemptedAt).getTime() >
                  60_000 &&
                (!data.budget.providerCheckedAt ||
                  new Date(data.budget.balanceAttemptedAt) >
                    new Date(data.budget.providerCheckedAt)) && (
                  <Notice>
                    {tr(
                      "The last provider balance check failed. Local request limits still apply.",
                    )}
                  </Notice>
                )}
              <div className="usage-facts">
                <span>
                  {tr("This workspace · last 24 hours")}{" "}
                  <strong>
                    {data.apiUsage.today.toLocaleString(locale())}
                  </strong>
                </span>
                <span>
                  {tr("Tracked calls · last 365 days")}{" "}
                  <strong>{formatNumber(data.budget.tracked)}</strong>
                </span>
                <span>
                  {tr("Adjusted provider balance")}{" "}
                  <strong>
                    {data.budget.providerRemaining === null
                      ? tr("Not checked yet")
                      : formatNumber(data.budget.providerRemaining)}
                  </strong>
                </span>
                <span>
                  {tr("Provider balance checked")}{" "}
                  <strong>
                    {data.budget.providerCheckedAt
                      ? age(data.budget.providerCheckedAt)
                      : tr("Not checked yet")}
                  </strong>
                </span>
                <span>
                  {tr("Reserved for recovery")}{" "}
                  <strong>{formatNumber(data.budget.reserve)}</strong>
                </span>
                <span>
                  {tr("Local rolling request limit")}{" "}
                  <strong>{formatNumber(data.budget.limit)}</strong>
                </span>
                <span>
                  {tr("Sampling interval")}{" "}
                  <strong>
                    {tr("{{count}} minutes", {
                      count: data.controller.pollSeconds / 60,
                    })}
                  </strong>
                </span>
                <span>
                  {tr("This workspace · projected / year")}{" "}
                  <strong>
                    {data.controller.annualProjectedCalls.toLocaleString(
                      locale(),
                    )}{" "}
                    {tr("/ year")}
                  </strong>
                </span>
                <span>
                  {tr("Shared App ID · projected / year")}{" "}
                  <strong>{formatNumber(data.budget.projected)}</strong>
                </span>
              </div>
              {data.budget.projected >
                data.budget.limit - data.budget.reserve && (
                <Notice tone="danger">
                  {tr(
                    "Projected usage exceeds the routine budget. Optimize control polling or configure a licensed allowance before continuous operation.",
                  )}
                </Notice>
              )}
              <p className="fine-print">
                {tr(
                  "The provider balance is checked at most once a day and reduced for subsequent app requests. Calls made elsewhere appear at the next check. A local rolling 365-day limit also applies; hosted use requires suitable provider licensing.",
                )}
              </p>
            </>
          ) : (
            <EmptyState
              icon={PlugZap}
              title={tr("API budget unavailable")}
              description={tr(
                "Link an account with OpenAPI credentials to track its shared request budget.",
              )}
            />
          )}
        </Panel>
      </div>
      {data.readings && (
        <Panel
          title={tr("Provider readings")}
          subtitle={tr(
            "Collected {{time}} · Read-only values returned for your selected device",
            { time: when(data.readings.collected_at, session.tenant.timezone) },
          )}
        >
          <div className="input-with-icon search-box">
            <Search size={17} />
            <input
              aria-label={tr("Search device readings")}
              placeholder={tr("Find a parameter…")}
              value={pointSearch}
              onChange={(event) => setPointSearch(event.target.value)}
            />
          </div>
          <div className="readings-table">
            <table>
              <thead>
                <tr>
                  <th>{tr("Parameter")}</th>
                  <th>{tr("Value")}</th>
                  <th>{tr("Unit")}</th>
                </tr>
              </thead>
              <tbody>
                {points.slice(0, 100).map((p) => (
                  <tr key={p.key}>
                    <td>
                      {p.name}
                      <small>{p.key}</small>
                    </td>
                    <td>{p.value}</td>
                    <td>{p.unit || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {points.length > 100 && (
            <p className="fine-print">
              {tr("Showing the first 100 results. Search to narrow the list.")}
            </p>
          )}
        </Panel>
      )}
    </>
  );
}

function InfoBlock(): ReactNode {
  return (
    <p>
      {tr(
        "Your Smart login is linked. OpenAPI app credentials are additionally required for monitoring and commands. Request your own API access or ask the host to configure licensed platform access.",
      )}
    </p>
  );
}

export function WorkspacesPage(): ReactNode {
  const { session } = useWorkspace();
  const { data, loading, error, reload } = useData<{ items: TenantMetadata[] }>(
    "/admin/tenants",
  );
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [invitation, setInvitation] = useState<string | null>(null);
  const [invitationRevision, setInvitationRevision] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setInvitation(null);
    try {
      const result = await request<{ url: string }>("/admin/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({ email, tenantName: name }),
      });
      setInvitation(result.url);
      setInvitationRevision((value) => value + 1);
      setCopied(false);
      setEmail("");
      setName("");
      reload();
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Unable to create the invitation",
      );
    } finally {
      setPending(false);
    }
  };
  const copy = async (): Promise<void> => {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation);
      setCopied(true);
    } catch {
      setFormError(
        "Copy the invitation from the field below. Clipboard access is unavailable.",
      );
    }
  };
  return (
    <>
      <Heading
        eyebrow={tr("PLATFORM ADMINISTRATION")}
        title={tr("Hosted workspaces")}
        description={tr(
          "Invite users into isolated workspaces connected to their own SOLARMAN accounts.",
        )}
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="settings-grid">
        <Panel
          title={tr("Invite a user")}
          subtitle={tr("An invitation creates a new, separate workspace")}
        >
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <label>
              {tr("Workspace name")}
              <input
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={tr("For example, Family home")}
              />
            </label>
            <label>
              {tr("User email")}
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="owner@example.com"
              />
            </label>
            {formError && <Notice tone="danger">{formError}</Notice>}
            <button className="button primary full" disabled={pending}>
              {pending ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Plus size={16} />
              )}
              {tr("Create private invitation")}
            </button>
          </form>
          {invitation && (
            <div className="invitation-result">
              <Notice tone="success">
                {tr(
                  "Invitation created. Share this link privately; it expires in 24 hours.",
                )}
              </Notice>
              <input
                aria-label={tr("Invitation link")}
                readOnly
                value={invitation}
                onFocus={(event) => event.target.select()}
              />
              <button
                className="button secondary full"
                onClick={() => {
                  void copy();
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? tr("Copied") : tr("Copy invitation link")}
              </button>
            </div>
          )}
        </Panel>
        <Panel
          title={tr("Private by design")}
          subtitle={tr("Each user connects their own provider account")}
        >
          <div className="tenant-principles">
            <div>
              <ShieldCheck size={22} />
              <h3>{tr("Scoped to the workspace")}</h3>
              <p>
                {tr(
                  "Readings, exports, activity and commands are scoped to the signed-in user’s tenant.",
                )}
              </p>
            </div>
            <div>
              <LockKeyhole size={22} />
              <h3>{tr("Separate credentials")}</h3>
              <p>
                {tr(
                  "Local passwords are hashed. Linked provider credentials are encrypted and tokens are isolated by account.",
                )}
              </p>
            </div>
            <div>
              <Building2 size={22} />
              <h3>{tr("One controller per inverter")}</h3>
              <p>
                {tr(
                  "A device cannot be bound to independent workspaces that could issue conflicting commands.",
                )}
              </p>
            </div>
          </div>
        </Panel>
      </div>
      <AccessAdministration
        revision={invitationRevision}
        clearCreatedLink={() => setInvitation(null)}
      />
      <TenantAdministration
        items={data?.items ?? null}
        loading={loading}
        onChanged={reload}
      />
    </>
  );
}
