import { test, expect } from "@playwright/test";
import { simulateDemo } from "../../web/demo-model";

test("demo physics preserves battery bounds, outage isolation and the value of a prepared reserve", () => {
  for (const scenario of ["sunny", "cloudy", "outage"] as const) for (const target of [20, 50, 100]) for (const mode of ["once", "reserve"] as const) {
    const day = simulateDemo(scenario, target, mode);
    expect(day.slots).toHaveLength(24);
    expect(day.slots.every(slot => Number.isFinite(slot.soc) && slot.soc >= 10 && slot.soc <= 100)).toBe(true);
    expect(day.slots.filter(slot => !slot.gridAvailable).every(slot => slot.gridKw === 0)).toBe(true);
    expect(day.cost).toBeGreaterThanOrEqual(0);
    expect(day.gridKwh).toBeGreaterThanOrEqual(0);
  }
  expect(simulateDemo("cloudy", 70, "once").gridKwh).toBeGreaterThan(simulateDemo("sunny", 70, "once").gridKwh);
  expect(simulateDemo("outage", 100, "reserve").unservedKwh).toBeLessThan(simulateDemo("outage", 20, "once").unservedKwh);
  expect(simulateDemo("sunny", 70, "once").slots.some(slot => slot.soc > 70)).toBe(true);
});

test("anonymous demo works with the backend blocked, supports keyboard review and keeps its state fictional", async ({ page }) => {
  const privateRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) privateRequests.push(request.url()); });
  await page.route("**/api/**", route => route.abort("failed"));
  await page.goto("/demo/");
  await expect(page.getByRole("heading", { name: "Try a day in control." })).toBeVisible();
  await expect(page.getByText("SIMULATED INSTALLATION", { exact: true })).toBeVisible();
  const slider = page.getByRole("slider", { name: "Demo battery target" });
  await slider.focus(); await page.keyboard.press("End");
  await expect(slider).toHaveValue("100");
  await expect(page.getByText("Current simulation: 70% · Charge once overnight", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Six-hour power cut", exact: true }).click();
  await page.getByRole("button", { name: "Review this demo plan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "How should this target work?", exact: true })).toBeFocused();
  await page.getByRole("radio", { name: /Keep energy for a power cut/ }).check();
  await page.getByRole("button", { name: "Apply to simulation", exact: true }).click();
  await expect(page.locator(".demo-plan-state")).toContainText("Demo updated");
  await page.getByRole("slider", { name: "Simulation hour", exact: true }).fill("16");
  await expect(page.getByText("Grid unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("The simulated battery and solar are covering household demand during the power cut.", { exact: true })).toBeVisible();
  await page.getByText("View hourly simulation data", { exact: true }).click();
  await expect(page.getByRole("region", { name: "Hourly demo data" }).locator("tbody tr")).toHaveCount(24);
  await page.getByRole("button", { name: "Reset demo", exact: true }).click();
  await expect(slider).toHaveValue("70");
  await expect(page.getByRole("slider", { name: "Simulation hour", exact: true })).toHaveValue("0");
  expect(privateRequests).toEqual([]);
});

test("demo routes are translated, mobile accessible, prerendered and isolated even after a member signs in", async ({ page, request }) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(process.env.E2E_EMAIL!);
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your energy, at a glance.", exact: true })).toBeVisible();
  const calls: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) calls.push(request.url()); });
  await page.route("**/api/**", route => route.abort("failed"));
  await page.goto("/bg/demo/");
  await expect(page.locator("html")).toHaveAttribute("lang", "bg");
  await expect(page.getByRole("heading", { name: "Управлявайте един примерен ден." })).toBeVisible();
  await page.getByRole("button", { name: "Прегледай този демонстрационен план" }).click();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByRole("button", { name: "Приложи в симулацията" })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.screenshot({ path: "test-results/public-demo-bg-mobile.png", fullPage: true });
  await page.locator(".language-switch select").selectOption("en");
  await expect(page).toHaveURL(/\/demo\/$/);
  await expect(page.getByRole("heading", { name: "Try a day in control." })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: "test-results/public-demo-desktop.png", fullPage: true });
  expect(calls).toEqual([]);
  for (const path of ["/demo/", "/bg/demo/"]) {
    const response = await request.get(path), html = await response.text();
    expect(response.status()).toBe(200);
    expect(html).toContain(`href="https://solarman.jilanov.com${path}"`);
    expect(html).toContain('name="robots" content="index, follow"');
    expect(html).toContain(path === "/demo/" ? "Try a day in control." : "Управлявайте един примерен ден.");
    expect(html).toContain('class="demo-console');
  }
});

test("returning from an internally opened demo checks the current session before reopening private pages", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(process.env.E2E_EMAIL!);
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your energy, at a glance.", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Solarman · Your home energy", exact: true }).click();
  await page.getByRole("link", { name: "Try the interactive demo", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Try a day in control.", exact: true })).toBeVisible();
  const privateRequests: string[] = [];
  await page.route("**/api/auth/session", route => route.fulfill({ status: 401, json: { error: "Sign in to continue" } }));
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/") && path !== "/api/auth/session") privateRequests.push(path); });
  await page.locator("header").getByRole("link", { name: "Open dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your energy, at a glance.", exact: true })).toHaveCount(0);
  expect(privateRequests).toEqual([]);
});
