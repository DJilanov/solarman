import { test, expect, type Page } from "@playwright/test";

async function enterWorkspace(page: Page): Promise<void> {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error("Configure private E2E credentials");
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("public landing explains the product, offers a real demo contact and previews controls without commands", async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      mutations.push(new URL(request.url()).pathname);
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Your home energy,/ }),
  ).toBeVisible();
  await expect(
    page.locator("header").getByRole("link", { name: "Log in", exact: true }),
  ).toHaveAttribute("href", "/login");
  await expect(
    page.getByRole("link", { name: "Request a demo", exact: true }).first(),
  ).toHaveAttribute("href", /^mailto:djilanov@gmail\.com\?subject=/);
  await expect(
    page.getByRole("link", { name: "djilanov@gmail.com", exact: true }),
  ).toHaveAttribute("href", "mailto:djilanov@gmail.com");
  await page
    .getByRole("button", { name: "Plan the night", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Plan the night", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".landing-console-caption")).toContainText(
    "Bring the weather forecast",
  );
  await page
    .getByRole("button", { name: "Be outage-ready", exact: true })
    .click();
  await expect(page.locator(".landing-console-caption")).toContainText(
    "Choose a battery target",
  );
  const slider = page.getByRole("slider", {
    name: "Preview your reserve target",
    exact: true,
  });
  await slider.focus();
  await slider.press("End");
  await expect(slider).toHaveValue("100");
  await expect(page.locator(".charge-target")).toHaveAttribute(
    "style",
    /--charge-fill: 100%/,
  );
  await slider.press("Home");
  await expect(slider).toHaveValue("50");
  await expect(page.locator(".charge-target")).toHaveAttribute(
    "style",
    /--charge-fill: 0%/,
  );
  await page
    .getByText("Will it work with my inverter?", { exact: true })
    .click();
  await expect(page.locator(".landing-faq")).toContainText(
    "specifically supported and verified inverter profiles",
  );
  expect(mutations).toEqual([]);
});

test("landing stays readable in both languages across phone, tablet and desktop sizes", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  for (const language of ["en", "bg"]) {
    await page.locator(".language-switch select").selectOption(language);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(page).toHaveTitle(
      language === "bg" ? /Солари и батерия/ : /Solar and battery monitoring/,
    );
    for (const detail of await page.locator(".landing-faq details").all()) {
      if ((await detail.getAttribute("open")) === null)
        await detail.locator("summary").click();
    }
    for (const width of [320, 390, 820, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.locator("h1")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${language} at ${width}px`,
      ).toBeLessThanOrEqual(width);
      const overflow = await page.locator(".landing").evaluate((element) =>
        [...element.querySelectorAll("*")]
          .filter((child) => {
            if (!child.checkVisibility()) return false;
            const box = child.getBoundingClientRect();
            return (
              box.width > 0 && (box.left < -1 || box.right > innerWidth + 1)
            );
          })
          .map((child) => `${child.tagName}.${child.getAttribute("class")}`)
          .slice(0, 12),
      );
      expect(overflow, `${language} at ${width}px`).toEqual([]);
      if (width === 390 || width === 1440) {
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({
          path: `test-results/landing-${language}-${width}.png`,
          fullPage: true,
        });
        await page.screenshot({
          path: `test-results/landing-hero-${language}-${width}.png`,
        });
      }
    }
  }
  expect(errors).toEqual([]);
});

test("landing login opens the existing panel and Home navigation stays inside the workspace", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("header")
    .getByRole("link", { name: "Log in", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await enterWorkspace(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("heading", {
      name: "Your energy, at a glance.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("link", { name: "Home", exact: true }),
  ).toHaveAttribute("href", "/dashboard");
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  await expect(
    page
      .locator("header")
      .getByRole("link", { name: "Open dashboard", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  const dashboardLink = page
    .locator("header")
    .getByRole("link", { name: "Open dashboard", exact: true });
  const box = await dashboardLink.boundingBox();
  if (!box) throw new Error("Dashboard link is not visible");
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await page
    .locator("header")
    .getByRole("link", { name: "Open dashboard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("protected deep links still require login and return to the requested page", async ({
  page,
}) => {
  await page.goto("/settings/security");
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible();
  await enterWorkspace(page);
  await expect(page).toHaveURL(/\/settings\/security$/);
  await expect(
    page.getByRole("heading", { name: "Account security", exact: true }),
  ).toBeVisible();
});

test("public information and demo contact remain available when session checking fails", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Session service unavailable" },
    }),
  );
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Your home energy,");
  await expect(
    page.getByRole("link", { name: "Request a demo", exact: true }).first(),
  ).toBeVisible();
  await page
    .locator("header")
    .getByRole("link", { name: "Log in", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Unable to check your session",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
});

test("installed app entry opens the panel instead of the public website", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList => {
      const result = original(query);
      if (query === "(display-mode: standalone)")
        Object.defineProperty(result, "matches", { value: true });
      return result;
    };
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible();
  const manifest = await page.request.get("/manifest.webmanifest");
  expect((await manifest.json()).start_url).toBe("/dashboard");
});
