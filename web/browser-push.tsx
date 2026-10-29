import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BellRing, RefreshCw, Smartphone } from "lucide-react";
import { useWorkspace } from "./context";
import { request, useData, isUnconfirmedResponse } from "./api";
import { tr, locale } from "./i18n";
import { Panel, Notice, Loading, when } from "./components";
import type { BrowserPushDevice, BrowserPushSettingsData } from "./types";

function appleMobile(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function homeScreen(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true)
  );
}

function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(decoded, (letter) => letter.charCodeAt(0));
}

async function subscriptionHash(
  subscription: PushSubscription,
): Promise<string> {
  const value = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(subscription.endpoint),
  );
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function deviceState(device: BrowserPushDevice): string {
  if (device.quarantined)
    return tr("Browser notifications need to be enabled again");
  if (device.blockedCode) return tr("Browser delivery needs attention");
  if (device.enabled) return tr("Browser alerts enabled");
  if (device.pending) return tr("Waiting for this device to display the test");
  return tr("Browser alerts disabled");
}

export function BrowserPushSettings(): ReactNode {
  const { session } = useWorkspace();
  const { data, error, loading, reload } = useData<BrowserPushSettingsData>(
    "/notifications/push",
    5000,
  );
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [endpointHash, setEndpointHash] = useState<string | null>(null);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >(
    typeof Notification === "undefined"
      ? "unsupported"
      : Notification.permission,
  );
  const [label, setLabel] = useState(
    appleMobile() ? "iPhone / iPad" : "Browser",
  );
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const needsInstall = appleMobile() && !homeScreen();
  const supported =
    isSecureContext &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    typeof Notification !== "undefined";
  const initialize = useCallback(async (): Promise<void> => {
    if (!supported || needsInstall) return;
    const next = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    await navigator.serviceWorker.ready;
    const subscription = await next.pushManager.getSubscription();
    setRegistration(next);
    setEndpointHash(subscription ? await subscriptionHash(subscription) : null);
    setPermission(Notification.permission);
  }, [supported, needsInstall]);
  useEffect(() => {
    void initialize().catch(() => {
      setFailed(true);
      setMessage(
        "Unable to prepare browser notifications. Refresh and try again.",
      );
    });
  }, [initialize]);
  const current = data?.devices.find(
    (device) => device.endpointHash === endpointHash,
  );
  const mutable = data && ["active", "suspended"].includes(data.lifecycle);
  const locked = pending || unconfirmed || !password || !mutable;
  const save = async (body: Record<string, unknown>): Promise<void> => {
    await request<BrowserPushSettingsData>("/notifications/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({ ...body, currentPassword: password }),
    });
  };
  const reportError = (cause: unknown): void => {
    setFailed(true);
    if (isUnconfirmedResponse(cause)) {
      setUnconfirmed(true);
      setMessage(
        "The browser notification request is unconfirmed. Refresh its status before trying again.",
      );
    } else
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Unable to update browser notifications",
      );
  };
  const enable = async (): Promise<void> => {
    if (!registration || !data?.publicKey || locked) return;
    setPending(true);
    setMessage(null);
    try {
      // iOS requires the permission request to run directly from the tap handler.
      const granted = await Notification.requestPermission();
      setPermission(granted);
      if (granted !== "granted") {
        setFailed(true);
        setMessage(
          "Notification permission was not granted. You can enable it in your device settings.",
        );
        return;
      }
      let subscription = await registration.pushManager.getSubscription();
      const existingHash = subscription
        ? await subscriptionHash(subscription)
        : null;
      const existingKey = subscription?.options.applicationServerKey;
      const serverKey = applicationKey(data.publicKey);
      const matchingKey =
        existingKey &&
        new Uint8Array(existingKey).every(
          (byte, index) => byte === serverKey[index],
        ) &&
        existingKey.byteLength === serverKey.length;
      const knownDevice = data.devices.find(
        (device) => device.endpointHash === existingHash,
      );
      let replacedId: string | null = null;
      if (
        subscription &&
        (!knownDevice ||
          !matchingKey ||
          knownDevice.blockedCode === "push_expired")
      ) {
        if (knownDevice) {
          await save({
            action: "revoke",
            id: knownDevice.id,
            revision: knownDevice.revision,
          });
          replacedId = knownDevice.id;
        }
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationKey(data.publicKey),
      });
      const hash = await subscriptionHash(subscription);
      setEndpointHash(hash);
      const existing = data.devices.find(
        (device) => device.endpointHash === hash,
      );
      await save({
        action: "subscribe",
        subscription: subscription.toJSON(),
        label: label.trim(),
        language: locale() === "bg-BG" ? "bg" : "en",
        revision:
          existing && existing.id !== replacedId ? existing.revision : "0",
        requestId: crypto.randomUUID(),
      });
      setFailed(false);
      setMessage(
        "Test queued. Browser alerts turn on after this device reports displaying the test.",
      );
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setPassword("");
      setPending(false);
      reload();
    }
  };
  const changeDevice = async (
    device: BrowserPushDevice,
    action: "test" | "revoke",
  ): Promise<void> => {
    setPending(true);
    setMessage(null);
    try {
      await save({
        action,
        id: device.id,
        revision: device.revision,
        ...(action === "test" ? { requestId: crypto.randomUUID() } : {}),
      });
      if (action === "revoke" && device.id === current?.id) {
        const subscription = await registration?.pushManager.getSubscription();
        await subscription?.unsubscribe();
        setEndpointHash(null);
      }
      setFailed(false);
      setMessage(
        action === "revoke"
          ? "Browser subscription removed"
          : "Browser notification test queued",
      );
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setPassword("");
      setPending(false);
      reload();
    }
  };
  const refresh = async (): Promise<void> => {
    setPending(true);
    try {
      await request<BrowserPushSettingsData>("/notifications/push");
      await initialize();
      setUnconfirmed(false);
      setMessage(null);
      reload();
    } catch (cause: unknown) {
      reportError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <Panel
      title={tr("Notifications on this device")}
      action={<Smartphone size={22} />}
    >
      <p>
        {tr(
          "Receive incident and recovery alerts directly from the dashboard. No Telegram account or bot is needed.",
        )}
      </p>
      {needsInstall && (
        <Notice>
          <strong>{tr("Install on your iPhone first")}</strong>
          <ol>
            <li>{tr("Open this dashboard in Safari and tap Share.")}</li>
            <li>
              {tr(
                "Choose Add to Home Screen. If Open as Web App appears, leave it on, then tap Add.",
              )}
            </li>
            <li>
              {tr("Open Solarman from its Home Screen icon and sign in.")}
            </li>
            <li>
              {tr(
                "Return here, tap Enable device notifications and allow the iPhone permission prompt.",
              )}
            </li>
          </ol>
          <p>
            {tr(
              "iPhone notifications require iOS 16.4 or later and the Home Screen web app.",
            )}
          </p>
        </Notice>
      )}
      {!needsInstall && !supported && (
        <Notice>
          {tr(
            "This browser cannot receive web notifications. Use a browser that supports Web Push.",
          )}
        </Notice>
      )}
      {loading && !data && <Loading />}
      {error && <Notice tone="danger">{tr(error)}</Notice>}
      {message && (
        <Notice tone={failed ? "danger" : undefined}>{tr(message)}</Notice>
      )}
      {data && !data.configured && (
        <Notice>
          {tr("Browser notifications are not configured on the server")}
        </Notice>
      )}
      {data && !mutable && (
        <Notice>
          {tr(
            "This workspace is closing. Notification changes are unavailable.",
          )}
        </Notice>
      )}
      {permission === "denied" && (
        <Notice>
          {tr(
            "Notifications are blocked for this app. Allow Solarman notifications in your iPhone or browser settings, then refresh.",
          )}
        </Notice>
      )}
      {data && (data.configured || data.devices.length > 0) && (
        <>
          <label className="field-label" htmlFor="push-device-name">
            {tr("Device name")}
          </label>
          <input
            id="push-device-name"
            value={label}
            maxLength={80}
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
          <label className="field-label" htmlFor="push-password">
            {tr("Current password for device notifications")}
          </label>
          <input
            id="push-password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={pending}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="readiness-actions">
            <button
              className="button primary"
              disabled={Boolean(
                locked ||
                !data.configured ||
                !registration ||
                !supported ||
                needsInstall ||
                permission === "denied" ||
                !label.trim() ||
                current?.enabled,
              )}
              onClick={() => {
                void enable();
              }}
            >
              <BellRing size={16} /> {tr("Enable device notifications")}
            </button>
          </div>
          <p className="fine-print">
            {tr(
              "A test is displayed on this device before alerts are enabled. Push service acceptance alone does not confirm display.",
            )}
          </p>
        </>
      )}
      <button
        className="button secondary"
        disabled={pending}
        onClick={() => {
          void refresh();
        }}
      >
        <RefreshCw size={16} /> {tr("Refresh device notifications")}
      </button>
      {data?.devices.map((device) => (
        <article className="notification-delivery" key={device.id}>
          <div className="notification-delivery-heading">
            <h3>{device.label}</h3>
            <strong>{deviceState(device)}</strong>
          </div>
          {device.blockedCode === "push_expired" && (
            <p>
              {tr(
                "This browser subscription has expired. Enable notifications again on that device.",
              )}
            </p>
          )}
          {device.blockedCode === "push_authorization_rejected" && (
            <p>
              {tr(
                "The push service rejected authorization. Review the server push configuration.",
              )}
            </p>
          )}
          {device.verifiedAt && (
            <p>
              {tr("Test displayed {{time}}", {
                time: when(
                  device.verifiedAt,
                  session.tenant.timezone,
                  "medium",
                ),
              })}
            </p>
          )}
          {device.lastDelivery?.code === "push_accepted" && (
            <p>
              {tr(
                "The push service accepted the message; confirmation from the device is still pending.",
              )}
            </p>
          )}
          <div className="readiness-actions">
            <button
              className="button secondary"
              disabled={Boolean(
                locked ||
                device.quarantined ||
                device.blockedCode ||
                (device.lastTestAt &&
                  Date.now() - Date.parse(device.lastTestAt) < 60000),
              )}
              onClick={() => {
                void changeDevice(device, "test");
              }}
            >
              {tr("Send device test")}
            </button>
            <button
              className="button secondary"
              disabled={Boolean(locked)}
              onClick={() => {
                void changeDevice(device, "revoke");
              }}
            >
              {tr("Remove device subscription")}
            </button>
          </div>
        </article>
      ))}
      {data?.configured && !data.devices.length && (
        <p>{tr("No browser devices subscribed yet.")}</p>
      )}
      <p className="fine-print">
        {tr(
          "The app server can send alerts while it is running. Detecting a complete server outage still needs an independent monitor.",
        )}
      </p>
    </Panel>
  );
}
