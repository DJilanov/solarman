import { test, expect } from "@playwright/test";

const origin = "https://solarman.jilanov.com";

test("public pages are complete, styled and linked in both languages without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    for (const [path, language, heading] of [
      ["/", "en", "Your home energy."],
      ["/bg/", "bg", "Енергията у дома."],
    ]) {
      const response = await page.goto(`http://localhost:3000${path}`);
      expect(response?.status()).toBe(200);
      await expect(page.locator("h1")).toContainText(heading);
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        origin + path,
      );
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        "index, follow",
      );
      await expect(page.locator('link[hreflang="en"]')).toHaveAttribute(
        "href",
        origin + "/",
      );
      await expect(page.locator('link[hreflang="bg"]')).toHaveAttribute(
        "href",
        origin + "/bg/",
      );
      await expect(page.locator('link[hreflang="x-default"]')).toHaveAttribute(
        "href",
        origin + "/",
      );
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
        "content",
        origin + path,
      );
      await expect(
        page.locator(
          '[itemtype="https://schema.org/WebSite"] [itemprop="name"]',
        ),
      ).toHaveAttribute("content", "Solarman");
      await expect(
        page.locator('.landing-language-links a[href="/bg/"]'),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "sales@jilanov.com", exact: true }),
      ).toHaveAttribute("href", "mailto:sales@jilanov.com");
      expect(
        await page
          .locator(".landing")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).not.toBe("rgba(0, 0, 0, 0)");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      const html = await response!.text();
      expect(html).toContain(heading);
      expect(html).not.toContain('type="application/ld+json"');
    }
    await page.locator('footer a[href="/"]').click();
    await expect(page).toHaveURL("http://localhost:3000/");
    await expect(page.locator("h1")).toContainText("Your home energy.");
  } finally {
    await context.close();
  }
});

test("public HTML hydrates without errors and the URL controls language including browser history", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const expectedGuestSession =
      message.text().includes("401 (Unauthorized)") &&
      message.location().url.endsWith("/api/auth/session");
    if (message.type() === "error" && !expectedGuestSession)
      errors.push(message.text());
  });
  await page.addInitScript(() =>
    localStorage.setItem("solarman.language", "bg"),
  );
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Your home energy.");
  await page
    .getByRole("button", { name: "Be outage-ready", exact: true })
    .click();
  await expect(page.getByRole("slider")).toBeVisible();
  await page.getByRole("slider").press("End");
  await expect(page.getByRole("slider")).toHaveValue("100");
  await page.locator(".language-switch select").selectOption("bg");
  await expect(page).toHaveURL(/\/bg\/$/);
  await expect(page.locator("h1")).toContainText("Енергията у дома.");
  await expect(page).toHaveTitle(/Солари и батерия/);
  await expect(page.getByRole("slider")).toHaveValue("100");
  await page.goBack();
  await expect(page.locator("h1")).toContainText("Your home energy.");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    origin + "/",
  );
  await page.goForward();
  await expect(page.locator("h1")).toContainText("Енергията у дома.");
  await page.reload();
  await expect(page.locator("h1")).toContainText("Енергията у дома.");
  expect(errors).toEqual([]);
});

test("crawling endpoints expose only canonical public URLs and private pages stay noindex", async ({
  request,
}) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  expect(await robots.text()).toContain(`Sitemap: ${origin}/sitemap.xml`);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  const locations = [
    ...(await sitemap.text()).matchAll(/<loc>(.*?)<\/loc>/g),
  ].map((match) => match[1]);
  expect(locations).toEqual(["/", "/bg/", "/demo/", "/bg/demo/", "/pricing/", "/bg/pricing/", "/privacy/", "/bg/privacy/", "/terms/", "/bg/terms/"].map((path) => origin + path));
  for (const path of [
    "/login",
    "/dashboard",
    "/controls/outage",
    "/settings/security",
    "/activate",
    "/recover",
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    const html = await response.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain("djilanov@gmail.com");
  }
  for (const path of [
    "/not-a-real-page",
    "/bg/missing",
    "/app.html",
    "/.vite/manifest.json",
    "/assets/missing.js",
    "/controls/missing.js",
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(404);
    expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  }
  for (const [path, destination] of [
    ["/welcome", "/"],
    ["/index.html", "/"],
    ["/bg", "/bg/"],
    ["/bg/index.html", "/bg/"],
  ]) {
    const response = await request.get(path + "?source=test", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe(destination + "?source=test");
  }
  const head = await request.head("/bg/");
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);
  expect(head.headers()["x-robots-tag"]).toBeUndefined();
});
