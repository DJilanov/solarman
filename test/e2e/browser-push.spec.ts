import { test, expect, type Page } from "@playwright/test";
import { createECDH, randomBytes, randomUUID, createHash } from "node:crypto";
import type { BrowserPushSettingsData } from "../../web/types";

async function signIn(page: Page): Promise<void> {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error("Configure private E2E credentials");
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Energy overview", exact: true }),
  ).toBeVisible();
}

interface BrowserProof {
  permissionRequests: number;
  gesture: boolean;
  subscriptions: number;
  unsubscriptions: number;
  registrations: number;
}

async function pushFixture(
  page: Page,
  options: {
    iphone?: boolean;
    standalone?: boolean;
    denied?: boolean;
    loseResponse?: boolean;
    expired?: boolean;
  } = {},
): Promise<{
  data: BrowserPushSettingsData;
  actions: string[];
  proof: () => Promise<BrowserProof>;
}> {
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  const publicKey = pair.getPublicKey().toString("base64url");
  const subscription = {
    endpoint: `https://web.push.apple.com/browser-${randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: publicKey, auth: randomBytes(16).toString("base64url") },
  };
  await page.addInitScript(
    ({ subscription, publicKey, options }) => {
      const proof = {
        permissionRequests: 0,
        gesture: false,
        subscriptions: 0,
        unsubscriptions: 0,
        registrations: 0,
      };
      let active: PushSubscription | null = null;
      let permission: NotificationPermission = options.denied
        ? "denied"
        : "default";
      if (options.iphone) {
        Object.defineProperty(navigator, "userAgent", {
          configurable: true,
          value:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1",
        });
        Object.defineProperty(navigator, "standalone", {
          configurable: true,
          value: Boolean(options.standalone),
        });
      }
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => permission,
      });
      Object.defineProperty(Notification, "requestPermission", {
        configurable: true,
        value: async (): Promise<NotificationPermission> => {
          proof.permissionRequests++;
          proof.gesture = navigator.userActivation.isActive;
          permission = "granted";
          return permission;
        },
      });
      const key = Uint8Array.from(
        atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")),
        (letter) => letter.charCodeAt(0),
      );
      const pushManager = {
        getSubscription: async (): Promise<PushSubscription | null> => active,
        subscribe: async (
          input: PushSubscriptionOptionsInit,
        ): Promise<PushSubscription> => {
          if (input.userVisibleOnly !== true)
            throw Error("Missing visible consent");
          proof.subscriptions++;
          active = {
            endpoint: subscription.endpoint,
            expirationTime: null,
            options: {
              userVisibleOnly: true,
              applicationServerKey: key.buffer,
            },
            toJSON: () => subscription,
            getKey: () => null,
            unsubscribe: async (): Promise<boolean> => {
              proof.unsubscriptions++;
              active = null;
              return true;
            },
          };
          return active;
        },
      };
      const registration = { pushManager };
      if (options.expired) {
        void pushManager.subscribe({ userVisibleOnly: true });
        proof.subscriptions = 0;
      }
      Object.defineProperty(navigator.serviceWorker, "register", {
        configurable: true,
        value: async (): Promise<unknown> => {
          proof.registrations++;
          return registration;
        },
      });
      Object.defineProperty(navigator.serviceWorker, "ready", {
        configurable: true,
        value: Promise.resolve(registration),
      });
      Object.defineProperty(window, "pushBrowserProof", { value: proof });
    },
    { subscription, publicKey, options },
  );
  await signIn(page);
  const data: BrowserPushSettingsData = {
    configured: true,
    publicKey,
    lifecycle: "active",
    devices: [],
  };
  if (options.expired)
    data.devices = [
      {
        id: randomUUID(),
        label: "Expired iPhone",
        endpointHash: createHash("sha256")
          .update(subscription.endpoint)
          .digest("hex"),
        language: "en",
        enabled: false,
        pending: false,
        quarantined: false,
        revision: "2",
        verifiedAt: null,
        lastTestAt: new Date(Date.now() - 120000).toISOString(),
        blockedCode: "push_expired",
        createdAt: new Date().toISOString(),
        lastDelivery: null,
      },
    ];
  const actions: string[] = [];
  let loseResponse = options.loseResponse;
  await page.route("**/api/notifications/push", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        action: string;
        label: string;
        currentPassword: string;
        subscription: PushSubscriptionJSON;
        language: "en" | "bg";
        revision: string;
      };
      expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
      expect(body.currentPassword).toBe("browser-push-fixture");
      actions.push(body.action);
      if (body.action === "subscribe") {
        if (options.expired) expect(body.revision).toBe("0");
        expect(body.subscription.endpoint).toBe(subscription.endpoint);
        const hash = await page.evaluate(async (endpoint) => {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(endpoint),
          );
          return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        }, subscription.endpoint);
        data.devices = [
          {
            id: randomUUID(),
            label: body.label,
            endpointHash: hash,
            language: body.language,
            enabled: false,
            pending: true,
            quarantined: false,
            revision: "1",
            verifiedAt: null,
            lastTestAt: new Date().toISOString(),
            blockedCode: null,
            createdAt: new Date().toISOString(),
            lastDelivery: {
              id: randomUUID(),
              state: "delivered",
              code: "push_accepted",
              displayedAt: null,
            },
          },
        ];
        if (loseResponse) {
          loseResponse = false;
          return route.abort("failed");
        }
      } else if (body.action === "revoke") data.devices = [];
    }
    return route.fulfill({ json: data });
  });
  const proof = (): Promise<BrowserProof> =>
    page.evaluate(
      () => Reflect.get(window, "pushBrowserProof") as BrowserProof,
    );
  return { data, actions, proof };
}

test("iPhone install instructions translate on mobile and never request notification permission from a Safari tab", async ({
  page,
}) => {
  const f = await pushFixture(page, { iphone: true });
  await page.goto("/settings/notifications");
  await expect(
    page.getByRole("heading", {
      name: "Notifications on this device",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Install on your iPhone first", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Enable device notifications",
      exact: true,
    }),
  ).toBeDisabled();
  await page.locator(".language-switch select").selectOption("bg");
  await page.setViewportSize({ width: 320, height: 1100 });
  await expect(
    page.getByText("Първо добавете приложението на вашия iPhone", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/iphone-push-install-bg.png",
    fullPage: true,
  });
  await page.screenshot({ path: "test-results/iphone-push-install-bg-viewport.png" });
  expect((await f.proof()).permissionRequests).toBe(0);
  expect((await f.proof()).registrations).toBe(0);
  expect(f.actions).toEqual([]);
});

test("a Home Screen app requests permission from the tap, waits for display, preserves language drafts and removes its subscription", async ({
  page,
}) => {
  const f = await pushFixture(page, { iphone: true, standalone: true });
  const commands: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/commands"
    )
      commands.push(request.url());
  });
  await page.goto("/settings/notifications");
  await page.getByLabel("Device name", { exact: true }).fill("Owner iPhone");
  await page
    .getByLabel("Current password for device notifications", { exact: true })
    .fill("browser-push-fixture");
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByLabel("Име на устройството", { exact: true }),
  ).toHaveValue("Owner iPhone");
  await expect(
    page.getByLabel("Текуща парола за известията на устройството", {
      exact: true,
    }),
  ).toHaveValue("browser-push-fixture");
  await page
    .getByRole("button", {
      name: "Включи известията на устройството",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Изчаква се устройството да покаже тестовото известие", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByText(
        "Услугата за известия прие съобщението; все още се очаква потвърждение от устройството.",
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(
    page.getByLabel("Текуща парола за известията на устройството", {
      exact: true,
    }),
  ).toHaveValue("");
  expect((await f.proof()).gesture).toBe(true);
  expect((await f.proof()).permissionRequests).toBe(1);
  const device = f.data.devices[0];
  device.enabled = true;
  device.pending = false;
  device.verifiedAt = new Date().toISOString();
  if (device.lastDelivery) {
    device.lastDelivery.code = "push_displayed";
    device.lastDelivery.displayedAt = device.verifiedAt;
  }
  await expect(
    page.getByText("Известията за браузъра са включени", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Текуща парола за известията на устройството", { exact: true })
    .fill("browser-push-fixture");
  await page
    .getByRole("button", {
      name: "Премахни абонамента на устройството",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Все още няма абонирани устройства с браузър.", {
      exact: true,
    }),
  ).toBeVisible();
  expect((await f.proof()).unsubscriptions).toBe(1);
  expect(f.actions).toEqual(["subscribe", "revoke"]);
  expect(commands).toEqual([]);
});

test("a lost subscription response stays unconfirmed until refresh and never automatically repeats subscription", async ({
  page,
}) => {
  const f = await pushFixture(page, { loseResponse: true });
  await page.goto("/settings/notifications");
  await page
    .getByLabel("Current password for device notifications", { exact: true })
    .fill("browser-push-fixture");
  await page
    .getByRole("button", { name: "Enable device notifications", exact: true })
    .click();
  await expect(
    page.getByText(
      "The browser notification request is unconfirmed. Refresh its status before trying again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Enable device notifications",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Refresh device notifications", exact: true })
    .click();
  await expect(
    page.getByText(
      "The browser notification request is unconfirmed. Refresh its status before trying again.",
      { exact: true },
    ),
  ).not.toBeVisible();
  expect(f.actions).toEqual(["subscribe"]);
  expect((await f.proof()).subscriptions).toBe(1);
});

test("blocked notification permission explains device settings without prompting again", async ({
  page,
}) => {
  const f = await pushFixture(page, { denied: true });
  await page.goto("/settings/notifications");
  await expect(
    page.getByText(
      "Notifications are blocked for this app. Allow Solarman notifications in your iPhone or browser settings, then refresh.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Enable device notifications",
      exact: true,
    }),
  ).toBeDisabled();
  expect((await f.proof()).permissionRequests).toBe(0);
});

test("an expired device subscription is removed and recreated before its new delivery test", async ({
  page,
}) => {
  const f = await pushFixture(page, { expired: true });
  await page.goto("/settings/notifications");
  await expect(
    page.getByText("Browser delivery needs attention", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Current password for device notifications", { exact: true })
    .fill("browser-push-fixture");
  await page
    .getByRole("button", { name: "Enable device notifications", exact: true })
    .click();
  await expect(
    page.getByText("Waiting for this device to display the test", {
      exact: true,
    }),
  ).toBeVisible();
  expect(f.actions).toEqual(["revoke", "subscribe"]);
  expect((await f.proof()).subscriptions).toBe(1);
  expect((await f.proof()).unsubscriptions).toBe(1);
});
