import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Download, Loader2 } from "lucide-react";
import { ApiError, isUnconfirmedResponse, request, useData } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { Panel, Notice, Loading, Heading, when } from "./components";
import { formatNumber } from "./format";
import type { RetentionPolicy } from "./types";

interface RetentionDraft {
  enabled: boolean;
  measurementDays: number;
  activityDays: number;
  revision: string;
}

function draftOf(policy: RetentionPolicy): RetentionDraft {
  return {
    enabled: policy.enabled,
    measurementDays: policy.measurementDays,
    activityDays: policy.activityDays,
    revision: policy.revision,
  };
}

function ArchivePanel(): ReactNode {
  const { session } = useWorkspace();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const download = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setFailure(null);
    setComplete(false);
    try {
      const response = await fetch("/api/workspace/archive", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({ currentPassword: password }),
      });
      if (!response.ok) {
        if (response.status === 401)
          window.dispatchEvent(new Event("solarman-session-expired"));
        const body: unknown = await response.json();
        throw new ApiError(
          response.status,
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Unable to download the workspace archive",
        );
      }
      const blob = await response.blob();
      const tail = (await blob.slice(-4096).text())
        .trimEnd()
        .split("\n")
        .at(-1);
      const footer: unknown = JSON.parse(tail ?? "");
      if (
        typeof footer !== "object" ||
        footer === null ||
        !("type" in footer) ||
        footer.type !== "complete" ||
        !("sha256" in footer) ||
        typeof footer.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(footer.sha256)
      )
        throw new Error("The archive is incomplete. Download it again.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `solarman-workspace-${new Date().toISOString().slice(0, 10)}.ndjson`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setComplete(true);
    } catch (cause) {
      setFailure(
        cause instanceof ApiError
          ? cause.message
          : "The archive download was interrupted. Try again.",
      );
    } finally {
      setPassword("");
      setPending(false);
    }
  };
  return (
    <Panel
      title={tr("Workspace archive")}
      subtitle={tr(
        "Download your data before changing retention or closing a workspace",
      )}
    >
      <p>
        {tr(
          "Includes stored readings, provider parameters, command and write history, cleanup state and workspace settings. Browser security and recovery metadata include only your own account. Passwords, tokens and encrypted credentials are excluded.",
        )}
      </p>
      <p className="fine-print">
        {tr(
          "The archive uses NDJSON with section counts and a completion checksum. Large archives are streamed from a consistent database snapshot. No export file is stored on the server.",
        )}
      </p>
      <form
        onSubmit={(event) => {
          void download(event);
        }}
      >
        <label>
          {tr("Dashboard password for the archive")}
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            disabled={pending}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {failure && <Notice tone="danger">{failure}</Notice>}
        {complete && (
          <Notice tone="success">{tr("Workspace archive downloaded.")}</Notice>
        )}
        <button className="button secondary" disabled={pending || !password}>
          {pending ? (
            <Loader2 size={16} className="spin" />
          ) : (
            <Download size={16} />
          )}{" "}
          {tr(pending ? "Preparing archive…" : "Download workspace archive")}
        </button>
      </form>
    </Panel>
  );
}

