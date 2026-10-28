import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type {
  OverviewData,
  SettingsData,
  Session,
  Command,
  OperationsData,
  Incident,
  BackupStatus,
  ApiCapacity,
  AccountSecurityData,
} from "../../web/types";

async function signIn(page: Page): Promise<void> {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password)
    throw new Error(
      "Configure the private E2E_EMAIL and E2E_PASSWORD environment variables",
    );
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Energy overview", exact: true }),
  ).toBeVisible();
}

test("account security renews the current browser and revokes other browsers with real cookies in Bulgarian", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const owner = (await (
    await page.request.get("/api/auth/session")
  ).json()) as Session;
  const email = `security-${Date.now()}@example.test`;
  const initial = "security-fixture-password";
  const replacement = "new-security-fixture-password= ";
  const invitation = await page.request.post("/api/admin/invitations", {
    headers: {
      origin: "http://localhost:3000",
      "x-csrf-token": owner.csrfToken,
    },
    data: { email, tenantName: "Security browser fixture" },
  });
  expect(invitation.status()).toBe(201);
  const invitationData = (await invitation.json()) as { url: string };
  const firstContext = await browser.newContext({
    baseURL: "http://localhost:3000",
    locale: "en-GB",
  });
  const secondContext = await browser.newContext({
    baseURL: "http://localhost:3000",
    locale: "en-GB",
  });
  try {
    const activation = await firstContext.request.post("/api/auth/activate", {
      headers: { origin: "http://localhost:3000" },
      data: {
        token: new URLSearchParams(
          new URL(invitationData.url).hash.slice(1),
        ).get("token"),
        password: initial,
      },
    });
    expect(activation.status()).toBe(200);
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    const loginSecond = async (password: string): Promise<void> => {
      await second.goto("/");
      await second.getByLabel("Email address", { exact: true }).fill(email);
      await second.getByLabel("Password", { exact: true }).fill(password);
      await second
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await expect(
        second.getByRole("heading", { name: "Energy overview", exact: true }),
      ).toBeVisible();
    };
    await loginSecond(initial);
    await first.goto("/settings");
    await first
      .getByRole("link", { name: "Account security", exact: true })
      .click();
    await expect(first.locator(".browser-session")).toHaveCount(2);
    const before = (await (
      await first.request.get("/api/auth/session")
    ).json()) as Session;
    await first
      .getByRole("button", { name: "End browser session", exact: true })
      .click();
    await expect(first.locator(".browser-session")).toHaveCount(1);
    expect((await second.request.get("/api/auth/session")).status()).toBe(401);
    await loginSecond(initial);
    await first
      .getByRole("button", { name: "Refresh status", exact: true })
      .click();
    await expect(first.locator(".browser-session")).toHaveCount(2);
    await first
      .getByLabel("Current password", { exact: true })
      .fill("incorrect-password");
    await first.getByLabel("New password", { exact: true }).fill(replacement);
    await first
      .getByLabel("Confirm new password", { exact: true })
      .fill("mismatching-password");
    await first.locator(".language-switch select").selectOption("bg");
    await first
      .getByRole("button", { name: "Промени паролата", exact: true })
      .click();
    await expect(first.getByRole("alert")).toContainText(
      "Паролите не съвпадат",
    );
    await first
      .getByLabel("Потвърдете новата парола", { exact: true })
      .fill(replacement);
    await first
      .getByRole("button", { name: "Промени паролата", exact: true })
      .click();
    await expect(first.getByRole("alert")).toContainText(
      "Текущата парола е неправилна",
    );
    expect((await second.request.get("/api/auth/session")).status()).toBe(200);
    await first.getByLabel("Текуща парола", { exact: true }).fill(initial);
    await first
      .getByRole("button", { name: "Промени паролата", exact: true })
      .click();
    await expect(
      first.getByText(
        "Паролата е променена. Другите браузъри са излезли от акаунта; достъпът на този браузър е обновен.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(first.locator(".browser-session")).toHaveCount(1);
    const after = (await (
      await first.request.get("/api/auth/session")
    ).json()) as Session;
    expect(after.csrfToken).not.toBe(before.csrfToken);
    expect((await second.request.get("/api/auth/session")).status()).toBe(401);
    await expect(first.getByLabel("Нова парола", { exact: true })).toHaveValue(
      "",
    );
    await loginSecond(replacement);
    await first
      .getByRole("button", { name: "Обновяване на състоянието", exact: true })
      .click();
    await expect(first.locator(".browser-session")).toHaveCount(2);
    await first
      .getByRole("button", { name: "Излез от другите браузъри", exact: true })
      .click();
    await expect(first.locator(".browser-session")).toHaveCount(1);
    expect((await second.request.get("/api/auth/session")).status()).toBe(401);
    await first.setViewportSize({ width: 320, height: 740 });
    await expect(first.locator(".security-events")).toContainText(
      "Промяна на паролата и обновяване на достъпа през браузър",
    );
    expect(
      await first.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await first.screenshot({
      path: "test-results/account-security-mobile-bg.png",
      fullPage: true,
    });
    await first.getByRole("button", { name: "Изход", exact: true }).click();
    await expect(
      first.getByRole("heading", { name: "Добре дошли отново", exact: true }),
    ).toBeVisible();
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("account security offers retry, session pagination and an honest unknown password outcome", async ({
  page,
}) => {
  await signIn(page);
  const now = new Date().toISOString();
  let fail = true;
  let offset = 0;
  const fixture: AccountSecurityData = {
    passwordChangedAt: null,
    recovery: { keyCreatedAt: null, linkExpiresAt: null },
    sessionCount: 22,
    offset: 0,
    hasMoreSessions: true,
    sessions: [
      {
        id: randomUUID(),
        current: true,
        userAgent: "fixture browser",
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    ],
    events: [],
  };
  await page.route("**/api/security?*", (route) => {
    offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    if (fail)
      return route.fulfill({
        status: 503,
        json: { error: "Temporary security service failure" },
      });
    return route.fulfill({
      json: {
        ...fixture,
        offset,
        hasMoreSessions: offset === 0,
        sessions: offset === 0 ? fixture.sessions : [],
      },
    });
  });
  await page.goto("/settings/security");
  await expect(page.getByRole("alert")).toContainText(
    "Temporary security service failure",
  );
  fail = false;
  await page
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(page.getByText("This browser", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByText("No browser sessions on this page.", { exact: true }),
  ).toBeVisible();
  expect(offset).toBe(20);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText("This browser", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Previous", exact: true }),
  ).toBeDisabled();
  await page.route("**/api/security/password", (route) =>
    route.abort("failed"),
  );
  await page
    .getByLabel("Current password", { exact: true })
    .fill("fixture-current-password");
  await page
    .getByLabel("New password", { exact: true })
    .fill("fixture-replacement-password");
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill("fixture-replacement-password");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "The password change could not be confirmed. It may have completed",
  );
  await page.locator(".language-switch select").selectOption("bg");
  await expect(page.getByRole("alert")).toContainText(
    "Промяната на паролата не може да бъде потвърдена",
  );
});

test("stored measurements render charts, legends and a full CSV download", async ({
  page,
}) => {
  const env = parseEnv(readFileSync(".env", "utf8"));
  const pool = new pg.Pool({
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: "solarman_test",
  });
  const account = (
    await pool.query(
      `SELECT a.id,a.tenant_id,a.device_sn FROM solarman_accounts a
    JOIN users u ON u.tenant_id=a.tenant_id WHERE lower(u.email)=$1`,
      [process.env.E2E_EMAIL?.toLowerCase()],
    )
  ).rows[0] as { id: string; tenant_id: string; device_sn: string | null };
  const device = account.device_sn ?? "e2e-chart-fixture";
  const times = [30, 15, 0].map(
    (minutes) => new Date(Date.now() - minutes * 60_000 - 1000),
  );
  try {
    await pool.query("UPDATE solarman_accounts SET device_sn=$2 WHERE id=$1", [
      account.id,
      device,
    ]);
    for (const [index, time] of times.entries())
      await pool.query(
        `INSERT INTO measurements
      (tenant_id,account_id,device,observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,snapshot)
      VALUES ($1,$2,$3,$4,$5,20,$6,700,-100,-500,false,'{}')`,
        [
          account.tenant_id,
          account.id,
          device,
          time,
          70 + index,
          1200 + index * 100,
        ],
      );
    await signIn(page);
    await page.getByRole("link", { name: "Analytics", exact: true }).click();
    await expect(page.locator(".recharts-surface")).toHaveCount(2);
    await expect(page.locator(".recharts-surface").last()).toBeVisible();
    const legend = page.getByRole("button", {
      name: "Battery SOC",
      exact: true,
    });
    await expect(legend).toHaveAttribute("aria-pressed", "true");
    await legend.click();
    await expect(legend).toHaveAttribute("aria-pressed", "false");
    await page.screenshot({
      path: "test-results/analytics-desktop.png",
      fullPage: true,
    });
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export CSV" }).click();
    const download = await downloadEvent;
    const csvPath = await download.path();
    expect(csvPath).not.toBeNull();
    const csv = readFileSync(csvPath!, "utf8");
    expect(csv.split("\n")).toHaveLength(4);
    expect(csv).toContain("battery_discharge_positive_w");
    await page.locator(".language-switch select").selectOption("bg");
    await expect(
      page.getByRole("heading", { name: "Енергийни анализи", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Заряд на батерията", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".analytics-metrics")).toContainText("0,65");
    await expect(page.locator(".analytics-metrics")).toContainText("кВтч");
    await expect(page.locator(".chart-frame")).toContainText("кВт");
    await page.screenshot({
      path: "test-results/analytics-bulgarian.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
      )
      .toBe(false);
    await expect
      .poll(() =>
        page.locator(".recharts-surface").evaluateAll((surfaces) =>
          surfaces.every((surface) => {
            const svg = surface as SVGSVGElement;
            const frame = svg.closest(".chart-frame,.daily-chart");
            return Boolean(
              frame &&
                svg.viewBox.baseVal.width <=
                  frame.getBoundingClientRect().width + 1,
            );
          }),
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: "test-results/analytics-bulgarian-mobile.png",
      fullPage: true,
    });
  } finally {
    await pool.query(
      "DELETE FROM measurements WHERE tenant_id=$1 AND observed_at=ANY($2::timestamptz[])",
      [account.tenant_id, times],
    );
    await pool.query("UPDATE solarman_accounts SET device_sn=$2 WHERE id=$1", [
      account.id,
      account.device_sn,
    ]);
    await pool.end();
  }
});

test("email login, honest setup states and all dashboard pages work", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await expect(
    page.getByText("Charts will appear after your linked inverter"),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: true,
  });
  for (const [link, title] of [
    ["Analytics", "Energy analytics"],
    ["Controls", "System controls"],
    ["Activity", "System activity"],
    ["Settings", "Workspace settings"],
  ]) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Unexpected error");
  }
  await expect(
    page.getByLabel("SOLARMAN password", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Test connection & discover devices" }),
  ).toBeDisabled();
  await page.screenshot({
    path: "test-results/settings-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("mobile layouts remain within the viewport and sign-out is available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await signIn(page);
  for (const link of [
    "Overview",
    "Analytics",
    "Controls",
    "Activity",
    "Settings",
    "Workspaces",
  ]) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(page.locator("h1")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow, link).toBe(false);
  }
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.screenshot({
    path: "test-results/overview-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
});

test("an invitation creates an isolated user who links their own provider account", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "Workspaces", exact: true }).click();
  const email = `tenant-${Date.now()}@example.test`;
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("E2E solar workspace");
  await page.getByLabel("User email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Create private invitation" }).click();
  const invitation = await page.getByLabel("Invitation link").inputValue();
  const context = await browser.newContext();
  const invited = await context.newPage();
  try {
    await invited.goto(invitation);
    await invited.locator(".language-switch select").selectOption("bg");
    await expect(
      invited.getByRole("button", { name: "Създаване на пространство" }),
    ).toBeVisible();
    await invited
      .getByLabel("Парола", { exact: true })
      .fill("e2e-workspace-password");
    await invited.locator(".language-switch select").selectOption("en");
    await expect(invited.getByLabel("Password", { exact: true })).toHaveValue(
      "e2e-workspace-password",
    );
    await invited
      .getByLabel("Password", { exact: true })
      .fill("e2e-workspace-password");
    await invited
      .getByLabel("Confirm password", { exact: true })
      .fill("e2e-workspace-password");
    await invited.getByRole("button", { name: "Create my workspace" }).click();
    await expect(
      invited.getByRole("heading", { name: "Energy overview" }),
    ).toBeVisible();
    await expect(
      invited.getByRole("link", { name: "Workspaces", exact: true }),
    ).toHaveCount(0);
    await invited.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(
      invited.getByLabel("SOLARMAN email", { exact: true }),
    ).toHaveValue("");
    await invited
      .getByLabel("SOLARMAN email", { exact: true })
      .fill("own-provider@example.test");
    await invited
      .getByLabel("SOLARMAN password", { exact: true })
      .fill("provider-test-password");
    await invited
      .getByRole("button", { name: "Link my SOLARMAN account" })
      .click();
    await expect(
      invited.getByText("Your account credentials are saved privately."),
    ).toBeVisible();
    await expect(
      invited.getByLabel("SOLARMAN password", { exact: true }),
    ).toHaveValue("");
    await expect(
      invited.getByText("own-provider@example.test", { exact: true }),
    ).toBeVisible();
    const response = await invited.request.get("/api/admin/tenants");
    expect(response.status()).toBe(403);
  } finally {
    await context.close();
  }
});

test("Bulgarian pages, setup messages, controls and an open form switch without losing the session", async ({
  page,
}) => {
  await signIn(page);
  await page.locator(".language-switch select").selectOption("bg");
  await expect(page.locator("html")).toHaveAttribute("lang", "bg");
  await expect(
    page.getByText(
      "За свързания акаунт са необходими App ID и App Secret за OpenAPI",
    ),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  for (const [link, title] of [
    ["Преглед", "Преглед на енергията"],
    ["Анализи", "Енергийни анализи"],
    ["Управление", "Управление на системата"],
    ["История", "История на системата"],
    ["Настройки", "Настройки на пространството"],
    ["Пространства", "Потребителски пространства"],
  ]) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      link,
    ).toBe(false);
  }
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page
    .getByLabel("Парола за SOLARMAN", { exact: true })
    .fill("unsaved-form-value");
  await page.locator(".language-switch select").selectOption("en");
  await expect(
    page.getByLabel("SOLARMAN password", { exact: true }),
  ).toHaveValue("unsaved-form-value");
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByLabel("Парола за SOLARMAN", { exact: true }),
  ).toHaveValue("unsaved-form-value");
  await page.route("**/api/account/link", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "SOLARMAN rejected request (code 2101021)" },
    }),
  );
  await page
    .getByRole("button", {
      name: "Обновяване на данните за достъп",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "SOLARMAN отхвърли заявката (код 2101021)",
  );
  await page.locator(".language-switch select").selectOption("en");
  await expect(page.getByRole("alert")).toContainText(
    "SOLARMAN rejected request (code 2101021)",
  );
  await page.locator(".language-switch select").selectOption("bg");
  await page.getByRole("link", { name: "Управление", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Дозареждане до 50%", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Преглед", exact: true }).click();
  await page.screenshot({
    path: "test-results/overview-bulgarian-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Изход", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Добре дошли отново" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "bg");
});

test("browser language and a saved choice select the correct login translations", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "bg-BG" });
  try {
    const page = await context.newPage();
    await page.goto("http://localhost:3000/");
    await expect(
      page.getByRole("heading", { name: "Добре дошли отново" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/login-bulgarian.png",
      fullPage: true,
    });
    await page
      .getByLabel("Имейл адрес", { exact: true })
      .fill("typed@example.test");
    await page.locator(".language-switch select").selectOption("en");
    await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
      "typed@example.test",
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    await page.locator(".language-switch select").selectOption("bg");
    await page
      .getByLabel("Имейл адрес", { exact: true })
      .fill("invalid@example.test");
    await page.getByLabel("Парола", { exact: true }).fill("invalid-password");
    await page.getByRole("button", { name: "Вход", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Имейлът или паролата са неправилни",
    );
  } finally {
    await context.close();
  }
});

test("language switching works when browser storage is unavailable", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "bg-BG" });
  try {
    await context.addInitScript(() => {
      for (const method of ["getItem", "setItem"])
        Object.defineProperty(Storage.prototype, method, {
          value: (): never => {
            throw new DOMException("Storage unavailable", "SecurityError");
          },
        });
    });
    const page = await context.newPage();
    await page.goto("http://localhost:3000/");
    await expect(
      page.getByRole("heading", { name: "Добре дошли отново" }),
    ).toBeVisible();
    await page.locator(".language-switch select").selectOption("en");
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  } finally {
    await context.close();
  }
});

test("read-only device verification explains locks and keeps Stop available after an error", async ({
  page,
}) => {
  await signIn(page);
  const response = await page.request.get("/api/overview");
  const overview = (await response.json()) as OverviewData;
  const now = new Date().toISOString();
  overview.latest = {
    at: new Date(Date.now() - 120_000).toISOString(),
    receivedAt: now,
    source: "provider",
    samplingSeconds: 300,
    soc: 45,
    pvW: 494,
    loadW: 304,
    gridW: 1779,
    batteryW: -1945,
    temperatureC: 16,
    acEnabled: null,
  };
  Object.assign(overview.controller, {
    apiConfigured: true,
    deviceSelected: true,
    profile: "bluesun-bse20kh3",
    mode: "paused",
    paused: true,
    error: null,
    setupError: null,
    control: {
      recovery: overview.controller.control.recovery,
      serverAllowed: false,
      workspaceEnabled: false,
      canVerify: true,
      canEnable: false,
      canStart: false,
      canStop: true,
      verification: null,
      reasons: [
        {
          code: "server",
          message: "The administrator has disabled changes to the inverter",
        },
      ],
    },
  });
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  const jobId = "8be21d37-e2cf-4d74-b5b6-659b5e552c81";
  let lastAction = "";
  await page.route("**/api/commands", (route) => {
    lastAction = (route.request().postDataJSON() as { action: string }).action;
    if (lastAction === "verify") {
      overview.controller.control.verification = {
        checkedAt: now,
        passed: true,
        checks: [
          {
            label: "Inverter rating",
            actual: 20000,
            expected: 20000,
            unit: "W",
            passed: true,
          },
          {
            label: "Operating mode",
            actual: 0,
            expected: 0,
            unit: "",
            passed: true,
          },
          {
            label: "Run and backup flags",
            actual: 9,
            expected: 9,
            unit: "",
            passed: true,
          },
          {
            label: "AC charging setting",
            actual: 2000,
            expected: 2000,
            unit: "W",
            passed: true,
          },
          {
            label: "Grid charging SOC target",
            actual: 50,
            expected: 50,
            unit: "%",
            passed: true,
          },
          {
            label: "Overall SOC maximum",
            actual: 100,
            expected: 100,
            unit: "%",
            passed: true,
          },
          {
            label: "On-grid battery reserve",
            actual: 50,
            expected: 50,
            unit: "%",
            passed: true,
          },
          {
            label: "Inverter clock difference",
            actual: 55,
            expected: 120,
            unit: "s",
            passed: true,
            comparison: "at_most",
          },
          {
            label: "Firmware compatibility",
            actual: 1,
            expected: 1,
            unit: "",
            passed: true,
          },
        ],
        firmware: { protocol: "2.02", dsp: "1.57", hmi: "1.45" },
      };
      overview.controller.control.firmware = {
        protocol: "2.02",
        dsp: "1.57",
        hmi: "1.45",
        collectedAt: now,
      };
    }
    return route.fulfill({
      status: 202,
      json: { id: jobId, status: "queued", action: lastAction },
    });
  });
  await page.route(`**/api/commands/${jobId}`, (route) =>
    route.fulfill({
      json: {
        id: jobId,
        status: "succeeded",
        action: lastAction,
        message:
          lastAction === "verify"
            ? "Device settings verified"
            : "Automation paused; hardware writes are unavailable in the current setup",
      },
    }),
  );
  await page.getByRole("link", { name: "Controls", exact: true }).click();
  await expect(
    page.getByText("The administrator has disabled changes to the inverter", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enable workspace control", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Verify device settings", exact: true })
    .click();
  await expect(page.locator(".readiness-details summary")).toContainText(
    "9 of 9 checks verified",
  );
  await page.locator(".readiness-details summary").click();
  await expect(page.locator(".readiness-check")).toHaveCount(9);
  await expect(page.locator(".readiness-check").first()).toContainText("20 kW");
  await expect(page.locator(".readiness-check").last()).toContainText(
    "Validated firmware",
  );
  await expect(
    page.getByText("Observed firmware: protocol 2.02, DSP 1.57, HMI 1.45"),
  ).toBeVisible();
  await expect(
    page.getByText(/native grid charging may still run below the reserve/),
  ).toBeVisible();
  expect(lastAction).toBe("verify");
  await expect(
    page.getByText("Scheduled AC permission", { exact: true }).locator(".."),
  ).toContainText("Not read yet");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.locator(".reading-provenance")).toContainText(
    "Logger readings",
  );
  await page.getByRole("link", { name: "Controls", exact: true }).click();
  overview.controller.error = "Device settings need attention";
  overview.controller.control.canStart = false;
  await page.reload();
  await page
    .getByRole("button", { name: "Stop scheduled top-ups", exact: true })
    .click();
  await expect.poll(() => lastAction).toBe("stop");
  await expect(page.locator(".toast")).toContainText(
    "Automation paused; hardware writes are unavailable",
  );
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByRole("heading", { name: "Готовност за управление", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator(".readiness-details summary").click();
  expect(
    await page.locator(".readiness-check").evaluateAll((cards) =>
      cards.every((card) => {
        const label = card
          .querySelector("span:not(.sr-only)")
          ?.getBoundingClientRect();
        const value = card.querySelector("strong")?.getBoundingClientRect();
        return (
          label &&
          value &&
          (label.right <= value.left + 1 ||
            value.right <= label.left + 1 ||
            label.bottom <= value.top + 1 ||
            value.bottom <= label.top + 1)
        );
      }),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/control-readiness-bulgarian-mobile.png",
    fullPage: true,
  });
});

test("shared API budgets explain remaining capacity and recovery limits in both languages", async ({
  page,
}) => {
  await signIn(page);
  const settings = (await (
    await page.request.get("/api/settings")
  ).json()) as SettingsData;
  settings.budget = {
    limit: 200000,
    reserve: 2000,
    tracked: 12000,
    remaining: 160000,
    routineRemaining: 158000,
    state: "available",
    workspaces: 2,
    projected: 175200,
    providerRemaining: 160000,
    providerCheckedAt: new Date().toISOString(),
    balanceAttemptedAt: new Date(Date.now() - 1000).toISOString(),
  };
  settings.controller.pollSeconds = 360;
  settings.controller.annualProjectedCalls = 87600;
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({ json: settings });
  });
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const panel = page.locator(".api-budget");
  await expect(panel).toContainText(
    "Connected workspaces sharing this budget: 2",
  );
  await expect(panel).toContainText("calls available for routine use");
  await expect(panel).toContainText("Adjusted provider balance");
  await expect(panel).toContainText("6 minutes");
  await expect(
    panel.getByRole("meter", { name: "API budget used" }),
  ).toHaveAttribute("aria-valuenow", "40000");
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.locator(".language-switch select").selectOption("bg");
  await expect(panel).toContainText("Запазени за възстановяване");
  settings.budget.state = "recovery-only";
  settings.budget.remaining = 2000;
  settings.budget.routineRemaining = 0;
  settings.budget.providerRemaining = 2000;
  await page.reload();
  await expect(panel).toContainText(
    "Оставащият API бюджет е запазен за спиране и възстановяване",
  );
  settings.budget.state = "exhausted";
  settings.budget.remaining = 0;
  settings.budget.providerRemaining = 0;
  settings.budget.balanceAttemptedAt = new Date(
    Date.now() - 120000,
  ).toISOString();
  settings.budget.providerCheckedAt = new Date(
    Date.now() - 2 * 86400000,
  ).toISOString();
  await page.reload();
  await expect(panel).toContainText("Бюджетът за API заявки е изчерпан");
  await expect(panel).toContainText(
    "Последната проверка на остатъка при доставчика е неуспешна",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/api-budget-mobile-bg.png",
    fullPage: true,
  });
});

