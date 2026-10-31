import { energyDashboardFixture } from "./energy.fixture";
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
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
  OffboardingStatus,
  TenantLifecycleStatus,
  TenantMetadata,
  PolicyObservationData,
  PolicyObservationRun,
  CommissioningData,
  CommissioningHistoryReview,
  NotificationSettingsData,
  NotificationDelivery,
  OutageData,
  CommandDetails,
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
    page.getByRole("heading", { name: "Your energy, at a glance.", exact: true }),
  ).toBeVisible();
}

async function homeConsoleFixture(page: Page): Promise<OverviewData> {
  await signIn(page);
  const data = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const at = new Date().toISOString();
  data.latest = {
    at,
    receivedAt: at,
    source: "provider",
    samplingSeconds: 360,
    soc: 30,
    temperatureC: 20,
    pvW: 500,
    loadW: 800,
    gridW: 2300,
    batteryW: -2000,
    acEnabled: true,
  };
  Object.assign(data.controller, {
    apiConfigured: true,
    deviceSelected: true,
    profile: "bluesun-bse20kh3",
    writesEnabled: true,
    paused: true,
    manualTopup: false,
    mode: "paused",
    error: null,
    setupError: null,
    recoveryTesting: false,
  });
  data.controller.telemetry = {
    source: "provider",
    collectedAt: at,
    receivedAt: at,
    deviceState: 1,
    clock: null,
  };
  data.controller.control.canStart = true;
  data.controller.control.canStop = true;
  data.controller.control.workspaceEnabled = true;
  data.controller.control.reasons = [];
  data.controller.control.recovery = {
    state: "clear",
    pending: false,
    inFlight: false,
    confirmedOffAt: at,
    updatedAt: at,
    writes: [],
  };
  await page.route("**/api/overview", (route) => route.fulfill({ json: data }));
  await page.reload();
  return data;
}

async function outageConsoleFixture(
  page: Page,
): Promise<{ overview: OverviewData; outage: OutageData }> {
  const overview = await homeConsoleFixture(page);
  const outage: OutageData = {
    supported: true,
    minTarget: 50,
    maxTarget: 100,
    acChargeKw: 2,
    solarTargetSoc: 100,
    canPrepare: true,
    canTest: false,
    canRestore: false,
    capabilityApproved: true,
    preparation: null,
  };
  await page.route("**/api/outage", (route) => route.fulfill({ json: outage }));
  return { overview, outage };
}

test("a recovered provider connection routes paused control to verification instead of connection settings", async ({
  page,
}) => {
  const data = await homeConsoleFixture(page);
  data.controller.mode = "error";
  data.controller.error = "SOLARMAN HTTP request failed or timed out";
  data.controller.connectionRecovered = false;
  data.controller.control.canStart = false;
  await page.goto("/");
  const message = page.getByText("Readings are arriving again.", {
    exact: false,
  });
  await expect(message).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Check connection", exact: false }),
  ).toHaveAttribute("href", "/settings");
  data.controller.connectionRecovered = true;
  await page.goto("/");
  await expect(message).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: "Review app controls", exact: true })
      .first(),
  ).toHaveAttribute("href", "/controls/setup");
  await expect(
    page.getByRole("link", { name: "Check connection", exact: false }),
  ).toHaveCount(0);
  if (!data.controller.telemetry) throw Error("Missing telemetry fixture");
  data.controller.telemetry.collectedAt = new Date(
    Date.now() - 86400000,
  ).toISOString();
  await page.goto("/");
  await expect(message).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Check connection", exact: false }),
  ).toHaveAttribute("href", "/settings");
  data.controller.telemetry.collectedAt = new Date().toISOString();
  await page.goto("/");
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByText("Отчитанията отново пристигат.", { exact: false }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/connection-restored-bg.png" });
  await page
    .getByRole("link", {
      name: "Прегледай управлението от приложението",
      exact: true,
    })
    .first()
    .click();
  await expect(page).toHaveURL(/\/controls\/setup$/);
  await expect(
    page.getByText("Отчитанията отново пристигат.", { exact: false }),
  ).toBeVisible();
});

test("failed night plan history explains restoration without claiming a completed trial in Bulgarian", async ({
  page,
}) => {
  await signIn(page);
  const data = energyDashboardFixture();
  if (!data.plan) throw Error("Missing energy fixture");
  data.history = [
    {
      ...data.plan,
      id: randomUUID(),
      state: "failed",
      code: "start-unconfirmed",
    },
  ];
  await page.route("**/api/energy", (route) => route.fulfill({ json: data }));
  await page.goto("/controls/night-savings");
  await page.locator(".language-switch select").selectOption("bg");
  const history = page.locator("details").filter({
    has: page.getByText("Предишни планове и очаквана икономия", {
      exact: true,
    }),
  });
  await history.locator("summary").click();
  await expect(history).toContainText("Планът е неуспешен");
  await expect(history).toContainText(
    "Нощното зареждане не е потвърдено. Нормалните настройки са възстановени; изпитването не е завършено.",
  );
});