function WorkspaceDataPanels(): ReactNode {
  const { session } = useWorkspace();
  const { data, error, reload } = useData<RetentionPolicy>(
    "/workspace/retention",
  );
  const [draft, setDraft] = useState<RetentionDraft | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  useEffect(() => {
    if (data && !draft) setDraft(draftOf(data));
  }, [data, draft]);
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!draft) return;
    setPending(true);
    setFailure(null);
    setSuccess(false);
    try {
      const result = await request<RetentionPolicy>("/workspace/retention", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({ ...draft, currentPassword: password }),
      });
      setDraft(draftOf(result));
      setSuccess(true);
    } catch (cause) {
      setFailure(
        isUnconfirmedResponse(cause)
          ? "The retention change is unconfirmed. Reload the saved policy before trying again."
          : cause instanceof Error
            ? cause.message
            : "Unable to save the retention policy",
      );
    } finally {
      setPassword("");
      setPending(false);
      reload();
    }
  };
  const reset = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    setSuccess(false);
    try {
      setDraft(draftOf(await request<RetentionPolicy>("/workspace/retention")));
      reload();
    } catch (cause) {
      setFailure(
        cause instanceof Error
          ? cause.message
          : "Unable to load data retention",
      );
    } finally {
      setPending(false);
    }
  };
  const changed = Boolean(
    data && draft && BigInt(data.revision) > BigInt(draft.revision),
  );
  return (
    <div className="settings-grid workspace-data-grid">
      <ArchivePanel />
      <Panel
        title={tr("Data retention")}
        subtitle={tr("Choose how long this workspace keeps historical data")}
      >
        {error && <Notice tone="danger">{error}</Notice>}
        {!data || !draft ? (
          <Loading />
        ) : (
          <>
            <strong>
              {tr(
                data.enabled
                  ? "Automatic pruning enabled"
                  : "Automatic pruning disabled",
              )}
            </strong>
            <p>
              {tr(
                "Pruning is off by default. When enabled, old records are removed gradually. Download an archive first; disabling pruning cannot restore deleted records.",
              )}
            </p>
            <form
              onSubmit={(event) => {
                void save(event);
              }}
            >
              <label>
                {tr("Automatic pruning")}
                <select
                  aria-label={tr("Automatic pruning")}
                  disabled={pending}
                  value={String(draft.enabled)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      enabled: event.target.value === "true",
                    })
                  }
                >
                  <option value="false">{tr("Disabled")}</option>
                  <option value="true">{tr("Enabled")}</option>
                </select>
              </label>
              <label>
                {tr("Reading retention in days")}
                <input
                  type="number"
                  required
                  min={1}
                  max={3650}
                  value={draft.measurementDays}
                  disabled={pending}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      measurementDays: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                {tr("Activity retention in days")}
                <input
                  type="number"
                  required
                  min={30}
                  max={3650}
                  value={draft.activityDays}
                  disabled={pending}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      activityDays: Number(event.target.value),
                    })
                  }
                />
              </label>
              <p className="fine-print">
                {tr(
                  "The latest selected-device reading, active incidents and unresolved inverter writes are retained. API accounting keeps at least 366 days. Changes and audit history may therefore outlive the chosen period.",
                )}
              </p>
              <label>
                {tr("Dashboard password for retention")}
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                  disabled={pending}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {changed && (
                <Notice>
                  {tr(
                    "Retention policy changed. Reload the saved policy to continue.",
                  )}
                </Notice>
              )}
              {failure && <Notice tone="danger">{failure}</Notice>}
              {success && (
                <Notice tone="success">{tr("Retention policy saved.")}</Notice>
              )}
              <div className="lifecycle-actions">
                <button
                  className="button primary"
                  disabled={pending || changed || !password}
                >
                  {tr(pending ? "Saving…" : "Save retention policy")}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={pending}
                  onClick={() => {
                    void reset();
                  }}
                >
                  {tr("Reload saved policy")}
                </button>
              </div>
            </form>
            <div className="diagnostic-values">
              <div>
                <span>{tr("Last pruning run")}</span>
                <strong>
                  {data.lastRunAt
                    ? when(data.lastRunAt, session.tenant.timezone)
                    : tr("Not run yet")}
                </strong>
              </div>
              <div>
                <span>{tr("Records removed in the last run")}</span>
                <strong>
                  {formatNumber(
                    Object.values(data.lastCounts).reduce(
                      (total, count) => total + count,
                      0,
                    ),
                  )}
                </strong>
              </div>
            </div>
            {data.enabled && data.lastFailedAt && (
              <Notice tone="danger">
                {tr(
                  "The latest pruning attempt failed. No partial batch was committed; it will retry automatically.",
                )}
              </Notice>
            )}
            {data.events.length > 0 && (
              <div className="lifecycle-history">
                <h3>{tr("Recent retention changes")}</h3>
                <ol>
                  {data.events.map((event) => (
                    <li key={event.revision}>
                      <strong>
                        {tr(
                          event.enabled
                            ? "Automatic pruning enabled"
                            : "Automatic pruning disabled",
                        )}
                      </strong>
                      <small>{when(event.at, session.tenant.timezone)}</small>
                      <p>
                        {tr(
                          "Readings: {{readings}} days · Activity: {{activity}} days",
                          {
                            readings: event.measurementDays,
                            activity: event.activityDays,
                          },
                        )}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

export default function WorkspaceDataPage(): ReactNode {
  return (
    <>
      <Heading
        eyebrow={tr("DATA AND PRIVACY")}
        title={tr("Workspace data")}
        description={tr(
          "Download your information and choose how long historical records are kept.",
        )}
      />
      <WorkspaceDataPanels />
    </>
  );
}
