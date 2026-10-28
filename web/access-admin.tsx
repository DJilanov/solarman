import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Copy, RefreshCw, X } from "lucide-react";
import { isUnconfirmedResponse, request, useData } from "./api";
import { useWorkspace } from "./context";
import { Notice, Panel, Loading, StatusBadge } from "./components";
import { tr } from "./i18n";
import { when, formatNumber } from "./format";

interface PrivateLink {
  url: string;
  email: string;
  expiresAt: string;
  kind: "invitation" | "recovery";
}
interface Invitation {
  id: string;
  email: string;
  tenant_name: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  replaced_by_id: string | null;
  status: "pending" | "accepted" | "revoked" | "expired" | "replaced";
}
interface InvitationPage {
  items: Invitation[];
  offset: number;
  hasMore: boolean;
}

function PrivateLinkResult({
  link,
  onDismiss,
}: {
  link: PrivateLink;
  onDismiss: () => void;
}): ReactNode {
  const { session } = useWorkspace();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setError(null);
    } catch {
      setError(
        "Copy the private link from the field below. Clipboard access is unavailable.",
      );
    }
  };
  return (
    <div className="private-access-result">
      <Notice tone="success">
        {tr(
          "Share this link privately with {{email}}. It expires at {{time}}.",
          {
            email: link.email,
            time: when(link.expiresAt, session.tenant.timezone, "medium"),
          },
        )}
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
      <label>
        {tr(
          link.kind === "invitation"
            ? "Invitation link"
            : "Account recovery link",
        )}
        <input
          value={link.url}
          readOnly
          onFocus={(event) => event.target.select()}
        />
      </label>
      <div className="settings-actions">
        <button
          className="button secondary small"
          onClick={() => {
            void copy();
          }}
        >
          <Copy size={15} />
          {tr(copied ? "Copied" : "Copy private link")}
        </button>
        <button className="button secondary small" onClick={onDismiss}>
          <X size={15} />
          {tr("Hide private link")}
        </button>
      </div>
    </div>
  );
}