test("outage dial, slider and presets stay in sync with precise accessible controls and reduced motion", async ({
  page,
}) => {
  const { overview } = await outageConsoleFixture(page);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(commands|outage\/(prepare|restore))$/.test(
        new URL(request.url()).pathname,
      )
    )
      mutations.push(request.url());
  });
  await page.goto("/controls/outage");
  const range = page.getByRole("slider", { name: /Battery target/ });
  const ring = page.locator(".charge-target-progress");
  await expect(range).toHaveValue("90");
  await expect(ring).toHaveAttribute("stroke-dashoffset", "10");
  await expect(page.locator(".charge-target-marker")).toHaveCount(1);
  const initialColour = await ring.evaluate(
    (element) => getComputedStyle(element).stroke,
  );
  await page.getByRole("button", { name: "80%", exact: true }).click();
  await expect(range).toHaveValue("80");
  await expect(ring).toHaveAttribute("stroke-dashoffset", "20");
  await expect(
    page.getByRole("button", { name: "80%", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => ring.evaluate((element) => getComputedStyle(element).stroke))
    .not.toBe(initialColour);
  await page
    .getByRole("button", { name: "Increase charge target", exact: true })
    .click();
  await expect(range).toHaveValue("81");
  await range.focus();
  await page.keyboard.press("ArrowRight");
  await expect(range).toHaveValue("82");
  await page.keyboard.press("Home");
  await expect(range).toHaveValue("50");
  await expect(
    page.getByRole("button", { name: "Decrease charge target", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("End");
  await expect(range).toHaveValue("100");
  await expect(ring).toHaveAttribute("stroke-dashoffset", "0");
  await expect(
    page.getByRole("button", { name: "Increase charge target", exact: true }),
  ).toBeDisabled();
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await ring.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
  ).toBe("0s");
  await page.locator(".language-switch select").selectOption("bg");
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.screenshot({
    path: "test-results/outage-dial-mobile-bg.png",
    fullPage: true,
  });
  if (!overview.latest) throw Error("Missing reading fixture");
  overview.latest.at = new Date(Date.now() - 3600000).toISOString();
  await page.reload();
  await expect(page.locator(".charge-target-marker")).toHaveCount(0);
  await expect(
    page.getByText("Това отчитане е старо.", { exact: false }),
  ).toBeVisible();
  expect(mutations).toEqual([]);
});

test("a restored outage message follows actual automation state and preview review explains the chosen target", async ({
  page,
}) => {
  const { overview, outage } = await outageConsoleFixture(page);
  outage.preparation = {
    id: randomUUID(),
    state: "restored",
    revision: "1",
    targetSoc: 90,
    normalTargetSoc: 50,
    test: false,
    attendedUntil: null,
    lastVerifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    error: null,
    proof: {},
    approvedAt: null,
    canApprove: false,
  };
  overview.controller.paused = false;
  await page.goto("/controls/outage");
  await expect(
    page.getByText("Normal settings are restored:", { exact: false }),
  ).toContainText("Home automation is running.");
  await page
    .getByRole("button", { name: "Review and save", exact: true })
    .click();
  const review = page.getByRole("region", {
    name: "Confirm battery control",
    exact: true,
  });
  await expect(review.locator(".outage-review-summary")).toContainText("90%");
  await expect(review.locator(".outage-review-summary")).toContainText("100%");
  await expect(review.locator(".outage-review-summary")).toContainText(
    "Until you return to normal",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  overview.controller.paused = true;
  if (overview.latest) overview.latest.soc = 95;
  await page.reload();
  await expect(
    page.getByText("Normal settings are restored:", { exact: false }),
  ).toContainText("App automation remains paused.");
  await expect(
    page.getByText("Your battery is already at this level.", { exact: false }),
  ).toBeVisible();
});

test("clock failure history shows the captured timestamps and tolerance in Bulgarian on a phone", async ({
  page,
}) => {
  await signIn(page);
  const id = randomUUID();
  const detail: CommandDetails = {
    id,
    action: "evaluate",
    actor: "Automation",
    status: "failed",
    message: "The inverter clock must match the workspace timezone",
    device: "TEST-BLUESUN",
    created_at: "2026-10-30T10:55:32Z",
    completed_at: "2026-10-30T10:55:36Z",
    writes: [],
    hasMoreWrites: false,
    offset: 0,
    evidence: {
      decision: null,
      verification: null,
      events: [
        {
          code: "inverter_clock_check_failed",
          enabled: null,
          reason: null,
          clock: {
            checkedAt: "2026-10-30T10:55:34Z",
            collectedAt: "2026-10-30T10:49:23Z",
            receivedAt: "2026-10-30T10:55:33Z",
            timezone: "Europe/Sofia",
            reportedTime: "2026-10-30 12:55:54",
            skewSeconds: 391,
            maximumSkewSeconds: 120,
          },
        },
      ],
    },
  };
  await page.route(`**/api/activity/${id}*`, (route) =>
    route.fulfill({ json: detail }),
  );
  await page.goto(`/activity/${id}`);
  await expect(
    page.getByText("Inverter clock check failed", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".command-clock-evidence")).toContainText(
    "391 seconds",
  );
  await page.locator(".language-switch select").selectOption("bg");
  await page.setViewportSize({ width: 320, height: 950 });
  await expect(
    page.getByText("Проверката на часовника на инвертора е неуспешна", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".command-clock-evidence")).toContainText(
    "391 секунди",
  );
  await expect(page.locator(".command-clock-evidence")).toContainText(
    "120 секунди",
  );
  await expect(page.locator(".command-clock-evidence")).toContainText(
    "Europe/Sofia",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("outage target slider needs review and explicit confirmation before sending the selected percentage", async ({
  page,
}) => {
  const { outage } = await outageConsoleFixture(page);
  const submissions: unknown[] = [];
  const id = randomUUID();
  await page.route("**/api/outage/prepare", async (route) => {
    submissions.push(route.request().postDataJSON());
    expect(route.request().headers()["idempotency-key"]).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    outage.canPrepare = false;
    outage.canRestore = true;
    outage.preparation = {
      id: randomUUID(),
      state: "queued",
      revision: "1",
      targetSoc: 81,
      normalTargetSoc: 50,
      test: false,
      attendedUntil: null,
      lastVerifiedAt: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
      error: null,
      proof: {},
      approvedAt: null,
      canApprove: false,
    };
    await route.fulfill({
      status: 202,
      json: { id, action: "outage_prepare", status: "queued" },
    });
  });
  await page.route(`**/api/commands/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        action: "outage_prepare",
        status: "succeeded",
        message: "Device settings verified",
      },
    }),
  );
  await page
    .getByRole("link", { name: "Prepare for an outage", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Prepare for an outage", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "80%", exact: true }).click();
  await page.getByRole("slider", { name: /Battery target/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider")).toHaveValue("81");
  expect(submissions).toEqual([]);
  await page
    .getByRole("button", { name: "Review and save", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Confirm battery control" }),
  ).toContainText("Charge and reserve 81%?");
  expect(submissions).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Review and save", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm and apply", exact: true })
    .click();
  await expect
    .poll(() => submissions)
    .toEqual([{ targetSoc: 81, test: false }]);
  await expect(
    page.getByRole("heading", { name: "Preparation requested", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Device settings verified")).toBeVisible();
  await expect(
    page.getByText("Native backup mode supplies", { exact: false }),
  ).toBeVisible();
});

test("saved outage reserve survives a reload and return to normal remains available with stale readings", async ({
  page,
}) => {
  const { overview, outage } = await outageConsoleFixture(page);
  if (overview.latest)
    overview.latest.at = new Date(Date.now() - 86400000).toISOString();
  outage.canPrepare = false;
  outage.canRestore = true;
  outage.preparation = {
    id: randomUUID(),
    state: "active",
    revision: "7",
    targetSoc: 90,
    normalTargetSoc: 50,
    test: false,
    attendedUntil: null,
    lastVerifiedAt: new Date(Date.now() - 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    proof: {},
    approvedAt: null,
    canApprove: false,
  };
  const submissions: unknown[] = [];
  await page.route("**/api/outage/restore", async (route) => {
    submissions.push(route.request().postDataJSON());
    outage.preparation!.state = "restored";
    outage.canRestore = false;
    await route.fulfill({
      status: 202,
      json: {
        id: randomUUID(),
        action: "outage_restore",
        status: "succeeded",
        message: "Normal settings restored",
      },
    });
  });
  await page.goto("/controls/outage");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Outage reserve is set" }),
  ).toBeVisible();
  await expect(
    page.getByText("Live readings are unavailable or old.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Return to normal", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Return to normal", exact: true })
    .click();
  expect(submissions).toEqual([]);
  await page
    .getByRole("button", { name: "Restore normal settings", exact: true })
    .click();
  await expect.poll(() => submissions).toEqual([{ revision: "7" }]);
  await expect(
    page.getByText("Normal settings are restored:", { exact: false }),
  ).toBeVisible();
});

test("outage first-use gate explains supervised validation and never sends a command from navigation", async ({
  page,
}) => {
  const { outage } = await outageConsoleFixture(page);
  outage.canPrepare = false;
  outage.capabilityApproved = false;
  const submissions: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") submissions.push(request.url());
  });
  await page.goto("/controls/outage");
  await expect(
    page.getByRole("button", { name: "Review and save", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Open attended controls", exact: true }),
  ).toHaveAttribute("href", "/controls/commissioning");
  outage.canTest = true;
  await page.reload();
  await page.getByRole("slider").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Review supervised test", exact: true })).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: "Review supervised test", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Review supervised test", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Confirm battery control" }),
  ).toContainText("attended session");
  expect(submissions).toEqual([]);
});

test("an uncertain outage response is not automatically retried or reported as applied", async ({
  page,
}) => {
  await outageConsoleFixture(page);
  let attempts = 0;
  await page.route("**/api/outage/prepare", async (route) => {
    attempts++;
    await route.abort("failed");
  });
  await page.goto("/controls/outage");
  await page
    .getByRole("button", { name: "Review and save", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm and apply", exact: true })
    .click();
  await expect(
    page.getByText("The request may have reached the inverter.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review and save", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Outage reserve is set" }),
  ).toHaveCount(0);
  expect(attempts).toBe(1);
});

test("near-reserve standby explains household grid import in both languages and clears during discharge", async ({
  page,
}) => {
  const data = await homeConsoleFixture(page);
  Object.assign(data.latest!, {
    soc: 53,
    pvW: 0,
    loadW: 2000,
    gridW: 2000,
    batteryW: 0,
    acEnabled: false,
  });
  await page.reload();
  const hint =
    "Near the reserve, the inverter may wait for more charge before using the battery again. Grid import here supplies the home; the battery is idle.";
  await expect(page.getByText(hint, { exact: true })).toBeVisible();
  await page.locator(".language-switch select").selectOption("bg");
  await expect(page.getByText(
    "Близо до резерва инверторът може да изчаква по-висок заряд, преди отново да използва батерията. В този момент мрежата захранва дома, а батерията изчаква.",
    { exact: true },
  )).toBeVisible();
  await page.locator(".language-switch select").selectOption("en");
  Object.assign(data.latest!, { batteryW: 2000, gridW: 0 });
  await page.reload();
  await expect(page.getByText("Battery supplying", { exact: true })).toBeVisible();
  await expect(page.getByText(hint, { exact: true })).toHaveCount(0);
  Object.assign(data.latest!, { soc: 50, batteryW: 0, gridW: 2000 });
  await page.reload();
  await expect(page.getByText(hint, { exact: true })).toHaveCount(0);
});

test("the homeowner console has four navigation items and usable Bulgarian phone layouts", async ({
  page,
}) => {
  await homeConsoleFixture(page);
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }).getByRole("link"),
  ).toHaveCount(4);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ["bg", "en"]) {
      await page
        .getByLabel(language === "bg" ? "Language" : "Език")
        .selectOption(language);
      for (const path of [
        "/",
        "/controls",
        "/analytics",
        "/settings",
        "/controls/setup",
        "/controls/outage",
      ]) {
        await page.goto(path);
        await expect(page.locator("h1")).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          `${width} ${language} ${path}`,
        ).toBe(false);
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Language").selectOption("bg");
  await page
    .getByRole("link", { name: "Подготовка за спиране на тока", exact: true })
    .click();
  await expect(page.getByRole("slider")).toBeVisible();
  await page.screenshot({ path: "test-results/home-charge-mobile-bg.png" });
  await page.goto("/");
  await page.screenshot({
    path: "test-results/home-console-mobile-bg.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: "test-results/home-console-desktop-bg.png",
    fullPage: true,
  });
});

function inverterClockTime(at: string, differenceSeconds: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Sofia",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(Date.parse(at) + differenceSeconds * 1000);
}

test("startup session failures can be retried without signing in again", async ({
  page,
}) => {
  await signIn(page);
  let logins = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/login") logins++;
  });
  for (const failure of ["unavailable", "transport", "invalid-response"]) {
    let checks = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/auth/session", async (route) => {
      checks++;
      if (checks > 1) {
        await gate;
        await route.continue();
      } else if (failure === "transport") await route.abort("failed");
      else if (failure === "invalid-response")
        await route.fulfill({ status: 200, body: "temporarily unavailable" });
      else
        await route.fulfill({
          status: 503,
          json: { error: "Unable to connect" },
        });
    });
    try {
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Unable to check your session" }),
      ).toBeVisible();
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
      await page.setViewportSize({ width: 320, height: 850 });
      await page.getByLabel("Language").selectOption("bg");
      await expect(
        page.getByRole("heading", { name: "Сесията не може да бъде проверена" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (failure === "unavailable")
        await page.screenshot({ path: "test-results/session-retry-mobile-bg.png" });
      await page.getByRole("button", { name: "Опитай отново", exact: true }).click();
      await expect(
        page.getByText("Пространството се зарежда…", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Опитай отново", exact: true }),
      ).toHaveCount(0);
      release();
      await expect(
        page.getByRole("heading", { name: "Всичко е пред теб.", exact: true }),
      ).toBeVisible();
      expect(checks).toBe(2);
      await page.getByLabel("Език").selectOption("en");
      await page.setViewportSize({ width: 1440, height: 1100 });
    } finally {
      release();
      await page.unroute("**/api/auth/session");
    }
  }
  expect(logins).toBe(0);
});

test("a retried expired session shows sign-in and failed checks keep account recovery accessible", async ({
  page,
}) => {
  await signIn(page);
  let checks = 0;
  await page.route("**/api/auth/session", async (route) => {
    checks++;
    await route.fulfill({
      status: checks === 1 ? 503 : 401,
      json: { error: "Unable to connect" },
    });
  });
  await page.reload();
  await page
    .getByRole("link", { name: "Forgot your dashboard password?" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Recover dashboard access", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  expect(checks).toBe(2);
});

test("successful account recovery clears a failed startup check and permits signing in with the new password", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const email = `startup-recovery-${randomUUID()}@example.test`;
  const initial = "startup-recovery-fixture-password";
  const replacement = "startup-recovery-replacement-password";
  const invitation = await privateInvitation(
    page,
    email,
    "Startup recovery fixture",
  );
  const context = await browser.newContext({ baseURL: "http://localhost:3000" });
  try {
    const activated = await context.request.post("/api/auth/activate", {
      headers: { origin: "http://localhost:3000" },
      data: {
        token: new URLSearchParams(new URL(invitation.url).hash.slice(1)).get(
          "token",
        ),
        password: initial,
      },
    });
    expect(activated.status()).toBe(200);
    const session = (await activated.json()) as Session;
    const generated = await context.request.post("/api/security/recovery/key", {
      headers: {
        origin: "http://localhost:3000",
        "x-csrf-token": session.csrfToken,
      },
      data: { currentPassword: initial },
    });
    expect(generated.status()).toBe(200);
    const saved = (await generated.json()) as { key: string };
    await context.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 503, json: { error: "Unable to connect" } }),
    );
    const user = await context.newPage();
    await user.goto(
      "/recover#" + new URLSearchParams({ email, key: saved.key }).toString(),
    );
    await user.getByLabel("New password", { exact: true }).fill(replacement);
    await user
      .getByLabel("Confirm new password", { exact: true })
      .fill(replacement);
    await user
      .getByRole("button", { name: "Reset dashboard password", exact: true })
      .click();
    await expect(
      user.getByText(
        "Password reset completed. All previous browser sessions and recovery credentials are invalid.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      user.getByRole("link", { name: "Back to sign in", exact: true }),
    ).toBeVisible();
    expect((await context.request.get("/api/auth/session")).status()).toBe(401);
    await user
      .getByRole("link", { name: "Back to sign in", exact: true })
      .click();
    await expect(
      user.getByRole("heading", { name: "Welcome back", exact: true }),
    ).toBeVisible();
    await context.unroute("**/api/auth/session");
    await user.getByLabel("Email address", { exact: true }).fill(email);
    await user.getByLabel("Password", { exact: true }).fill(replacement);
    await user.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      user.getByRole("heading", { name: "Your energy, at a glance.", exact: true }),
    ).toBeVisible();
    const remaining = await context.request.get("/api/auth/session");
    expect(remaining.status()).toBe(200);
    expect(((await remaining.json()) as Session).user.id).toBe(session.user.id);
  } finally {
    await context.close();
  }
});

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
        second.getByRole("heading", { name: "Your energy, at a glance.", exact: true }),
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
      `SELECT a.id,a.tenant_id,a.device_sn,a.timezone FROM solarman_accounts a
    JOIN users u ON u.tenant_id=a.tenant_id WHERE lower(u.email)=$1`,
      [process.env.E2E_EMAIL?.toLowerCase()],
    )
  ).rows[0] as {
    id: string;
    tenant_id: string;
    device_sn: string | null;
    timezone: string;
  };
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
    await page.getByRole("link", { name: "History", exact: true }).click();
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: account.timezone,
    });
    await page
      .getByLabel("From date", { exact: true })
      .fill(day.format(times[0]));
    await page.getByLabel("To date", { exact: true }).fill(day.format(times[2]));
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
    ["Automations", "Automations"],
    ["History", "Energy analytics"],
    ["Actions and events", "System activity"],
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
    "Home",
    "Automations",
    "History",
    "Settings",
  ]) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(page.locator("h1")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow, link).toBe(false);
  }
  await page.getByRole("link", { name: "Home", exact: true }).click();
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
  await page.getByRole("link", { name: "Administration", exact: true }).click();
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
      invited.getByRole("heading", { name: "Your energy, at a glance." }),
    ).toBeVisible();
    await expect(
      invited.getByRole("link", { name: "Administration", exact: true }),
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
    ["Начало", "Всичко е пред теб."],
    ["Автоматизации", "Автоматизации"],
    ["История", "Енергийни анализи"],
    ["Действия и събития", "История на системата"],
    ["Настройки", "Настройки на пространството"],
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
  await expect(page.getByRole("alert").filter({ hasText: "SOLARMAN" })).toContainText(
    "SOLARMAN отхвърли заявката (код 2101021)",
  );
  await page.locator(".language-switch select").selectOption("en");
  await expect(page.getByRole("alert").filter({ hasText: "SOLARMAN" })).toContainText(
    "SOLARMAN rejected request (code 2101021)",
  );
  await page.locator(".language-switch select").selectOption("bg");
  await page.getByRole("link", { name: "Автоматизации", exact: true }).click();
  await page.getByRole("link", { name: "Разширено управление и диагностика", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Дозареждане до 50%", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Начало", exact: true }).click();
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
      verificationStatus: {
        state: "missing",
        checkedAt: null,
        expiresAt: null,
      },
      clock: null,
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
      overview.controller.control.verificationStatus = {
        state: "verified",
        checkedAt: now,
        expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      };
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
  await page.reload();
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await page.getByRole("link", { name: "Advanced controls and diagnostics", exact: true }).click();
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
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.locator(".console-reading-time")).toContainText("Recorded");
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await page.getByRole("link", { name: "Advanced controls and diagnostics", exact: true }).click();
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

test("readiness distinguishes failed device checks from a newer passing clock and retains unconfirmed command outcomes", async ({
  page,
}) => {
  await signIn(page);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3600_000).toISOString();
  Object.assign(overview.controller, {
    apiConfigured: true,
    deviceSelected: true,
    profile: "bluesun-bse20kh3",
    paused: true,
    manualTopup: false,
    mode: "error",
    setupError: null,
    error: "Device settings need attention",
  });
  Object.assign(overview.controller.control, {
    serverAllowed: false,
    workspaceEnabled: false,
    canVerify: true,
    canEnable: false,
    canStart: false,
    canStop: true,
    verificationStatus: { state: "failed", checkedAt: old, expiresAt: null },
    verification: {
      checkedAt: old,
      passed: false,
      checks: [
        {
          label: "Inverter rating",
          actual: 20000,
          expected: 20000,
          unit: "W",
          passed: true,
        },
        {
          label: "Inverter clock difference",
          actual: 252,
          expected: 120,
          unit: "s",
          comparison: "at_most",
          passed: false,
        },
      ],
    },
    clock: {
      passed: true,
      skewSeconds: 59,
      reportedTime: inverterClockTime(now, 59),
      collectedAt: now,
      fresh: true,
      maximumSkewSeconds: 120,
    },
    reasons: [
      {
        code: "server",
        message: "The administrator has disabled changes to the inverter",
      },
      {
        code: "verification",
        message: "Verify the inverter settings before enabling control",
      },
      {
        code: "settings",
        message: "Refresh readings to confirm the current control settings",
      },
      {
        code: "workspace",
        message: "Control has not been enabled for this workspace",
      },
    ],
  });
  const actions: string[] = [];
  const id = randomUUID();
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/commands", (route) => {
    const action = (route.request().postDataJSON() as { action: string })
      .action;
    actions.push(action);
    return action === "verify"
      ? route.abort("failed")
      : route.fulfill({ status: 202, json: { id, status: "queued", action } });
  });
  await page.route(`**/api/commands/${id}`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "fixture status temporarily unavailable" },
    }),
  );
  await page.reload();
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await page.getByRole("link", { name: "Advanced controls and diagnostics", exact: true }).click();
  const saved = page.getByRole("region", {
    name: "Saved device verification",
    exact: true,
  });
  const clock = page.getByRole("region", {
    name: "Latest inverter clock check",
    exact: true,
  });
  await expect(saved).toContainText("Device checks failed");
  await expect(clock).toContainText("Within clock tolerance");
  await expect(clock).toContainText("Clock difference: 59 s (maximum 120 s)");
  await expect(clock).toContainText(
    "does not replace a failed or expired device verification",
  );
  await expect(page.locator(".readiness-check.attention")).toContainText(
    "252 seconds",
  );
  await expect(
    page.getByRole("list", { name: "Requirements before starting" }),
  ).toContainText("Handled by Server operator");
  await expect(
    page.getByRole("button", { name: "Enable workspace control", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Stop scheduled top-ups", exact: true }),
  ).toBeEnabled();
  await page
    .locator(".readiness-panel")
    .screenshot({ path: "test-results/readiness-evidence-desktop-en.png" });
  await page
    .getByRole("button", { name: "Refresh diagnostics", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Stop scheduled top-ups now",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(page.locator(".toast")).toContainText(
    "The request was accepted, but its final result is unconfirmed.",
  );
  await expect(
    page.getByRole("link", { name: "Review command result", exact: true }),
  ).toHaveAttribute("href", `/activity/${id}`);
  await page
    .getByRole("button", { name: "Verify device settings", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText(
    "The request outcome is unconfirmed.",
  );
  await expect(
    page.getByRole("link", { name: "Review command result", exact: true }),
  ).toHaveAttribute("href", "/activity");
  expect(actions).toEqual(["refresh", "verify"]);
  await expect(saved).toContainText("Device checks failed");
  await page.locator(".language-switch select").selectOption("bg");
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(
    page.getByRole("region", {
      name: "Запазена проверка на инвертора",
      exact: true,
    }),
  ).toContainText("Има неуспешни проверки");
  await expect(
    page.getByRole("region", {
      name: "Последна проверка на часа",
      exact: true,
    }),
  ).toContainText("Разлика в часа: 59 сек.");
  await expect(page.locator(".toast")).toContainText(
    "Резултатът от заявката не е потвърден",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator(".toast").getByRole("button").click();
  await page.setViewportSize({ width: 320, height: 1100 });
  await page
    .locator(".verification-evidence")
    .screenshot({ path: "test-results/readiness-evidence-mobile-bg.png" });
  overview.controller.control.verification = null;
  overview.controller.control.verificationStatus = {
    state: "missing",
    checkedAt: null,
    expiresAt: null,
  };
  overview.controller.error = "Device command failed (code 530)";
  await page.reload();
  await expect(
    page.getByRole("region", {
      name: "Запазена проверка на инвертора",
      exact: true,
    }),
  ).toContainText("Няма актуална проверка");
  await expect(
    page.getByRole("button", { name: "Разреши управлението", exact: true }),
  ).toBeDisabled();
});

test("expired verification and cached clock evidence need an explicit fresh check without automatically activating control", async ({
  page,
}) => {
  await signIn(page);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const old = new Date(Date.now() - 3600_000).toISOString();
  Object.assign(overview.controller, {
    apiConfigured: true,
    deviceSelected: true,
    profile: "bluesun-bse20kh3",
    paused: true,
    manualTopup: false,
    mode: "paused",
    setupError: null,
    error: null,
  });
  Object.assign(overview.controller.control, {
    serverAllowed: false,
    workspaceEnabled: false,
    canVerify: true,
    canEnable: false,
    canStart: false,
    canStop: true,
    verificationStatus: {
      state: "expired",
      checkedAt: old,
      expiresAt: new Date(Date.now() - 1800_000).toISOString(),
    },
    verification: {
      checkedAt: old,
      passed: true,
      checks: [
        {
          label: "Inverter clock difference",
          actual: 55,
          expected: 120,
          unit: "s",
          comparison: "at_most",
          passed: true,
        },
      ],
    },
    clock: {
      passed: true,
      skewSeconds: 55,
      reportedTime: inverterClockTime(old, 55),
      collectedAt: old,
      fresh: false,
      maximumSkewSeconds: 120,
    },
    reasons: [
      {
        code: "server",
        message: "The administrator has disabled changes to the inverter",
      },
      {
        code: "verification",
        message: "Verify the inverter settings before enabling control",
      },
      {
        code: "clock_refresh",
        message: "Refresh readings to confirm the current inverter clock",
      },
      {
        code: "workspace",
        message: "Control has not been enabled for this workspace",
      },
    ],
  });
  const actions: string[] = [];
  const id = randomUUID();
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/commands", (route) => {
    const action = (route.request().postDataJSON() as { action: string })
      .action;
    actions.push(action);
    if (action === "verify") {
      const now = new Date().toISOString();
      overview.controller.control.verificationStatus = {
        state: "verified",
        checkedAt: now,
        expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      };
      const report = overview.controller.control.verification!;
      report.checkedAt = now;
      overview.controller.control.clock!.collectedAt = now;
      overview.controller.control.clock!.reportedTime = inverterClockTime(
        now,
        55,
      );
      overview.controller.control.clock!.fresh = true;
      overview.controller.control.reasons =
        overview.controller.control.reasons.filter((reason) =>
          ["server", "workspace"].includes(reason.code),
        );
    }
    return route.fulfill({
      status: 202,
      json: { id, status: "queued", action },
    });
  });
  await page.route(`**/api/commands/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        status: "succeeded",
        action: actions.at(-1),
        message: "Device settings verified",
      },
    }),
  );
  await page.reload();
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await page.getByRole("link", { name: "Advanced controls and diagnostics", exact: true }).click();
  const saved = page.getByRole("region", {
    name: "Saved device verification",
    exact: true,
  });
  const clock = page.getByRole("region", {
    name: "Latest inverter clock check",
    exact: true,
  });
  await expect(saved).toContainText("Verification expired");
  await expect(saved).toContainText("30-minute activation window");
  await expect(clock).toContainText("Clock evidence expired");
  await page
    .getByRole("button", { name: "Refresh diagnostics", exact: true })
    .click();
  await expect(page.locator(".toast")).toHaveClass(/success/);
  await expect(saved).toContainText("Verification expired");
  await expect(clock).toContainText("Clock evidence expired");
  await page
    .getByRole("button", { name: "Verify device settings", exact: true })
    .click();
  await expect(saved).toContainText("Device checks passed");
  await expect(clock).toContainText("Within clock tolerance");
  await expect(
    page.getByRole("button", { name: "Enable workspace control", exact: true }),
  ).toBeDisabled();
  expect(actions).toEqual(["refresh", "verify"]);
  await page.locator(".language-switch select").selectOption("bg");
  await expect(saved).toHaveCount(0);
  await expect(
    page.getByRole("region", {
      name: "Запазена проверка на инвертора",
      exact: true,
    }),
  ).toContainText("Валидна за активиране до:");
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
  await page.locator(".api-budget-disclosure > summary").click();
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
  await page.getByRole("link", { name: "Автоматизации", exact: true }).click();
  await page.getByRole("link", { name: "Разширено управление и диагностика", exact: true }).click();
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
  await page.goto("/controls/advanced");
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
  await page.goto("/controls/advanced");
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
  await page.getByRole("link", { name: "Начало", exact: true }).click();
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
    await page.getByRole("link", { name: "History", exact: true }).click();
    await page.getByRole("link", { name: "Actions and events", exact: true }).click();
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
  await page.goto("/settings");
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
      user.getByRole("heading", { name: "Your energy, at a glance.", exact: true }),
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
      user.getByRole("heading", { name: "Всичко е пред теб.", exact: true }),
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
  await page.getByRole("link", { name: "Administration", exact: true }).click();
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
      user.getByRole("heading", { name: "Your energy, at a glance.", exact: true }),
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
      user.getByRole("heading", { name: "Your energy, at a glance.", exact: true }),
    ).toBeVisible();
    release();
    await finished;
    await expect(
      user.getByRole("link", { name: "Administration", exact: true }),
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
      page.getByRole("link", { name: "Administration", exact: true }),
    ).toBeVisible();
  } finally {
    release();
    if (intercepted) await finished;
    await context.close();
  }
});

test("workspace suspension and resumption preserve member access and require separate control activation in Bulgarian", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const owner = (await (
    await page.request.get("/api/auth/session")
  ).json()) as Session;
  const name = `Lifecycle browser ${Date.now()}`;
  const invited = await page.request.post("/api/admin/invitations", {
    headers: {
      origin: "http://localhost:3000",
      "x-csrf-token": owner.csrfToken,
    },
    data: {
      email: `lifecycle-browser-${randomUUID()}@example.test`,
      tenantName: name,
    },
  });
  expect(invited.status()).toBe(201);
  const link = (await invited.json()) as { url: string };
  const memberContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  try {
    const activated = await memberContext.request.post("/api/auth/activate", {
      headers: { origin: "http://localhost:3000" },
      data: {
        token: new URLSearchParams(new URL(link.url).hash.slice(1)).get(
          "token",
        ),
        password: "lifecycle-browser-fixture-password",
      },
    });
    expect(activated.status()).toBe(200);
    const memberSession = (await activated.json()) as Session;
    const member = await memberContext.newPage();
    await member.goto("/settings");
    await expect(
      member.getByRole("heading", { name: "Workspace settings", exact: true }),
    ).toBeVisible();
    await page.goto("/workspaces");
    await page
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("button", { name: "Manage workspace", exact: true })
      .click();
    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await panel
      .getByLabel("Current dashboard password", { exact: true })
      .fill("incorrect-password");
    await panel
      .getByRole("button", { name: "Suspend workspace", exact: true })
      .click();
    await expect(
      panel.getByText("Current password is incorrect", { exact: true }),
    ).toBeVisible();
    await page.locator(".language-switch select").selectOption("bg");
    await page.setViewportSize({ width: 320, height: 1000 });
    await panel
      .getByLabel("Текуща парола за таблото", { exact: true })
      .fill(process.env.E2E_PASSWORD!);
    await panel
      .getByLabel("Съобщение до членовете на пространството", { exact: true })
      .fill("Проверка на достъпа за тестовото пространство.");
    await panel
      .getByRole("button", { name: "Спри пространството", exact: true })
      .click();
    await expect(
      panel.getByText(
        "Пространството е спряно. Заявките за стартиране на автоматизация са отменени; премахването на разрешението за зареждане има отделно състояние.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      panel.getByLabel("Текуща парола за таблото", { exact: true }),
    ).toHaveValue("");
    await page.screenshot({
      path: "test-results/workspace-suspension-mobile-bg.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await member.reload();
    await member.locator(".language-switch select").selectOption("bg");
    await member.setViewportSize({ width: 320, height: 1000 });
    await expect(
      member
        .getByText(
          "Наблюдението, износът на данни, сигурността на акаунта и възстановяването остават достъпни. Стартирането на автоматизация не е достъпно.",
        )
        .first(),
    ).toBeVisible();
    await expect(
      member
        .getByText("Проверка на достъпа за тестовото пространство.")
        .first(),
    ).toBeVisible();
    const denied = await member.request.post("/api/commands", {
      headers: {
        origin: "http://localhost:3000",
        "x-csrf-token": memberSession.csrfToken,
        "idempotency-key": randomUUID(),
      },
      data: { action: "topup" },
    });
    expect(denied.status()).toBe(409);
    expect((await member.request.get("/api/security")).status()).toBe(200);
    expect((await member.request.get("/api/overview")).status()).toBe(200);
    expect(
      await member.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await member.screenshot({
      path: "test-results/suspended-workspace-mobile-bg.png",
      fullPage: true,
    });
    // The mutation commits but its response is lost. The UI must show uncertainty and fetch the actual state.
    await page.route(
      `**/api/admin/tenants/${memberSession.tenant.id}/lifecycle`,
      async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        await route.fetch();
        await route.abort("failed");
      },
    );
    await panel
      .getByLabel("Текуща парола за таблото", { exact: true })
      .fill(process.env.E2E_PASSWORD!);
    await panel
      .getByRole("button", {
        name: "Направи пространството достъпно",
        exact: true,
      })
      .click();
    await expect(
      panel.getByText(
        "Промяната на пространството не е потвърдена. Обновете състоянието му, преди да опитате отново.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Спри пространството", exact: true }),
    ).toBeVisible();
    const actual = (await (
      await member.request.get("/api/workspace/lifecycle")
    ).json()) as { state: string; events: { state: string }[] };
    expect(actual.state).toBe("active");
    expect(actual.events.map((e) => e.state)).toEqual(["active", "suspended"]);
    const overview = (await (
      await member.request.get("/api/overview")
    ).json()) as OverviewData;
    expect(overview.controller.paused).toBe(true);
    expect(overview.controller.control.workspaceEnabled).toBe(false);
    expect(overview.controller.control.verification).toBeNull();
    await member.reload();
    await member.locator("summary").filter({ hasText: "Състояние на пространството" }).click();
    await expect(
      member.getByText("Пространството е достъпно", { exact: true }),
    ).toBeVisible();
  } finally {
    await memberContext.close();
  }
});

test("workspace archives download complete data and retention changes remain explicit and recoverable in Bulgarian", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const owner = (await (
    await page.request.get("/api/auth/session")
  ).json()) as Session;
  const invite = await page.request.post("/api/admin/invitations", {
    headers: {
      origin: "http://localhost:3000",
      "x-csrf-token": owner.csrfToken,
    },
    data: {
      email: `data-browser-${randomUUID()}@example.test`,
      tenantName: "Workspace data browser fixture",
    },
  });
  expect(invite.status()).toBe(201);
  const link = (await invite.json()) as { url: string };
  const context = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  const secret = "workspace-data-browser-fixture-password";
  try {
    const activated = await context.request.post("/api/auth/activate", {
      headers: { origin: "http://localhost:3000" },
      data: {
        token: new URLSearchParams(new URL(link.url).hash.slice(1)).get(
          "token",
        ),
        password: secret,
      },
    });
    expect(activated.status()).toBe(200);
    const member = await context.newPage();
    const urls: string[] = [];
    member.on("request", (request) => urls.push(request.url()));
    await member.goto("/settings");
    await member
      .getByRole("link", { name: "Data and privacy", exact: true })
      .click();
    await expect(
      member.getByRole("heading", { name: "Workspace archive", exact: true }),
    ).toBeVisible();
    await member
      .getByLabel("Dashboard password for the archive", { exact: true })
      .fill(secret);
    await member
      .getByLabel("Reading retention in days", { exact: true })
      .fill("90");
    await member
      .getByLabel("Activity retention in days", { exact: true })
      .fill("180");
    await member.locator(".language-switch select").selectOption("bg");
    await expect(
      member.getByLabel("Срок за показанията в дни", { exact: true }),
    ).toHaveValue("90");
    await expect(
      member.getByLabel("Парола за таблото за изтегляне на архив", {
        exact: true,
      }),
    ).toHaveValue(secret);
    const [download] = await Promise.all([
      member.waitForEvent("download"),
      member
        .getByRole("button", {
          name: "Изтегли архив на пространството",
          exact: true,
        })
        .click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^solarman-workspace-\d{4}-\d{2}-\d{2}\.ndjson$/,
    );
    const path = await download.path();
    expect(path).not.toBeNull();
    const archive = readFileSync(path!, "utf8");
    const rows = archive
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { type: string; counts?: Record<string, number> },
      );
    expect(rows[0].type).toBe("manifest");
    expect(rows.at(-1)?.type).toBe("complete");
    expect(rows.at(-1)?.counts?.members).toBe(1);
    expect(archive).not.toContain(secret);
    expect(archive).not.toContain("token_hash");
    expect(archive).not.toContain("password_hash");
    expect(urls.some((url) => url.includes(secret))).toBe(false);
    await expect(
      member.getByText("Архивът е проверен. Проверете изтеглянията в браузъра.", {
        exact: true,
      }),
    ).toBeVisible();
    const before = (await (
      await member.request.get("/api/workspace/retention")
    ).json()) as { enabled: boolean; revision: string };
    expect(before.enabled).toBe(false);
    expect(before.revision).toBe("0");
    await member
      .getByLabel("Автоматично почистване", { exact: true })
      .selectOption("true");
    await member
      .getByLabel("Парола за таблото за промяна на съхранението", {
        exact: true,
      })
      .fill("wrong-password");
    await member
      .getByRole("button", {
        name: "Запази правилата за съхранение",
        exact: true,
      })
      .click();
    await expect(
      member.getByText("Текущата парола е неправилна", { exact: true }),
    ).toBeVisible();
    await member.route("**/api/workspace/retention", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fetch();
      await route.abort("failed");
    });
    await member
      .getByLabel("Парола за таблото за промяна на съхранението", {
        exact: true,
      })
      .fill(secret);
    await member
      .getByRole("button", {
        name: "Запази правилата за съхранение",
        exact: true,
      })
      .click();
    await expect(
      member.getByText(
        "Промяната на съхранението не е потвърдена. Заредете запазените правила, преди да опитате отново.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      member.getByRole("button", {
        name: "Запази правилата за съхранение",
        exact: true,
      }),
    ).toBeDisabled();
    await member
      .getByRole("button", { name: "Зареди запазените правила", exact: true })
      .click();
    await expect(
      member.getByLabel("Автоматично почистване", { exact: true }),
    ).toHaveValue("true");
    await expect(
      member.getByLabel("Срок за показанията в дни", { exact: true }),
    ).toHaveValue("90");
    await member.unroute("**/api/workspace/retention");
    await member
      .getByLabel("Автоматично почистване", { exact: true })
      .selectOption("false");
    await member
      .getByLabel("Парола за таблото за промяна на съхранението", {
        exact: true,
      })
      .fill(secret);
    await member
      .getByRole("button", {
        name: "Запази правилата за съхранение",
        exact: true,
      })
      .click();
    await expect(
      member.getByText("Правилата за съхранение са запазени.", { exact: true }),
    ).toBeVisible();
    await member.setViewportSize({ width: 320, height: 1000 });
    expect(
      await member.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await member
      .locator(".workspace-data-grid")
      .screenshot({ path: "test-results/workspace-data-mobile-bg.png" });
    const after = (await (
      await member.request.get("/api/workspace/retention")
    ).json()) as { enabled: boolean; revision: string; events: unknown[] };
    expect(after.enabled).toBe(false);
    expect(after.revision).toBe("2");
    expect(after.events).toHaveLength(2);
  } finally {
    await context.close();
  }
});

