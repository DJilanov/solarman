import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createElement, StrictMode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { createServer } from "vite";

const output = new URL("../dist/web/", import.meta.url);
const template = await readFile(new URL("index.html", output), "utf8");
if (!template.includes('<div id="root"></div>'))
  throw new Error("Application shell is missing its empty root");
const manifest = JSON.parse(
  await readFile(new URL(".vite/manifest.json", output), "utf8"),
);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

function metadata(source, page) {
  const headEnd = source.indexOf("</head>");
  if (headEnd < 0) throw new Error("Public HTML head is missing");
  let head = source
    .slice(0, headEnd)
    .replace(/<html lang="[^"]*">/, `<html lang="${page.language}">`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escape(page.title)}</title>`)
    .replace(/\s*<meta\s+name="description"\s+content="[^"]*"\s*\/?>/, "")
    .replace(
      /\s*<meta\s+property="og:(?:title|description|url|locale)"\s+content="[^"]*"\s*\/?>/g,
      "",
    )
    .replace(/\s*<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/, "");
  head += `\n    <meta name="description" content="${escape(page.description)}" />`;
  head += `\n    <meta name="robots" content="${page.url ? "index, follow" : "noindex, nofollow"}" />`;
  if (page.url) {
    head += `\n    <link rel="canonical" href="${escape(page.url)}" />`;
    for (const [property, content] of [
      ["title", page.title],
      ["description", page.description],
      ["url", page.url],
      ["locale", page.locale],
    ])
      head += `\n    <meta property="og:${property}" content="${escape(content)}" />`;
  }
  return head + "\n  " + source.slice(headEnd);
}

const appShell = metadata(template, {
  language: "en",
  title: "Solarman · Energy dashboard",
  description: "Private solar energy monitoring and battery control",
});
await writeFile(new URL("app.html", output), appShell);

const server = await createServer({
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: "custom",
});
try {
  const { default: App } = await server.ssrLoadModule("/App.tsx");
  const { i18n } = await server.ssrLoadModule("/i18n.tsx");
  const { publicPage, publicPages, SITE_ORIGIN } =
    await server.ssrLoadModule("/site-seo.ts");
  function collectStyles(chunk, css = new Set(), visited = new Set()) {
    if (visited.has(chunk.file)) return;
    visited.add(chunk.file);
    for (const file of chunk.css ?? []) css.add(file);
    for (const name of chunk.imports ?? []) {
      if (!manifest[name]) throw new Error(`Missing build chunk: ${name}`);
      collectStyles(manifest[name], css, visited);
    }
    return css;
  }
  const pages = publicPages();
  for (const page of pages) {
    const entry =
      page.kind === "home" ? "landing.tsx" : "public-information.tsx";
    const chunk = manifest[entry];
    if (!chunk)
      throw new Error(
        `Public page is missing from the build manifest: ${entry}`,
      );
    const css = collectStyles(chunk);
    await i18n.changeLanguage(page.language);
    const stream = await renderToReadableStream(
      createElement(
        StrictMode,
        null,
        createElement(
          StaticRouter,
          { location: page.path },
          createElement(App),
        ),
      ),
      { signal: AbortSignal.timeout(30_000) },
    );
    await stream.allReady;
    const content = await new Response(stream).text();
    if (!content.includes("<h1") || content.includes("<script"))
      throw new Error(`Public render is incomplete: ${page.language}`);
    let html = metadata(template, page).replace(
      '<div id="root"></div>',
      () => `<div id="root">${content}</div>`,
    );
    const links = [];
    for (const alternate of pages.filter(
      (candidate) => candidate.kind === page.kind,
    ))
      links.push(
        `<link rel="alternate" hreflang="${alternate.language}" href="${alternate.url}" />`,
      );
    links.push(
      `<link rel="alternate" hreflang="x-default" href="${publicPage("en", page.kind).url}" />`,
    );
    for (const file of css) {
      if (!html.includes(`href="/${file}"`))
        links.push(`<link rel="stylesheet" href="/${file}" />`);
    }
    links.push(`<link rel="modulepreload" href="/${chunk.file}" />`);
    html = html.replace("</head>", links.join("\n    ") + "\n  </head>");
    await mkdir(new URL(page.path.slice(1), output), { recursive: true });
    await writeFile(new URL(page.path.slice(1) + "index.html", output), html);
  }
  await writeFile(
    new URL("robots.txt", output),
    `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /solarman/callback/\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
  );
  await writeFile(
    new URL("sitemap.xml", output),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((page) => `  <url><loc>${page.url}</loc></url>`).join("\n")}\n</urlset>\n`,
  );
  console.log(
    `Prerendered ${pages.length} public pages, robots.txt and sitemap.xml`,
  );
} finally {
  await server.close();
}
