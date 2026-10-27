import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
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
import type { ActivityData, Analytics, SettingsData } from "./types";

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
      <Notice tone="danger">{error ?? "Unable to load your workspace"}</Notice>
    );
  const { latest, controller, today, recent } = data;
  const stale = latest
    ? Date.now() - new Date(latest.at).getTime() >
      (controller.pollSeconds + 180) * 1000
    : true;
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: session.tenant.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
  return (
    <>
      <Heading
        eyebrow={date.toUpperCase()}
        title="Energy overview"
        description="A clear view of your solar, battery, and home."
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
            Refresh readings
          </button>
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <SetupNotice controller={controller} />
      {latest && stale && (
        <Notice>
          These are the last available readings from{" "}
          {when(latest.at, session.tenant.timezone)}. They are not current live
          values.
        </Notice>
      )}
      <div className="metrics-grid">
        <Metric
          label="Solar production"
          value={power(latest?.pvW)}
          detail={
            latest ? "Available solar power" : "Waiting for your inverter"
          }
          icon={Sun}
          color={COLORS.solar}
        />
        <Metric
          label="House consumption"
          value={power(latest?.loadW)}
          detail={
            latest ? "Current household demand" : "Waiting for your inverter"
          }
          icon={Home}
          color={COLORS.house}
        />
        <Metric
          label={latest && latest.gridW < 0 ? "Grid export" : "Grid import"}
          value={power(latest?.gridW)}
          detail={
            latest
              ? latest.gridW < 0
                ? "Power sent to the grid"
                : "Power drawn from the grid"
              : "Waiting for your inverter"
          }
          icon={PlugZap}
          color={COLORS.grid}
        />
        <Metric
          label={
            latest && latest.batteryW < 0
              ? "Battery charging"
              : "Battery output"
          }
          value={power(latest?.batteryW)}
          detail={
            latest
              ? `${latest.soc}% state of charge`
              : "Waiting for your inverter"
          }
          icon={BatteryCharging}
          color={COLORS.battery}
        />
      </div>
      <div className="overview-main">
        <Panel
          title="Where your power flows"
          subtitle="The latest readings from your selected inverter"
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
              Device sampling every {Math.round(controller.pollSeconds / 60)}{" "}
              minutes. Refreshing this page uses stored data.
            </span>
          </div>
        </Panel>
        {controller.profile === "bluesun-bse20kh3" ? (
          <BatteryReserve reading={latest} controller={controller} />
        ) : (
          <Panel
            title="Your connected system"
            subtitle="Account-specific monitoring"
          >
            <div className="connection-summary">
              <span className="summary-symbol">
                <Sun size={35} />
              </span>
              <h3>
                {controller.deviceSelected
                  ? "Read-only monitoring"
                  : "Connect your solar system"}
              </h3>
              <p>
                {controller.deviceSelected
                  ? "View the readings returned by your inverter in Connection settings. Hardware controls require a verified device profile."
                  : "Link your own SOLARMAN account, then choose an inverter from your plants."}
              </p>
              <Link className="button secondary" to="/settings">
                Connection settings <ArrowRight size={15} />
              </Link>
            </div>
          </Panel>
        )}
      </div>
      <div className="section-heading">
        <div>
          <h2>Today at a glance</h2>
          <p>Estimated energy from valid sample intervals</p>
        </div>
        <span className="coverage-pill">
          {Math.round(today.coverage * 100)}% data coverage
        </span>
      </div>
      <div className="daily-metrics">
        <div>
          <span className="small-symbol solar">
            <Sun size={18} />
          </span>
          <div>
            <span>Solar generated</span>
            <strong>
              {energy(today.totals?.solarKwh)} <small>kWh</small>
            </strong>
          </div>
        </div>
        <div>
          <span className="small-symbol house">
            <Home size={18} />
          </span>
          <div>
            <span>House consumption</span>
            <strong>
              {energy(today.totals?.loadKwh)} <small>kWh</small>
            </strong>
          </div>
        </div>
        <div>
          <span className="small-symbol grid">
            <ArrowDownLeft size={18} />
          </span>
          <div>
            <span>Grid imported</span>
            <strong>
              {energy(today.totals?.importKwh)} <small>kWh</small>
            </strong>
          </div>
        </div>
        <div>
          <span className="small-symbol battery">
            <BatteryCharging size={18} />
          </span>
          <div>
            <span>Battery charged</span>
            <strong>
              {energy(today.totals?.chargeKwh)} <small>kWh</small>
            </strong>
          </div>
        </div>
      </div>
      <Panel
        title="Your energy through the day"
        subtitle="Power and battery state of charge"
        action={
          <Link className="text-link" to="/analytics">
            Explore analytics <ArrowRight size={14} />
          </Link>
        }
      >
        <PowerChart data={today} timezone={session.tenant.timezone} />
      </Panel>
      <Panel
        title="Recent activity"
        subtitle="Your commands and scheduled checks"
        action={
          <Link className="text-link" to="/activity">
            View all activity <ArrowRight size={14} />
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
        eyebrow="KNOW YOUR PATTERNS"
        title="Energy analytics"
        description="Understand generation, consumption, and your battery over time."
        action={
          <a
            className="button secondary"
            href={`/api/export.csv?from=${from}&to=${to}`}
          >
            <Download size={16} />
            Export CSV
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
              {name}
            </button>
          ))}
        </div>
        <div className="date-inputs">
          <label>
            <span>From</span>
            <input
              aria-label="From date"
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
            <span>To</span>
            <input
              aria-label="To date"
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
              label="Solar energy"
              value={`${energy(data.totals?.solarKwh)} kWh`}
              detail="Estimated generation"
              icon={Sun}
              color={COLORS.solar}
            />
            <Metric
              label="House energy"
              value={`${energy(data.totals?.loadKwh)} kWh`}
              detail="Estimated consumption"
              icon={Home}
              color={COLORS.house}
            />
            <Metric
              label="Grid import"
              value={`${energy(data.totals?.importKwh)} kWh`}
              detail="Estimated energy purchased"
              icon={ArrowDownLeft}
              color={COLORS.grid}
            />
            <Metric
              label="Grid export"
              value={`${energy(data.totals?.exportKwh)} kWh`}
              detail="Estimated energy exported"
              icon={ArrowUpRight}
              color={COLORS.battery}
            />
          </div>
          <Panel
            title="Power and state of charge"
            subtitle="Compare the sources supplying your home"
            action={
              <span className="coverage-pill">
                {data.sampleCount.toLocaleString()} readings
              </span>
            }
          >
            <PowerChart data={data} timezone={session.tenant.timezone} />
          </Panel>
          <div className="analytics-bottom">
            <Panel
              title="Daily energy balance"
              subtitle="Solar production, consumption, and grid import"
            >
              <DailyChart data={data} />
            </Panel>
            <Panel
              title="Battery energy"
              subtitle="Estimated over the selected range"
            >
              <div className="energy-breakdown">
                <div>
                  <span className="small-symbol battery">
                    <BatteryCharging size={20} />
                  </span>
                  <span>Charged into battery</span>
                  <strong>
                    {energy(data.totals?.chargeKwh)} <small>kWh</small>
                  </strong>
                </div>
                <div>
                  <span className="small-symbol house">
                    <Zap size={20} />
                  </span>
                  <span>Supplied by battery</span>
                  <strong>
                    {energy(data.totals?.dischargeKwh)} <small>kWh</small>
                  </strong>
                </div>
              </div>
              <div className="coverage-block">
                <div>
                  <span>Data coverage</span>
                  <strong>{Math.round(data.coverage * 100)}%</strong>
                </div>
                <div className="coverage-track">
                  <i style={{ width: `${data.coverage * 100}%` }} />
                </div>
                <p>
                  Power is integrated only across valid neighboring samples.
                  Missing intervals are excluded. These are estimates, not
                  billing-meter totals.
                </p>
              </div>
            </Panel>
          </div>
        </>
      )}
    </>
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
        eyebrow="YOUR BATTERY, YOUR CONTROL"
        title="System controls"
        description="Clear actions with device acknowledgments and readback verification."
      />
      <SetupNotice controller={controller} />
      <div className="controls-grid">
        <Panel
          title="Grid top-up"
          subtitle="Restore the reserve when solar is insufficient"
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
              <span>Battery SOC target</span>
              <small>2 kW AC charge setting</small>
            </div>
          </div>
          <p className="control-description">
            Top up from the grid below 50%. The controller removes AC permission
            at the target, and leaves charging to solar when surplus is
            sufficient.
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
              ? "Battery is already above the reserve"
              : "Top up to 50%"}
          </button>
          <p className="button-helper">
            {!controller.writesEnabled
              ? "A verified compatible profile and enabled hardware writes are required."
              : "The inverter’s native 50% charging target remains in control."}
          </p>
        </Panel>
        <Panel
          title="Stop grid charging"
          subtitle="Return to normal solar and battery use"
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
            Stop the grid top-up and pause automatic top-ups. Solar can still
            charge the battery, and the configured on-grid reserve remains in
            place.
          </p>
          <button
            className="button secondary full"
            disabled={submitting || !controller.writesEnabled}
            onClick={() => {
              void command("stop");
            }}
          >
            <Pause size={17} />
            Stop grid charging
          </button>
          <p className="button-helper">
            Stops are queued after an in-progress device operation.
          </p>
        </Panel>
        <Panel
          title="Reserve automation"
          subtitle="Evaluate the reserve throughout the day"
          action={<StatusBadge status={controller.mode} />}
        >
          <div className="automation-route">
            <span>Solar first</span>
            <ArrowRight size={15} />
            <span>Battery to 50%</span>
            <ArrowRight size={15} />
            <span>Grid support</span>
          </div>
          <p className="control-description">
            Automatic checks use this workspace’s linked account and selected
            inverter. No other tenant’s account or commands are used.
          </p>
          <button
            className="button secondary full"
            disabled={
              busy || !controller.apiConfigured || !controller.deviceSelected
            }
            onClick={() => {
              void command(controller.paused ? "resume" : "pause");
            }}
          >
            {controller.paused ? <Play size={16} /> : <Pause size={16} />}
            {controller.paused ? "Resume automation" : "Pause automation"}
          </button>
          <p className="button-helper">
            {controller.writesEnabled
              ? `Evaluation every ${Math.round(controller.pollSeconds / 60)} minutes.`
              : "The server’s read-only setting prevents physical writes even when evaluations resume."}
          </p>
        </Panel>
        <Panel
          title="Refresh diagnostics"
          subtitle="Request fresh readings from your device"
          action={
            <span className="small-symbol solar">
              <RefreshCw size={20} />
            </span>
          }
        >
          <div className="diagnostic-values">
            <div>
              <span>Last sample</span>
              <strong>{age(latest?.at)}</strong>
            </div>
            <div>
              <span>Grid charge permission</span>
              <strong>
                {latest
                  ? latest.acEnabled
                    ? "Enabled"
                    : "Disabled"
                  : "Not read yet"}
              </strong>
            </div>
            <div>
              <span>Battery temperature</span>
              <strong>
                {latest
                  ? `${latest.temperatureC.toFixed(1)}°C`
                  : "Not read yet"}
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
            Read current state
          </button>
          <p className="button-helper">
            Uses provider API calls. Displayed values update after a successful
            device response.
          </p>
        </Panel>
      </div>
      {controller.profile === "bluesun-bse20kh3" && (
        <Notice>
          The separate 5 kW solar power cap is not configured or verified.
          Existing inverter and battery limits continue to apply.
        </Notice>
      )}
      <Panel
        title="How the reserve works"
        subtitle="The intended behavior of the supported battery profile"
      >
        <div className="policy-explainer">
          <div>
            <span>01</span>
            <h3>Capture the sunshine</h3>
            <p>
              Solar supplies your home and charges the battery toward 100% SOC.
            </p>
          </div>
          <div>
            <span>02</span>
            <h3>Use stored energy</h3>
            <p>
              With low solar, use battery energy above the configured 50%
              reserve.
            </p>
          </div>
          <div>
            <span>03</span>
            <h3>Keep the reserve</h3>
            <p>
              Grid power supports the home at the reserve. Below 50%, a guarded
              top-up can restore it.
            </p>
          </div>
        </div>
      </Panel>
    </>
  );
}

