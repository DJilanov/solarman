import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { Download, KeyRound, LockKeyhole } from "lucide-react";
import { isUnconfirmedResponse, request } from "./api";
import { useWorkspace } from "./context";
import { usePrivateAccess, type PrivateAccess } from "./private-access";
import { tr, LanguageSwitch } from "./i18n";
import { when } from "./format";
import { Notice, Panel } from "./components";
import type { AccountSecurityData, Session } from "./types";

function RecoveryKey({
  secret,
  email,
  onDismiss,
}: {
  secret: string;
  email: string;
  onDismiss: () => void;
}): ReactNode {
  const save = (): void => {
    const contents = [
      tr("SOLARMAN account recovery"),
      `${tr("Website")}: ${window.location.origin}`,
      `${tr("Email address")}: ${email}`,
      `${tr("Recovery key")}: ${secret}`,
      "",
      tr(
        "Keep this file private and separate from your password. Each successful recovery replaces this key.",
      ),
      "",
    ].join("\n");
    const address = URL.createObjectURL(
      new Blob([contents], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = address;
    anchor.download = "solarman-account-recovery-key.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(address), 1000);
  };
  return (
    <div className="private-access-result">
      <Notice>
        {tr(
          "Save this key privately. It is shown only now; anyone holding it can reset your dashboard password.",
        )}
      </Notice>
      <label>
        {tr("Recovery key")}
        <input
          value={secret}
          readOnly
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.target.select()}
        />
      </label>
      <div className="settings-actions">
        <button className="button secondary" onClick={save}>
          <Download size={15} />
          {tr("Download recovery key")}
        </button>
        <button className="button secondary" onClick={onDismiss}>
          {tr("I saved the key")}
        </button>
      </div>
    </div>
  );
}

export function RecoverySettings({
  status,
  onChanged,
}: {
  status: AccountSecurityData["recovery"];
  onChanged: () => void;
}): ReactNode {
  const { session } = useWorkspace();
  const [password, setPassword] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const update = async (action: "key" | "revoke"): Promise<void> => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    setKey(null);
    try {
      const result = await request<{ key?: string }>(
        `/security/recovery/${action}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": session.csrfToken,
          },
          body: JSON.stringify({ currentPassword: password }),
        },
      );
      setPassword("");
      setKey(result.key ?? null);
      onChanged();
      setMessage({
        text:
          action === "key"
            ? "Recovery key created. Save it before leaving this page."
            : "Recovery keys and pending recovery links revoked",
        error: false,
      });
    } catch (cause) {
      setMessage({
        text: isUnconfirmedResponse(cause)
          ? "Recovery access could not be confirmed. Refresh status before generating or revoking a key again."
          : cause instanceof Error
            ? cause.message
            : "Unable to update recovery access",
        error: true,
      });
    } finally {
      setPending(false);
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void update("key");
  };
  return (
    <Panel
      title={tr("Account recovery")}
      subtitle={tr("Prepare a private key for a forgotten dashboard password.")}
    >
      <p className="fine-print">
        {status.keyCreatedAt
          ? tr("A saved recovery key is available. Created {{time}}.", {
              time: when(
                status.keyCreatedAt,
                session.tenant.timezone,
                "medium",
              ),
            })
          : tr("No saved recovery key is available.")}
      </p>
      {status.linkExpiresAt && (
        <Notice>
          {tr("An administrator recovery link is pending until {{time}}.", {
            time: when(status.linkExpiresAt, session.tenant.timezone, "medium"),
          })}
        </Notice>
      )}
      {message && (
        <Notice tone={message.error ? "danger" : "success"}>
          {message.text}
        </Notice>
      )}
      {key && (
        <RecoveryKey
          secret={key}
          email={session.user.email}
          onDismiss={() => setKey(null)}
        />
      )}
      <form className="security-form" onSubmit={submit}>
        <label>
          {tr("Current dashboard password")}
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
        <p className="fine-print">
          {tr(
            "Generating a key replaces the previous key and cancels pending recovery links. Your password and browser sessions stay active.",
          )}
        </p>
        <div className="settings-actions">
          <button className="button primary" disabled={pending}>
            <KeyRound size={15} />
            {tr("Generate recovery key")}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={
              pending ||
              !password ||
              (!status.keyCreatedAt && !status.linkExpiresAt)
            }
            onClick={() => {
              void update("revoke");
            }}
          >
            {tr("Revoke recovery access")}
          </button>
        </div>
      </form>
    </Panel>
  );
}

interface RecoveryProps {
  onRecovered: (email: string) => void;
  currentSession: Session | null;
}
export default function RecoverAccount(props: RecoveryProps): ReactNode {
  const access = usePrivateAccess();
  return <RecoveryForm key={access.revision} access={access} {...props} />;
}

function RecoveryForm({
  access,
  onRecovered,
  currentSession,
}: RecoveryProps & { access: PrivateAccess }): ReactNode {
  const [email, setEmail] = useState(access.email);
  const [secret, setSecret] = useState(access.key);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [replacement, setReplacement] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setPending(true);
    try {
      const result = await request<{ recoveryKey: string }>("/auth/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, key: secret, newPassword: password }),
      });
      if (!active.current) return;
      setPassword("");
      setConfirm("");
      setSecret("");
      setSuccess(true);
      setReplacement(result.recoveryKey);
      onRecovered(email);
    } catch (cause) {
      if (!active.current) return;
      setError(
        isUnconfirmedResponse(cause)
          ? "Recovery could not be confirmed. Try signing in with the new password before requesting another link."
          : cause instanceof Error
            ? cause.message
            : "Unable to recover this account",
      );
    } finally {
      if (active.current) setPending(false);
    }
  };
  return (
    <main className="activation-page">
      <div className="auth-language">
        <LanguageSwitch />
      </div>
      <div className="auth-card activation-card recovery-card">
        <span className="eyebrow">{tr("PRIVATE ACCOUNT RECOVERY")}</span>
        <h1>{tr("Recover dashboard access")}</h1>
        {success ? (
          <>
            <Notice tone="success">
              {tr(
                "Password reset completed. All previous browser sessions and recovery credentials are invalid.",
              )}
            </Notice>
            {replacement && (
              <RecoveryKey
                secret={replacement}
                email={email}
                onDismiss={() => setReplacement(null)}
              />
            )}
            <p className="fine-print">
              {tr(
                "Save the replacement recovery key, then sign in with your new password.",
              )}
            </p>
            {currentSession && (
              <Notice>
                {tr(
                  "This browser is signed in as {{email}}. Sign out in the dashboard to switch accounts.",
                  { email: currentSession.user.email },
                )}
              </Notice>
            )}
            <Link className="button primary full" to="/">
              {tr(currentSession ? "Return to dashboard" : "Back to sign in")}
            </Link>
          </>
        ) : (
          <>
            <p>
              {tr(
                "Use your saved recovery key or the private link provided by your administrator. A platform administrator can also use server-operator recovery.",
              )}
            </p>
            <form
              onSubmit={(event) => {
                void submit(event);
              }}
            >
              <label>
                {tr("Email address")}
                <input
                  type="email"
                  autoComplete="username"
                  maxLength={254}
                  required
                  value={email}
                  disabled={pending}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                {tr("Recovery key")}
                <input
                  type="password"
                  autoComplete="off"
                  maxLength={128}
                  required
                  value={secret}
                  disabled={pending}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </label>
              <label>
                {tr("New password")}
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={1024}
                  required
                  value={password}
                  disabled={pending}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label>
                {tr("Confirm new password")}
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={1024}
                  required
                  value={confirm}
                  disabled={pending}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </label>
              {error && <Notice tone="danger">{error}</Notice>}
              <button className="button primary full" disabled={pending}>
                <LockKeyhole size={16} />
                {tr(
                  pending ? "Recovering access…" : "Reset dashboard password",
                )}
              </button>
            </form>
            <p className="fine-print">
              {tr(
                "Recovery signs out browsers. Inverter automation and accepted commands continue; use Controls after signing in if charging must be paused.",
              )}
            </p>
            <Link className="text-link" to="/">
              {tr("Back to sign in")}
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
