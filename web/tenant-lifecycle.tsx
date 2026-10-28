import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { request, useData, isUnconfirmedResponse } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { Loading, Notice, Panel, StatusBadge, when } from "./components";
import ClosureAdministration from "./workspace-offboarding";
import type {
  LifecycleState,
  TenantLifecycleStatus,
  TenantMetadata,
} from "./types";

function stateLabel(state: LifecycleState): string {
  return tr(
    {
      active: "Workspace available",
      suspended: "Workspace suspended",
      offboarding: "Workspace closing",
      removed: "Workspace removed",
    }[state],
  );
}

export function WorkspaceLifecycleNotice(): ReactNode {
  const { data, error } = useData<TenantLifecycleStatus>(
    "/workspace/lifecycle",
  );
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!data || data.state === "active") return null;
  return (
    <Notice tone="danger">
      <strong>{stateLabel(data.state)}</strong>
      <p>
        {tr(
          data.state === "offboarding"
            ? "Routine collection and automation are stopped. Export needed data before erasure authorization."
            : "Monitoring, exports, account security and recovery remain available. Starting automation is unavailable.",
        )}
      </p>
      {data.message && <p>{data.message}</p>}
      <Link to="/settings">{tr("View workspace status")}</Link>
    </Notice>
  );
}