export default function AccessAdministration({
  revision,
  clearCreatedLink,
}: {
  revision: number;
  clearCreatedLink: () => void;
}): ReactNode {
  const { session } = useWorkspace();
  const [offset, setOffset] = useState(0);
  const { data, loading, error, reload } = useData<InvitationPage>(
    `/admin/invitations?offset=${offset}`,
    30000,
  );
  useEffect(() => {
    if (revision > 0) {
      setOffset(0);
      reload();
    }
  }, [revision, reload]);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [link, setLink] = useState<PrivateLink | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const headers = {
    "content-type": "application/json",
    "x-csrf-token": session.csrfToken,
  };
  const changeInvite = async (
    item: Invitation,
    action: "revoke" | "reissue",
  ): Promise<void> => {
    if (pending) return;
    setPending(item.id);
    clearCreatedLink();
    setActionError(null);
    setLink(null);
    try {
      const result = await request<{ url?: string; expiresAt: string }>(
        `/admin/invitations/${item.id}/${action}`,
        { method: "POST", headers, body: "{}" },
      );
      if (result.url)
        setLink({
          url: result.url,
          email: item.email,
          expiresAt: result.expiresAt,
          kind: "invitation",
        });
      setOffset(0);
      reload();
    } catch (cause) {
      setActionError(
        isUnconfirmedResponse(cause)
          ? "Invitation change could not be confirmed. Refresh invitation history before retrying."
          : cause instanceof Error
            ? cause.message
            : "Unable to update this invitation",
      );
    } finally {
      setPending(null);
    }
  };
  const recovery = async (action: "issue" | "revoke"): Promise<void> => {
    if (pending) return;
    setPending("recovery");
    clearCreatedLink();
    setRecoveryError(null);
    setRecoveryMessage(null);
    setLink(null);
    try {
      const result = await request<{ url?: string; expiresAt: string }>(
        "/admin/recovery",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ email, currentPassword: password, action }),
        },
      );
      setPassword("");
      if (result.url)
        setLink({
          url: result.url,
          email: email.trim().toLowerCase(),
          expiresAt: result.expiresAt,
          kind: "recovery",
        });
      setRecoveryMessage(
        action === "issue"
          ? "Private recovery link created"
          : "Pending administrator recovery links revoked",
      );
    } catch (cause) {
      setRecoveryError(
        isUnconfirmedResponse(cause)
          ? "The recovery link request could not be confirmed. Creating another link will invalidate earlier administrator links."
          : cause instanceof Error
            ? cause.message
            : "Unable to update recovery access",
      );
    } finally {
      setPending(null);
    }
  };
  const submitRecovery = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void recovery("issue");
  };
  return (
    <>
      {link && (
        <Panel
          title={tr(
            link.kind === "invitation"
              ? "Reissued invitation"
              : "Private account recovery",
          )}
        >
          <PrivateLinkResult
            key={link.url}
            link={link}
            onDismiss={() => setLink(null)}
          />
        </Panel>
      )}
      <Panel
        title={tr("Invitation history")}
        subtitle={tr("Review, revoke or replace private invitation links.")}
        action={
          <button
            className="button secondary small"
            disabled={loading || Boolean(pending)}
            onClick={reload}
          >
            <RefreshCw size={15} />
            {tr("Refresh invitation history")}
          </button>
        }
      >
        {(error || actionError) && (
          <Notice tone="danger">{error || actionError}</Notice>
        )}
        {!data && loading && <Loading />}
        {data && (
          <>
            <div className="invitation-history">
              {data.items.map((item) => (
                <article className="invitation-entry" key={item.id}>
                  <div className="browser-session-heading">
                    <div>
                      <strong>{item.email}</strong>
                      <p>{item.tenant_name}</p>
                    </div>
                    <StatusBadge status={item.status} />
                  </div>
                  <dl className="command-facts">
                    <div>
                      <dt>{tr("Created")}</dt>
                      <dd>
                        {when(
                          item.created_at,
                          session.tenant.timezone,
                          "medium",
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{tr("Link expires")}</dt>
                      <dd>
                        {when(
                          item.expires_at,
                          session.tenant.timezone,
                          "medium",
                        )}
                      </dd>
                    </div>
                  </dl>
                  {!item.used_at && !item.replaced_by_id && (
                    <div className="settings-actions">
                      <button
                        className="button secondary small"
                        disabled={Boolean(pending)}
                        onClick={() => {
                          void changeInvite(item, "reissue");
                        }}
                      >
                        {tr("Reissue invitation")}
                      </button>
                      <button
                        className="button secondary small"
                        disabled={Boolean(pending) || Boolean(item.revoked_at)}
                        onClick={() => {
                          void changeInvite(item, "revoke");
                        }}
                      >
                        {tr("Revoke invitation")}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            {!data.items.length && (
              <p className="fine-print">
                {tr("No invitations yet. Create a private invitation above.")}
              </p>
            )}
            {(offset > 0 || data.hasMore) && (
              <div className="pagination">
                <span>
                  {tr("Invitation page {{page}}", {
                    page: formatNumber(Math.floor(offset / 20) + 1),
                  })}
                </span>
                <div>
                  <button
                    className="button secondary small"
                    disabled={offset === 0 || Boolean(pending)}
                    onClick={() => setOffset(Math.max(0, offset - 20))}
                  >
                    <ChevronLeft size={15} />
                    {tr("Previous")}
                  </button>
                  <button
                    className="button secondary small"
                    disabled={!data.hasMore || Boolean(pending)}
                    onClick={() => setOffset(offset + 20)}
                  >
                    {tr("Next")}
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Panel>
      <Panel
        title={tr("Help a user recover access")}
        subtitle={tr("Short-lived recovery for ordinary workspace accounts.")}
      >
        <form className="security-form" onSubmit={submitRecovery}>
          <label>
            {tr("Account email")}
            <input
              type="email"
              maxLength={254}
              required
              value={email}
              disabled={Boolean(pending)}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            {tr("Administrator password")}
            <input
              type="password"
              autoComplete="current-password"
              maxLength={1024}
              required
              value={password}
              disabled={Boolean(pending)}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {recoveryError && <Notice tone="danger">{recoveryError}</Notice>}
          {recoveryMessage && <Notice tone="success">{recoveryMessage}</Notice>}
          <p className="fine-print">
            {tr(
              "Recovery links last 30 minutes and can be used once. Creating a new link replaces previous administrator links. Platform administrators use a saved key or server-operator recovery.",
            )}
          </p>
          <div className="settings-actions">
            <button className="button primary" disabled={Boolean(pending)}>
              {tr("Create private recovery link")}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={Boolean(pending) || !email || !password}
              onClick={() => {
                void recovery("revoke");
              }}
            >
              {tr("Cancel pending recovery links")}
            </button>
          </div>
        </form>
      </Panel>
    </>
  );
}