export function ActivityPage(): ReactNode {
  const { session } = useWorkspace();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const { data, loading, error } = useData<ActivityData>(
    `/activity?search=${encodeURIComponent(query)}&offset=${offset}`,
    5000,
  );
  return (
    <>
      <Heading
        eyebrow="A RECORD YOU CAN TRUST"
        title="System activity"
        description="Your commands, scheduled checks, and the result of each request."
      />
      <div className="activity-toolbar">
        <div className="input-with-icon search-box">
          <Search size={17} />
          <input
            aria-label="Search activity"
            placeholder="Search commands, results, or actor…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="fine-print">Only this workspace’s activity</span>
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
            title={query ? "No matching activity" : "No activity yet"}
            description={
              query
                ? "Try a different search or clear the filter."
                : "Completed commands and scheduled checks will appear here."
            }
          />
        )}
      </Panel>
      <div className="pagination">
        <span>
          {offset
            ? `Showing entries ${offset + 1}–${offset + (data?.items.length ?? 0)}`
            : `${data?.items.length ?? 0} recent entries`}
        </span>
        <div>
          <button
            className="button secondary small"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            <ChevronLeft size={15} />
            Previous
          </button>
          <button
            className="button secondary small"
            disabled={!data?.hasMore}
            onClick={() => setOffset(offset + 25)}
          >
            Next
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </>
  );
}