export function WorkspaceLifecyclePanel(): ReactNode {
  const { data, error, reload } = useData<TenantLifecycleStatus>(
    "/workspace/lifecycle",
  );
  const { session } = useWorkspace();
  return (
    <Panel
      title={tr("Workspace status")}
      subtitle={tr("Availability and recent workspace changes")}
      action={
        <button className="button secondary" onClick={reload}>
          {tr("Refresh status")}
        </button>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {!data ? (
        <Loading />
      ) : (
        <>
          <strong>{stateLabel(data.state)}</strong>
          <p>
            {tr(
              data.state === "active"
                ? "Workspace availability does not enable inverter control. Fresh verification and control activation are separate."
                : data.state === "offboarding"
                  ? "Routine collection and automation are stopped. Export needed data before erasure authorization."
                  : "Monitoring, exports, account security and recovery remain available. Starting automation is unavailable.",
            )}
          </p>
          {data.message && <p>{data.message}</p>}
          {data.cleanupPending && (
            <Notice tone="danger">
              {tr(
                "Scheduled charging cleanup is pending. Suspension does not confirm that the inverter has stopped.",
              )}
            </Notice>
          )}
          <LifecycleHistory data={data} timezone={session.tenant.timezone} />
        </>
      )}
    </Panel>
  );
}

function LifecycleHistory({
  data,
  timezone,
}: {
  data: TenantLifecycleStatus;
  timezone: string;
}): ReactNode {
  return (
    <div className="lifecycle-history">
      <h3>{tr("Recent workspace changes")}</h3>
      {!data.events.length ? (
        <p className="fine-print">
          {tr("No workspace availability changes yet.")}
        </p>
      ) : (
        <ol>
          {data.events.map((event) => (
            <li key={event.id}>
              <strong>
                {tr(
                  event.state === "active"
                    ? "Workspace made available"
                    : event.state === "offboarding"
                      ? "Workspace closing"
                      : event.state === "removed"
                        ? "Workspace removed"
                        : "Workspace suspended",
                )}
              </strong>
              <small>{when(event.at, timezone)}</small>
              {event.message && <p>{event.message}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function LifecycleForm({
  tenant,
  onChanged,
  onClose,
}: {
  tenant: TenantMetadata;
  onChanged: () => void;
  onClose: () => void;
}): ReactNode {
  const { session } = useWorkspace();
  const { data, error, reload } = useData<TenantLifecycleStatus>(
    `/admin/tenants/${tenant.id}/lifecycle`,
  );
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!data) return;
    setPending(true);
    setFailure(null);
    setSuccess(null);
    try {
      const result = await request<TenantLifecycleStatus>(
        `/admin/tenants/${tenant.id}/lifecycle`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": session.csrfToken,
          },
          body: JSON.stringify({
            state: data.state === "active" ? "suspended" : "active",
            revision: data.revision,
            currentPassword: password,
            message,
          }),
        },
      );
      setPassword("");
      setMessage("");
      setSuccess(
        result.state === "suspended"
          ? "Workspace suspended. Automation starts were cancelled; device cleanup has a separate status."
          : "Workspace available. Automation remains paused and control must be verified and activated again.",
      );
    } catch (cause) {
      if (isUnconfirmedResponse(cause)) setPassword("");
      setFailure(
        isUnconfirmedResponse(cause)
          ? "The workspace change is unconfirmed. Refresh its status before trying again."
          : cause instanceof Error
            ? cause.message
            : "Unable to change workspace availability",
      );
    } finally {
      setPending(false);
      reload();
      onChanged();
    }
  };
  return (
    <Panel
      title={data?.state === "removed" ? tr("Workspace removed") : tenant.name}
      subtitle={tr("Manage workspace availability")}
      action={
        <button
          className="button secondary"
          disabled={pending}
          onClick={onClose}
        >
          {tr("Close")}
        </button>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {!data ? (
        <Loading />
      ) : (
        <>
          <strong>{stateLabel(data.state)}</strong>
          {data.message && <p>{data.message}</p>}
          {data.cleanupPending && (
            <Notice tone="danger">
              {tr(
                "Scheduled charging cleanup is pending. Suspension does not confirm that the inverter has stopped.",
              )}
            </Notice>
          )}
          {(data.state === "active" || data.state === "suspended") && (
            <p>
              {tr(
                "Suspension cancels automation starts and revokes workspace control. Monitoring and recovery continue. Making a workspace available does not restart automation.",
              )}
            </p>
          )}
          {(data.state === "active" || data.state === "suspended") && (
            <form
              onSubmit={(event) => {
                void submit(event);
              }}
            >
              <label>
                {tr("Current dashboard password")}
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                  value={password}
                  disabled={pending || data.protected}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label>
                {tr("Message to workspace members")}
                <textarea
                  maxLength={500}
                  value={message}
                  disabled={pending || data.protected}
                  onChange={(event) => setMessage(event.target.value)}
                  rows={3}
                />
              </label>
              {data.protected && (
                <Notice>
                  {tr(
                    "Administrator workspace availability is managed by the server operator",
                  )}
                </Notice>
              )}
              {failure && <Notice tone="danger">{failure}</Notice>}
              {success && <Notice tone="success">{success}</Notice>}
              <div className="lifecycle-actions">
                <button
                  className="button primary"
                  disabled={pending || data.protected || !password}
                >
                  {tr(
                    pending
                      ? "Saving…"
                      : data.state === "active"
                        ? "Suspend workspace"
                        : "Make workspace available",
                  )}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={pending}
                  onClick={reload}
                >
                  {tr("Refresh status")}
                </button>
              </div>
            </form>
          )}
          <ClosureAdministration
            tenantId={tenant.id}
            tenantName={tenant.name}
            lifecycle={data}
            onChanged={() => {
              reload();
              onChanged();
            }}
          />
          <LifecycleHistory data={data} timezone={session.tenant.timezone} />
        </>
      )}
    </Panel>
  );
}

export function TenantAdministration({
  items,
  loading,
  onChanged,
}: {
  items: TenantMetadata[] | null;
  loading: boolean;
  onChanged: () => void;
}): ReactNode {
  const { session } = useWorkspace();
  const [selected, setSelected] = useState<TenantMetadata | null>(null);
  return (
    <>
      <Panel
        title={tr("Workspaces")}
        subtitle={tr(
          "Platform account metadata only; inverter data stays private",
        )}
      >
        {!items ? (
          loading ? (
            <Loading />
          ) : null
        ) : (
          <div className="readings-table">
            <table>
              <thead>
                <tr>
                  {[
                    "Workspace",
                    "Members",
                    "Connection",
                    "Availability",
                    "Created",
                    "Actions",
                  ].map((label) => (
                    <th key={label}>{tr(label)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>
                        {item.lifecycle === "removed"
                          ? tr("Workspace removed")
                          : item.name}
                      </strong>
                    </td>
                    <td>{item.members}</td>
                    <td>
                      <StatusBadge
                        status={item.connection_status ?? "pending"}
                      />
                    </td>
                    <td>
                      {stateLabel(item.lifecycle)}
                      {item.cleanup_pending && (
                        <small>{tr("Cleanup pending")}</small>
                      )}
                    </td>
                    <td>{when(item.created_at, session.tenant.timezone)}</td>
                    <td>
                      <button
                        className="button secondary"
                        onClick={() => setSelected(item)}
                      >
                        {tr("Manage workspace")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {selected && (
        <LifecycleForm
          key={selected.id}
          tenant={selected}
          onChanged={onChanged}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