test("an incomplete archive never triggers a successful file download", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/data");
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.route("**/api/workspace/archive", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: '{"type":"manifest","version":1}\n{"type":"record","section":"workspace","data":{}}\n',
    }),
  );
  await page
    .getByLabel("Dashboard password for the archive", { exact: true })
    .fill("archive-fixture-password");
  await page
    .getByRole("button", { name: "Download workspace archive", exact: true })
    .click();
  await expect(
    page.getByText("Archive verification failed. Download it again.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(downloads).toBe(0);
  await expect(
    page.getByLabel("Dashboard password for the archive", { exact: true }),
  ).toHaveValue("");
});

test("workspace closure uses real cookies, reports a lost response and permits cancellation into suspension", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const owner = (await (
    await page.request.get("/api/auth/session")
  ).json()) as Session;
  const name = `Closure browser ${randomUUID()}`;
  const email = `closure-browser-${randomUUID()}@example.test`;
  const memberPassword = "closure-browser-fixture-password";
  const invited = await page.request.post("/api/admin/invitations", {
    headers: {
      origin: "http://localhost:3000",
      "x-csrf-token": owner.csrfToken,
    },
    data: { email, tenantName: name },
  });
  expect(invited.status()).toBe(201);
  const link = (await invited.json()) as { url: string };
  const context = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  try {
    const activation = await context.request.post("/api/auth/activate", {
      headers: { origin: "http://localhost:3000" },
      data: {
        token: new URLSearchParams(new URL(link.url).hash.slice(1)).get(
          "token",
        ),
        password: memberPassword,
      },
    });
    expect(activation.status()).toBe(200);
    const child = (await activation.json()) as Session;
    const member = await context.newPage();
    await member.goto("/settings/data");
    await expect(
      member.getByRole("heading", { name: "Workspace data", exact: true }),
    ).toBeVisible();
    await page.goto("/workspaces");
    await page
      .getByRole("row")
      .filter({ hasText: owner.tenant.name })
      .getByRole("button", { name: "Manage workspace", exact: true })
      .click();
    const protectedPanel = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", {
          name: owner.tenant.name,
          exact: true,
        }),
      });
    await expect(
      protectedPanel.getByRole("heading", {
        name: "Close or remove this workspace",
        exact: true,
      }),
    ).toHaveCount(0);
    await protectedPanel
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("button", { name: "Manage workspace", exact: true })
      .click();
    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await page.route(
      `**/api/admin/tenants/${child.tenant.id}/offboarding`,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const action = (route.request().postDataJSON() as { action: string })
          .action;
        if (action !== "close") return route.continue();
        const result = await route.fetch();
        expect(result.status()).toBe(200);
        await route.abort("failed");
      },
    );
    await page.locator(".language-switch select").selectOption("bg");
    await panel
      .getByLabel("Парола за таблото при закриване", { exact: true })
      .fill(process.env.E2E_PASSWORD!);
    await panel
      .getByLabel("Въведи името на пространството за потвърждение", {
        exact: true,
      })
      .fill(name);
    await panel
      .getByRole("button", {
        name: "Заяви закриване на пространството",
        exact: true,
      })
      .click();
    await expect(panel).toContainText(
      "Промяната на закриването не е потвърдена.",
    );
    await expect(panel).toContainText("Готово за разрешаване на изтриването");
    expect((await context.request.get("/api/auth/session")).status()).toBe(401);
    await member.reload();
    await member.getByLabel("Email address", { exact: true }).fill(email);
    await member.getByLabel("Password", { exact: true }).fill(memberPassword);
    await member.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      member.getByText("Workspace closing", { exact: true }),
    ).toHaveCount(1);
    await panel
      .getByLabel("Парола за таблото при закриване", { exact: true })
      .fill(process.env.E2E_PASSWORD!);
    await panel
      .getByLabel("Въведи името на пространството за потвърждение", {
        exact: true,
      })
      .fill(name);
    await panel
      .getByLabel(
        "Необходимите данни са изтеглени. Разрешавам окончателното изтриване на това пространство.",
        { exact: true },
      )
      .check();
    await expect(
      panel.getByRole("button", {
        name: "Разреши окончателното изтриване",
        exact: true,
      }),
    ).toBeDisabled();
    await panel
      .getByRole("button", {
        name: "Отмени закриването и остави пространството спряно",
        exact: true,
      })
      .click();
    await expect(panel).toContainText("Няма заявено закриване");
    const overview = (await (
      await context.request.get("/api/overview")
    ).json()) as OverviewData;
    expect(overview.controller.paused).toBe(true);
    expect(overview.controller.control.workspaceEnabled).toBe(false);
    await page.setViewportSize({ width: 320, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("workspace erasure UI requires consent, tracks receipts and exposes private recovery health in Bulgarian", async ({
  page,
}) => {
  await signIn(page);
  const id = randomUUID();
  const now = new Date().toISOString();
  const name = "Isolated erasure interface";
  const item: TenantMetadata = {
    id,
    name,
    created_at: now,
    members: 1,
    connection_status: "connected",
    lifecycle: "offboarding",
    revision: "3",
    protected: false,
    cleanup_pending: true,
  };
  const lifecycle: TenantLifecycleStatus = {
    state: "offboarding",
    revision: "3",
    changedAt: now,
    message: "",
    protected: false,
    cleanupPending: true,
    events: [],
  };
  const status: OffboardingStatus = {
    id: randomUUID(),
    state: "offboarding",
    requestedAt: now,
    authorizedAt: null,
    acknowledgedAt: null,
    startedAt: null,
    completedAt: null,
    processedRows: 0,
    lastFailedAt: null,
    cleanupPending: true,
    receiptService: true,
    receiptReady: false,
    phase: "cleanup",
  };
  await page.route("**/api/admin/tenants", (route) =>
    route.fulfill({ json: { items: [item] } }),
  );
  await page.route(`**/api/admin/tenants/${id}/lifecycle`, (route) =>
    route.fulfill({ json: lifecycle }),
  );
  const actions: {
    action: string;
    consent: boolean;
    confirmed: boolean;
    reauthenticated: boolean;
  }[] = [];
  await page.route(
    `**/api/admin/tenants/${id}/offboarding/recovery`,
    (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body.action).toBe("repair");
      expect(Boolean(body.currentPassword === process.env.E2E_PASSWORD)).toBe(
        true,
      );
      expect(
        Boolean(
          body.appId === "fixture-app" && body.appSecret === "fixture-secret",
        ),
      ).toBe(true);
      status.cleanupPending = false;
      status.phase = "ready";
      lifecycle.cleanupPending = false;
      actions.push({
        action: "repair",
        consent: false,
        confirmed: true,
        reauthenticated: true,
      });
      return route.fulfill({ json: status });
    },
  );
  await page.route(`**/api/admin/tenants/${id}/offboarding`, (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      actions.push({
        action: String(body.action),
        consent: body.eraseConfirmed === true,
        confirmed: body.confirmation === name,
        reauthenticated: body.currentPassword === process.env.E2E_PASSWORD,
      });
      status.authorizedAt = now;
      status.phase = "awaiting-receipt";
      lifecycle.revision = "4";
    }
    return route.fulfill({ json: status });
  });
  await page.goto("/workspaces");
  await page
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("button", { name: "Manage workspace", exact: true })
    .click();
  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(
    panel.getByRole("button", {
      name: "Authorize permanent erasure",
      exact: true,
    }),
  ).toBeDisabled();
  await panel
    .getByLabel("Dashboard password for closure recovery", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await panel
    .getByText("Repair provider access for cleanup", { exact: true })
    .click();
  await panel
    .getByLabel("Original SOLARMAN account email", { exact: true })
    .fill("cleanup-provider@example.test");
  await panel
    .getByLabel("SOLARMAN password for closure recovery", { exact: true })
    .fill("fixture-provider-password");
  await panel
    .getByText("OpenAPI credentials for cleanup", { exact: true })
    .click();
  await panel.getByLabel("App ID", { exact: true }).fill("fixture-app");
  await panel.getByLabel("App Secret", { exact: true }).fill("fixture-secret");
  await panel
    .getByRole("button", { name: "Test repaired provider access", exact: true })
    .click();
  await expect(panel).toContainText("Ready for erasure authorization");
  await expect(
    panel.getByLabel("SOLARMAN password for closure recovery", { exact: true }),
  ).toHaveCount(0);
  await panel
    .getByLabel("Dashboard password for closure", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await panel
    .getByLabel("Type the workspace name to confirm", { exact: true })
    .fill(name);
  await panel
    .getByLabel("Dashboard password for closure", { exact: true })
    .press("Enter");
  expect(actions.map((a) => a.action)).toEqual(["repair"]);
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    panel.getByLabel("Въведи името на пространството за потвърждение", {
      exact: true,
    }),
  ).toHaveValue(name);
  await panel
    .getByLabel(
      "Необходимите данни са изтеглени. Разрешавам окончателното изтриване на това пространство.",
      { exact: true },
    )
    .check();
  await panel
    .getByRole("button", {
      name: "Разреши окончателното изтриване",
      exact: true,
    })
    .click();
  await expect(panel).toContainText(
    "Изчаква се проверено потвърждение извън сървъра",
  );
  expect(actions[1]).toEqual({
    action: "erase",
    consent: true,
    confirmed: true,
    reauthenticated: true,
  });
  await expect(
    panel.getByRole("button", {
      name: "Отмени закриването и остави пространството спряно",
      exact: true,
    }),
  ).toHaveCount(0);
  status.acknowledgedAt = now;
  status.receiptReady = true;
  status.phase = "erasing";
  status.startedAt = now;
  status.processedRows = 500;
  await panel
    .getByRole("button", {
      name: "Обнови състоянието на закриването",
      exact: true,
    })
    .click();
  await expect(panel).toContainText("Записите на пространството се изтриват");
  status.phase = "removed";
  status.state = "removed";
  status.completedAt = now;
  lifecycle.state = "removed";
  lifecycle.revision = "5";
  item.name = "Removed workspace";
  item.lifecycle = "removed";
  item.members = 0;
  await panel
    .getByRole("button", {
      name: "Обнови състоянието на закриването",
      exact: true,
    })
    .click();
  const removed = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "Пространството е изтрито",
        exact: true,
      }),
    });
  await expect(removed).toContainText("Пространството е изтрито");
  const download = page.waitForEvent("download");
  await removed
    .getByRole("button", {
      name: "Изтегли потвърждението за изтриване",
      exact: true,
    })
    .click();
  const file = await download;
  const stream = await file.createReadStream();
  if (!stream) throw new Error("Fixture receipt download is unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
    version: 1,
    id: status.id,
    tenantId: id,
    authorizedAt: now,
  });
  const health = (await (
    await page.request.get("/api/operations")
  ).json()) as OperationsData;
  health.erasure = { state: "verified", checkedAt: now, receipts: 1 };
  await page.route("**/api/operations?*", (route) =>
    route.fulfill({ json: health }),
  );
  await page.goto("/settings/health");
  const protection = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "Защита при възстановяване на изтрити акаунти",
        exact: true,
      }),
    });
  await expect(protection).toContainText(
    "Потвържденията извън сървъра са синхронизирани",
  );
  health.erasure.state = "stale";
  await page.reload();
  await expect(protection).toContainText(
    "Синхронизацията на потвържденията е просрочена",
  );
  health.erasure.state = "unavailable";
  health.erasure.checkedAt = null;
  health.erasure.receipts = null;
  await page.reload();
  await expect(protection).toContainText(
    "Състоянието на защитата при възстановяване е недостъпно",
  );
  await page.setViewportSize({ width: 320, height: 1000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await protection.screenshot({
    path: "test-results/erasure-health-mobile-bg.png",
  });
});

