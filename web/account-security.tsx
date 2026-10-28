import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  LockKeyhole,
  RefreshCw,
  LogOut,
} from "lucide-react";
import { ApiError, request, useData } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { when, formatNumber } from "./format";
import { Heading, Loading, Notice, Panel } from "./components";
import type { AccountSecurityData, Session } from "./types";

export default function AccountSecurityPage(): ReactNode {
  const { session, updateSession } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const offsetText = params.get("offset") ?? "0";
  const offset = /^\d{1,6}$/.test(offsetText) ? Number(offsetText) : 0;
  const { data, error, loading, reload } = useData<AccountSecurityData>(
    `/security?offset=${offset}`,
    30000,
  );
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const date = (value: string | null): string =>
    value ? when(value, session.tenant.timezone, "medium") : tr("Not recorded");
  const changePassword = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    if (newPassword !== confirm) {
      setMessage({ text: "Passwords do not match", error: true });
      return;
    }
    setPending("password");
    try {
      const updated = await request<Session>("/security/password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      updateSession(updated);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      setParams({});
      reload();
      setMessage({
        text: "Password changed. Other browsers are signed out; this browser has renewed access.",
        error: false,
      });
    } catch (cause) {
      setMessage({
        text:
          cause instanceof ApiError &&
          (cause.status === 0 || cause.status === 200 || cause.status >= 500)
            ? "The password change could not be confirmed. It may have completed; try signing in with the new password before retrying."
            : cause instanceof Error
              ? cause.message
              : "Unable to update account security",
        error: true,
      });
    } finally {
      setPending(null);
    }
  };
  const revoke = async (id: string | null): Promise<void> => {
    if (pending) return;
    setPending(id ?? "others");
    setMessage(null);
    try {
      await request(
        id ? "/security/sessions/revoke" : "/security/sessions/revoke-others",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": session.csrfToken,
          },
          body: JSON.stringify(id ? { id } : {}),
        },
      );
      setParams({});
      reload();
      setMessage({
        text: id
          ? "Browser session signed out"
          : "Other browser sessions signed out",
        error: false,
      });
    } catch (cause) {
      setMessage({
        text:
          cause instanceof Error
            ? cause.message
            : "Unable to update account security",
        error: true,
      });
    } finally {
      setPending(null);
    }
  };
  const eventTitles: Record<
    AccountSecurityData["events"][number]["kind"],
    string
  > = {
    signed_in: "Signed in",
    signed_out: "Signed out",
    password_changed: "Password changed and browser access renewed",
    session_revoked: "Browser session signed out",
    other_sessions_revoked: "Other browser sessions signed out",
  };
  return (
    <>
      <Heading
        title={tr("Account security")}
        description={tr("Manage your dashboard password and browser access.")}
        action={
          <button
            className="button secondary small"
            onClick={reload}
            disabled={loading || Boolean(pending)}
          >
            <RefreshCw size={15} />
            {tr("Refresh status")}
          </button>
        }
      />
      <Link className="text-link command-back" to="/settings">
        <ArrowLeft size={15} />
        {tr("Back to settings")}
      </Link>
      {error && <Notice tone="danger">{error}</Notice>}
      {message && (
        <Notice tone={message.error ? "danger" : "success"}>
          {message.text}
        </Notice>
      )}
      {!data && loading && <Loading />}
      {data && (
        <>
          <div className="security-grid">
            <Panel
              title={tr("Change dashboard password")}
              subtitle={tr("Your SOLARMAN provider password is separate.")}
            >
              <form
                className="security-form"
                onSubmit={(event) => {
                  void changePassword(event);
                }}
              >
                <label>
                  {tr("Email address")}
                  <input
                    type="email"
                    name="username"
                    autoComplete="username"
                    value={session.user.email}
                    readOnly
                  />
                </label>
                <label>
                  {tr("Current password")}
                  <input
                    type="password"
                    name="currentPassword"
                    autoComplete="current-password"
                    maxLength={1024}
                    required
                    disabled={Boolean(pending)}
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </label>
                <label>
                  {tr("New password")}
                  <input
                    type="password"
                    name="newPassword"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={1024}
                    required
                    disabled={Boolean(pending)}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                <label>
                  {tr("Confirm new password")}
                  <input
                    type="password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={1024}
                    required
                    disabled={Boolean(pending)}
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                </label>
                <p className="fine-print">
                  {tr(
                    "Use 8 to 1024 characters. Changing your password signs out every other browser.",
                  )}
                </p>
                <button className="button primary" disabled={Boolean(pending)}>
                  <LockKeyhole size={16} />
                  {tr(
                    pending === "password"
                      ? "Changing password…"
                      : "Change password",
                  )}
                </button>
              </form>
              <p className="fine-print">
                {tr("Last password change")}: {date(data.passwordChangedAt)}
              </p>
            </Panel>
            <Panel
              title={tr("Browser sessions")}
              subtitle={tr("Active browser sessions: {{count}}", {
                count: data.sessionCount,
              })}
              action={
                <button
                  className="button secondary small"
                  disabled={Boolean(pending) || data.sessionCount <= 1}
                  onClick={() => {
                    void revoke(null);
                  }}
                >
                  <LogOut size={15} />
                  {tr("Sign out other browsers")}
                </button>
              }
            >
              <div className="browser-sessions">
                {data.sessions.map((browser) => (
                  <article className="browser-session" key={browser.id}>
                    <div className="browser-session-heading">
                      <strong>
                        {tr(
                          browser.current
                            ? "This browser"
                            : "Another browser session",
                        )}
                      </strong>
                      {!browser.current && (
                        <button
                          className="button secondary small"
                          disabled={Boolean(pending)}
                          onClick={() => {
                            void revoke(browser.id);
                          }}
                        >
                          {tr("End browser session")}
                        </button>
                      )}
                    </div>
                    <dl className="command-facts">
                      <div>
                        <dt>{tr("Signed in")}</dt>
                        <dd>{date(browser.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>{tr("Last activity")}</dt>
                        <dd>{date(browser.lastSeenAt)}</dd>
                      </div>
                      <div>
                        <dt>{tr("Access expires")}</dt>
                        <dd>{date(browser.expiresAt)}</dd>
                      </div>
                    </dl>
                    <details className="browser-description">
                      <summary>{tr("Browser details")}</summary>
                      <p>{browser.userAgent || tr("Not recorded")}</p>
                    </details>
                  </article>
                ))}
                {!data.sessions.length && (
                  <p className="fine-print">
                    {tr("No browser sessions on this page.")}
                  </p>
                )}
              </div>
              {(offset > 0 || data.hasMoreSessions) && (
                <div className="pagination">
                  <span>
                    {tr("Session page {{page}}", {
                      page: formatNumber(Math.floor(offset / 20) + 1),
                    })}
                  </span>
                  <div>
                    <button
                      className="button secondary small"
                      disabled={offset === 0 || Boolean(pending)}
                      onClick={() =>
                        setParams({ offset: String(Math.max(0, offset - 20)) })
                      }
                    >
                      <ChevronLeft size={15} />
                      {tr("Previous")}
                    </button>
                    <button
                      className="button secondary small"
                      disabled={!data.hasMoreSessions || Boolean(pending)}
                      onClick={() => setParams({ offset: String(offset + 20) })}
                    >
                      {tr("Next")}
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </div>
              )}
              <p className="fine-print">
                {tr(
                  "Activity times update at most every five minutes. Browser details are supplied by the browser.",
                )}
              </p>
            </Panel>
          </div>
          <Notice>
            {tr(
              "Signing out browsers does not stop inverter automation or cancel accepted commands. Use Stop scheduled top-ups in Controls when you need to pause charging requests.",
            )}{" "}
            <Link className="text-link" to="/controls">
              {tr("Open controls")}
            </Link>
          </Notice>
          <Panel
            title={tr("Recent account security events")}
            subtitle={tr("The latest 20 account events.")}
          >
            {data.events.length ? (
              <ol className="security-events">
                {data.events.map((event) => (
                  <li key={event.id}>
                    <div>
                      <strong>{tr(eventTitles[event.kind])}</strong>
                      <span>
                        {tr("Sessions affected: {{count}}", {
                          count: event.affectedSessions,
                        })}
                      </span>
                    </div>
                    <time dateTime={event.at}>{date(event.at)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="fine-print">
                {tr("No account security events recorded yet.")}
              </p>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
