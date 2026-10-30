import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { localDateTimeInput, localDateTimeInstant } from "../../web/local-date-time";
import type { EnergyToolsData, OutageEstimate } from "../../web/energy-tools-types";
import type { OutageData } from "../../web/types";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email address").fill(process.env.E2E_EMAIL!);
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your energy, at a glance.", exact: true })).toBeVisible();
}

function fixture(): EnergyToolsData {
  return { ready: true, energyRevision: "1", forecastFresh: true,
    preferences: { revision: "0", briefingsEnabled: false, morningMinute: 435, eveningMinute: 1140 },
    tasks: [], briefings: [], nextBriefing: null,
    learning: { forecastDays: 2, forecastStage: "learning", meanAbsoluteErrorKwh: 0.7, forecastBiasKwh: -0.4,
      observedFullCapacityKwh: null, qualifyingCycles: 0, requiredSocChange: 20, measuredHours: 48,
      batteryEstimateChangesSettings: false, hourlySolar: [] },
    report: { fromDay: "2026-10-20", throughDay: "2026-10-26", currency: "EUR", gridCost: 12,
      solarKwh: 50, importKwh: 120, coverage: 0.95, estimatedSavings: null, assessedPlans: 0, wearIncluded: false,
      days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${20 + i}`, coverage: i === 0 ? 0 : 1,
        solarKwh: 7, loadKwh: 20, importKwh: 13, exportKwh: 0, batteryDischargeKwh: 5, gridCost: 1.2 })) },
  };
}

test("site-local date entry handles different browser timezones and rejects missing or duplicated clock-change times", async () => {
  const normal = localDateTimeInstant("2026-10-30T13:00", "Europe/Sofia");
  expect(normal).toBe("2026-10-30T11:00:00.000Z");
  expect(localDateTimeInput(Date.parse(normal), "Europe/Sofia")).toBe("2026-10-30T13:00");
  expect(() => localDateTimeInstant("2026-03-29T03:30", "Europe/Sofia")).toThrow(/does not exist/);
  expect(() => localDateTimeInstant("2026-10-25T03:30", "Europe/Sofia")).toThrow(/occurs twice/);
  expect(() => localDateTimeInstant("2026-02-30T13:00", "Europe/Sofia")).toThrow(/valid date/);
});

test("energy assistant preserves briefing drafts across language changes and exports a Bulgarian report on mobile", async ({ page }) => {
  await signIn(page);
  const data = fixture(), mutations: unknown[] = [];
  await page.route("**/api/energy/tools", route => route.fulfill({ json: data }));
  await page.route("**/api/energy/tools/preferences", async route => {
    const body = route.request().postDataJSON() as EnergyToolsData["preferences"] & { currentPassword: string };
    mutations.push(body);
    expect(body.currentPassword).toBe("energy-browser-fixture");
    expect(body.morningMinute).toBe(490);
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    data.preferences = { revision: "1", briefingsEnabled: body.briefingsEnabled, morningMinute: body.morningMinute, eveningMinute: body.eveningMinute };
    await route.fulfill({ json: data.preferences });
  });
  await page.goto("/controls/energy-tools");
  await expect(page.getByRole("heading", { name: "Energy assistant", exact: true })).toBeVisible();
  await page.getByLabel("Morning briefing", { exact: true }).fill("08:10");
  await page.getByLabel("Send daily energy briefings", { exact: true }).check();
  await page.locator(".language-switch select").selectOption("bg");
  await expect(page.getByLabel("Сутрешен отчет", { exact: true })).toHaveValue("08:10");
  await page.getByLabel("Текуща парола за таблото", { exact: true }).fill("energy-browser-fixture");
  await page.getByRole("button", { name: "Запиши настройките на известията", exact: true }).click();
  await expect(page.getByText("Енергийните известия са обновени", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Текуща парола за таблото", { exact: true })).toHaveValue("");
  expect(mutations).toHaveLength(1);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll("main *")].filter(element => element.getBoundingClientRect().right > innerWidth && getComputedStyle(element).position !== "fixed").map(element => `${element.tagName}.${element.className} ${element.getBoundingClientRect().right}/${innerWidth}, doc=${document.documentElement.scrollWidth}`).slice(0, 20));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), overflow.join(", ")).toBe(true);
    for (const checkbox of await page.getByRole("checkbox").all()) {
      const box = await checkbox.boundingBox();
      expect(box?.width).toBeLessThanOrEqual(24);
      expect(await checkbox.locator("..").evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(110);
    }
  }
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Изтегли седмичния отчет", exact: true }).click();
  const file = await (await download).path();
  expect(file).not.toBeNull();
  const csv = readFileSync(file!, "utf8");
  expect(csv).toContain("2026-10-20");
  expect(csv).toContain("Разход за мрежова енергия за отчетените периоди");
  expect(csv.trim().split("\r\n")).toHaveLength(8);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.screenshot({ path: "test-results/energy-assistant-bg.png", fullPage: true });
});

test("appliance scheduling saves a manual reminder, marks completion and never sends inverter commands", async ({ page }) => {
  await signIn(page);
  const data = fixture(), commands: string[] = [], bodies: { action: string }[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/commands" && request.method() === "POST") commands.push(request.url()); });
  await page.route("**/api/energy/tools", route => route.fulfill({ json: data }));
  await page.route("**/api/energy/tools/task", async route => {
    const body = route.request().postDataJSON() as { action: string; id: string; name: string; earliestAt: string; deadlineAt: string; reminderEnabled: boolean };
    bodies.push(body);
    if (body.action === "save") {
      expect(body.reminderEnabled).toBe(true);
      data.tasks.push({ id: body.id, revision: "1", name: body.name, powerKw: 2, durationMinutes: 120,
        earliestAt: body.earliestAt, deadlineAt: body.deadlineAt, suggestedAt: body.earliestAt,
        reminderEnabled: true, remindedAt: null, state: "planned", currentBinding: true,
        recommendation: { finishesAt: new Date(Date.parse(body.earliestAt) + 2 * 3600000).toISOString(), estimatedCost: 0.2, solarKwh: 2, energyKwh: 4 } });
    } else { data.tasks[0].state = "done"; data.tasks[0].revision = "2"; }
    await route.fulfill({ json: { accepted: true } });
  });
  await page.goto("/controls/energy-tools");
  await page.getByLabel("Appliance name", { exact: true }).fill("Water heater");
  await page.getByLabel("Remind me when it is time to start", { exact: true }).check();
  await page.getByRole("button", { name: "Find the best time", exact: true }).click();
  await expect(page.getByText("Water heater", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark completed", exact: true }).click();
  await expect(page.getByText("Marked as completed", { exact: true })).toBeVisible();
  expect(bodies.map(body => body.action)).toEqual(["save", "done"]);
  expect(commands).toEqual([]);
});

test("outage coverage hands its target to the existing review flow without starting charging", async ({ page }) => {
  await signIn(page);
  const outage = await (await page.request.get("/api/outage")).json() as OutageData;
  Object.assign(outage, { supported: true, needsCommissioning: false, canPrepare: true, canTest: false, minTarget: 50, maxTarget: 100, preparation: null });
  const changes: string[] = [];
  page.on("request", request => { if (["/api/outage/prepare", "/api/commands"].includes(new URL(request.url()).pathname) && request.method() === "POST") changes.push(request.url()); });
  await page.route("**/api/outage", route => route.fulfill({ json: outage }));
  await page.route("**/api/energy/tools/outage", async route => {
    const body = route.request().postDataJSON() as { startsAt: string; hours: number; mode: string };
    expect(body.hours).toBe(10);
    const estimate: OutageEstimate = { startsAt: body.startsAt, endsAt: new Date(Date.parse(body.startsAt) + 10 * 3600000).toISOString(),
      mode: "essential", targetSoc: 63, currentSoc: 50, shortfallKwh: 0, currentShortfallKwh: 2.4,
      powerShortfallKwh: 0, loadKwh: 10, conservativeSolarKwh: 0, solarCoverage: 0,
      chargingHours: 1.4, chargingKwh: 2.7, readyAt: new Date(Date.now() + 1.4 * 3600000).toISOString(),
      readyBeforeStart: true, feasible: true, powerAssumed: true, estimated: true };
    await route.fulfill({ json: estimate });
  });
  await page.goto("/controls/outage");
  await page.getByText("Plan an outage by hours", { exact: true }).click();
  await page.getByRole("combobox", { name: "Loads to support", exact: true }).selectOption("essential");
  await page.getByRole("button", { name: "Calculate outage coverage", exact: true }).click();
  await expect(page.getByText("Recommended charge target", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Use this target in the charging controls", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Battery target" })).toHaveValue("63");
  expect(changes).toEqual([]);
});

test("an unconfirmed energy preference change requires reading saved state before retry", async ({ page }) => {
  await signIn(page);
  const data = fixture(); let mutations = 0;
  await page.route("**/api/energy/tools", route => route.fulfill({ json: data }));
  await page.route("**/api/energy/tools/preferences", async route => { mutations++; await route.abort("failed"); });
  await page.goto("/controls/energy-tools");
  await page.getByLabel("Current dashboard password", { exact: true }).fill("energy-browser-fixture");
  await page.getByRole("button", { name: "Save briefing preferences", exact: true }).click();
  await expect(page.getByText("The change is unconfirmed. Refresh the saved state before trying again.", { exact: true })).toBeVisible();
  await page.getByLabel("Current dashboard password", { exact: true }).fill("energy-browser-fixture");
  await expect(page.getByRole("button", { name: "Save briefing preferences", exact: true })).toBeDisabled();
  expect(mutations).toBe(1);
  await page.getByRole("button", { name: "Refresh saved state", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save briefing preferences", exact: true })).toBeEnabled();
});