test("capacity admission explains waiting, retries without premature success and exposes control revocation in Bulgarian on mobile", async ({
  page,
}) => {
  await signIn(page);
  const settings = (await (
    await page.request.get("/api/settings")
  ).json()) as SettingsData;
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const capacity: ApiCapacity = {
    fits: true,
    planningLimit: 188000,
    reservedAnnual: 175200,
    monitorMs: 1800000,
    scheduledMs: 900000,
    assessmentMs: 900000,
    admitted: false,
    controlAvailable: false,
    monitoringWorkspaces: 10,
    controlWorkspaces: 0,
    waitingWorkspaces: 1,
    activation: null,
  };
  settings.budget = {
    limit: 200000,
    reserve: 2000,
    tracked: 2000,
    remaining: 198000,
    routineRemaining: 196000,
    state: "available",
    workspaces: 11,
    projected: 175200,
    providerRemaining: null,
    providerCheckedAt: null,
    balanceAttemptedAt: null,
    capacity,
  };
  settings.controller.deviceSelected = true;
  overview.controller.capacity = capacity;
  overview.controller.mode = "capacity";
  overview.controller.error = null;
  overview.controller.setupError = null;
  overview.controller.control.workspaceEnabled = false;
  overview.controller.control.canStart = false;
  overview.controller.control.canStop = true;
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: settings }),
  );
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  const retryId = randomUUID();
  const disableId = randomUUID();
  let finished = false;
  const actions: string[] = [];
  await page.route("**/api/commands", (route) => {
    const action = (route.request().postDataJSON() as { action: string })
      .action;
    actions.push(action);
    return route.fulfill({
      status: 202,
      json: {
        id: action === "retry_capacity" ? retryId : disableId,
        status: "queued",
        action,
      },
    });
  });
  await page.route(`**/api/commands/${retryId}`, (route) => {
    if (finished) {
      Object.assign(capacity, {
        admitted: true,
        controlAvailable: true,
        monitoringWorkspaces: 1,
        waitingWorkspaces: 0,
        monitorMs: 300000,
        reservedAnnual: 105120,
        activation: {
          fits: true,
          planningLimit: 188000,
          reservedAnnual: 187245,
          monitorMs: 300000,
          scheduledMs: 1020000,
          assessmentMs: 1920000,
        },
      });
    }
    return route.fulfill({
      json: {
        id: retryId,
        status: finished ? "succeeded" : "running",
        action: "retry_capacity",
        message: finished ? "Monitoring capacity is available" : null,
      },
    });
  });
  await page.route(`**/api/commands/${disableId}`, (route) => {
    overview.controller.control.workspaceEnabled = false;
    return route.fulfill({
      json: {
        id: disableId,
        status: "succeeded",
        action: "disable_controls",
        message: "Workspace control disabled; scheduled permission cleared",
      },
    });
  });
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.locator(".capacity-details")).toHaveAttribute("open", "");
  await expect(page.locator(".capacity-details")).toContainText(
    "no capacity slot",
  );
  await page
    .getByRole("button", { name: "Retry monitoring capacity", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Retry monitoring capacity",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.locator(".capacity-details")).toContainText(
    "no capacity slot",
  );
  expect(actions).toEqual(["retry_capacity"]);
  finished = true;
  await expect(page.locator(".toast")).toContainText(
    "Monitoring capacity is available",
  );
  await expect(page.locator(".capacity-details")).not.toHaveAttribute(
    "open",
    "",
  );
  await page.locator(".capacity-details summary").click();
  await expect(page.locator(".capacity-details")).toContainText(
    "scheduled checks 17 minutes",
  );
  await expect(page.locator(".capacity-details")).toContainText(
    "reserve assessments 32 minutes",
  );
  await expect(
    page
      .locator(".capacity-details dt")
      .filter({ hasText: "Scheduled charging interval" }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".capacity-details dt")
      .filter({ hasText: "Below-reserve assessment interval" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator(".language-switch select").selectOption("bg");
  await expect(page.locator(".capacity-details")).toContainText(
    "Паузата запазва резервацията",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  Object.assign(overview.controller, {
    mode: "error",
    error: "Device settings need attention",
  });
  overview.controller.control.workspaceEnabled = true;
  await page.getByRole("link", { name: "Управление", exact: true }).click();
  await page
    .getByRole("button", { name: "Изключи управлението", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText(
    "Управлението за пространството е изключено",
  );
  expect(actions).toEqual(["retry_capacity", "disable_controls"]);
  await expect(
    page.getByRole("button", { name: "Разреши управлението", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/api-capacity-mobile-bg.png",
    fullPage: true,
  });
});

test("uncertain writes remain distinct from confirmed cleanup in English and Bulgarian", async ({
  page,
}) => {
  await signIn(page);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const now = new Date().toISOString();
  overview.controller.control.recovery = {
    state: "uncertain",
    pending: true,
    inFlight: false,
    confirmedOffAt: null,
    updatedAt: now,
    writes: [
      {
        id: "4d2ace90-639a-4d0a-b640-c760ef93ff13",
        executionId: null,
        operation: "enable",
        status: "uncertain",
        inFlight: false,
        createdAt: now,
        acknowledgedAt: now,
        verifiedAt: null,
        reconciledAt: null,
      },
    ],
  };
  overview.controller.control.canStart = false;
  overview.controller.control.canStop = true;
  overview.controller.control.reasons = [
    {
      code: "cleanup",
      message: "Scheduled charging has not been confirmed off",
    },
  ];
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.goto("/controls");
  const panel = page.locator(".write-recovery");
  await expect(panel).toContainText("Write outcome unknown");
  await expect(
    page.getByRole("button", { name: "Top up to 50%", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Stop scheduled top-ups", exact: true }),
  ).toBeEnabled();
  await panel.locator("summary").click();
  await expect(panel.locator("dl")).toContainText("Not recorded");
  overview.controller.control.recovery.inFlight = true;
  overview.controller.control.recovery.writes[0].inFlight = true;
  overview.controller.control.recovery.writes[0].status = "acknowledged";
  await page.reload();
  await expect(
    page.getByText(
      "Waiting for device acknowledgment and readback before confirming the change.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(panel.locator("summary")).toContainText(
    "Waiting for device confirmation",
  );
  overview.controller.control.recovery.inFlight = false;
  overview.controller.control.recovery.writes[0].inFlight = false;
  overview.controller.control.recovery.writes[0].status = "uncertain";
  await page.reload();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator(".language-switch select").selectOption("bg");
  await expect(panel).toContainText("Резултатът от промяната е неизвестен");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  overview.controller.control.recovery.pending = false;
  overview.controller.control.recovery.state = "clear";
  overview.controller.control.recovery.confirmedOffAt = now;
  overview.controller.control.recovery.writes[0].reconciledAt = now;
  await page.reload();
  await expect(panel).toContainText(
    "Изключването е потвърдено; резултатът от първоначалната промяна е неизвестен",
  );
  await panel.locator("summary").click();
  await expect(panel.locator("dl")).toContainText("Няма запис");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/write-recovery-mobile-bg.png",
    fullPage: true,
  });
});

test("native supervision and observed charging problems remain clear on mobile in both languages", async ({
  page,
}) => {
  await signIn(page);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const warning =
    "The grid is supplying the home above the reserve with little or no battery support. Check inverter settings and BMS limits.";
  overview.controller.supervision = {
    mode: "monitoring",
    auditSeconds: 3600,
    lastNativeAt: new Date().toISOString(),
    nextAuditAt: new Date(Date.now() + 3600000).toISOString(),
    issue: {
      code: "battery_not_supporting_home",
      message: warning,
      observedAt: new Date().toISOString(),
    },
  };
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.goto("/controls");
  await expect(
    page.getByText("Monitoring existing inverter policy", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(warning, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/Full native checks every 60 minutes/),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByText("Наблюдение на текущата политика на инвертора", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/Домът се захранва от мрежата над резерва/),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.getByRole("link", { name: "Преглед", exact: true }).click();
  await expect(
    page.getByText(/Домът се захранва от мрежата над резерва/),
  ).toBeVisible();
});

test("activity details preserve filters, explain a command without writes and handle a missing record in Bulgarian", async ({
  page,
}) => {
  await signIn(page);
  const session = (await (
    await page.request.get("/api/auth/session")
  ).json()) as Session;
  const response = await page.request.post("/api/commands", {
    headers: {
      origin: "http://localhost:3000",
      "x-csrf-token": session.csrfToken,
      "idempotency-key": randomUUID(),
    },
    data: { action: "pause" },
  });
  expect(response.status()).toBe(202);
  const job = (await response.json()) as Command;
  await expect
    .poll(async () => {
      const result = (await (
        await page.request.get(`/api/commands/${job.id}`)
      ).json()) as Command;
      return result.status;
    })
    .toBe("succeeded");
  await page.goto("/activity");
  await page.getByLabel("Search activity").fill("pause");
  await expect(page).toHaveURL(/search=pause/);
  await page.locator(`a[href="/activity/${job.id}"]`).click();
  await expect(
    page.getByRole("heading", { name: "Command details", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".command-writes")).toContainText(
    "No inverter write intents were recorded for this command.",
  );
  await expect(page.locator(".command-record")).toContainText(job.id);
  await page
    .getByRole("link", { name: "Back to activity", exact: true })
    .click();
  await expect(page.getByLabel("Search activity")).toHaveValue("pause");
  await expect(page).toHaveURL(/search=pause/);
  await page.locator(`a[href="/activity/${job.id}"]`).click();
  await page.locator(".language-switch select").selectOption("bg");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", {
      name: "Подробности за командата",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".command-writes")).toContainText(
    "За тази команда няма записани заявки за промени по инвертора.",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.goto(`/activity/${randomUUID()}`);
  await expect(page.getByRole("alert")).toContainText(
    "Командата не е намерена",
  );
  await expect(page.locator(".command-record")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Обновяване на записа", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Командата не е намерена",
  );
});

test("full write history includes recovery and paginated command evidence without confirming an uncertain write", async ({
  page,
}) => {
  const env = parseEnv(readFileSync(".env", "utf8"));
  const pool = new pg.Pool({
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: "solarman_test",
  });
  const account = (
    await pool.query(
      "SELECT a.id,a.tenant_id FROM solarman_accounts a JOIN users u ON u.tenant_id=a.tenant_id WHERE lower(u.email)=$1",
      [process.env.E2E_EMAIL?.toLowerCase()],
    )
  ).rows[0] as { id: string; tenant_id: string };
  const jobId = randomUUID();
  const device =
    "historical-inverter-" + jobId + "-" + "a-long-serial-".repeat(6);
  const writeIds = Array.from({ length: 27 }, () => randomUUID());
  try {
    await pool.query(
      "INSERT INTO command_executions (tenant_id,id,account_id,device,actor,action,status,message,completed_at,detail) VALUES ($1,$2,$3,$4,'fixture-owner@example.test','topup','failed','Device acknowledgment timed out; command outcome is unknown',now(),$5)",
      [
        account.tenant_id,
        jobId,
        account.id,
        device,
        {
          decision: { charge: false, reason: "reserve_reached" },
          events: [
            {
              event: "decision",
              charge: false,
              reason: "reserve_reached",
              soc: 51,
              pvW: 1600,
              loadW: 800,
              gridW: 0,
              batteryW: -750,
              dryRun: false,
              acEnabled: false,
            },
            { event: "native_policy_check", reason: "native_audit" },
          ],
        },
      ],
    );
    await pool.query(
      "INSERT INTO device_control_state (tenant_id,account_id,device,state,confirmed_off_at) VALUES ($1,$2,$3,'clear',now())",
      [account.tenant_id, account.id, device],
    );
    for (const [index, id] of writeIds.entries()) {
      const uncertain = index === 25;
      const recovery = index === 26;
      await pool.query(
        `INSERT INTO inverter_write_intents (id,tenant_id,account_id,device,execution_id,operation,address,register_values,status,created_at,acknowledged_at,verified_at,reconciled_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()-interval '1 hour'+($10*interval '1 second'),now(),CASE WHEN $11 THEN null ELSE now() END,CASE WHEN $11 THEN now() ELSE null END)`,
        [
          id,
          account.tenant_id,
          account.id,
          device,
          recovery ? null : jobId,
          recovery ? "disable" : uncertain ? "enable" : "window",
          uncertain || recovery ? 206 : 2509,
          JSON.stringify(
            uncertain
              ? [0, 25]
              : recovery
                ? [0, 9]
                : [4096, 4121, 0, 0, 0, 0, 0, 0],
          ),
          uncertain ? "uncertain" : "verified",
          index,
          uncertain,
        ],
      );
    }
    await signIn(page);
    await page.getByRole("link", { name: "Activity", exact: true }).click();
    await page
      .getByRole("link", { name: "All inverter writes", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "All inverter writes", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".write-history > li")).toHaveCount(25);
    await expect(page.locator(".write-history > li").first()).toContainText(
      "System recovery; no linked command record",
    );
    await page.locator(".write-history > li").nth(1).locator("summary").click();
    await page
      .getByRole("link", { name: "View command details", exact: true })
      .first()
      .click();
    await expect(page.locator(".command-record").first()).toContainText(device);
    await expect(page.locator(".command-events")).toContainText(
      "Periodic or required native check",
    );
    await expect(
      page.locator(".command-writes .write-history > li"),
    ).toHaveCount(25);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page).toHaveURL(/offset=25/);
    await expect(
      page.locator(".command-writes .write-history > li"),
    ).toHaveCount(1);
    await expect(page.locator(".write-history summary")).toContainText(
      "Cleanup confirmed; original write outcome unknown",
    );
    await expect(
      page.locator(".write-history dd").filter({ hasText: "0, 25" }),
    ).toBeVisible();
    await expect(
      page
        .locator(".write-history dl > div")
        .filter({ has: page.getByText("Readback verified", { exact: true }) }),
    ).toContainText("Not recorded");
    await page.locator(".language-switch select").selectOption("bg");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".write-history summary")).toContainText(
      "Изключването е потвърдено; резултатът от първоначалната промяна е неизвестен",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: "test-results/command-details-mobile-bg.png",
      fullPage: true,
    });
    await page
      .getByRole("link", { name: "Към историята на промените", exact: true })
      .click();
    await expect(page).toHaveURL("/activity/writes");
    await page.getByRole("button", { name: "Следващи", exact: true }).click();
    await expect(page.locator(".write-history > li")).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Следващи", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  } finally {
    try {
      await pool.query(
        "DELETE FROM inverter_write_intents WHERE id=ANY($1::uuid[])",
        [writeIds],
      );
      await pool.query(
        "DELETE FROM device_control_state WHERE tenant_id=$1 AND device=$2",
        [account.tenant_id, device],
      );
      await pool.query("DELETE FROM command_executions WHERE id=$1", [jobId]);
    } finally {
      await pool.end();
    }
  }
});

test("health alerts stay active after being marked seen and show resolved history in Bulgarian on mobile", async ({
  page,
}) => {
  await signIn(page);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const now = new Date().toISOString();
  const before = new Date(Date.now() - 3600000).toISOString();
  const items: Incident[] = [
    {
      id: randomUUID(),
      kind: "cleanup_pending",
      severity: "critical",
      device: "health-inverter-" + "long-serial-".repeat(5),
      detailCode: null,
      firstSeenAt: before,
      lastSeenAt: now,
      resolvedAt: null,
      resolutionReason: null,
      acknowledgedAt: null,
      revision: 1,
    },
    {
      id: randomUUID(),
      kind: "telemetry_stale",
      severity: "warning",
      device: "health-inverter",
      detailCode: null,
      firstSeenAt: before,
      lastSeenAt: now,
      resolvedAt: null,
      resolutionReason: null,
      acknowledgedAt: null,
      revision: 1,
    },
  ];
  const monitor = { checkedAt: now, state: "current" } as const;
  overview.alerts = { items, active: 2, unseen: 2, monitor };
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/operations?**", (route) => {
    const filter = new URL(route.request().url()).searchParams.get("filter");
    const selected = items.filter(
      (item) =>
        filter === "all" ||
        (filter === "resolved"
          ? item.resolvedAt !== null
          : item.resolvedAt === null),
    );
    const data: OperationsData = {
      items: selected,
      hasMore: false,
      offset: 0,
      total: selected.length,
      unseen: selected.filter(
        (item) => !item.resolvedAt && !item.acknowledgedAt,
      ).length,
      monitor,
      deviceHealth: {
        device: "health-inverter",
        attemptedAt: now,
        succeededAt: now,
        failedAt: before,
        uploadedAt: before,
        deviceState: 1,
        failures: 0,
        controlFault: false,
        staleAfterSeconds: 480,
      },
    };
    return route.fulfill({ json: data });
  });
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/incidents/${items[0].id}/acknowledge`,
    async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
      expect(route.request().postDataJSON() as { revision: number }).toEqual({
        revision: 1,
      });
      await gate;
      items[0].acknowledgedAt = now;
      overview.alerts.unseen = 1;
      await route.fulfill({ json: items[0] });
    },
  );
  await page.goto("/");
  await expect(page.locator(".incident-summary")).toContainText(
    "2 active alerts",
  );
  await page
    .getByRole("link", { name: "Review health and alerts", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "System health", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".incident-card")).toHaveCount(2);
  const critical = page.locator(".incident-card.critical");
  await critical
    .getByRole("button", { name: "Mark as seen", exact: true })
    .click();
  await expect(
    critical.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  release();
  await expect(critical).toContainText("Seen; the condition is still active.");
  await expect(critical.locator(".badge")).toHaveText("Critical");
  await page.locator(".language-switch select").selectOption("bg");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Състояние на системата", exact: true }),
  ).toBeVisible();
  await expect(critical).toContainText("Видян; състоянието все още е активно.");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/system-health-mobile-bg.png",
    fullPage: true,
  });
  items[0].resolvedAt = now;
  items[0].resolutionReason = "cleared";
  await page.getByLabel("Показване на сигнали").selectOption("resolved");
  await expect(page.locator(".incident-card")).toHaveCount(1);
  await expect(page.locator(".incident-card")).toContainText(
    "Записано състояние:",
  );
  await expect(page.locator(".incident-card .badge")).toHaveText("Приключен");
  await expect(page.locator(".incident-card")).toContainText(
    "Състоянието вече не се установява",
  );
  await expect(
    page.getByRole("button", { name: "Отбелязване като видян", exact: true }),
  ).toHaveCount(0);
});

test("health request failure offers retry and a delayed monitor never appears as current", async ({
  page,
}) => {
  await signIn(page);
  let requests = 0;
  await page.route("**/api/operations?**", (route) => {
    requests++;
    if (requests === 1)
      return route.fulfill({
        status: 503,
        json: {
          error: "The request could not be completed. Please try again.",
        },
      });
    const data: OperationsData = {
      items: [],
      hasMore: false,
      offset: 0,
      total: 0,
      unseen: 0,
      monitor: {
        checkedAt: new Date(Date.now() - 300000).toISOString(),
        state: "delayed",
      },
      deviceHealth: null,
    };
    return route.fulfill({ json: data });
  });
  await page.goto("/settings/health");
  await expect(page.getByRole("alert")).toContainText(
    "The request could not be completed. Please try again.",
  );
  await expect(page.locator(".health-facts")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "The operational monitor is overdue. Alert status may be out of date.",
  );
  await expect(page.locator(".health-facts")).toBeVisible();
  await expect(
    page.getByText("No active workspace alerts recorded.", { exact: true }),
  ).toBeVisible();
});

test("recovery health distinguishes a failed latest test from previous success in both languages on mobile", async ({
  page,
}) => {
  await signIn(page);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const health = (await (
    await page.request.get("/api/operations")
  ).json()) as OperationsData;
  const now = new Date().toISOString();
  const before = new Date(Date.now() - 12 * 3600000).toISOString();
  const backup: BackupStatus = {
    state: "attention",
    issues: ["restore_failed"],
    lastBackupAt: before,
    lastRestoreAt: before,
    retentionDays: 30,
    backup: {
      state: "verified",
      startedAt: before,
      completedAt: before,
      offsiteVerified: true,
    },
    restore: {
      state: "failed",
      startedAt: now,
      completedAt: now,
      inventoryVerified: false,
      credentialsVerified: false,
      authenticationVerified: false,
      controlQuarantined: false,
    },
  };
  overview.backup = backup;
  health.backup = backup;
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/operations?**", (route) =>
    route.fulfill({ json: health }),
  );
  await page.reload();
  await expect(
    page.getByText("Backup and recovery need attention."),
  ).toBeVisible();
  await page.getByRole("link", { name: "Review recovery status" }).click();
  const panel = page.locator(".health-facts").filter({
    has: page.getByRole("heading", {
      name: "Backup and recovery",
      exact: true,
    }),
  });
  await expect(panel).toContainText("The latest recovery test failed.");
  await expect(panel).toContainText("Last successful recovery test");
  await expect(panel).not.toContainText("Recovery verified database inventory");
  await page.getByLabel("Language").selectOption("bg");
  await page.setViewportSize({ width: 390, height: 844 });
  const bulgarianPanel = page.locator(".health-facts").filter({
    has: page.getByRole("heading", {
      name: "Архивиране и възстановяване",
      exact: true,
    }),
  });
  await expect(bulgarianPanel).toContainText(
    "Последният тест за възстановяване е неуспешен.",
  );
  backup.state = "healthy";
  backup.issues = [];
  backup.lastRestoreAt = now;
  backup.restore = {
    state: "verified",
    startedAt: now,
    completedAt: now,
    inventoryVerified: true,
    credentialsVerified: true,
    authenticationVerified: true,
    controlQuarantined: true,
  };
  await page
    .getByRole("button", { name: "Обновяване на състоянието", exact: true })
    .click();
  await expect(bulgarianPanel).toContainText(
    "Проверките за възстановяване са успешни",
  );
  await expect(bulgarianPanel).toContainText("без достъп до устройства");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/recovery-health-mobile-bg.png",
    fullPage: true,
  });
});

async function privateInvitation(
  page: Page,
  email: string,
  name: string,
): Promise<{ url: string }> {
  const session = (await (
    await page.request.get("/api/auth/session")
  ).json()) as Session;
  const response = await page.request.post("/api/admin/invitations", {
    headers: {
      origin: "http://localhost:3000",
      "x-csrf-token": session.csrfToken,
    },
    data: { email, tenantName: name },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { url: string };
}

test("saved recovery works through the public page and downloads a Bulgarian key without URL secrets", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const email = `saved-recovery-${randomUUID()}@example.test`;
  const initial = "saved-recovery-fixture-password";
  const replacement = "recovered-fixture-password= ";
  const invitation = await privateInvitation(
    page,
    email,
    "Saved recovery fixture",
  );
  const context = await browser.newContext({
    baseURL: "http://localhost:3000",
    locale: "en-GB",
  });
  try {
    const user = await context.newPage();
    const requests: string[] = [];
    user.on("request", (request) => requests.push(request.url()));
    await user.goto(invitation.url);
    await expect(user.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(user).toHaveURL("http://localhost:3000/activate");
    await user.getByLabel("Password", { exact: true }).fill(initial);
    await user.getByLabel("Confirm password", { exact: true }).fill(initial);
    await user
      .getByRole("button", { name: "Create my workspace", exact: true })
      .click();
    await expect(
      user.getByRole("heading", { name: "Energy overview", exact: true }),
    ).toBeVisible();
    await user.goto("/settings/security");
    await user
      .getByLabel("Current dashboard password", { exact: true })
      .fill(initial);
    await user
      .getByRole("button", { name: "Generate recovery key", exact: true })
      .click();
    const key = await user
      .getByLabel("Recovery key", { exact: true })
      .inputValue();
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    await user.locator(".language-switch select").selectOption("bg");
    const downloading = user.waitForEvent("download");
    await user
      .getByRole("button", {
        name: "Изтегли ключа за възстановяване",
        exact: true,
      })
      .click();
    const download = await downloading;
    const file = await download.path();
    expect(file).not.toBeNull();
    const content = readFileSync(file!, "utf8");
    expect(content).toContain(key);
    expect(content).toContain(email);
    expect(content).toContain("Ключ за възстановяване");
    await user
      .getByRole("button", { name: "Запазих ключа", exact: true })
      .click();
    await expect(
      user.getByLabel("Ключ за възстановяване", { exact: true }),
    ).toHaveCount(0);
    await user.setViewportSize({ width: 320, height: 740 });
    await user.getByRole("button", { name: "Изход", exact: true }).click();
    await user
      .getByRole("link", { name: "Забравена парола за таблото?", exact: true })
      .click();
    await expect(
      user.getByRole("heading", {
        name: "Възстановяване на достъпа до таблото",
        exact: true,
      }),
    ).toBeVisible();
    await user.getByLabel("Имейл адрес", { exact: true }).fill(email);
    await user
      .getByLabel("Ключ за възстановяване", { exact: true })
      .fill("0".repeat(64));
    await user.getByLabel("Нова парола", { exact: true }).fill(replacement);
    await user
      .getByLabel("Потвърдете новата парола", { exact: true })
      .fill(replacement);
    await user
      .getByRole("button", { name: "Смени паролата за таблото", exact: true })
      .click();
    await expect(user.getByRole("alert")).toContainText(
      "Данните за възстановяване са невалидни",
    );
    await user.getByLabel("Ключ за възстановяване", { exact: true }).fill(key);
    await user
      .getByRole("button", { name: "Смени паролата за таблото", exact: true })
      .click();
    await expect(
      user.getByText(
        "Паролата е сменена. Всички предишни сесии в браузър и данни за възстановяване са невалидни.",
        { exact: true },
      ),
    ).toBeVisible();
    const next = await user
      .getByLabel("Ключ за възстановяване", { exact: true })
      .inputValue();
    expect(next).not.toBe(key);
    expect((await user.request.get("/api/auth/session")).status()).toBe(401);
    expect(
      requests.some(
        (url) =>
          url.includes(key) ||
          url.includes(next) ||
          url.includes(
            new URLSearchParams(new URL(invitation.url).hash.slice(1)).get(
              "token",
            )!,
          ),
      ),
    ).toBe(false);
    expect(
      await user.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await user.screenshot({
      path: "test-results/recovered-key-mobile-bg.png",
      fullPage: true,
    });
    await user
      .getByRole("link", { name: "Обратно към входа", exact: true })
      .click();
    await user.getByLabel("Имейл адрес", { exact: true }).fill(email);
    await user.getByLabel("Парола", { exact: true }).fill(replacement);
    await user.getByRole("button", { name: "Вход", exact: true }).click();
    await expect(
      user.getByRole("heading", { name: "Преглед на енергията", exact: true }),
    ).toBeVisible();
    await user.goto("/settings/security");
    await user
      .getByLabel("Текуща парола за таблото", { exact: true })
      .fill(replacement);
    await user
      .getByRole("button", {
        name: "Отмени достъпа за възстановяване",
        exact: true,
      })
      .click();
    await expect(
      user.getByText("Няма запазен ключ за възстановяване.", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("administrators revoke and reissue invitations and provide a single-use private recovery link", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const email = `invitation-access-${randomUUID()}@example.test`;
  const initial = "invitation-access-fixture-password";
  await page.getByRole("link", { name: "Workspaces", exact: true }).click();
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Access lifecycle fixture");
  await page.getByLabel("User email", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Create private invitation", exact: true })
    .click();
  const original = await page
    .getByLabel("Invitation link", { exact: true })
    .inputValue();
  const entry = page.locator(".invitation-entry").filter({ hasText: email });
  await expect(entry).toHaveCount(1);
  await entry
    .getByRole("button", { name: "Revoke invitation", exact: true })
    .click();
  await expect(entry.locator(".badge")).toHaveText("Revoked");
  const context = await browser.newContext({
    baseURL: "http://localhost:3000",
    locale: "en-GB",
  });
  try {
    const user = await context.newPage();
    const requests: string[] = [];
    user.on("request", (request) => requests.push(request.url()));
    await user.goto(original);
    await expect(
      user.getByRole("heading", {
        name: "Invitation unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await entry
      .getByRole("button", { name: "Reissue invitation", exact: true })
      .click();
    const current = await page
      .getByLabel("Invitation link", { exact: true })
      .inputValue();
    expect(current).not.toBe(original);
    await user.goto(current);
    await user.getByLabel("Password", { exact: true }).fill(initial);
    await user.getByLabel("Confirm password", { exact: true }).fill(initial);
    await user
      .getByRole("button", { name: "Create my workspace", exact: true })
      .click();
    await expect(
      user.getByRole("heading", { name: "Energy overview", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Account email", { exact: true }).fill(email);
    await page
      .getByLabel("Administrator password", { exact: true })
      .fill(process.env.E2E_PASSWORD!);
    await page
      .getByRole("button", {
        name: "Create private recovery link",
        exact: true,
      })
      .click();
    const link = await page
      .getByLabel("Account recovery link", { exact: true })
      .inputValue();
    const secret = new URLSearchParams(new URL(link).hash.slice(1)).get("key")!;
    expect(new URL(link).search).toBe("");
    await page.locator(".language-switch select").selectOption("bg");
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: "test-results/private-access-admin-mobile-bg.png",
      fullPage: true,
    });
    await user.goto(link);
    await expect(user).toHaveURL("http://localhost:3000/recover");
    await expect(user.getByLabel("Email address", { exact: true })).toHaveValue(
      email,
    );
    await expect(user.getByLabel("Recovery key", { exact: true })).toHaveValue(
      secret,
    );
    await user
      .getByLabel("New password", { exact: true })
      .fill("admin-recovery-replacement");
    await user
      .getByLabel("Confirm new password", { exact: true })
      .fill("admin-recovery-replacement");
    await user
      .getByRole("button", { name: "Reset dashboard password", exact: true })
      .click();
    await expect(
      user.getByText(
        "Password reset completed. All previous browser sessions and recovery credentials are invalid.",
        { exact: true },
      ),
    ).toBeVisible();
    expect((await user.request.get("/api/auth/session")).status()).toBe(401);
    expect(requests.some((url) => url.includes(secret))).toBe(false);
    await page
      .getByLabel("Парола на администратора", { exact: true })
      .fill(process.env.E2E_PASSWORD!);
    await page
      .getByRole("button", {
        name: "Създай лична връзка за възстановяване",
        exact: true,
      })
      .click();
    const cancelled = await page
      .getByLabel("Връзка за възстановяване на акаунта", { exact: true })
      .inputValue();
    await page
      .getByLabel("Парола на администратора", { exact: true })
      .fill(process.env.E2E_PASSWORD!);
    await page
      .getByRole("button", {
        name: "Отмени неизползваните връзки за възстановяване",
        exact: true,
      })
      .click();
    await expect(
      page.getByText(
        "Неизползваните администраторски връзки за възстановяване са отменени",
        { exact: true },
      ),
    ).toBeVisible();
    await user.goto(cancelled);
    await user
      .getByLabel("New password", { exact: true })
      .fill("cancelled-link-replacement");
    await user
      .getByLabel("Confirm new password", { exact: true })
      .fill("cancelled-link-replacement");
    await user
      .getByRole("button", { name: "Reset dashboard password", exact: true })
      .click();
    await expect(user.getByRole("alert")).toContainText(
      "Recovery details are invalid",
    );
  } finally {
    await context.close();
  }
});

test("public recovery reports an unconfirmed response in Bulgarian instead of claiming a failed reset", async ({
  page,
}) => {
  await page.goto(
    "/recover#key=" + "a".repeat(64) + "&email=fixture%40example.test",
  );
  await expect(page).toHaveURL("http://localhost:3000/recover");
  await page.route("**/api/auth/recover", (route) => route.abort("failed"));
  await page
    .getByLabel("New password", { exact: true })
    .fill("unconfirmed-recovery-fixture");
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill("unconfirmed-recovery-fixture");
  await page.locator(".language-switch select").selectOption("bg");
  await page
    .getByRole("button", { name: "Смени паролата за таблото", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Възстановяването не може да бъде потвърдено",
  );
});

test("a delayed identity cannot replace an activated user and recovery preserves another signed-in account", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const owner = (await (
    await page.request.get("/api/auth/session")
  ).json()) as Session;
  const email = `identity-recovery-${randomUUID()}@example.test`;
  const initial = "identity-recovery-fixture";
  const invitation = await privateInvitation(
    page,
    email,
    "Identity recovery fixture",
  );
  const context = await browser.newContext({
    baseURL: "http://localhost:3000",
    locale: "en-GB",
  });
  await context.addCookies(await page.context().cookies());
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let intercepted = false;
  await context.route("**/api/auth/session", async (route) => {
    if (intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    try {
      const original = await route.fetch();
      await gate;
      await route.fulfill({ response: original });
    } finally {
      completed();
    }
  });
  try {
    const user = await context.newPage();
    await user.goto(invitation.url);
    await user.getByLabel("Password", { exact: true }).fill(initial);
    await user.getByLabel("Confirm password", { exact: true }).fill(initial);
    await user
      .getByRole("button", { name: "Create my workspace", exact: true })
      .click();
    await expect(
      user.getByRole("heading", { name: "Energy overview", exact: true }),
    ).toBeVisible();
    release();
    await finished;
    await expect(
      user.getByRole("link", { name: "Workspaces", exact: true }),
    ).toHaveCount(0);
    const session = (await (
      await user.request.get("/api/auth/session")
    ).json()) as Session;
    expect(session.user.email).toBe(email);
    const generated = await user.request.post("/api/security/recovery/key", {
      headers: {
        origin: "http://localhost:3000",
        "x-csrf-token": session.csrfToken,
      },
      data: { currentPassword: initial },
    });
    expect(generated.status()).toBe(200);
    const saved = (await generated.json()) as { key: string };
    await page.goto(
      "/recover#" + new URLSearchParams({ email, key: saved.key }).toString(),
    );
    await page
      .getByLabel("New password", { exact: true })
      .fill("identity-recovered-password");
    await page
      .getByLabel("Confirm new password", { exact: true })
      .fill("identity-recovered-password");
    await page
      .getByRole("button", { name: "Reset dashboard password", exact: true })
      .click();
    await expect(
      page.getByText(
        `This browser is signed in as ${owner.user.email}. Sign out in the dashboard to switch accounts.`,
        { exact: true },
      ),
    ).toBeVisible();
    const remaining = await page.request.get("/api/auth/session");
    expect(remaining.status()).toBe(200);
    expect(((await remaining.json()) as Session).user.id).toBe(owner.user.id);
    expect((await user.request.get("/api/auth/session")).status()).toBe(401);
    await page
      .getByRole("link", { name: "Return to dashboard", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Workspaces", exact: true }),
    ).toBeVisible();
  } finally {
    release();
    if (intercepted) await finished;
    await context.close();
  }
});
