import { useState, type FormEvent, type ReactNode } from "react";
import { request, useData, isUnconfirmedResponse } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { Panel, Notice, Loading, when } from "./components";
import { formatNumber } from "./format";
import type {
  OffboardingStatus,
  TenantLifecycleStatus,
  ErasureServiceStatus,
} from "./types";

export function ErasureHealth({
  status,
}: {
  status: ErasureServiceStatus;
}): ReactNode {
  const { session } = useWorkspace();
  const labels: Record<ErasureServiceStatus["state"], string> = {
    verified: "Offsite receipts synchronized",
    stale: "Receipt synchronization is overdue",
    unavailable: "Erasure recovery status is unavailable",
    "not-configured": "Erasure recovery is not configured",
  };
  return (
    <Panel title={tr("Erasure recovery protection")}>
      <strong>{tr(labels[status.state])}</strong>
      {status.state !== "verified" && (
        <Notice tone="danger">
          {tr(
            "Ask the server operator to check receipt synchronization before restarting the service.",
          )}
        </Notice>
      )}
      <dl className="command-facts">
        <div>
          <dt>{tr("Last receipt synchronization")}</dt>
          <dd>
            {status.checkedAt
              ? when(status.checkedAt, session.tenant.timezone)
              : tr("Not recorded")}
          </dd>
        </div>
        <div>
          <dt>{tr("Retained erasure receipts")}</dt>
          <dd>
            {status.receipts === null
              ? tr("Unavailable")
              : formatNumber(status.receipts)}
          </dd>
        </div>
      </dl>
      <p className="fine-print">
        {tr(
          "Recent offsite synchronization is required for erasure and service restart. Monitoring and inverter cleanup continue if synchronization becomes unavailable while the app is running.",
        )}
      </p>
    </Panel>
  );
}

function phaseLabel(phase: OffboardingStatus["phase"]): string {
  return tr(
    {
      none: "No closure requested",
      cleanup: "Inverter cleanup required",
      ready: "Ready for erasure authorization",
      "awaiting-receipt": "Waiting for a verified offsite receipt",
      queued: "Erasure queued",
      erasing: "Erasing workspace records",
      removed: "Workspace removed",
    }[phase],
  );
}

function ClosureFacts({ data }: { data: OffboardingStatus }): ReactNode {
  const { session } = useWorkspace();
  return (
    <>
      <strong>{phaseLabel(data.phase)}</strong>
      {data.cleanupPending && (
        <Notice tone="danger">
          {tr(
            "Inverter cleanup remains unresolved. Provider credentials and administrator cleanup access are retained; data removal is blocked.",
          )}
        </Notice>
      )}
      <div className="diagnostic-values">
        <div>
          <span>{tr("Offsite erasure receipt")}</span>
          <strong>
            {tr(
              data.receiptReady || data.completedAt
                ? "Verified"
                : !data.authorizedAt
                  ? "No erasure authorized"
                  : data.receiptService
                    ? "Awaiting publication"
                    : "Receipt service unavailable",
            )}
          </strong>
        </div>
        <div>
          <span>{tr("Records processed")}</span>
          <strong>{formatNumber(data.processedRows)}</strong>
        </div>
        {data.completedAt && (
          <div>
            <span>{tr("Completed")}</span>
            <strong>{when(data.completedAt, session.tenant.timezone)}</strong>
          </div>
        )}
      </div>
      {data.lastFailedAt && (
        <Notice tone="danger">
          {tr(
            "Erasure is incomplete. The service will retry. Recovery receipts and anonymous quota accounting remain after removal.",
          )}
        </Notice>
      )}
    </>
  );
}

export function MemberClosureStatus({
  data,
}: {
  data: OffboardingStatus | null;
}): ReactNode {
  if (!data || data.phase === "none") return null;
  return (
    <Panel title={tr("Workspace closure")}>
      <ClosureFacts data={data} />
      <p>
        {tr(
          "Routine collection and automation are stopped. Export the information you need before an administrator authorizes erasure. Existing native inverter settings continue.",
        )}
      </p>
    </Panel>
  );
}

