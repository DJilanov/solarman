import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import serviceIdentity from "../../src/service-identity.json" with { type: "json" };

async function administrator(page: Page): Promise<void> {
  const email = process.env.E2E_EMAIL,
    password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error("Configure private E2E credentials");
  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test("public service and legal pages contain the real provider in both languages without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL: "http://localhost:3000",
  });
  try {
    const page = await context.newPage();
    for (const language of ["en", "bg"]) {
      for (const kind of ["pricing", "privacy", "terms"]) {
        const path = `/${language === "bg" ? "bg/" : ""}${kind}/`;
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        await expect(page.locator("h1")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          "href",
          "https://solarman.jilanov.com" + path,
        );
        await expect(
          page.locator(`link[hreflang="${language}"]`),
        ).toHaveAttribute("href", "https://solarman.jilanov.com" + path);
        await expect(page.locator(".public-provider")).toContainText(
          "JILANOVI Ltd",
        );
        await expect(page.locator(".public-provider")).toContainText(
          "205509804",
        );
        await expect(page.locator(".public-provider")).toContainText(
          "BG205509804",
        );
        await expect(page.locator(".public-provider")).toContainText(
          "sales@jilanov.com",
        );
        for (const width of [320, 390, 1440]) {
          await page.setViewportSize({ width, height: 960 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
            `${path} at ${width}`,
          ).toBeLessThanOrEqual(width);
          const clipped = await page.locator(".landing").evaluate(element =>
            [...element.querySelectorAll("a, button, select, h1, h2")].filter(child => {
              if (!child.checkVisibility()) return false;
              const box = child.getBoundingClientRect();
              return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
            }).map(child => child.tagName + "." + child.className),
          );
          expect(clipped, `${path} at ${width}`).toEqual([]);
        }
        if (kind === "pricing")
          await expect(page.locator("main")).toContainText(
            language === "bg" ? "следващия работен ден" : "next business day",
          );
        if (kind === "terms")
          await expect(page.locator("main")).toContainText(
            language === "bg" ? "14 дни" : "14 days",
          );
        if (language === "bg") {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.screenshot({
            path: `test-results/business-${kind}-bg-phone.png`,
            fullPage: true,
          });
        }
      }
    }
  } finally {
    await context.close();
  }
});