export function SettingsPage(): ReactNode {
  const { session, refreshSession } = useWorkspace();
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
      <Notice tone="danger">{error ?? "Unable to load settings"}</Notice>
    );
  const points =
    data.readings?.data_list.filter((p) =>
      `${p.name} ${p.key}`.toLowerCase().includes(pointSearch.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Heading
        eyebrow="CONNECTED TO YOUR ACCOUNT"
        title="Workspace settings"
        description="Manage the provider account and inverter belonging to your workspace."
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {message && (
        <Notice tone={message.error ? "danger" : "success"}>
          {message.text}
        </Notice>
      )}
      <div className="settings-grid">
        <Panel
          title="SOLARMAN account"
          subtitle="Your provider login is separate from your dashboard login"
          action={
            <span className="small-symbol solar">
              <Link2 size={20} />
            </span>
          }
        >
          <form onSubmit={submitLink}>
            <label>
              SOLARMAN email
              <input
                type="email"
                required
                autoComplete="off"
                placeholder="Your SOLARMAN Smart email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              SOLARMAN password
              <input
                type="password"
                required
                autoComplete="off"
                placeholder={
                  data.account
                    ? "Enter password to update the link"
                    : "Your SOLARMAN Smart password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <details className="advanced-fields">
              <summary>
                Personal OpenAPI credentials <ChevronRight size={14} />
              </summary>
              <p>
                Optional if the host provides licensed API access. Leave blank
                to keep existing app credentials or use the platform default.
              </p>
              <label>
                App ID
                <input
                  autoComplete="off"
                  value={appId}
                  onChange={(event) => setAppId(event.target.value)}
                />
              </label>
              <label>
                App Secret
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
                Provider credentials are encrypted for this workspace. They are
                never sent back to your browser.
              </span>
            </div>
            <button className="button primary full" disabled={Boolean(pending)}>
              {pending === "link" ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <>
                  <Link2 size={16} />
                  {data.account
                    ? "Update account credentials"
                    : "Link my SOLARMAN account"}
                </>
              )}
            </button>
          </form>
        </Panel>
        <Panel
          title="Connection status"
          subtitle="Verify access before choosing an inverter"
          action={
            <StatusBadge
              status={data.account?.connection_status ?? "pending"}
            />
          }
        >
          <div className="diagnostic-values connection-details">
            <div>
              <span>Linked account</span>
              <strong>{data.account?.email ?? "Not connected"}</strong>
            </div>
            <div>
              <span>Device selected</span>
              <strong>{data.account?.device_sn ?? "Not selected"}</strong>
            </div>
            <div>
              <span>API readiness</span>
              <strong>
                {data.controller.apiConfigured
                  ? "App credentials configured"
                  : "OpenAPI access required"}
              </strong>
            </div>
            <div>
              <span>Hardware writes</span>
              <strong>
                {data.controller.writesEnabled
                  ? "Enabled for compatible profile"
                  : "Disabled"}
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
                SOLARMAN API activation <ExternalLink size={13} />
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
            Test connection & discover devices
          </button>
        </Panel>
      </div>
      <Panel
        title="Select your inverter"
        subtitle="Only devices returned for your linked provider account can be selected"
      >
        <form className="device-form" onSubmit={submitDevice}>
          <label>
            Inverter
            <select
              value={device}
              required
              onChange={(event) => setDevice(event.target.value)}
            >
              <option value="">Choose a discovered inverter</option>
              {data.account?.discovered_devices.map((d) => (
                <option key={d.deviceSn} value={d.deviceSn}>
                  {d.stationName} · {d.deviceSn}
                </option>
              ))}
            </select>
          </label>
          <label>
            Compatibility profile
            <select
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
            >
              <option value="monitor-only">Read-only provider readings</option>
              <option value="bluesun-bse20kh3">
                Bluesun BSE20KH3 · guarded 50% reserve
              </option>
            </select>
          </label>
          <label>
            Inverter timezone
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
            Save inverter
          </button>
        </form>
        <p className="fine-print">
          The timezone must match the inverter clock. The Bluesun profile checks
          SelfUse, 2 kW / 50% AC charging, 100% overall SOC and a 50% on-grid
          reserve. Other models remain read-only.
        </p>
      </Panel>
      <div className="settings-grid">
        <Panel
          title="Battery policy"
          subtitle="Supported targets for the Bluesun profile"
        >
          <div className="settings-policy">
            <div>
              <span className="small-symbol battery">
                <ShieldCheck size={18} />
              </span>
              <div>
                <strong>50% grid-connected reserve</strong>
                <p>Use battery energy above the reserve.</p>
              </div>
              <span className="setting-value">50%</span>
            </div>
            <div>
              <span className="small-symbol solar">
                <Sun size={18} />
              </span>
              <div>
                <strong>Solar SOC target</strong>
                <p>Solar can charge above the grid target.</p>
              </div>
              <span className="setting-value">100%</span>
            </div>
            <div>
              <span className="small-symbol grid">
                <PlugZap size={18} />
              </span>
              <div>
                <strong>AC charging setting</strong>
                <p>Verified before any hardware write.</p>
              </div>
              <span className="setting-value">2 kW</span>
            </div>
          </div>
          <Notice>
            The separate 5 kW solar power cap remains unverified and is not
            changed by this application.
          </Notice>
        </Panel>
        <Panel title="API usage" subtitle="Requests made by this workspace">
          <div className="usage-number">
            {data.apiUsage.year.toLocaleString()}
            <span>calls this calendar year</span>
          </div>
          <div className="coverage-track">
            <i
              style={{
                width: `${Math.min(100, (data.apiUsage.year / data.quota) * 100)}%`,
              }}
            />
          </div>
          <div className="usage-facts">
            <span>
              Last 24 hours{" "}
              <strong>{data.apiUsage.today.toLocaleString()}</strong>
            </span>
            <span>
              Sampling interval{" "}
              <strong>
                {Math.round(data.controller.pollSeconds / 60)} minutes
              </strong>
            </span>
            <span>
              Projected regular usage{" "}
              <strong>
                {data.controller.annualProjectedCalls.toLocaleString()} / year
              </strong>
            </span>
          </div>
          <p className="fine-print">
            The reference personal API plan allows 200,000 calls/year. Shared
            platform access also has user and plant limits. These counts exclude
            requests made outside this service; hosted tenants require suitable
            provider licensing.
          </p>
        </Panel>
      </div>
      {data.readings && (
        <Panel
          title="Provider readings"
          subtitle={`Collected ${when(data.readings.collected_at, session.tenant.timezone)} · Read-only values returned for your selected device`}
        >
          <div className="input-with-icon search-box">
            <Search size={17} />
            <input
              aria-label="Search device readings"
              placeholder="Find a parameter…"
              value={pointSearch}
              onChange={(event) => setPointSearch(event.target.value)}
            />
          </div>
          <div className="readings-table">
            <table>
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Value</th>
                  <th>Unit</th>
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
              Showing the first 100 results. Search to narrow the list.
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
      Your Smart login is linked. OpenAPI app credentials are additionally
      required for monitoring and commands. Request your own API access or ask
      the host to configure licensed platform access.
    </p>
  );
}

export function WorkspacesPage(): ReactNode {
  const { session } = useWorkspace();
  const { data, loading, error, reload } = useData<{
    items: {
      id: string;
      name: string;
      created_at: string;
      members: number;
      connection_status: string | null;
    }[];
  }>("/admin/tenants");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [invitation, setInvitation] = useState<string | null>(null);
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
        eyebrow="PLATFORM ADMINISTRATION"
        title="Hosted workspaces"
        description="Invite users into isolated workspaces connected to their own SOLARMAN accounts."
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="settings-grid">
        <Panel
          title="Invite a user"
          subtitle="An invitation creates a new, separate workspace"
        >
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <label>
              Workspace name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="For example, Family home"
              />
            </label>
            <label>
              User email
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
              Create private invitation
            </button>
          </form>
          {invitation && (
            <div className="invitation-result">
              <Notice tone="success">
                Invitation created. Share this link privately; it expires in 24
                hours.
              </Notice>
              <input
                aria-label="Invitation link"
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
                {copied ? "Copied" : "Copy invitation link"}
              </button>
            </div>
          )}
        </Panel>
        <Panel
          title="Private by design"
          subtitle="Each user connects their own provider account"
        >
          <div className="tenant-principles">
            <div>
              <ShieldCheck size={22} />
              <h3>Scoped to the workspace</h3>
              <p>
                Readings, exports, activity and commands are scoped to the
                signed-in user’s tenant.
              </p>
            </div>
            <div>
              <LockKeyhole size={22} />
              <h3>Separate credentials</h3>
              <p>
                Local passwords are hashed. Linked provider credentials are
                encrypted and tokens are isolated by account.
              </p>
            </div>
            <div>
              <Building2 size={22} />
              <h3>One controller per inverter</h3>
              <p>
                A device cannot be bound to independent workspaces that could
                issue conflicting commands.
              </p>
            </div>
          </div>
        </Panel>
      </div>
      <Panel
        title="Workspaces"
        subtitle="Platform account metadata only; inverter data stays private"
      >
        {!data ? (
          loading ? (
            <Loading />
          ) : null
        ) : (
          <div className="readings-table">
            <table>
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Members</th>
                  <th>Connection</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>{item.members}</td>
                    <td>
                      <StatusBadge
                        status={item.connection_status ?? "pending"}
                      />
                    </td>
                    <td>{when(item.created_at, session.tenant.timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
