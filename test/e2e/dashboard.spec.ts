import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
import type { OverviewData, SettingsData } from "../../web/types";

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
        ],
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
    "8 of 8 checks verified",
  );
  await page.locator(".readiness-details summary").click();
  await expect(page.locator(".readiness-check")).toHaveCount(8);
  await expect(page.locator(".readiness-check").first()).toContainText("20 kW");
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
    .getByRole("button", { name: "Stop scheduled top-up", exact: true })
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
    page.getByRole("button", { name: "Stop scheduled top-up", exact: true }),
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