test("public language switching retains the document, updates metadata and leaves the login reachable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .locator("footer")
    .getByRole("link", { name: "Services & support", exact: true })
    .click();
  await expect(page).toHaveURL(/\/pricing\/$/);
  await expect(page.locator('link[hreflang="bg"]')).toHaveAttribute(
    "href",
    "https://solarman.jilanov.com/bg/pricing/",
  );
  await page.locator(".language-switch select").selectOption("bg");
  await expect(page).toHaveURL(/\/bg\/pricing\/$/);
  await expect(page.locator("h1")).toContainText("Първо демонстрация");
  await page
    .locator("footer")
    .getByRole("link", { name: "Поверителност", exact: true })
    .click();
  await expect(page).toHaveURL(/\/bg\/privacy\/$/);
  await page.locator(".language-switch select").selectOption("en");
  await expect(page).toHaveURL(/\/privacy\/$/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://solarman.jilanov.com/privacy/",
  );
  await page
    .locator("header")
    .getByRole("link", { name: "Log in", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("a customer accepts versioned terms, starts the guided setup and enrolls a real browser passkey", async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  await administrator(page);
  const session = (await (
    await page.request.get("/api/auth/session")
  ).json()) as { csrfToken: string };
  const email = `passkey-customer-${crypto.randomUUID()}@example.test`;
  const password = "business-customer-fixture-password";
  const response = await page.request.post("/api/admin/invitations", {
    headers: {
      origin: "http://localhost:3000",
      "x-csrf-token": session.csrfToken,
    },
    data: { email, tenantName: "Passkey customer home" },
  });
  expect(response.status()).toBe(201);
  const invitation = (await response.json()) as { url: string };
  const context: BrowserContext = await browser.newContext({
    baseURL: "http://localhost:3000",
    locale: "en-GB",
  });
  let releaseStatus: (() => void) | undefined;
  try {
    const customer = await context.newPage();
    const device = await context.newCDPSession(customer);
    await device.send("WebAuthn.enable");
    await device.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await customer.goto(invitation.url);
    await customer.getByLabel("Password", { exact: true }).fill(password);
    await customer
      .getByLabel("Confirm password", { exact: true })
      .fill(password);
    await expect(customer.getByRole("checkbox")).not.toBeChecked();
    await customer.getByRole("checkbox").check();
    await customer
      .getByRole("button", { name: "Create my workspace", exact: true })
      .click();
    await expect(customer).toHaveURL(/\/settings\/getting-started$/);
    await expect(
      customer.getByRole("heading", {
        name: "Let’s set up your home.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(customer.locator(".customer-setup-list")).toContainText(
      "Connect your SOLARMAN account",
    );
    await expect(
      customer.getByRole("link", { name: "Administration", exact: true }),
    ).toHaveCount(0);
    const accepted = (await (
      await context.request.get("/api/auth/session")
    ).json()) as { csrfToken: string };
    const archive = await context.request.post("/api/workspace/archive", {
      headers: {
        origin: "http://localhost:3000",
        "x-csrf-token": accepted.csrfToken,
      },
      data: { currentPassword: password },
    });
    expect(archive.status()).toBe(200);
    expect(await archive.text()).toContain(
      `"service_terms_version":"${serviceIdentity.policyVersion}"`,
    );
    await customer
      .getByRole("link", { name: "Open account security", exact: true })
      .click();
    let markHeld: (() => void) | undefined;
    const holdStatus = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const statusHeld = new Promise<void>((resolve) => { markHeld = resolve; });
    let held = false;
    await customer.route("**/api/auth/session", async (route) => {
      if (held) return route.continue();
      held = true;
      const response = await route.fetch();
      markHeld?.();
      await holdStatus;
      await route.fulfill({ response });
    });
    await customer
      .getByLabel("Current dashboard password", { exact: true })
      .fill(password);
    await customer
      .getByRole("button", { name: "Generate recovery key", exact: true })
      .click();
    await statusHeld;
    await expect(
      customer.getByText(
        "Recovery key created. Save it before leaving this page.",
        { exact: true },
      ),
    ).toBeVisible();
    await customer
      .getByLabel("Passkey name", { exact: true })
      .fill("Customer phone");
    await customer
      .getByLabel("Dashboard password for passkey setup", { exact: true })
      .fill(password);
    await customer
      .getByRole("button", { name: "Prepare a passkey", exact: true })
      .click();
    await customer
      .getByRole("button", { name: "Save passkey on your device", exact: true })
      .click();
    await expect(customer.locator(".passkey-list")).toContainText(
      "Customer phone",
    );
    const resumed = customer.waitForResponse((response) => response.url().endsWith("/api/auth/session"));
    releaseStatus?.();
    await resumed;
    await customer.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(customer.locator(".passkey-session-status")).toBeVisible();
    const secured = (await (
      await context.request.get("/api/auth/session")
    ).json()) as { security: { mfaVerified: boolean } };
    expect(secured.security.mfaVerified).toBe(true);
    await customer
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await customer.getByLabel("Email address", { exact: true }).fill(email);
    await customer.getByLabel("Password", { exact: true }).fill(password);
    await customer
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(
      customer.getByRole("heading", { name: "Confirm it’s you", exact: true }),
    ).toBeVisible();
    expect((await context.request.get("/api/auth/session")).status()).toBe(401);
    await customer.evaluate(() =>
      Object.defineProperty(navigator.credentials, "get", {
        configurable: true,
        value: () =>
          Promise.reject(
            new DOMException("Cancelled fixture", "NotAllowedError"),
          ),
      }),
    );
    await customer
      .getByRole("button", { name: "Continue with passkey", exact: true })
      .click();
    await expect(
      customer.getByText(
        "Passkey sign-in was cancelled or timed out. Try again or use account recovery.",
        { exact: true },
      ),
    ).toBeVisible();
    expect((await context.request.get("/api/auth/session")).status()).toBe(401);
    await customer.reload();
    await customer.getByLabel("Email address", { exact: true }).fill(email);
    await customer.getByLabel("Password", { exact: true }).fill(password);
    await customer
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await customer
      .getByRole("button", { name: "Continue with passkey", exact: true })
      .click();
    await expect(
      customer.getByRole("heading", { name: "Account security", exact: true }),
    ).toBeVisible();
    await customer.locator(".language-switch select").selectOption("bg");
    await customer.setViewportSize({ width: 320, height: 844 });
    await expect(customer.locator(".passkey-list")).toContainText(
      "Customer phone",
    );
    expect(
      await customer.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
  } finally {
    releaseStatus?.();
    await context.close();
  }
});
