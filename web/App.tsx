import { tr, LanguageSwitch } from "./i18n";
import { useTranslation } from "react-i18next";
import {
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Building2,
  History,
  Check,
  ChevronRight,
  CircleHelp,
  Home,
  Loader2,
  LockKeyhole,
  LogOut,
  Mail,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Zap,
  X,
} from "lucide-react";
import { ApiError, isUnconfirmedResponse, request, useData } from "./api";
import { Context } from "./context";
import { usePrivateAccess } from "./private-access";
import { WorkspaceLifecycleNotice } from "./tenant-lifecycle";
import { age, Loading, Notice } from "./components";
import {
  AnalyticsPage,
  AdvancedControls,
  ActivityPage,
  SettingsPage,
  WorkspacesPage,
} from "./pages";
import type { Action, Command, OverviewData, Session } from "./types";
import HomePage from "./home";
import AutomationsPage, { ControlSetupPage } from "./automations";
import { HistoryNavigation } from "./history-navigation";

const CommandDetailsPage = lazy(() => import("./command-details"));
const OutagePreparationPage = lazy(() => import("./outage-preparation"));
const SystemHealthPage = lazy(() => import("./system-health"));
const PolicyObservationsPage = lazy(() => import("./policy-observations"));
const CommissioningPage = lazy(() => import("./commissioning"));
const NotificationsPage = lazy(() => import("./notifications"));
const AccountSecurityPage = lazy(() => import("./account-security"));
const WorkspaceDataPage = lazy(() => import("./workspace-data"));
const RecoverAccountPage = lazy(() => import("./account-recovery"));
const WriteHistoryPage = lazy(() =>
  import("./command-details").then((module) => ({
    default: module.WriteHistoryPage,
  })),
);

function Brand({ compact = false }: { compact?: boolean }): ReactNode {
  return (
    <div className={`brand ${compact ? "compact" : ""}`}>
      <span className="brand-mark">
        <Zap size={23} strokeWidth={1.7} />
      </span>
      <div>
        <strong>
          solarman<span>.</span>
        </strong>
        {!compact && <small>{tr("HOME ENERGY")}</small>}
      </div>
    </div>
  );
}