test("policy observations explain the real empty state without sending inverter commands", async ({
  page,
}) => {
  await signIn(page);
  let commands = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/commands" &&
      request.method() === "POST"
    )
      commands++;
  });
  await page.goto("/controls/advanced");
  await page
    .getByRole("link", { name: "Observe the home policy", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Observe the home policy", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start observations", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "No observation run yet. Verify the device in Controls, then record its normal behavior through daylight and night.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reload observation status", exact: true })
    .click();
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByRole("button", { name: "Започни наблюдение", exact: true }),
  ).toBeDisabled();
  expect(commands).toBe(0);
  await page.setViewportSize({ width: 320, height: 1000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("policy observations preserve an unknown start, distinguish physical signals from limits and retain invalidated history in Bulgarian", async ({
  page,
}) => {
  await signIn(page);
  const now = new Date().toISOString();
  const account = randomUUID(),
    runId = randomUUID();
  const identity = {
    accountId: account,
    device: "observation-interface-fixture",
    profile: "bluesun-bse20kh3",
    model: "BSE20KH3",
    timezone: "Europe/Sofia",
    mapping: "bluesun-bse20kh3/2.02",
    policy: "reserve-50/ac-2kw/solar-100/v1",
    firmware: { protocol: "2.02", dsp: "1.57", hmi: "1.45" },
  };
  const empty = { count: 0, first: null, last: null, observedAt: null };
  const run: PolicyObservationRun = {
    id: runId,
    state: "observing",
    reason: null,
    startedAt: now,
    endedAt: null,
    checkedAt: null,
    failedAt: null,
    identity,
    verification: { checkedAt: now, passed: true, checks: [] },
    currentBinding: true,
    progress: {
      version: 1,
      accepted: 0,
      rejected: 0,
      firstAt: null,
      last: null,
      coveredSeconds: 0,
      solarSeen: false,
      nightSeen: false,
      approach: null,
      solar: { ...empty },
      discharge: { ...empty },
      gridCharge: { ...empty },
      gridStop: { ...empty },
    },
    window: { spanSeconds: 0, coverage: 0, cycleObserved: false },
  };
  const data: PolicyObservationData = {
    canStart: true,
    activeRunId: null,
    identity,
    run: null,
    history: [],
  };
  let firstStart = true;
  const actions: string[] = [];
  await page.route("**/api/policy-observations*", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        action: string;
        id?: string;
      };
      actions.push(body.action);
      expect(Boolean(route.request().headers()["x-csrf-token"])).toBe(true);
      if (body.action === "start") {
        data.activeRunId = runId;
        data.run = run;
        data.history = [
          {
            id: runId,
            state: "observing",
            reason: null,
            started_at: now,
            ended_at: null,
          },
        ];
        if (firstStart) {
          firstStart = false;
          return route.abort("failed");
        }
      } else if (body.action === "check") {
        expect(body.id).toBe(runId);
        const first = {
          id: "1",
          at: now,
          receivedAt: now,
          samplingSeconds: 300,
          soc: 51,
          pvW: 2500,
          loadW: 1000,
          gridW: 0,
          batteryW: -1400,
          source: "provider" as const,
        };
        const last = {
          ...first,
          id: "2",
          at: new Date(Date.parse(now) + 300000).toISOString(),
          soc: 52,
        };
        run.checkedAt = now;
        run.progress.accepted = 2;
        run.progress.firstAt = now;
        run.progress.last = last;
        run.progress.solar = { count: 2, first, last, observedAt: last.at };
        run.window = { spanSeconds: 300, coverage: 1, cycleObserved: false };
      } else if (body.action === "stop") {
        expect(body.id).toBe(runId);
        run.state = "stopped";
        run.endedAt = now;
        data.activeRunId = null;
        data.history[0]!.state = "stopped";
      }
    }
    return route.fulfill({ json: data });
  });
  await page.goto("/controls/observations");
  await page.locator(".language-switch select").selectOption("bg");
  await page
    .getByRole("button", { name: "Започни наблюдение", exact: true })
    .click();
  await expect(
    page.getByText(
      "Промяната на наблюдението не е потвърдена. Обнови състоянието му, преди да опиташ отново.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Приключи наблюдението", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Започни наблюдение", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Провери запазените данни", exact: true })
    .click();
  await expect(
    page.getByText("1 от 5 признака в наблюдението", { exact: true }),
  ).toBeVisible();
  const barDimensions = await page
    .locator(".observation-progress .coverage-track")
    .evaluate((track) => {
      const fill = track.firstElementChild?.getBoundingClientRect();
      return {
        trackWidth: track.getBoundingClientRect().width,
        fillWidth: fill?.width ?? 0,
        fillHeight: fill?.height ?? 0,
      };
    });
  expect(barDimensions.fillWidth).toBeCloseTo(barDimensions.trackWidth * 0.2, 0);
  expect(barDimensions.fillHeight).toBeGreaterThan(0);
  await expect(
    page.getByRole("progressbar", { name: "Наблюдавано поведение на батерията" }),
  ).toHaveAttribute("aria-valuenow", "1");
  await expect(
    page.getByText("2 приети отчета", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Соларното зареждане следва ограниченията на инвертора и батерията до целеви заряд от 100%.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByText("Покажи отчетените стойности", { exact: true })
    .first()
    .click();
  await expect(
    page.locator(".observation-readings table tbody tr"),
  ).toHaveCount(2);
  await expect(page.locator(".observation-readings")).toContainText("-1400");
  run.currentBinding = null;
  await page
    .getByRole("button", {
      name: "Обнови състоянието на наблюдението",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Текущата идентичност на устройството е недостъпна. Записаните данни се запазват, без да се приема, че конфигурацията е променена.",
      { exact: true },
    ),
  ).toBeVisible();
  run.currentBinding = true;
  await page
    .getByRole("button", { name: "Приключи наблюдението", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Приключи наблюдението", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("1 от 5 признака в наблюдението", { exact: true }),
  ).toBeVisible();
  run.state = "invalidated";
  run.reason = "binding_changed";
  run.currentBinding = false;
  data.canStart = false;
  data.history[0]!.state = "invalidated";
  await page
    .getByRole("button", {
      name: "Обнови състоянието на наблюдението",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Устройството или фърмуерът са променени. Тези данни се отнасят за предишната конфигурация.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Виж наблюдението", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp("run=" + runId));
  await page.setViewportSize({ width: 320, height: 1100 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/policy-observations-mobile-bg.png",
    fullPage: true,
  });
  expect(actions).toEqual(["start", "check", "stop"]);
});

test("commissioning separates preparation from attended controls, keeps Stop available and covers unconfirmed changes in Bulgarian on mobile", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await signIn(page);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const now = new Date().toISOString();
  const identity = {
    accountId: randomUUID(),
    device: "commissioning-browser-inverter",
    profile: "bluesun-bse20kh3",
    model: "BSE20KH3",
    timezone: "Europe/Sofia",
    mapping: "browser-fixture",
    policy: "browser-fixture",
    firmware: { protocol: "2.02", dsp: "1.57", hmi: "1.45" },
  };
  const verification = {
    checkedAt: now,
    passed: true,
    checks: [],
    firmware: identity.firmware,
  };
  overview.controller.control = {
    ...overview.controller.control,
    canCommission: true,
    canStart: false,
    canEnable: false,
    canStop: true,
    serverAllowed: true,
    workspaceEnabled: false,
    verification,
    verificationStatus: {
      state: "verified",
      checkedAt: now,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    },
    commissioning: {
      id: null,
      state: "missing",
      approved: false,
      attended: false,
      attendedUntil: null,
    },
  };
  overview.latest = {
    at: now,
    receivedAt: now,
    source: "provider",
    samplingSeconds: 300,
    soc: 30,
    pvW: 0,
    loadW: 1000,
    gridW: 3000,
    batteryW: -1942,
    temperatureC: 18,
    acEnabled: false,
  };
  const data: CommissioningData = {
    canPrepare: true,
    attendedMinutes: 30,
    availableObservation: null,
    recoveryCommands: [],
    identity,
    run: null,
    history: [],
  };
  const mutations: string[] = [];
  const commands: string[] = [];
  let loseCreate = true;
  let running: Command | null = null;
  await page.route("**/api/overview", async (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/commissioning", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        action: string;
        currentPassword: string;
        attending?: boolean;
      };
      expect(body.currentPassword).toBe("browser-fixture-password");
      expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
      mutations.push(body.action);
      if (body.action === "create") {
        const id = randomUUID();
        data.run = {
          id,
          state: "preparing",
          revision: "1",
          createdAt: now,
          updatedAt: now,
          attendedUntil: null,
          currentBinding: true,
          identity,
          verification,
          evidence: {},
          events: [{ action: "created", revision: "1", created_at: now }],
          requirements: (
            [
              "solar",
              "discharge",
              "gridCharge",
              "gridStop",
              "dayNight",
              "recovery",
            ] as const
          ).map((code) => ({ code, passed: false })),
        };
        data.history = [
          {
            id,
            state: "preparing",
            created_at: now,
            ended_at: null,
            reason: null,
          },
        ];
        if (loseCreate) {
          loseCreate = false;
          return route.abort("failed");
        }
      } else if (body.action === "attend" && data.run) {
        expect(body.attending).toBe(true);
        data.run.state = "attending";
        data.run.revision = "2";
        data.run.attendedUntil = new Date(Date.now() + 1800000).toISOString();
        overview.controller.control.commissioning = {
          id: data.run.id,
          state: "attending",
          approved: false,
          attended: true,
          attendedUntil: data.run.attendedUntil,
        };
      }
    }
    return route.fulfill({ json: data });
  });
  await page.route("**/api/commands", async (route) => {
    const body = route.request().postDataJSON() as { action: string };
    commands.push(body.action);
    const job: Command = {
      id: randomUUID(),
      actor: "Browser fixture",
      action: body.action,
      status: body.action === "commission_topup" ? "running" : "succeeded",
      message: null,
      created_at: now,
      completed_at: now,
    };
    if (body.action === "commission_controls")
      overview.controller.control.workspaceEnabled = true;
    if (body.action === "commission_topup") running = job;
    return route.fulfill({ status: 202, json: job });
  });
  await page.route("**/api/commands/*", async (route) =>
    route.fulfill({ json: running }),
  );
  await page.goto("/controls/commissioning");
  await expect(
    page.getByRole("heading", { name: "Prove the home policy", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Current dashboard password", { exact: true })
    .fill("browser-fixture-password");
  await page
    .getByRole("button", { name: "Prepare commissioning", exact: true })
    .click();
  await expect(
    page.getByText(
      "The commissioning change is unconfirmed. Refresh its status before trying again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open attended session", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Current dashboard password", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Refresh commissioning status", exact: true })
    .click();
  await page
    .getByLabel("Current dashboard password", { exact: true })
    .fill("browser-fixture-password");
  await page
    .getByRole("checkbox", {
      name: "I am attending the inverter test and can verify its physical behavior and recovery.",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Open attended session", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Approve unattended control",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Enable attended controls", exact: true })
    .click();
  const recoveryLabel="I understand that scheduled charging permission will be enabled briefly during this attended test.";
  const recoveryButton=page.getByRole('button',{name:'Test scheduled-permission recovery',exact:true});
  await expect(recoveryButton).toBeDisabled();
  await page.getByRole('checkbox',{name:recoveryLabel,exact:true}).check();
  const checkboxSize=await page.getByRole('checkbox',{name:recoveryLabel,exact:true}).boundingBox();
  expect(checkboxSize).not.toBeNull();expect(checkboxSize?.width).toBeLessThanOrEqual(20);expect(checkboxSize?.height).toBeLessThanOrEqual(20);
  await expect(recoveryButton).toBeDisabled();
  if(!overview.latest)throw new Error('Missing browser fixture reading');
  overview.latest.soc=55;
  await page.reload();
  await expect(recoveryButton).toBeDisabled();
  await page.getByRole('checkbox',{name:recoveryLabel,exact:true}).check();
  await expect(recoveryButton).toBeEnabled();
  await page.locator('.language-switch select').selectOption('bg');
  await expect(page.getByRole('checkbox',{name:'Разбирам, че по време на тази проверка с присъстващ оператор разрешението за планирано зареждане ще бъде включено за кратко.',exact:true})).toBeChecked();
  await expect(page.getByRole('button',{name:'Провери изключването на планираното зареждане',exact:true})).toBeEnabled();
  await page.locator('.language-switch select').selectOption('en');
  await recoveryButton.click();
  await expect(page.getByRole('checkbox',{name:recoveryLabel,exact:true})).not.toBeChecked();
  await expect(recoveryButton).toBeDisabled();
  overview.latest.soc=30;
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Test grid top-up to 50%", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Test grid top-up to 50%", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop scheduled top-ups", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Stop scheduled top-ups", exact: true })
    .click();
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByRole("heading", {
      name: "Проверка на правилата за дома",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Потвърдено изключване на зареждането по график", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Одобри автоматичното управление",
      exact: true,
    }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 320, height: 1100 });
  await page.getByRole('button',{name:'Затваряне на известието',exact:true}).click();
  await expect(page.getByRole("link", { name: "Назад към управлението", exact: true }).locator("svg")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/commissioning-mobile-bg.png",
    fullPage: true,
  });
  await page.locator('.panel').filter({has:page.getByRole('button',{name:'Провери изключването на планираното зареждане',exact:true})}).screenshot({path:'test-results/attended-recovery-mobile-bg.png'});
  expect(pageErrors).toEqual([]);
  expect(mutations).toEqual(["create", "attend"]);
  expect(commands).toEqual(["commission_controls", "commission_recovery", "commission_topup", "stop"]);
});

test("commissioning previews unsaved evidence and selects verified recovery without copying command IDs", async ({ page }) => {
  await signIn(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const now = new Date().toISOString();
  const recoveryId = randomUUID();
  const observationId = randomUUID();
  const codes = ["solar", "discharge", "gridCharge", "gridStop", "dayNight", "recovery"] as const;
  const identity = {
    accountId: randomUUID(), device: "evidence-browser-inverter",
    profile: "bluesun-bse20kh3", model: "BSE20KH3", timezone: "Europe/Sofia",
    mapping: "browser-fixture", policy: "browser-fixture",
    firmware: { protocol: "2.02", dsp: "1.57", hmi: "1.45" },
  };
  const progress: PolicyObservationRun["progress"] = {
    version: 1, accepted: 2, rejected: 0, firstAt: now, last: null,
    coveredSeconds: 300, solarSeen: false, nightSeen: true, approach: null,
    solar: { count: 0, first: null, last: null, observedAt: null },
    discharge: { count: 0, first: null, last: null, observedAt: null },
    gridCharge: { count: 2, first: null, last: null, observedAt: now },
    gridStop: { count: 0, first: null, last: null, observedAt: null },
  };
  const run: NonNullable<CommissioningData["run"]> = {
    id: randomUUID(), state: "preparing", revision: "1", createdAt: now,
    updatedAt: now, attendedUntil: null, currentBinding: true, identity,
    verification: { checkedAt: now, passed: true, checks: [], firmware: identity.firmware },
    evidence: {}, requirements: codes.map((code) => ({ code, passed: false })), events: [],
  };
  const data: CommissioningData = {
    identity, canPrepare: true, attendedMinutes: 30, run, history: [],
    availableObservation: {
      id: observationId, checkedAt: now,
      requirements: codes.map((code) => ({ code, passed: code === "gridCharge" })),
    },
    recoveryCommands: [{ id: recoveryId, action: "commission_recovery", completedAt: now }],
  };
  const saved: string[] = [];
  const commands: string[] = [];
  let separateObservationRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/commands" && request.method() === "POST") commands.push(path);
    if (path === "/api/policy-observations") separateObservationRequests++;
  });
  await page.route("**/api/commissioning", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        action: string; currentPassword: string; observationRunId: string; recoveryCommandId: string;
      };
      expect(body.action).toBe("evidence");
      expect(body.currentPassword).toBe("evidence-browser-fixture");
      expect(body.observationRunId).toBe(observationId);
      expect(body.recoveryCommandId).toBe(recoveryId);
      expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
      saved.push(body.action);
      run.requirements = codes.map((code) => ({ code, passed: code === "gridCharge" || code === "recovery" }));
      run.evidence = {
        observation: { id: observationId, checkedAt: now, progress },
        recovery: { commandId: recoveryId, completedAt: now },
      };
      run.revision = "2";
    }
    return route.fulfill({ json: data });
  });
  await page.goto("/controls/commissioning");
  const checklist = page.locator(".commissioning-checklist");
  const counts = page.locator(".commissioning-counts");
  await expect(page.getByText("0 of 6 checks recorded", { exact: true })).toBeVisible();
  await expect(counts.getByText("Recorded", { exact: true }).locator("..").locator("dd")).toHaveText("0");
  await expect(counts.getByText("Available to save", { exact: true }).locator("..").locator("dd")).toHaveText("1");
  await expect(counts.getByText("Awaiting evidence", { exact: true }).locator("..").locator("dd")).toHaveText("5");
  await expect(checklist.getByText("Needs a completed attended recovery test or Stop with a verified disable write.", { exact: true })).toBeVisible();
  await expect(checklist.getByText("Available to save", { exact: true })).toHaveCount(1);
  await expect(checklist.getByText("Recorded evidence", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve unattended control", exact: true })).toBeDisabled();
  const recovery = page.getByLabel("Verified recovery result (optional)", { exact: true });
  await recovery.selectOption(recoveryId);
  await expect(counts.getByText("Available to save", { exact: true }).locator("..").locator("dd")).toHaveText("2");
  await expect(counts.getByText("Awaiting evidence", { exact: true }).locator("..").locator("dd")).toHaveText("4");
  await expect(page.getByRole("progressbar", { name: "Recorded commissioning checks" })).toHaveAttribute("aria-valuenow", "0");
  await expect(checklist.getByText("Needs a completed attended recovery test or Stop with a verified disable write.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review selected recovery result", exact: true })).toHaveAttribute("href", `/activity/${recoveryId}`);
  await expect(checklist.getByText("Available to save", { exact: true })).toHaveCount(2);
  await page.getByLabel("Current dashboard password", { exact: true }).fill("evidence-browser-fixture");
  await page.locator(".language-switch select").selectOption("bg");
  const translatedRecovery = page.getByLabel("Потвърден резултат от изключване (незадължително)", { exact: true });
  await expect(translatedRecovery).toHaveValue(recoveryId);
  await expect(page.getByLabel("Текуща парола за таблото", { exact: true })).toHaveValue("evidence-browser-fixture");
  const availableObservation = data.availableObservation;
  data.availableObservation = null;
  await expect(counts.getByText("Готово за преглед", { exact: true }).locator("..").locator("dd")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Запиши текущите доказателства от наблюдението", exact: true })).toBeDisabled();
  data.availableObservation = availableObservation;
  await expect(checklist.getByText("Готово за записване", { exact: true })).toHaveCount(2);
  await expect(counts.getByText("Готово за записване", { exact: true }).locator("..").locator("dd")).toHaveText("2");
  await page.setViewportSize({ width: 320, height: 1100 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/commissioning-progress-unsaved-mobile-bg.png", fullPage: true });
  await page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Проверки на реалното поведение", exact: true }) }).screenshot({ path: "test-results/commissioning-progress-panel-mobile-bg.png" });
  const save = page.getByRole("button", { name: "Запиши текущите доказателства от наблюдението", exact: true });
  await save.click();
  await expect(checklist.getByText("Записани доказателства", { exact: true })).toHaveCount(2);
  await expect(page.getByText("2 от 6 проверки са записани", { exact: true })).toBeVisible();
  await expect(counts.getByText("Готово за записване", { exact: true }).locator("..").locator("dd")).toHaveText("0");
  await expect(counts.getByText("Чакащи", { exact: true }).locator("..").locator("dd")).toHaveText("4");
  await expect(page.getByLabel("Текуща парола за таблото", { exact: true })).toHaveValue("");
  await expect(page.getByRole("link", { name: "Преглед на запазения резултат от изключване", exact: true })).toHaveAttribute("href", `/activity/${recoveryId}`);
  await expect(page.getByRole("button", { name: "Одобри автоматичното управление", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 320, height: 1100 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/commissioning-evidence-mobile-bg.png", fullPage: true });

  data.recoveryCommands = [];
  await expect(translatedRecovery.locator("option:checked")).toHaveText("Избраният резултат от изключване не е наличен");
  await page.getByLabel("Текуща парола за таблото", { exact: true }).fill("evidence-browser-fixture");
  await expect(save).toBeDisabled();
  await translatedRecovery.selectOption("");
  await expect(save).toBeEnabled();
  data.availableObservation = null;
  await expect(page.getByText("Няма валидно наблюдение за това устройство. Отворете наблюденията, за да записвате измервания.", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(counts.getByText("Записани", { exact: true }).locator("..").locator("dd")).toHaveText("2");
  run.requirements = codes.map((code) => ({ code, passed: true }));
  run.state = "approved";
  await expect(page.getByText("6 от 6 проверки са записани", { exact: true })).toBeVisible();
  await expect(counts.getByText("Готово за преглед", { exact: true }).locator("..").locator("dd")).toHaveText("0");
  await expect(counts.getByText("Чакащи", { exact: true }).locator("..").locator("dd")).toHaveText("0");
  await expect(page.getByRole("progressbar", { name: "Записани проверки при въвеждане в експлоатация" })).toHaveAttribute("aria-valuenow", "6");
  expect(saved).toEqual(["evidence"]);
  expect(commands).toEqual([]);
  expect(separateObservationRequests).toBe(0);
  expect(errors).toEqual([]);
});

test("commissioning reviews stored history without commands and saves it separately from approval in Bulgarian", async ({ page }) => {
  const overview = await homeConsoleFixture(page), now = new Date().toISOString();
  const codes = ["solar", "discharge", "gridCharge", "gridStop", "dayNight", "recovery"] as const;
  const identity = { accountId: randomUUID(), device: "history-browser-inverter", profile: "bluesun-bse20kh3",
    model: "BSE20KH3", timezone: "Europe/Sofia", mapping: "browser-fixture", policy: "browser-fixture",
    firmware: { protocol: "2.02", dsp: "1.57", hmi: "1.45" } };
  const evidence = { count: 2, first: null, last: null, observedAt: now };
  const progress: PolicyObservationRun["progress"] = {
    version: 1, accepted: 417, rejected: 0, firstAt: new Date(Date.now() - 34 * 3600000).toISOString(),
    last: { id: "616", at: now, receivedAt: now, source: "register", samplingSeconds: 300,
      soc: 50, pvW: 0, loadW: 1000, gridW: 1100, batteryW: 0 },
    coveredSeconds: 114076, solarSeen: true, nightSeen: true, approach: null,
    solar: evidence, discharge: evidence, gridCharge: evidence, gridStop: evidence,
  };
  const review: CommissioningHistoryReview = { source: "stored-measurements", anchorRunId: randomUUID(),
    throughId: "616", hash: "a".repeat(64), startedAt: progress.firstAt!, checkedAt: now,
    sampleCount: 451, excluded: 34, progress, window: { spanSeconds: 122400, coverage: 0.932, cycleObserved: true },
    requirements: codes.map(code => ({ code, passed: code !== "recovery" })) };
  const recoveryId = randomUUID();
  const run: NonNullable<CommissioningData["run"]> = {
    id: randomUUID(), state: "preparing", revision: "1", createdAt: now, updatedAt: now,
    attendedUntil: null, currentBinding: true, identity,
    verification: { checkedAt: now, passed: true, checks: [], firmware: identity.firmware },
    evidence: {}, requirements: codes.map(code => ({ code, passed: false })), events: [],
  };
  const data: CommissioningData = { identity, canPrepare: true, attendedMinutes: 30, run, history: [],
    availableObservation: null, recoveryCommands: [{ id: recoveryId, action: "commission_recovery", completedAt: now }] };
  const saved: unknown[] = [], commands: string[] = [];
  page.on("request", request => { if(new URL(request.url()).pathname === "/api/commands" && request.method() === "POST") commands.push(request.url()); });
  await page.route("**/api/overview", route => route.fulfill({ json: overview }));
  await page.route("**/api/commissioning/history", route => route.fulfill({ json: review }));
  await page.route("**/api/commissioning", async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { action: string; observationSource: string; historyThroughId: string; historyHash: string; recoveryCommandId: string };
      saved.push(body);
      expect(body.action).toBe("evidence");
      expect(body.observationSource).toBe(review.source);
      expect(body.historyThroughId).toBe(review.throughId);
      expect(body.historyHash).toBe(review.hash);
      expect(body.recoveryCommandId).toBe(recoveryId);
      run.requirements = codes.map(code => ({ code, passed: true }));
      run.evidence = { observation: { id: randomUUID(), checkedAt: now, progress }, recovery: { commandId: recoveryId, completedAt: now } };
      run.revision = "2";
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/controls/commissioning");
  await page.getByRole("button", { name: "Review stored measurements", exact: true }).click();
  await expect(page.getByText("Reviewed 451 saved readings with 93.2% coverage. 34 readings outside the normal policy were excluded.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save current observation evidence", exact: true })).toBeDisabled();
  expect(saved).toEqual([]);
  await page.locator(".language-switch select").selectOption("bg");
  await page.setViewportSize({ width: 320, height: 1000 });
  await expect(page.getByText("Прегледани са 451 запазени измервания с 93,2% покритие. Изключени са 34 измервания извън нормалния режим.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel("Потвърден резултат от изключване (незадължително)", { exact: true }).selectOption(recoveryId);
  await page.getByLabel("Текуща парола за таблото", { exact: true }).fill("history-browser-fixture");
  await page.getByRole("button", { name: "Запиши текущите доказателства от наблюдението", exact: true }).click();
  await expect(page.getByText("6 от 6 проверки са записани", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Текуща парола за таблото", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Одобри автоматичното управление", exact: true })).toBeDisabled();
  expect(run.state).toBe("preparing");
  expect(saved).toHaveLength(1);
  expect(commands).toEqual([]);
});

test("notifications explain the real empty state and never infer a destination from the login email", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/notifications");
  await expect(
    page.getByRole("heading", { name: "External notifications", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Numeric chat ID", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByLabel("Telegram bot token", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Send destination test", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("No notification deliveries have been requested.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByRole("heading", { name: "Външни известия", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 1100 });
  await expect(
    page
      .getByRole("link", { name: "Към настройките", exact: true })
      .locator("svg"),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("notifications preserve configuration drafts across language changes, distinguish queued and confirmed tests, and report a lost response", async ({
  page,
}) => {
  await signIn(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const now = new Date().toISOString();
  const botToken = "123456789:" + "b".repeat(35);
  const data: NotificationSettingsData = {
    channel: null,
    deliveries: [],
    events: [],
    offset: 0,
    hasMore: false,
    lifecycle: "active",
    worker: { state: "current", checkedAt: now },
  };
  let loseSave = true;
  const actions: string[] = [];
  await page.route("**/api/notifications*", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        action: string;
        botToken?: string;
        chatId?: string;
        language?: "bg" | "en";
        currentPassword: string;
        revision: string;
        requestId?: string;
      };
      actions.push(body.action);
      expect(body.currentPassword).toBe("notification-browser-fixture");
      data.events.unshift({
        actor: "notification-owner-with-a-long-address@example.test",
        action:
          body.action === "save"
            ? "saved"
            : body.action === "enable"
              ? "enabled"
              : body.action === "disable"
                ? "disabled"
                : "test",
        revision: body.revision,
        at: now,
      });
      expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
      if (body.action === "save") {
        expect(body.botToken).toBe(botToken);
        expect(body.chatId).toBe("-1001234567890");
        expect(body.language).toBe("en");
        data.channel = {
          id: randomUUID(),
          kind: "telegram",
          chatId: "-1001234567890",
          language: "en",
          revision: "1",
          enabled: false,
          quarantined: false,
          configured: true,
          verifiedAt: null,
          lastTestAt: null,
          blockedCode: null,
        };
        if (loseSave) {
          loseSave = false;
          return route.abort("failed");
        }
      } else if (body.action === "test" && data.channel) {
        expect(body.botToken).toBeUndefined();
        expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
        data.channel.lastTestAt = now;
        data.deliveries = [
          {
            id: randomUUID(),
            kind: "test",
            state: "queued",
            attempts: 0,
            hadUnconfirmed: false,
            createdAt: now,
            nextAttemptAt: now,
            completedAt: null,
            cancelRequestedAt: null,
            lastCode: null,
            messageId: null,
            payload: {
              title: "Notification test",
              text: "Fixture destination test",
            },
            history: [],
          },
        ];
      } else if (body.action === "enable" && data.channel) {
        expect(data.channel.verifiedAt).not.toBeNull();
        data.channel.enabled = true;
        data.channel.revision = "2";
      } else if (body.action === "disable" && data.channel) {
        data.channel.enabled = false;
        data.channel.revision = "3";
      }
    }
    return route.fulfill({ json: data });
  });
  await page.goto("/settings/notifications");
  await page.getByLabel("Telegram bot token", { exact: true }).fill(botToken);
  await page
    .getByLabel("Numeric chat ID", { exact: true })
    .fill("-1001234567890");
  await page
    .getByLabel("Notification language", { exact: true })
    .selectOption("en");
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByLabel("Токен за бот в Telegram", { exact: true }),
  ).toHaveValue(botToken);
  await page
    .getByLabel("Текуща парола за таблото", { exact: true })
    .fill("notification-browser-fixture");
  await page
    .getByRole("button", { name: "Запази дестинацията", exact: true })
    .click();
  await expect(
    page.getByText(
      "Заявката за известие не е потвърдена. Обновете историята на доставянето, преди да опитате отново.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel("Токен за бот в Telegram", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Текуща парола за таблото", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", {
      name: "Изпрати тест до дестинацията",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Обнови състоянието на доставянето",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Текуща парола за таблото", { exact: true })
    .fill("notification-browser-fixture");
  await page
    .getByRole("button", { name: "Изпрати тест до дестинацията", exact: true })
    .click();
  await expect(
    page.getByText("Изчаква изпращане", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Включи известията", exact: true }),
  ).toBeDisabled();
  const channel = data.channel!;
  channel.verifiedAt = now;
  const job = data.deliveries[0]!;
  job.state = "delivered";
  job.messageId = "14";
  job.attempts = 1;
  job.completedAt = now;
  job.lastCode = "delivered";
  job.history = [
    {
      number: 1,
      state: "delivered",
      code: "delivered",
      startedAt: now,
      completedAt: now,
      messageId: "14",
    },
  ];
  await page
    .getByRole("button", {
      name: "Обнови състоянието на доставянето",
      exact: true,
    })
    .click();
  await expect(
    page
      .locator(".notification-delivery-heading")
      .getByText("Доставянето е потвърдено", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Текуща парола за таблото", { exact: true })
    .fill("notification-browser-fixture");
  await page
    .getByRole("button", { name: "Включи известията", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Известията в Telegram са включени", exact: true }),
  ).toBeVisible();
  const incident: NotificationDelivery = {
    ...job,
    id: randomUUID(),
    kind: "opened",
    attempts: 2,
    hadUnconfirmed: true,
    messageId: "16",
    payload: {
      title: "Fixture incident",
      text: "Fixture incident with two delivery attempts",
    },
    history: [
      {
        number: 1,
        state: "unconfirmed",
        code: "transport_unconfirmed",
        startedAt: now,
        completedAt: now,
        messageId: null,
      },
      {
        number: 2,
        state: "delivered",
        code: "delivered",
        startedAt: now,
        completedAt: now,
        messageId: "16",
      },
    ],
  };
  data.deliveries.unshift(incident);
  await page
    .getByRole("button", {
      name: "Обнови състоянието на доставянето",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "По-ранен опит не е потвърден. Възможни са дублирани съобщения дори ако следващ опит е успешен.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByText("Преглед на съобщението и опитите", { exact: true })
    .first()
    .click();
  await expect(
    page
      .locator(".notification-delivery")
      .filter({ hasText: "Fixture incident" })
      .locator("tbody tr"),
  ).toHaveCount(2);
  await page
    .getByLabel("Текуща парола за таблото", { exact: true })
    .fill("notification-browser-fixture");
  await page
    .getByRole("button", {
      name: "Изключи известията и отмени чакащото доставяне",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Известията в Telegram са изключени", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 1100 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/notifications-mobile-bg.png",
    fullPage: true,
  });
  expect(await page.locator("body").innerText()).not.toContain(botToken);
  expect(actions).toEqual(["save", "test", "enable", "disable"]);
  expect(pageErrors).toEqual([]);
});

test("notifications retry a failed page load and paginate history without dispatching messages", async ({
  page,
}) => {
  await signIn(page);
  const now = new Date().toISOString();
  const jobs = Array.from(
    { length: 26 },
    (_, index): NotificationDelivery => ({
      id: randomUUID(),
      kind: "opened",
      state: "retry",
      attempts: 1,
      hadUnconfirmed: false,
      createdAt: now,
      nextAttemptAt: new Date(Date.now() + 300000).toISOString(),
      completedAt: null,
      cancelRequestedAt: null,
      lastCode: "rate_limited",
      messageId: null,
      payload: {
        title: `History fixture ${index + 1}`,
        text: "Private fixture message",
      },
      history: [
        {
          number: 1,
          state: "rejected",
          code: "rate_limited",
          startedAt: now,
          completedAt: now,
          messageId: null,
        },
      ],
    }),
  );
  let failFirst = true;
  const offsets: number[] = [];
  await page.route("**/api/notifications*", async (route) => {
    expect(route.request().method()).toBe("GET");
    if (failFirst) {
      failFirst = false;
      return route.fulfill({
        status: 503,
        json: { error: "Unable to update notifications" },
      });
    }
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset") ?? 0,
    );
    offsets.push(offset);
    const data: NotificationSettingsData = {
      channel: null,
      deliveries: jobs.slice(offset, offset + 25),
      hasMore: offset === 0,
      offset,
      events: [],
      lifecycle: "active",
      worker: { state: "current", checkedAt: now },
    };
    return route.fulfill({ json: data });
  });
  await page.goto("/settings/notifications");
  await expect(
    page.getByText("Unable to update notifications", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh delivery status", exact: true })
    .click();
  await expect(page.locator(".notification-delivery")).toHaveCount(25);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".notification-delivery")).toHaveCount(1);
  await expect(
    page.getByText("History fixture 26", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.locator(".notification-delivery")).toHaveCount(25);
  expect(offsets).toContain(25);
});

async function firmwareEvidenceFixture(page: Page): Promise<OverviewData> {
  await signIn(page);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as OverviewData;
  const checkedAt = "2026-10-28T21:14:30.000Z";
  const firmware = { protocol: "2.02", dsp: "1.57", hmi: "1.45" };
  overview.controller.profile = "bluesun-bse20kh3";
  overview.controller.error =
    "PRIVATE-DIAGNOSTIC-DATA private-provider@example.test SENSITIVE-INVERTER-SERIAL";
  overview.controller.control = {
    ...overview.controller.control,
    canStart: false,
    canEnable: false,
    serverAllowed: false,
    workspaceEnabled: false,
    firmware: { ...firmware, collectedAt: "2026-10-28T22:50:00.000Z" },
    verificationStatus: {
      state: "expired",
      checkedAt,
      expiresAt: "2026-10-28T21:44:30.000Z",
    },
    verification: {
      checkedAt,
      passed: true,
      firmware,
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
          label: "PRIVATE-DIAGNOSTIC-DATA",
          actual: 1234,
          expected: 1234,
          unit: "PRIVATE-UNIT",
          passed: true,
        },
      ],
    },
  };
  overview.controller.policy.solarPowerLimit = "native";
  if (overview.controller.control.verification)
    overview.controller.control.verification.holdingRegisters = {
      2504: 100,
      2505: 500,
      3005: 1000,
      3022: 0,
      3023: 100,
      3036: 500,
    };
  const commissioning: CommissioningData = {
    identity: null,
    canPrepare: false,
    attendedMinutes: 30,
    availableObservation: null,
    recoveryCommands: [],
    run: null,
    history: [],
  };
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/commissioning", (route) =>
    route.fulfill({ json: commissioning }),
  );
  return overview;
}

test("native solar policy is consistent in Controls, Settings and observations in both languages", async ({
  page,
}) => {
  await firmwareEvidenceFixture(page);
  for (const [language, message] of [
    ["en", "Solar charging follows the inverter and battery limits, up to the 100% SOC target."],
    ["bg", "Соларното зареждане следва ограниченията на инвертора и батерията до целеви заряд от 100%."],
  ] as const) {
    await page.goto("/controls/advanced");
    await page.locator(".language-switch select").selectOption(language);
    for (const path of ["/controls/advanced", "/settings", "/controls/observations"]) {
      await page.goto(path);
      await expect(page.locator("main")).toContainText(message);
      await expect(page.locator("main")).not.toContainText(/5\s*(kW|кВт)/i);
    }
  }
});

test("device evidence is available before commissioning and exports only saved technical evidence", async ({
  page,
}) => {
  await firmwareEvidenceFixture(page);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      new URL(request.url()).pathname.startsWith("/api/")
    )
      mutations.push(request.method());
  });
  await page.goto("/controls/commissioning");
  await expect(
    page.getByRole("heading", { name: "No commissioning run", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Prepare commissioning", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", {
      name: "Saved device evidence",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByText("Review saved device evidence", { exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Device evidence preview",
    exact: true,
  });
  await expect(preview).toContainText("Settings report expired");
  await expect(preview).toContainText("2026-10-28T21:14:30.000Z");
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download diagnostic report", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("solarman-device-evidence.txt");
  const file = await download.path();
  expect(file).not.toBeNull();
  const text = readFileSync(file!, "utf8");
  expect(text).toBe(await preview.textContent());
  expect(text).toContain("Protocol version: 2.02");
  expect(text).toContain("Main DSP version: 1.57");
  expect(text).toContain("HMI version: 1.45");
  expect(text).toContain("AC charging setting: 2000 W");
  expect(text).toContain("Overall SOC maximum: 100 %");
  expect(text).toContain("Saved holding-register words");
  expect(text).not.toMatch(/5\s*kW/i);
  expect(text).not.toContain("Please provide");
  expect(text).toContain("\n3022: 0\n3023: 100\n");
  expect(text).toContain("\n2504: 100\n");
  expect(text).not.toContain("PRIVATE-DIAGNOSTIC-DATA");
  expect(text).not.toContain("PRIVATE-UNIT");
  expect(text).not.toContain("private-provider@example.test");
  expect(text).not.toContain("SENSITIVE-INVERTER-SERIAL");
  if (process.env.E2E_EMAIL) expect(text).not.toContain(process.env.E2E_EMAIL);
  expect(text).not.toContain("Settings report verified");
  await page.setViewportSize({ width: 320, height: 1100 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await preview.focus();
  expect(
    await preview.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  expect(mutations).toEqual([]);
});

test("device evidence keeps missing observations separate, handles clipboard failures and translates the report on mobile", async ({
  page,
}) => {
  const overview = await firmwareEvidenceFixture(page);
  const observed = overview.controller.control.firmware;
  if (!observed) throw new Error("Missing firmware fixture");
  observed.protocol = "PRIVATE-PROTOCOL";
  observed.dsp = "PRIVATE-DSP";
  observed.hmi = null;
  observed.collectedAt = "PRIVATE-DATE";
  const verification = overview.controller.control.verification;
  if (!verification) throw new Error("Missing settings fixture");
  verification.checkedAt = "PRIVATE-DATE";
  verification.checks[0].actual = null;
  delete verification.holdingRegisters;
  overview.controller.control.verificationStatus.state = "outdated";
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      new URL(request.url()).pathname.startsWith("/api/")
    )
      mutations.push(request.method());
  });
  await page.goto("/controls/commissioning");
  await page.locator(".language-switch select").selectOption("bg");
  await expect(
    page.getByRole("heading", {
      name: "Запазени данни за устройството",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByText("Преглед на запазените данни за устройството", { exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Преглед на данните за устройството",
    exact: true,
  });
  const text = await preview.textContent();
  expect(text).toContain("Запазени данни за устройството");
  expect(text).not.toContain("PRIVATE-");
  expect(text?.split("Версия на основния DSP: 1.57")).toHaveLength(2);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (): Promise<void> => {
          throw new DOMException(
            "Fixture permission denied",
            "NotAllowedError",
          );
        },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Копирай диагностичния отчет", exact: true })
    .click();
  await expect(
    page.getByText(
      "Няма достъп до клипборда. Изтеглете диагностичния отчет като файл.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string): Promise<void> => {
          sessionStorage.setItem("firmware-evidence-copy", value);
        },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Копирай диагностичния отчет", exact: true })
    .click();
  await expect(
    page.getByText("Диагностичният отчет е копиран", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("firmware-evidence-copy")),
  ).toBe(text);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Изтегли диагностичния отчет", exact: true })
    .click();
  const file = await (await downloaded).path();
  expect(file).not.toBeNull();
  expect(readFileSync(file!, "utf8")).toBe(text);
  await page.setViewportSize({ width: 320, height: 1100 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/firmware-evidence-mobile-bg.png",
    fullPage: true,
  });
  await page.locator(".language-switch select").selectOption("en");
  await expect(
    page.getByText("Diagnostic report copied", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "Device evidence preview", exact: true }),
  ).toContainText("Saved device evidence");
  await expect(
    page.getByRole("region", { name: "Device evidence preview", exact: true }),
  ).toContainText("2504: Not recorded");
  verification.holdingRegisters = {
    2504: -1,
    2505: 65536,
    3022: 1.5,
    3023: null,
  };
  await page.reload();
  await page
    .getByText("Review saved device evidence", { exact: true })
    .click();
  const invalidWords = page.getByRole("region", {
    name: "Device evidence preview",
    exact: true,
  });
  await expect(invalidWords).toContainText("2504: Not recorded");
  await expect(invalidWords).toContainText("2505: Not recorded");
  await expect(invalidWords).toContainText("3022: Not recorded");
  expect(mutations).toEqual([]);
});

test("device evidence is hidden for another selected profile", async ({
  page,
}) => {
  const overview = await firmwareEvidenceFixture(page);
  overview.controller.profile = "monitor-only";
  await page.goto("/controls/commissioning");
  await expect(
    page.getByRole("heading", { name: "No commissioning run", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Saved device evidence",
      exact: true,
    }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download diagnostic report", exact: true }),
  ).not.toBeVisible();
});

test("archive integrity rejects tampering and recovers with verified UTF-8 data", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/data");
  const payload =
    JSON.stringify({ type: "manifest", version: 1 }) +
    "\n" +
    JSON.stringify({
      type: "record",
      section: "workspace",
      data: { name: "Дом ☀️" },
    }) +
    "\n";
  const checksum = createHash("sha256").update(payload).digest("hex");
  const footer = (sha256: string): string =>
    JSON.stringify({ type: "complete", counts: { workspace: 1 }, sha256 }) +
    "\n";
  let response = payload + footer("0".repeat(64));
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.route("**/api/workspace/archive", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: response,
    }),
  );
  await page
    .getByLabel("Dashboard password for the archive", { exact: true })
    .fill("archive-fixture-password");
  await page
    .getByRole("button", { name: "Download workspace archive", exact: true })
    .click();
  await expect(
    page.getByText("Archive verification failed. Download it again.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(downloads).toBe(0);
  await page.locator(".language-switch select").selectOption("bg");
  const error = page.getByText(
    "Проверката на архива е неуспешна. Изтеглете го отново.",
    { exact: true },
  );
  await expect(error).toBeVisible();
  response = payload.replace("Дом", "Променен дом") + footer(checksum);
  await page
    .getByLabel("Парола за таблото за изтегляне на архив", { exact: true })
    .fill("archive-fixture-password");
  await page
    .getByRole("button", {
      name: "Изтегли архив на пространството",
      exact: true,
    })
    .click();
  await expect(error).toBeVisible();
  await expect(
    page.getByLabel("Парола за таблото за изтегляне на архив", { exact: true }),
  ).toHaveValue("");
  expect(downloads).toBe(0);
  response = payload + footer(checksum);
  await page
    .getByLabel("Парола за таблото за изтегляне на архив", { exact: true })
    .fill("archive-fixture-password");
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Изтегли архив на пространството",
      exact: true,
    })
    .click();
  const downloaded = await pending;
  const file = await downloaded.path();
  expect(file).not.toBeNull();
  expect(readFileSync(file!, "utf8")).toBe(response);
  await expect(
    page.getByText("Архивът е проверен. Проверете изтеглянията в браузъра.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(error).not.toBeVisible();
  expect(downloads).toBe(1);
});

test("scheduled night plans keep their approval while refreshed previews update the graph", async ({
  page,
}) => {
  await signIn(page);
  const data = energyDashboardFixture();
  if (!data.plan) throw Error("Missing energy fixture");
  data.plan.state = "scheduled";
  data.plan.createdAt = new Date(Date.now() - 3600000).toISOString();
  data.plan.forecast.expiresAt = new Date(Date.now() - 60000).toISOString();
  const id = data.plan.id,
    requests: unknown[] = [];
  await page.route("**/api/energy", (route) => route.fulfill({ json: data }));
  await page.route("**/api/energy/refresh", async (route) => {
    requests.push(route.request().postDataJSON());
    const preview = energyDashboardFixture().plan;
    if (!preview) throw Error("Missing preview fixture");
    preview.id = randomUUID();
    preview.prediction.targetSoc = 75;
    data.preview = preview;
    await route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.goto("/controls/night-savings");
  await expect(
    page.getByText("This recommendation is out of date.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Saved night plan", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh forecast and plan", exact: true })
    .click();
  await expect(
    page.getByText("The latest forecast below is a preview.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use tonight", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "View solar and battery graph", exact: true })
    .click();
  await expect(page).toHaveURL(/#energy-timeline$/);
  await expect(page.locator("#energy-timeline")).toContainText(
    "Latest preview target: 75%",
  );
  expect(data.plan.id).toBe(id);
  expect(data.plan.prediction.targetSoc).toBe(82);
  expect(requests).toEqual([{ revision: data.revision }]);
  await page.locator(".language-switch select").selectOption("bg");
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator("#energy-timeline")).toContainText(
    "Цел според актуалната прогноза: 75%",
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.locator("#energy-timeline").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/night-forecast-preview-bg.png" });
});

test("night savings previews a target and requires an explicit mode and password before scheduling", async ({
  page,
}) => {
  await homeConsoleFixture(page);
  const data = energyDashboardFixture(),
    requests: unknown[] = [];
  await page.route("**/api/energy", (route) => route.fulfill({ json: data }));
  await page.route("**/api/energy/apply", async (route) => {
    requests.push(route.request().postDataJSON());
    expect(route.request().headers()["idempotency-key"]).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    if (data.plan) data.plan.state = "scheduled";
    await route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.goto("/controls/night-savings");
  await expect(
    page.getByRole("heading", { name: "Night savings", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("82%", { exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: "Use tonight", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Use this plan tonight?" }),
  ).toBeVisible();
  expect(requests).toEqual([]);
  await page
    .getByLabel("Current dashboard password", { exact: true })
    .fill("browser-fixture-password");
  await page
    .getByRole("button", { name: "Confirm night plan", exact: true })
    .click();
  await expect(
    page.getByText("Scheduled for tonight", { exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([
    {
      revision: "2",
      planId: data.plan?.id,
      choice: "tonight",
      currentPassword: "browser-fixture-password",
    },
  ]);
  await expect(
    page.getByText("This is a one-time night plan.", { exact: true }),
  ).toBeVisible();
});

test("night savings target adjustment recalculates without scheduling or inverter commands", async ({
  page,
}) => {
  await homeConsoleFixture(page);
  const data = energyDashboardFixture(),
    adjusted: unknown[] = [];
  await page.route("**/api/energy", (route) => route.fulfill({ json: data }));
  await page.route("**/api/energy/adjust", async (route) => {
    adjusted.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.goto("/controls/night-savings");
  await page
    .getByRole("button", { name: "Adjust target", exact: true })
    .click();
  await page
    .getByRole("slider", { name: /Choose the maximum grid target/ })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider")).toHaveValue("83");
  await page.getByRole("button", { name: "Recalculate this target" }).click();
  expect(adjusted).toEqual([
    { revision: "2", planId: data.plan?.id, targetSoc: 83 },
  ]);
  await expect(
    page.getByRole("heading", { name: "Use this plan tonight?" }),
  ).not.toBeVisible();
});

test("night savings preserves unsaved inputs, translates to Bulgarian and fits a 320px screen", async ({
  page,
}) => {
  await homeConsoleFixture(page);
  const data = energyDashboardFixture();
  data.plan!.prediction.reasons.push("assumed-discharge-restart");
  await page.route("**/api/energy", (route) => route.fulfill({ json: data }));
  await page.goto("/controls/night-savings");
  await expect(page.getByText(
    "The forecast uses a conservative six-point discharge restart band above the reserve.",
    { exact: true },
  )).toBeVisible();
  await page
    .getByText("Edit installation and assumptions", { exact: true })
    .click();
  await page.getByLabel("Battery capacity · kWh", { exact: true }).fill("24");
  await page.waitForTimeout(5200);
  await expect(
    page.getByLabel("Battery capacity · kWh", { exact: true }),
  ).toHaveValue("24");
  await page.getByLabel("Language", { exact: true }).selectOption("bg");
  await page.setViewportSize({ width: 320, height: 1100 });
  await expect(page.getByText(
    "Прогнозата използва предпазно допускане за възобновяване на разреждането на шест процентни пункта над резерва.",
    { exact: true },
  )).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Нощна икономия", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Капацитет на батерията · kWh", { exact: true }),
  ).toHaveValue("24");
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:"test-results/night-savings-mobile-top-bg.png"});
  await page.screenshot({
    path: "test-results/night-savings-mobile-bg.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:"test-results/night-savings-desktop-top-bg.png"});
  await page.screenshot({
    path: "test-results/night-savings-desktop-bg.png",
    fullPage: true,
  });
});

test("night savings exposes incomplete, stale and outage-priority states without enabling actions", async ({
  page,
}) => {
  await homeConsoleFixture(page);
  const data = energyDashboardFixture();
  data.plan!.forecast.expiresAt = new Date(Date.now() - 60000).toISOString();
  data.control.canActivate = false;
  data.control.active = true;
  data.control.purpose = "outage";
  await page.route("**/api/energy", (route) => route.fulfill({ json: data }));
  await page.goto("/controls/night-savings");
  await expect(
    page.getByText(
      "Outage reserve has priority. Night savings cannot change it.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use tonight", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "This recommendation is out of date. Refresh it before choosing a plan.",
      { exact: true },
    ),
  ).toBeVisible();
  data.missing = ["location"];
  data.plan = null;
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Start with your installation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use tonight", exact: true }),
  ).not.toBeVisible();
});

test("night savings Automatic remains available when no extra charging is recommended", async ({
  page,
}) => {
  await homeConsoleFixture(page);
  const data = energyDashboardFixture(),
    sent: unknown[] = [];
  data.plan!.prediction.action = "normal";
  data.plan!.prediction.targetSoc = 50;
  data.plan!.prediction.reasons = ["no-economic-topup"];
  data.plan!.prediction.estimatedSavings = 0;
  await page.route("**/api/energy", (route) => route.fulfill({ json: data }));
  await page.route("**/api/energy/apply", async (route) => {
    sent.push(route.request().postDataJSON());
    data.automatic = true;
    data.plan!.state = "scheduled";
    await route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.goto("/controls/night-savings");
  await expect(
    page.getByRole("button", { name: "Use tonight", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Automatic", exact: true }).click();
  await page
    .getByLabel("Current dashboard password", { exact: true })
    .fill("browser-fixture-password");
  await page
    .getByRole("button", { name: "Confirm night plan", exact: true })
    .click();
  expect(sent).toEqual([
    {
      revision: "2",
      planId: data.plan!.id,
      choice: "automatic",
      currentPassword: "browser-fixture-password",
    },
  ]);
});
