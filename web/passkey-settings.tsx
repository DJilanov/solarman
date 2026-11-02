import { useState, type FormEvent, type ReactNode } from "react";
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import { Fingerprint, Plus, Trash2 } from "lucide-react";
import { request, isUnconfirmedResponse, ApiError } from "./api";
import { passkeyCancelled, passkeysSupported } from "./passkey-support";
import { useWorkspace } from "./context";
import { Panel, Notice } from "./components";
import { tr } from "./i18n";
import { when } from "./format";
import type { AccountSecurityData, Session } from "./types";

interface PasskeySettingsProps {
  data: AccountSecurityData;
  onChanged: () => void;
}
interface RegistrationChallenge {
  challengeToken: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export function PasskeySettings({
  data,
  onChanged,
}: PasskeySettingsProps): ReactNode {
  const { session, updateSession } = useWorkspace();
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [prepared, setPrepared] = useState<RegistrationChallenge | null>(null);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const keys = data.passkeys ?? [];
  const ready = Boolean(
    data.recovery.keyCreatedAt &&
    (!session.user.platformAdmin || data.passwordChangedAt),
  );
  const prepare = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending || !ready) return;
    if (!passkeysSupported()) {
      setMessage({
        text: "This browser cannot use passkeys. Open a current browser on your phone or computer, or use account recovery.",
        error: true,
      });
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      if (prepared) {
        const response = await startRegistration({
          optionsJSON: prepared.options,
        });
        const next = await request<Session>("/security/passkeys/register", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": session.csrfToken,
          },
          body: JSON.stringify({
            challengeToken: prepared.challengeToken,
            response,
          }),
        });
        updateSession(next);
        setPrepared(null);
        setName("");
        onChanged();
        setMessage({
          text: "Passkey added. Other browsers are signed out.",
          error: false,
        });
      } else {
        const options = await request<RegistrationChallenge>(
          "/security/passkeys/options",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": session.csrfToken,
            },
            body: JSON.stringify({ currentPassword: password, name }),
          },
        );
        setPassword("");
        setPrepared(options);
      }
    } catch (cause) {
      const cancelled = passkeyCancelled(cause);
      setMessage({
        text: cancelled
          ? "Passkey setup was cancelled or timed out. You can try again."
          : isUnconfirmedResponse(cause)
            ? "The passkey change is unconfirmed. Refresh security status before trying again."
            : cause instanceof ApiError
              ? cause.message
              : "Unable to update passkeys",
        error: true,
      });
      if (!cancelled) setPrepared(null);
      onChanged();
    } finally {
      setPending(false);
    }
  };
  const remove = async (id: string): Promise<void> => {
    if (pending || !password || keys.length < 2) return;
    setPending(true);
    setMessage(null);
    try {
      await request("/security/passkeys/remove", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({ currentPassword: password, id }),
      });
      setPassword("");
      setPrepared(null);
      onChanged();
      setMessage({
        text: "Passkey removed. Other browsers are signed out.",
        error: false,
      });
    } catch (cause) {
      setMessage({
        text: isUnconfirmedResponse(cause)
          ? "The passkey change is unconfirmed. Refresh security status before trying again."
          : cause instanceof Error
            ? cause.message
            : "Unable to update passkeys",
        error: true,
      });
      onChanged();
    } finally {
      setPending(false);
    }
  };
  return (
    <Panel
      title={tr("Passkeys and two-step sign-in")}
      subtitle={tr(
        "Your password and a verified device protect your account together.",
      )}
    >
      <p className="fine-print">
        {tr(
          "Use Face ID, Touch ID, your device PIN or a security key. Your private key and biometric data stay with your device or passkey provider.",
        )}
      </p>
      {session.security?.mfaVerified && <p className="fine-print passkey-session-status">{tr("This browser is verified with a passkey.")}</p>}
      {!ready && (
        <Notice>
          {tr(
            session.user.platformAdmin
              ? "First change the initial administrator password, then create and save your recovery key. You can add a passkey after those steps."
              : "Create and save your recovery key before adding a passkey",
          )}
        </Notice>
      )}
      {session.security?.passkeyEnrollmentRequired && (
        <Notice tone="danger">
          {tr("Finish passkey setup before opening your workspace")}
        </Notice>
      )}
      {message && (
        <Notice tone={message.error ? "danger" : "success"}>
          {message.text}
        </Notice>
      )}
      {keys.length > 0 ? (
        <ul className="passkey-list">
          {keys.map((key) => (
            <li key={key.id}>
              <Fingerprint size={22} aria-hidden="true" />
              <div>
                <strong>{key.name}</strong>
                <p>
                  {tr(key.backedUp ? "Synced passkey" : "Device passkey")}
                  {" · "}
                  {key.lastUsedAt
                    ? tr("Last used {{time}}", {
                        time: when(
                          key.lastUsedAt,
                          session.tenant.timezone,
                          "medium",
                        ),
                      })
                    : tr("Not used for sign-in yet")}
                </p>
              </div>
              <button
                type="button"
                className="button secondary small"
                aria-label={tr("Remove passkey {{name}}", { name: key.name })}
                disabled={pending || !password || keys.length < 2}
                onClick={() => {
                  void remove(key.id);
                }}
              >
                <Trash2 size={15} aria-hidden="true" />
                {tr("Remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine-print">{tr("No passkey is registered yet.")}</p>
      )}
      <form
        className="security-form"
        onSubmit={(event) => {
          void prepare(event);
        }}
      >
        {!prepared ? (
          <>
            <label>
              {tr("Passkey name")}
              <input
                autoComplete="off"
                value={name}
                required
                maxLength={80}
                disabled={pending || !ready}
                onChange={(event) => setName(event.target.value)}
                placeholder={tr("For example: my iPhone")}
              />
            </label>
            <label>
              {tr("Dashboard password for passkey setup")}
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                required
                maxLength={1024}
                disabled={pending || !ready}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </>
        ) : (
          <Notice>
            {tr(
              "Ready to save {{name}}. Your browser will ask you to confirm with your device.",
              { name },
            )}
          </Notice>
        )}
        <div className="settings-actions">
          <button className="button primary" disabled={pending || !ready}>
            <Plus size={16} aria-hidden="true" />
            {tr(
              pending
                ? "Please wait…"
                : prepared
                  ? "Save passkey on your device"
                  : "Prepare a passkey",
            )}
          </button>
          {prepared && (
            <button
              className="button secondary"
              type="button"
              disabled={pending}
              onClick={() => setPrepared(null)}
            >
              {tr("Cancel")}
            </button>
          )}
        </div>
      </form>
      <p className="fine-print">
        {tr(
          "Add a second passkey as a backup. Your last passkey can only be reset through account recovery.",
        )}
      </p>
    </Panel>
  );
}
