import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { energyDashboardFixture } from "./energy.fixture";
import type { Analytics, OverviewData, OutageData } from "../../web/types";
import type { EnergyToolsData } from "../../web/energy-tools-types";

const screenshots =
  process.env.LAYOUT_SCREENSHOT_DIR ?? "test-results/layout-review";

async function prepareLayout(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email address").fill(process.env.E2E_EMAIL!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Your energy, at a glance.",
      exact: true,
    }),
  ).toBeVisible();
  const response = await page.request.get("/api/overview");
  expect(response.ok()).toBe(true);
  const data = (await response.json()) as OverviewData;
  const at = new Date().toISOString();
  data.latest = {
    at,
    receivedAt: at,
    source: "provider",
    samplingSeconds: 300,
    soc: 68,
    temperatureC: 22,
    pvW: 2800,
    loadW: 1400,
    gridW: 0,
    batteryW: -1400,
    acEnabled: false,
  };
  Object.assign(data.controller, {
    apiConfigured: true,
    deviceSelected: true,
    profile: "bluesun-bse20kh3",
    writesEnabled: true,
    paused: false,
    manualTopup: false,
    mode: "active",
    error: null,
    setupError: null,
    recoveryTesting: false,
    outage: null,
  });
  Object.assign(data.controller.control, {
    canStart: true,
    canStop: true,
    workspaceEnabled: true,
    reasons: [],
  });
  data.controller.telemetry = {
    source: "provider",
    collectedAt: at,
    receivedAt: at,
    deviceState: 1,
    clock: null,
  };
  const totals = {
    solarKwh: 12.8,
    loadKwh: 18.4,
    importKwh: 7.5,
    exportKwh: 1.5,
    chargeKwh: 4,
    dischargeKwh: 5,
    coveredSeconds: 82080,
  };
  const start = Date.now() - 86400000;
  const analytics: Analytics = {
    start: new Date(start).toISOString(),
    end: at,
    timezone: "Europe/Sofia",
    estimated: true,
    sampleCount: 96,
    coverage: 0.95,
    totals,
    daily: [{ day: new Date(start).toISOString().slice(0, 10), ...totals }],
    points: Array.from({ length: 96 }, (_, i) => ({
      at: start + i * 900000,
      pvW: Math.max(0, Math.sin((i / 96) * Math.PI * 2 - Math.PI / 2) * 4000),
      loadW: 1200 + (i % 6) * 100,
      gridW: 1000 - (i % 8) * 150,
      batteryW: i < 40 ? 900 : -1000,
      soc: Math.min(95, 50 + i / 2),
      temperatureC: 22,
    })),
  };
  data.today = analytics;
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
  const tools: EnergyToolsData = {
    ready: true,
    energyRevision: "1",
    forecastFresh: true,
    preferences: {
      revision: "1",
      briefingsEnabled: true,
      morningMinute: 435,
      eveningMinute: 1140,
    },
    tasks: [],
    briefings: [],
    nextBriefing: null,
    report: {
      fromDay: "2026-10-23",
      throughDay: "2026-10-29",
      currency: "EUR",
      gridCost: 8.2,
      solarKwh: 76,
      importKwh: 94,
      coverage: 0.95,
      estimatedSavings: null,
      assessedPlans: 0,
      wearIncluded: false,
      days: Array.from({ length: 7 }, (_, i) => ({
        day: `2026-10-${23 + i}`,
        coverage: 0.95,
        solarKwh: 10.8,
        loadKwh: 23.4,
        importKwh: 13.4,
        exportKwh: 0.8,
        batteryDischargeKwh: 6.2,
        gridCost: 1.17,
      })),
    },
    learning: {
      forecastDays: 2,
      forecastStage: "learning",
      meanAbsoluteErrorKwh: 0.8,
      forecastBiasKwh: -0.2,
      observedFullCapacityKwh: null,
      qualifyingCycles: 0,
      requiredSocChange: 20,
      measuredHours: 48,
      batteryEstimateChangesSettings: false,
      hourlySolar: [],
    },
  };
  await page.route("**/api/overview", (route) => route.fulfill({ json: data }));
  await page.route("**/api/analytics**", (route) =>
    route.fulfill({ json: analytics }),
  );
  await page.route("**/api/energy", (route) =>
    route.fulfill({ json: energyDashboardFixture() }),
  );
  await page.route("**/api/energy/tools", (route) =>
    route.fulfill({ json: tools }),
  );
  await page.route("**/api/outage", (route) => route.fulfill({ json: outage }));
  await page.reload();
  await page.locator(".language-switch select").selectOption("bg");
  await mkdir(screenshots, { recursive: true });
}

