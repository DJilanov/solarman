import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";

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
  await page.setViewportSize({ width: 390, height: 844 });
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