function RecoveryControls({
  tenantId,
  onChanged,
}: {
  tenantId: string;
  onChanged: () => void;
}): ReactNode {
  const { session } = useWorkspace();
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [providerPassword, setProviderPassword] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [usePlatform, setUsePlatform] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const recover = async (
    action: "inspect" | "stop" | "repair",
  ): Promise<void> => {
    setPending(true);
    setFailure(null);
    try {
      await request(`/admin/tenants/${tenantId}/offboarding/recovery`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({
          action,
          currentPassword: password,
          email,
          password: providerPassword,
          appId: usePlatform ? undefined : appId,
          appSecret: usePlatform ? undefined : appSecret,
          usePlatform,
        }),
      });
    } catch (cause) {
      setFailure(
        isUnconfirmedResponse(cause)
          ? "Closure recovery is unconfirmed. Refresh the closure status before retrying."
          : cause instanceof Error
            ? cause.message
            : "Closure recovery remains unconfirmed",
      );
    } finally {
      setPassword("");
      setProviderPassword("");
      setAppSecret("");
      setPending(false);
      onChanged();
    }
  };
  return (
    <div className="lifecycle-history">
      <h3>{tr("Closure recovery")}</h3>
      <p>
        {tr(
          "These actions apply only to this closing workspace and its original inverter. They cannot re-enable automation.",
        )}
      </p>
      <label>
        {tr("Dashboard password for closure recovery")}
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={pending}
          onChange={(event) => setPassword(event.target.value)}
          maxLength={1024}
        />
      </label>
      {failure && <Notice tone="danger">{failure}</Notice>}
      <div className="lifecycle-actions">
        <button
          type="button"
          className="button secondary"
          disabled={pending || !password}
          onClick={() => {
            void recover("inspect");
          }}
        >
          {tr("Inspect scheduled permission")}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={pending || !password}
          onClick={() => {
            void recover("stop");
          }}
        >
          {tr("Clear scheduled permission")}
        </button>
      </div>
      <details>
        <summary>{tr("Repair provider access for cleanup")}</summary>
        <form
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void recover("repair");
          }}
        >
          <label>
            {tr("Original SOLARMAN account email")}
            <input
              type="email"
              required
              value={email}
              disabled={pending}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            {tr("SOLARMAN password for closure recovery")}
            <input
              type="password"
              required
              autoComplete="off"
              maxLength={1024}
              value={providerPassword}
              disabled={pending}
              onChange={(event) => setProviderPassword(event.target.value)}
            />
          </label>
          <button className="button secondary" disabled={pending || !password}>
            {tr("Test repaired provider access")}
          </button>
          <details>
            <summary>{tr("OpenAPI credentials for cleanup")}</summary>
            <label className="closure-consent">
              <input
                type="checkbox"
                checked={usePlatform}
                disabled={pending}
                onChange={(event) => setUsePlatform(event.target.checked)}
              />
              {tr("Use platform OpenAPI credentials for cleanup")}
            </label>
            <label>
              {tr("App ID")}
              <input
                value={appId}
                disabled={pending || usePlatform}
                maxLength={200}
                onChange={(event) => setAppId(event.target.value)}
              />
            </label>
            <label>
              {tr("App Secret")}
              <input
                type="password"
                autoComplete="off"
                value={appSecret}
                disabled={pending || usePlatform}
                maxLength={1000}
                onChange={(event) => setAppSecret(event.target.value)}
              />
            </label>
            <p>
              {tr(
                "Leave both fields empty to keep the original OpenAPI credentials.",
              )}
            </p>
          </details>
        </form>
      </details>
    </div>
  );
}