test("active navigation keeps complete Bulgarian labels on one line across sidebar and phone widths", async ({
  page,
}) => {
  await prepareLayout(page);
  await page.goto("/controls");
  const problems: object[] = [];
  for (const width of [1440, 1280, 1200, 1024, 1000, 820, 761, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const language of ["en", "bg"]) {
      await page.locator(".language-switch select").selectOption(language);
      const labels = await page
        .locator(".sidebar nav .nav-item")
        .evaluateAll((items) =>
          items.map((item) => {
            const label = item.querySelector("span")!,
              icon = item.querySelector("svg")!;
            const range = document.createRange();
            range.selectNodeContents(label);
            return {
              label: label.textContent,
              lines: range.getClientRects().length,
              clipped:
                label.scrollWidth > label.clientWidth + 1 ||
                label.getBoundingClientRect().right >
                  item.getBoundingClientRect().right,
              iconWidth: icon.getBoundingClientRect().width,
            };
          }),
        );
      const broken = labels.filter(
        (label) => label.lines !== 1 || label.clipped || label.iconWidth < 17,
      );
      if (broken.length) problems.push({ width, language, labels: broken });
      await page
        .locator(".sidebar")
        .screenshot({
          path: join(
            screenshots,
            `navigation-${width}${language === "en" ? "-en" : ""}.png`,
          ),
          animations: "disabled",
        });
    }
  }
  await writeFile(
    join(screenshots, "navigation.json"),
    JSON.stringify(problems, null, 2),
  );
  expect(problems).toEqual([]);
});

test("Bulgarian main screens remain readable and contained at phone, tablet and desktop widths", async ({
  page,
}) => {
  test.setTimeout(120000);
  await prepareLayout(page);
  const changes: string[] = [],
    problems: object[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(?:commands|outage\/(?:prepare|restore)|energy\/(?:apply|adjust|pause))$/.test(
        new URL(request.url()).pathname,
      )
    )
      changes.push(request.url());
  });
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, path] of [
      ["home", "/"],
      ["automations", "/controls"],
      ["outage", "/controls/outage"],
      ["night-savings", "/controls/night-savings"],
      ["energy-assistant", "/controls/energy-tools"],
      ["history", "/analytics"],
      ["settings", "/settings"],
    ]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const overflowing = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth > innerWidth,
        text: [
          ...document.querySelectorAll(
            "main h1,main h2,main .energy-number,main .energy-target,main .console-tag,main .energy-mode",
          ),
        ]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.textContent),
      }));
      if (overflowing.page || overflowing.text.length)
        problems.push({ width, path, ...overflowing });
      if (width === 390 && name === "home") {
        const action = await page
          .getByRole("link", {
            name: "Подготовка за спиране на тока",
            exact: true,
          })
          .boundingBox();
        const navigation = await page.locator(".sidebar").boundingBox();
        expect(action).not.toBeNull();
        expect(navigation).not.toBeNull();
        expect(action!.y + action!.height).toBeLessThan(navigation!.y);
        expect(
          (await page.locator(".mobile-logout").boundingBox())!.height,
        ).toBeGreaterThanOrEqual(44);
        expect(
          (await page.locator(".language-switch select").boundingBox())!.width,
        ).toBeGreaterThanOrEqual(100);
      }
      await page.screenshot({
        path: join(screenshots, `${name}-${width}.png`),
        animations: "disabled",
      });
      if (name === "outage" || name === "energy-assistant") {
        await page.getByRole("button").last().scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(screenshots, `${name}-${width}-lower.png`),
          animations: "disabled",
        });
      }
    }
  }
  await writeFile(
    join(screenshots, "screens.json"),
    JSON.stringify(problems, null, 2),
  );
  expect(problems).toEqual([]);
  expect(changes).toEqual([]);
});

test("account navigation opens security without signing out and short laptop windows keep sign-out reachable", async ({
  page,
}) => {
  await prepareLayout(page);
  await page.setViewportSize({ width: 1024, height: 700 });
  const account = page.locator(".sidebar .user-profile");
  await expect(account).toHaveAttribute("href", "/settings/security");
  const logout = page.locator(".sidebar-logout");
  const box = await logout.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.y + box!.height).toBeLessThanOrEqual(700);
  await account.click();
  await expect(page).toHaveURL(/\/settings\/security$/);
  await expect(
    page.getByRole("heading", { name: "Сигурност на акаунта", exact: true }),
  ).toBeVisible();
  expect((await page.request.get("/api/auth/session")).status()).toBe(200);
  await page.screenshot({
    path: join(screenshots, "account-short-laptop.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Изход", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Добре дошли отново", exact: true }),
  ).toBeVisible();
});