function SignIn({
  onSignedIn,
  initialError,
}: {
  onSignedIn: (session: Session) => void;
  initialError: string | null;
}): ReactNode {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const session = await request<Session>("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      setPassword("");
      onSignedIn(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in");
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="auth-page">
      <div className="auth-language">
        <LanguageSwitch />
      </div>
      <div className="auth-story">
        <Brand />
        <div className="auth-message">
          <span className="eyebrow">{tr("A CLEARER VIEW OF YOUR ENERGY")}</span>
          <h1>
            {tr("Make the most")}
            <br />
            {tr("of every ray.")}
          </h1>
          <p>
            {tr(
              "Your solar production, battery reserve, and energy use. Together in one private workspace.",
            )}
          </p>
          <div className="auth-benefits">
            <span>
              <Check size={15} /> {tr("Your account. Your data.")}
            </span>
            <span>
              <Check size={15} /> {tr("Verified inverter controls")}
            </span>
          </div>
        </div>
        <div className="auth-horizon">
          <span />
          <span />
          <span />
          <Sun size={80} strokeWidth={0.7} />
        </div>
        <p className="auth-footnote">
          {tr("Solar monitoring · Battery reserve · Energy analytics")}
        </p>
      </div>
      <div className="auth-form-side">
        <div className="auth-card">
          <div className="auth-lock">
            <LockKeyhole size={23} />
          </div>
          <span className="eyebrow">{tr("YOUR ENERGY WORKSPACE")}</span>
          <h2>{tr("Welcome back")}</h2>
          <p>{tr("Sign in to monitor your system and manage your battery.")}</p>
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <label>
              {tr("Email address")}
              <div className="input-with-icon">
                <Mail size={17} />
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoFocus
                />
              </div>
            </label>
            <label>
              {tr("Password")}
              <div className="input-with-icon">
                <LockKeyhole size={17} />
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={tr("Your password")}
                />
              </div>
            </label>
            {error && <Notice tone="danger">{error}</Notice>}
            <button className="button primary full" disabled={pending}>
              {pending ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <>
                  {tr("Sign in")} <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <div className="auth-help">
            <ShieldCheck size={16} />
            <span>
              {tr(
                "Your SOLARMAN account is linked privately after you sign in.",
              )}
            </span>
          </div>
          <Link className="text-link auth-recovery-link" to="/recover">
            {tr("Forgot your dashboard password?")}
          </Link>
          <p className="invite-note">
            {tr("New here? Ask your administrator for a workspace invitation.")}
          </p>
        </div>
        <span className="auth-copyright">
          {tr("SOLARMAN WORKSPACE · PRIVATE ENERGY MONITORING")}
        </span>
      </div>
    </main>
  );
}

function Activate({
  onSignedIn,
}: {
  onSignedIn: (session: Session) => void;
}): ReactNode {
  const { token } = usePrivateAccess();
  const [data, setData] = useState<{
    email: string;
    tenant_name: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [retryable, setRetryable] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    request<{ email: string; tenant_name: string }>("/invitation/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: abort.signal,
    })
      .then((result) => {
        if (active) setData(result);
      })
      .catch((cause: unknown) => {
        if (active) {
          setData(null);
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to inspect this invitation",
          );
          setRetryable(
            cause instanceof ApiError &&
              (cause.status === 0 || cause.status >= 500),
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [token, retry]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    setPassword("");
    setConfirm("");
    setFormError(null);
  }, [token]);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password !== confirm) {
      setFormError("The passwords do not match");
      return;
    }
    setPending(true);
    setFormError(null);
    try {
      const result = await request<Session>("/auth/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      setPassword("");
      setConfirm("");
      onSignedIn(result);
      navigate("/", { replace: true });
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Unable to activate your workspace",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="activation-page">
      <div className="auth-language">
        <LanguageSwitch />
      </div>
      <Brand />
      <div className="auth-card activation-card">
        {loading ? (
          <Loading />
        ) : error ? (
          <>
            <h1>{tr("Invitation unavailable")}</h1>
            <Notice tone="danger">{error}</Notice>
            {retryable && (
              <button
                className="button secondary full"
                onClick={() => setRetry((value) => value + 1)}
              >
                {tr("Retry invitation check")}
              </button>
            )}
            <Link className="button secondary full" to="/">
              {tr("Back to sign in")}
            </Link>
          </>
        ) : (
          data && (
            <>
              <span className="eyebrow">{tr("YOU’RE INVITED")}</span>
              <h1>{data.tenant_name}</h1>
              <p>
                {tr("Create your workspace password for")}{" "}
                <strong>{data.email}</strong>
                {tr(". You will link your own SOLARMAN account next.")}
              </p>
              <form
                onSubmit={(event) => {
                  void submit(event);
                }}
              >
                <label>
                  {tr("Password")}
                  <input
                    type="password"
                    minLength={8}
                    maxLength={1024}
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <label>
                  {tr("Confirm password")}
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                </label>
                {formError && <Notice tone="danger">{formError}</Notice>}
                <button className="button primary full" disabled={pending}>
                  {pending ? (
                    <Loader2 size={17} className="spin" />
                  ) : (
                    <>
                      {tr("Create my workspace")} <ArrowRight size={17} />
                    </>
                  )}
                </button>
              </form>
            </>
          )
        )}
      </div>
    </main>
  );
}

function Dashboard({
  session,
  onSession,
  onLogout,
}: {
  session: Session;
  onSession: (session: Session) => void;
  onLogout: () => void;
}): ReactNode {
  const { data, error, loading, reload } = useData<OverviewData>("/overview");
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    tone: "info" | "danger" | "success";
    commandPath?: string;
  } | null>(null);
  const generation = useRef(0);
  const location = useLocation();
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const command = async (action: Action): Promise<void> => {
    if (
      submitting ||
      (busy && !["stop", "pause", "disable_controls"].includes(action))
    )
      return;
    const current = ++generation.current;
    setBusy(true);
    setSubmitting(true);
    setToast({ message: "Sending your request…", tone: "info" });
    let commandId: string | null = null;
    try {
      let job = await request<Command>("/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ action }),
      });
      if (current !== generation.current) return;
      commandId = job.id;
      setSubmitting(false);
      setToast({
        message:
          action === "retry_capacity"
            ? "Checking polling capacity…"
            : "Request queued. Waiting for the device result…",
        tone: "info",
      });
      for (
        let i = 0;
        i < 180 &&
        ["queued", "running"].includes(job.status) &&
        current === generation.current;
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        job = await request<Command>(`/commands/${job.id}`);
      }
      if (current !== generation.current) return;
      setToast({
        message:
          job.message ??
          "This request is still pending. Check Activity for its final result.",
        tone:
          job.status === "succeeded"
            ? "success"
            : ["failed", "interrupted"].includes(job.status)
              ? "danger"
              : "info",
        commandPath: `/activity/${job.id}`,
      });
    } catch (cause) {
      if (current === generation.current) {
        const unconfirmed = commandId !== null || isUnconfirmedResponse(cause);
        setToast({
          message: unconfirmed
            ? commandId
              ? "The request was accepted, but its final result is unconfirmed. Review Activity and current device readings before retrying."
              : "The request outcome is unconfirmed. Review Activity and current device readings before retrying."
            : cause instanceof Error
              ? cause.message
              : "Unable to complete this action",
          tone: unconfirmed ? "info" : "danger",
          ...(unconfirmed
            ? {
                commandPath: commandId ? `/activity/${commandId}` : "/activity",
              }
            : {}),
        });
      }
    } finally {
      if (current === generation.current) {
        setBusy(false);
        setSubmitting(false);
        reload();
      }
    }
  };
  const refreshSession = async (): Promise<void> => {
    onSession(await request<Session>("/auth/session"));
    reload();
  };
  const logout = async (): Promise<void> => {
    try {
      await request("/auth/logout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: "{}",
      });
      onLogout();
    } catch (cause) {
      setToast({
        message: cause instanceof Error ? cause.message : "Unable to sign out",
        tone: "danger",
      });
    }
  };
  const navigation = [
    { to: "/", label: "Home", icon: Home },
    { to: "/controls", label: "Automations", icon: SlidersHorizontal },
    { to: "/analytics", label: "History", icon: History },
    { to: "/settings", label: "Settings", icon: Settings2 },
  ];
  const matchesSection = (to: string): boolean =>
    to === "/"
      ? location.pathname === "/"
      : to === "/analytics"
        ? location.pathname.startsWith("/analytics") ||
          location.pathname.startsWith("/activity")
        : location.pathname === to || location.pathname.startsWith(`${to}/`);
  const section =
    location.pathname === "/workspaces"
      ? "Administration"
      : (navigation.find((item) => matchesSection(item.to))?.label ?? "Home");
  return (
    <Context.Provider
      value={{
        session,
        overview: data,
        overviewError: error,
        overviewLoading: loading,
        busy,
        submitting,
        command,
        reload,
        refreshSession,
        updateSession: onSession,
      }}
    >
      <div className="app-shell">
        <aside className="sidebar">
          <Link to="/" className="brand-link" aria-label={tr("Solarman Home")}>
            <Brand />
          </Link>
          <div className="workspace-label">
            <span className="workspace-avatar">
              {session.tenant.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{session.tenant.name}</strong>
              <small>{tr("My home")}</small>
            </div>
          </div>
          <span className="nav-label">{tr("MY HOME")}</span>
          <nav aria-label={tr("Main navigation")}>
            {navigation.map(({ to, label, icon: Icon }) => (
              <Link
                to={to}
                key={to}
                className={matchesSection(to) ? "nav-item active" : "nav-item"}
                aria-current={matchesSection(to) ? "page" : undefined}
              >
                <Icon size={18} strokeWidth={1.6} />
                <span>{tr(label)}</span>
                {to === "/controls" && data?.controller.mode === "active" && (
                  <i className="nav-active-dot" />
                )}
              </Link>
            ))}
          </nav>
          <div className="sidebar-bottom">
            {session.user.platformAdmin && (
              <Link className="admin-nav-link" to="/workspaces">
                <Building2 size={17} />
                {tr("Administration")}
              </Link>
            )}
            <div className="sidebar-tip">
              <CircleHelp size={18} />
              <p>
                {tr("Solar keeps charging when timed grid charging is off.")}
              </p>
            </div>
            <button
              className="user-profile"
              onClick={() => {
                void logout();
              }}
              title={tr("Sign out")}
            >
              <span className="user-avatar">
                {session.user.email[0].toUpperCase()}
              </span>
              <span>
                <strong>{tr("My account")}</strong>
                <small>{session.user.email}</small>
              </span>
              <LogOut size={16} />
            </button>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="mobile-brand">
              <Brand compact />
            </div>
            <div className="breadcrumb">
              <Home size={16} />
              <span>{tr("My home")}</span>
              <ChevronRight size={13} />
              <strong>{tr(section)}</strong>
            </div>
            <div className="topbar-status">
              <LanguageSwitch />
              <span className="last-reading">
                <span className="status-dot" />
                {age(data?.latest?.at)}
              </span>
              <button
                className="mobile-logout"
                aria-label={tr("Sign out")}
                onClick={() => {
                  void logout();
                }}
              >
                <LogOut size={17} />
              </button>
            </div>
          </header>
          <main className="main-content">
            <WorkspaceLifecycleNotice />
            {(location.pathname.startsWith("/analytics") ||
              location.pathname.startsWith("/activity")) && (
              <HistoryNavigation />
            )}
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/controls" element={<AutomationsPage />} />
              <Route
                path="/controls/outage"
                element={
                  <Suspense fallback={<Loading />}>
                    <OutagePreparationPage />
                  </Suspense>
                }
              />
              <Route path="/controls/setup" element={<ControlSetupPage />} />
              <Route path="/controls/advanced" element={<AdvancedControls />} />
              <Route
                path="/controls/observations"
                element={
                  <Suspense fallback={<Loading />}>
                    <PolicyObservationsPage />
                  </Suspense>
                }
              />
              <Route path="/activity" element={<ActivityPage />} />
              <Route
                path="/activity/writes"
                element={
                  <Suspense fallback={<Loading />}>
                    <WriteHistoryPage />
                  </Suspense>
                }
              />
              <Route
                path="/activity/:id"
                element={
                  <Suspense fallback={<Loading />}>
                    <CommandDetailsPage />
                  </Suspense>
                }
              />
              <Route
                path="/controls/commissioning"
                element={
                  <Suspense fallback={<Loading />}>
                    <CommissioningPage />
                  </Suspense>
                }
              />
              <Route path="/settings" element={<SettingsPage />} />
              <Route
                path="/settings/notifications"
                element={
                  <Suspense fallback={<Loading />}>
                    <NotificationsPage />
                  </Suspense>
                }
              />
              <Route
                path="/settings/data"
                element={
                  <Suspense fallback={<Loading />}>
                    <WorkspaceDataPage />
                  </Suspense>
                }
              />
              <Route
                path="/settings/security"
                element={
                  <Suspense fallback={<Loading />}>
                    <AccountSecurityPage />
                  </Suspense>
                }
              />
              <Route
                path="/settings/health"
                element={
                  <Suspense fallback={<Loading />}>
                    <SystemHealthPage />
                  </Suspense>
                }
              />
              <Route
                path="/workspaces"
                element={
                  session.user.platformAdmin ? (
                    <WorkspacesPage />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <footer className="page-footer">
              <span>{tr("Solarman · Your home energy")}</span>
              <span>
                {tr("Times shown in")} {session.tenant.timezone}{" "}
                {tr("· Private account data")}
              </span>
            </footer>
          </main>
        </div>
      </div>
      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {busy ? (
            <Loader2 size={18} className="spin" />
          ) : toast.tone === "success" ? (
            <Check size={18} />
          ) : (
            <Activity size={18} />
          )}
          <span>
            {tr(toast.message)}
            {toast.commandPath && (
              <Link className="text-link" to={toast.commandPath}>
                {tr("Review command result")}
              </Link>
            )}
          </span>
          <button
            aria-label={tr("Dismiss notification")}
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </Context.Provider>
  );
}

export default function App(): ReactNode {
  useTranslation();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionCheck, setSessionCheck] = useState<
    "checking" | "complete" | "failed"
  >("checking");
  const [sessionCheckAttempt, setSessionCheckAttempt] = useState(0);
  const authenticationVersion = useRef(0);
  const identify = (next: Session | null): void => {
    authenticationVersion.current++;
    setSession(next);
    setSessionCheck("complete");
  };
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    const version = authenticationVersion.current;
    request<Session>("/auth/session", { signal: abort.signal })
      .then((result) => {
        if (active && version === authenticationVersion.current) {
          setSession(result);
          setError(null);
          setSessionCheck("complete");
        }
      })
      .catch((cause: unknown) => {
        if (!active || version !== authenticationVersion.current) return;
        if (cause instanceof ApiError && cause.status === 401) {
          setSessionCheck("complete");
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to connect");
        setSessionCheck("failed");
      });
    const expired = (): void => {
      identify(null);
      setError("Your session expired. Please sign in again.");
    };
    window.addEventListener("solarman-session-expired", expired);
    return () => {
      active = false;
      abort.abort();
      window.removeEventListener("solarman-session-expired", expired);
    };
  }, [sessionCheckAttempt]);
  if (location.pathname === "/activate")
    return <Activate onSignedIn={identify} />;
  if (sessionCheck === "checking")
    return (
      <main className="app-starting">
        <Brand />
        <Loading />
      </main>
    );
  if (location.pathname === "/recover")
    return (
      <Suspense fallback={<Loading />}>
        <RecoverAccountPage
          currentSession={session}
          onRecovered={(email) => {
            authenticationVersion.current++;
            setSessionCheck("complete");
            setSession((current) =>
              current?.user.email.toLowerCase() === email.trim().toLowerCase()
                ? null
                : current,
            );
            setError(null);
          }}
        />
      </Suspense>
    );
  if (sessionCheck === "failed")
    return (
      <main className="activation-page">
        <LanguageSwitch />
        <Brand />
        <div className="activation-card">
          <h1>{tr("Unable to check your session")}</h1>
          <p>
            {tr(
              "Retry when the dashboard is available to open your workspace.",
            )}
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
          <button
            className="button primary"
            onClick={() => {
              setError(null);
              setSessionCheck("checking");
              setSessionCheckAttempt((attempt) => attempt + 1);
            }}
          >
            {tr("Retry")}
          </button>
          <Link className="button secondary" to="/recover">
            {tr("Forgot your dashboard password?")}
          </Link>
        </div>
      </main>
    );
  if (!session) return <SignIn onSignedIn={identify} initialError={error} />;
  return (
    <Dashboard
      key={session.tenant.id}
      session={session}
      onSession={identify}
      onLogout={() => {
        identify(null);
        setError(null);
      }}
    />
  );
}
