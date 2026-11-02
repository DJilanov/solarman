# Public search discovery

The public English page is `https://solarman.jilanov.com/` and the Bulgarian page is `https://solarman.jilanov.com/bg/`. Both are rendered from the actual React landing page during `npm run build`, including its lazy-loaded styles. Hydration restores the interactive preview. No customer readings, session state or provider credentials are included in this HTML.

Each language has its own title, description, canonical URL and Open Graph metadata. Reciprocal English/Bulgarian `hreflang` links and an English `x-default` connect the versions. The URL determines the public language; private pages continue to use the saved language preference. Footer links also allow switching without JavaScript. WebSite microdata describes the site without weakening the script CSP.

The build generates `/robots.txt` and `/sitemap.xml`. The sitemap lists only the two canonical public pages. `/welcome` and explicit public `index.html` paths permanently redirect to their canonical URL. Unknown public routes return HTTP 404. Login and workspace routes use a separate empty application shell with both a robots meta tag and an `X-Robots-Tag: noindex, nofollow` response header. These are indexing instructions; authentication and tenant isolation remain the access controls. API and callback paths are excluded from crawling, and private page paths remain crawlable so Google can see their noindex instruction.

## Search Console

Use the URL-prefix property `https://solarman.jilanov.com/` in [Google Search Console](https://search.google.com/search-console). Ownership was confirmed in the existing owner's native Chrome session on 2 November 2026. Keep the existing Google ownership verification in place.

After deployment, submit `https://solarman.jilanov.com/sitemap.xml` under Sitemaps. Inspect `/` and `/bg/`, run the live URL test and request indexing if Google permits it. Confirm that the live test can fetch the page and its assets through Cloudflare. Never disable dashboard authentication for a crawler.

Monitor Pages for exclusion/fetch errors and Performance for actual impressions, queries and clicks. A submitted sitemap and a successful live test do not prove indexing or ranking. Google says crawling can take days to weeks and indexing is not guaranteed. Avoid repeatedly requesting the same URL.

## Content and acquisition plan

These are intended search topics, not measured keyword volumes:

1. Bulgarian solar monitoring: a useful guide to reading photovoltaic production, household demand, grid import and battery flow. Link to the demo from the explanation.
2. Night charging: explain how day/night prices, weather predictions, recent consumption and battery reserve affect a charging plan. Use explicit assumptions and measured results when available; do not promise a fixed saving.
3. Battery reserve before an outage: explain the user workflow and the installation requirements for actual backup power.
4. Compatibility: publish the supported Bluesun BSE20KH3 profile and connection requirements accurately. Do not imply that every inverter supported by SOLARMAN monitoring also supports this application's controls.

Create original Bulgarian and English pages only when there is enough substantive material for each. Add their routes to public client routing, static HTTP serving, prerendering and the sitemap together, with real internal links. Do not create thin keyword, city or model variants. Obtain consent and anonymize installation details before publishing a customer case study.

Seek relevant links from actual installers, technical partners and useful community contributions. A product demo or measured case study gives those links a reason to exist. Do not buy bulk backlinks or fabricate testimonials. The existing SOLARMAN vendor already uses this name, so make the independent product identity clear; a future naming decision should consider that search competition.

The current demo action opens a local email draft. Do not count a button click as a completed lead. Track qualified demo requests manually initially, alongside Search Console data. If analytics or a contact form is later introduced, decide its privacy and consent behavior explicitly.

## Verification

`test/e2e/seo.spec.ts` checks full HTML and styling without JavaScript, metadata and language links, hydration and browser history, sitemap and robots responses, private noindex headers, redirects and real 404s. The landing tests cover interactive previews, phone/tablet/desktop layouts, login, deep links and installed-app entry.

Google references: [JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics), [multilingual URLs](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites), [noindex](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag), [indexing requests](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl).