export default function ClosureAdministration({
  tenantId,
  tenantName,
  lifecycle,
  onChanged,
}: {
  tenantId: string;
  tenantName: string;
  lifecycle: TenantLifecycleStatus;
  onChanged: () => void;
}): ReactNode {
  const { session } = useWorkspace();
  const { data, error, reload } = useData<OffboardingStatus>(
    `/admin/tenants/${tenantId}/offboarding`,
    5000,
  );
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = (): void => {
    reload();
    onChanged();
  };
  const submit = async (
    action: "close" | "cancel" | "erase",
  ): Promise<void> => {
    setPending(true);
    setFailure(null);
    try {
      await request(`/admin/tenants/${tenantId}/offboarding`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({
          action,
          currentPassword: password,
          confirmation,
          eraseConfirmed: consent,
          revision: lifecycle.revision,
        }),
      });
    } catch (cause) {
      setFailure(
        isUnconfirmedResponse(cause)
          ? "The closure change is unconfirmed. Refresh its status before trying again."
          : cause instanceof Error
            ? cause.message
            : "Unable to change workspace closure",
      );
    } finally {
      setPassword("");
      setConfirmation("");
      setConsent(false);
      setPending(false);
      refresh();
    }
  };
  const download = (): void => {
    if (!data?.authorizedAt || !data.id) return;
    const value =
      JSON.stringify(
        { version: 1, id: data.id, tenantId, authorizedAt: data.authorizedAt },
        null,
        2,
      ) + "\n";
    const url = URL.createObjectURL(
      new Blob([value], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `solarman-erasure-receipt-${data.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (lifecycle.protected) return null;
  return (
    <div className="lifecycle-history">
      <h3>{tr("Close or remove this workspace")}</h3>
      {error && <Notice tone="danger">{error}</Notice>}
      {!data ? (
        <Loading />
      ) : (
        <>
          <ClosureFacts data={data} />
          <p>
            {tr(
              "Closure cancels starts and stops routine collection. Erasure authorization disables customer sign-in and cannot be cancelled. Credentials and data are removed in bounded batches after inverter cleanup and offsite receipt verification.",
            )}
          </p>
          <p className="fine-print">
            {tr(
              "Existing encrypted backups expire under the backup retention policy. An erasure receipt prevents restored access.",
            )}
          </p>
          {data.phase !== "removed" && !data.authorizedAt && (
            <form
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (data.phase === "none") void submit("close");
              }}
            >
              <label>
                {tr("Dashboard password for closure")}
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                  value={password}
                  disabled={pending}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label>
                {tr("Type the workspace name to confirm")}
                <input
                  required
                  value={confirmation}
                  disabled={pending}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder={tenantName}
                />
              </label>
              {data.phase !== "none" && (
                <label className="closure-consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={pending}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  {tr(
                    "The required data has been exported. I authorize permanent erasure of this workspace.",
                  )}
                </label>
              )}
              <div className="lifecycle-actions">
                {data.phase === "none" ? (
                  <button
                    className="button secondary"
                    disabled={
                      pending || !password || confirmation !== tenantName
                    }
                  >
                    {tr("Request workspace closure")}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={
                        pending || !password || confirmation !== tenantName
                      }
                      onClick={() => {
                        void submit("cancel");
                      }}
                    >
                      {tr("Cancel closure and keep suspended")}
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={
                        pending ||
                        !password ||
                        confirmation !== tenantName ||
                        !consent ||
                        data.phase !== "ready" ||
                        !data.receiptService
                      }
                      onClick={() => {
                        void submit("erase");
                      }}
                    >
                      {tr("Authorize permanent erasure")}
                    </button>
                  </>
                )}
              </div>
            </form>
          )}
          {data.authorizedAt && (
            <Notice>
              {tr(
                "Erasure has been authorized. Customer sign-in is disabled; this request cannot be cancelled.",
              )}
            </Notice>
          )}
          {failure && <Notice tone="danger">{failure}</Notice>}
          {data.cleanupPending && !data.startedAt && (
            <RecoveryControls tenantId={tenantId} onChanged={refresh} />
          )}
          {(data.receiptReady || data.completedAt) && (
            <button
              type="button"
              className="button secondary"
              onClick={download}
            >
              {tr("Download erasure receipt")}
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={pending}
            onClick={refresh}
          >
            {tr("Refresh closure status")}
          </button>
        </>
      )}
    </div>
  );
}
