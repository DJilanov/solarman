import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  BellRing,
  CheckCircle2,
  Circle,
  RefreshCw,
} from "lucide-react";
import { request, useData, isUnconfirmedResponse } from "./api";
import { useWorkspace } from "./context";
import { Heading, Panel, Notice, Loading, when } from "./components";
import { tr } from "./i18n";
import type {
  NotificationSettingsData,
  NotificationChannel,
  NotificationDelivery,
} from "./types";

import { BrowserPushSettings } from "./browser-push";

interface Draft {
  revision: string;
  chatId: string;
  language: "en" | "bg";
  botToken: string;
}
function draftFrom(channel: NotificationChannel | null): Draft {
  return {
    revision: channel?.revision ?? "0",
    chatId: channel?.chatId ?? "",
    language: channel?.language ?? "bg",
    botToken: "",
  };
}
const stateLabels: Record<string, string> = {
  queued: "Waiting to send",
  sending: "Delivery in progress",
  retry: "Retry scheduled",
  delivered: "Delivery confirmed",
  failed: "Delivery failed",
  unconfirmed: "Delivery unconfirmed",
  cancelled: "Delivery cancelled",
  rejected: "Delivery rejected",
};
const kindLabels: Record<NotificationDelivery["kind"], string> = {
  opened: "Incident opened",
  escalated: "Incident escalated",
  resolved: "Recovery detected",
  test: "Destination test",
  platform: "Platform health",
};
const codes: Record<string, string> = {
  delivered: "The destination confirmed a message ID.",
  rate_limited: "The provider requested a delay before retrying.",
  rate_limit_delay_unavailable:
    "The provider rate limit could not be scheduled safely. Test again later.",
  bot_unauthorized:
    "The provider rejected the bot token. Save corrected credentials and test again.",
  destination_rejected:
    "The destination rejected the message. Check the numeric chat ID and bot access.",
  provider_rejected: "The provider rejected delivery.",
  provider_unavailable: "The provider is temporarily unavailable.",
  invalid_configuration: "Delivery configuration is invalid.",
  credentials_unavailable:
    "Notification credentials could not be opened. Save the bot token again.",
  delivery_timeout: "Delivery timed out; the message may already have arrived.",
  transport_unconfirmed: "The connection failed without confirming delivery.",
  response_unconfirmed:
    "The provider response did not confirm delivery to this destination.",
  delivery_unconfirmed: "The delivery result could not be confirmed.",
  dispatch_check_failed:
    "Delivery permissions could not be checked. A retry is scheduled without sending a message.",
  cancelled_before_dispatch: "The request was cancelled before dispatch.",
  settings_changed: "Settings changed; future delivery was cancelled.",
  closed: "Workspace closure cancelled future delivery.",
  restore: "Delivery was disabled by a database restore.",
  rollback: "Delivery was disabled by an application rollback.",
  service_restarted:
    "The service restarted before the delivery result was saved.",
  result_not_saved:
    "A previous delivery result could not be saved. Delivery remains unconfirmed.",
  retry_after_deadline:
    "The next permitted retry would exceed the message deadline. No retry is scheduled.",
  delivery_expired: "The delivery deadline or retry limit was reached.",
  push_accepted:
    "The push service accepted the message; confirmation from the device is still pending.",
  push_displayed: "The device reported that the notification was displayed.",
  push_expired:
    "This browser subscription has expired. Enable notifications again on that device.",
  push_authorization_rejected:
    "The push service rejected authorization. Review the server push configuration.",
  queue_limit:
    "The pending delivery limit was reached. No message was sent for this request.",
};
const eventLabels: Record<string, string> = {
  saved: "Notification settings saved",
  enabled: "Notifications enabled",
  disabled: "Notifications disabled",
  test: "Destination test requested",
  closed: "Notifications disabled for closure",
  restore: "Notifications quarantined after restore",
  rollback: "Notifications disabled for rollback",
  blocked: "Notification delivery disabled after rejection",
};

function TelegramNotifications(): ReactNode {
  const { session } = useWorkspace();
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useData<NotificationSettingsData>(
    `/notifications?offset=${offset}`,
    5000,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (data && draft === null) setDraft(draftFrom(data.channel));
  }, [data, draft]);
  const reset = (): void => {
    if (!data) return;
    setDraft(draftFrom(data.channel));
    setDirty(false);
    setPassword("");
  };
  const update = (patch: Partial<Draft>): void => {
    setDraft((value) => value && { ...value, ...patch });
    setDirty(true);
  };
  const change = async (
    action: "save" | "test" | "enable" | "disable",
  ): Promise<void> => {
    if (!draft) return;
    setPending(true);
    setMessage(null);
    try {
      const next = await request<NotificationSettingsData>("/notifications", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({
          action,
          ...(action === "save"
            ? draft
            : { revision: data?.channel?.revision ?? draft.revision }),
          currentPassword: password,
          ...(action === "test" ? { requestId: crypto.randomUUID() } : {}),
        }),
      });
      setDraft(draftFrom(next.channel));
      setDirty(false);
      setFailed(false);
      setUnconfirmed(false);
      setMessage(
        action === "test"
          ? "Test queued. Delivery is confirmed only when the destination returns a message ID."
          : "Notification settings updated",
      );
      setOffset(0);
    } catch (cause: unknown) {
      setFailed(true);
      if (isUnconfirmedResponse(cause)) {
        setUnconfirmed(true);
        setMessage(
          "The notification request is unconfirmed. Refresh delivery history before trying again.",
        );
      } else
        setMessage(
          cause instanceof Error
            ? cause.message
            : "Unable to update notifications",
        );
      setDraft((value) => value && { ...value, botToken: "" });
    } finally {
      setPassword("");
      setPending(false);
      reload();
    }
  };
  const refresh = async (): Promise<void> => {
    setPending(true);
    try {
      const next = await request<NotificationSettingsData>(
        `/notifications?offset=${offset}`,
      );
      setUnconfirmed(false);
      setMessage(null);
      setDraft(draftFrom(next.channel));
      setDirty(false);
      reload();
    } catch (cause: unknown) {
      setFailed(true);
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Unable to update notifications",
      );
    } finally {
      setPending(false);
    }
  };
  if (!data || !draft)
    return loading || data ? (
      <Loading />
    ) : (
      <Notice tone="danger">
        <p>{tr(error ?? "Unable to update notifications")}</p>
        <button className="button secondary" onClick={reload}>
          {tr("Refresh delivery status")}
        </button>
      </Notice>
    );
  const channel = data.channel;
  const conflict = draft.revision !== (channel?.revision ?? "0");
  const mutable = ["active", "suspended"].includes(data.lifecycle);
  const locked = pending || unconfirmed || !password || !mutable;
  const testCooling = Boolean(
    channel?.lastTestAt && Date.now() - Date.parse(channel.lastTestAt) < 60000,
  );
  const timezone = session.tenant.timezone;
  const date = (value: string | null): string =>
    value ? when(value, timezone, "medium") : tr("Not recorded");
  return (
    <>
      {error && <Notice tone="danger">{error}</Notice>}
      {message && (
        <Notice tone={failed ? "danger" : undefined}>{tr(message)}</Notice>
      )}
      {data.worker.state === "delayed" && (
        <Notice tone="danger">
          {tr(
            "The notification worker is overdue. Delivery status may be out of date.",
          )}
        </Notice>
      )}
      {!mutable && (
        <Notice>
          {tr(
            "This workspace is closing. Notification changes are unavailable.",
          )}
        </Notice>
      )}
      {channel?.quarantined && (
        <Notice>
          {tr(
            "Delivery is quarantined after closure or restore. Save the settings and confirm a new test before enabling alerts.",
          )}
        </Notice>
      )}
      {channel?.blockedCode && (
        <Notice tone="danger">
          {tr(
            codes[channel.blockedCode] ?? "Delivery configuration is invalid.",
          )}
        </Notice>
      )}
      <ol className="notification-steps">
        {[
          { label: "Save a destination", done: channel?.configured },
          { label: "Confirm a test", done: channel?.verifiedAt },
          { label: "Enable alerts", done: channel?.enabled },
        ].map((step) => (
          <li key={step.label} className={step.done ? "complete" : ""}>
            {step.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
            {tr(step.label)}
          </li>
        ))}
      </ol>
      <Panel title={tr("Telegram destination")} action={<BellRing size={22} />}>
        <p>
          {tr(
            "Use a bot token and a numeric chat ID that you control. Login emails are never used as notification destinations.",
          )}
        </p>
        <p>
          {tr(
            "For a private destination, open a chat with your bot and send it a message before testing.",
          )}
        </p>
        <a
          className="text-link"
          href="https://core.telegram.org/bots/tutorial#obtain-your-bot-token"
          target="_blank"
          rel="noreferrer"
        >
          {tr("Telegram bot setup")}
        </a>
        {conflict && (
          <Notice>
            {tr(
              "The saved settings changed. Load the current configuration before sending another request.",
            )}
          </Notice>
        )}
        <label className="field-label" htmlFor="notification-token">
          {tr("Telegram bot token")}
        </label>
        <input
          id="notification-token"
          type="password"
          autoComplete="off"
          value={draft.botToken}
          disabled={pending || !mutable}
          onChange={(event) => update({ botToken: event.target.value })}
        />
        {channel?.configured && (
          <p className="fine-print">
            {tr(
              "Leave the token empty to retain the stored credential. It is never returned to the browser.",
            )}
          </p>
        )}
        <label className="field-label" htmlFor="notification-chat">
          {tr("Numeric chat ID")}
        </label>
        <input
          id="notification-chat"
          inputMode="text"
          autoComplete="off"
          value={draft.chatId}
          maxLength={17}
          disabled={pending || !mutable}
          onChange={(event) => update({ chatId: event.target.value })}
        />
        <label className="field-label" htmlFor="notification-language">
          {tr("Notification language")}
        </label>
        <select
          id="notification-language"
          value={draft.language}
          disabled={pending || !mutable}
          onChange={(event) =>
            update({ language: event.target.value === "en" ? "en" : "bg" })
          }
        >
          <option value="bg">Български</option>
          <option value="en">English</option>
        </select>
        <label className="field-label" htmlFor="notification-password">
          {tr("Current dashboard password")}
        </label>
        <input
          id="notification-password"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={pending}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="readiness-actions">
          <button
            className="button primary"
            disabled={
              locked ||
              !dirty ||
              conflict ||
              !draft.chatId ||
              (!channel?.configured && !draft.botToken)
            }
            onClick={() => {
              void change("save");
            }}
          >
            {tr("Save destination")}
          </button>
          <button
            className="button secondary"
            disabled={pending}
            onClick={reset}
          >
            {tr("Load saved settings")}
          </button>
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCw size={16} />
            {tr("Refresh delivery status")}
          </button>
        </div>
        <p className="fine-print">
          {tr(
            "Changing the destination, credentials or language disables alerts and requires another confirmed test.",
          )}
        </p>
      </Panel>
      <Panel
        title={tr(
          channel?.enabled
            ? "Telegram notifications enabled"
            : "Telegram notifications disabled",
        )}
        subtitle={tr("A queued request is distinct from confirmed delivery")}
      >
        <dl className="command-facts">
          <div>
            <dt>{tr("Last confirmed test")}</dt>
            <dd>{date(channel?.verifiedAt ?? null)}</dd>
          </div>
          <div>
            <dt>{tr("Last test requested")}</dt>
            <dd>{date(channel?.lastTestAt ?? null)}</dd>
          </div>
          <div>
            <dt>{tr("Delivery worker")}</dt>
            <dd>{date(data.worker.checkedAt)}</dd>
          </div>
        </dl>
        <div className="readiness-actions">
          <button
            className="button secondary"
            disabled={
              locked ||
              dirty ||
              conflict ||
              !channel?.configured ||
              testCooling ||
              channel.quarantined
            }
            onClick={() => {
              void change("test");
            }}
          >
            {tr("Send destination test")}
          </button>
          <button
            className="button primary"
            disabled={
              locked ||
              dirty ||
              conflict ||
              !channel?.verifiedAt ||
              channel.enabled ||
              channel.quarantined
            }
            onClick={() => {
              void change("enable");
            }}
          >
            {tr("Enable alerts")}
          </button>
          <button
            className="button secondary"
            disabled={locked || !channel}
            onClick={() => {
              void change("disable");
            }}
          >
            {tr("Disable alerts and cancel pending delivery")}
          </button>
        </div>
        <p className="fine-print">
          {tr(
            "Retries can duplicate a message after an uncertain response. Each message includes the same event reference. A message already in flight may arrive after disabling alerts.",
          )}
        </p>
        <p className="fine-print">
          {tr(
            "This application cannot report its own complete outage. Independent reachability monitoring must run on another host.",
          )}
        </p>
      </Panel>
      <Panel
        title={tr("Delivery history")}
        subtitle={tr(
          "Up to four attempts per message; pending work survives a service restart",
        )}
      >
        {!data.deliveries.length && (
          <p>{tr("No notification deliveries have been requested.")}</p>
        )}
        <div className="notification-deliveries">
          {data.deliveries.map((job) => (
            <article
              key={job.id}
              className={`notification-delivery ${job.state}`}
            >
              <div className="notification-delivery-heading">
                <div>
                  <small>{tr(kindLabels[job.kind])}</small>
                  <h3>{job.payload.title}</h3>
                </div>
                <strong>
                  {tr(
                    job.lastCode === "push_accepted"
                      ? "Accepted by push service"
                      : stateLabels[job.state],
                  )}
                </strong>
              </div>
              <p>
                {date(job.createdAt)} ·{" "}
                {tr("{{count}} delivery attempts", { count: job.attempts })}
              </p>
              {job.state === "retry" && (
                <p>
                  {tr("Next attempt {{time}}", {
                    time: date(job.nextAttemptAt),
                  })}
                </p>
              )}
              {job.lastCode && (
                <p>
                  {tr(
                    codes[job.lastCode] ??
                      "The delivery result could not be confirmed.",
                  )}
                </p>
              )}
              {job.hadUnconfirmed && (
                <Notice>
                  {tr(
                    "An earlier attempt was unconfirmed. Duplicate messages are possible even if a later attempt succeeded.",
                  )}
                </Notice>
              )}
              <details>
                <summary>{tr("Review message and attempts")}</summary>
                <pre className="notification-message">{job.payload.text}</pre>
                <div
                  className="readings-table"
                  tabIndex={0}
                  role="region"
                  aria-label={tr("Delivery attempts")}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>{tr("Attempt")}</th>
                        <th>{tr("Started")}</th>
                        <th>{tr("Status")}</th>
                        <th>{tr("Details")}</th>
                        <th>{tr("Message ID")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {job.history.map((attempt) => (
                        <tr key={attempt.number}>
                          <td>{attempt.number}</td>
                          <td>{date(attempt.startedAt)}</td>
                          <td>
                            {tr(
                              attempt.code === "push_accepted"
                                ? "Accepted by push service"
                                : stateLabels[attempt.state],
                            )}
                          </td>
                          <td>
                            {attempt.code
                              ? tr(
                                  codes[attempt.code] ??
                                    "The delivery result could not be confirmed.",
                                )
                              : "—"}
                          </td>
                          <td>{attempt.messageId ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </article>
          ))}
        </div>
        <div className="pagination">
          <button
            className="button secondary"
            disabled={!offset}
            onClick={() => setOffset((n) => Math.max(0, n - 25))}
          >
            {tr("Previous")}
          </button>
          <button
            className="button secondary"
            disabled={!data.hasMore || offset >= 50000}
            onClick={() => setOffset((n) => n + 25)}
          >
            {tr("Next")}
          </button>
        </div>
      </Panel>
      <Panel title={tr("Recent notification changes")}>
        <ul className="commissioning-events notification-events">
          {data.events.map((event, index) => (
            <li key={`${event.at}:${index}`}>
              <strong>{tr(eventLabels[event.action])}</strong>
              <span>{event.actor}</span>
              <time>{date(event.at)}</time>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

export default function NotificationsPage(): ReactNode {
  return (
    <>
      <Heading
        eyebrow={tr("RELIABLE NOTIFICATIONS")}
        title={tr("External notifications")}
        description={tr(
          "Private incident and recovery alerts for this workspace, with delivery history.",
        )}
        action={
          <Link
            className="button secondary"
            to="/settings"
            aria-label={tr("Back to settings")}
          >
            <ArrowLeft size={16} /> {tr("Back to settings")}
          </Link>
        }
      />
      <BrowserPushSettings />
      <h2>{tr("Optional Telegram alerts")}</h2>
      <TelegramNotifications />
    </>
  );
}
