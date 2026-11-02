import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { Globe2 } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import english from "./locales/en.json";
import bulgarian from "./locales/bg.json";
import { publicLanguage, publicPage, publicRoute } from "./site-seo";

export type Language = "en" | "bg";
const storageKey = "solarman.language";

function preferredLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const pageLanguage = publicLanguage(window.location.pathname);
  if (pageLanguage) return pageLanguage;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "en" || saved === "bg") return saved;
  } catch {
    // Language switching remains available when browser storage is disabled.
  }
  return navigator.language.toLowerCase().startsWith("bg") ? "bg" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: english }, bg: { translation: bulgarian } },
  lng: preferredLanguage(),
  supportedLngs: ["en", "bg"],
  fallbackLng: "en",
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
});

export function updateDocument(language: string): void {
  if (typeof document === "undefined") return;
  const pageLanguage = publicLanguage(window.location.pathname);
  const page = pageLanguage ? publicRoute(window.location.pathname) : null;
  document.documentElement.lang =
    page?.language ?? (language === "bg" ? "bg" : "en");
  document.title = page?.title ?? `Solarman · ${tr("Energy dashboard")}`;
  const description = document.querySelector<HTMLMetaElement>(
    'meta[name="description"]',
  );
  if (description)
    description.content =
      page?.description ??
      tr("Private solar energy monitoring and battery control");
  let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (!robots) {
    robots = document.createElement("meta");
    robots.name = "robots";
    document.head.append(robots);
  }
  robots.content = page ? "index, follow" : "noindex, nofollow";
  let canonical = document.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  );
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach((link) => link.remove());
  if (page) {
    for (const language of ["en", "bg", "x-default"] as const) {
      const link = document.createElement("link");
      link.rel = "alternate";
      link.hreflang = language;
      link.href = publicPage(language === "bg" ? "bg" : "en", page.kind).url;
      document.head.append(link);
    }
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.append(canonical);
    }
    canonical.href = page.url;
    for (const [property, content] of [
      ["og:title", page.title],
      ["og:description", page.description],
      ["og:url", page.url],
      ["og:locale", page.locale],
    ]) {
      let meta = document.querySelector<HTMLMetaElement>(
        `meta[property="${property}"]`,
      );
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("property", property);
        document.head.append(meta);
      }
      meta.content = content;
    }
  } else canonical?.remove();
}
i18n.on("languageChanged", updateDocument);
updateDocument(i18n.language);

export function tr(
  message: string,
  values: Record<string, string | number> = {},
): string {
  if (i18n.exists(message))
    return i18n.t(message, { ...values, defaultValue: message });
  const diagnostics: ReadonlyArray<
    readonly [RegExp, string, readonly string[]]
  > = [
    [
      /^SOLARMAN HTTP status (\d{3})$/,
      "SOLARMAN HTTP status {{code}}",
      ["code"],
    ],
    [
      /^SOLARMAN rejected request \(code (\d{1,12}|unspecified)\)$/,
      "SOLARMAN rejected request (code {{code}})",
      ["code"],
    ],
    [
      /^Device command failed \(code (\d{1,12}|unspecified)\)$/,
      "Device command failed (code {{code}})",
      ["code"],
    ],
    [/^Modbus exception (\d+)$/, "Modbus exception {{code}}", ["code"]],
    [
      /^Missing environment variable: ([A-Z_0-9]+)$/,
      "Missing environment variable: {{name}}",
      ["name"],
    ],
    [/^Invalid integer: ([A-Z_0-9]+)$/, "Invalid integer: {{name}}", ["name"]],
    [
      /^Invalid telemetry value: ([A-Za-z0-9_]{1,64})$/,
      "Invalid telemetry value: {{key}}",
      ["key"],
    ],
    [
      /^([A-Z_0-9]+) must be between (\d+) and (\d+)$/,
      "{{name}} must be between {{min}} and {{max}}",
      ["name", "min", "max"],
    ],
  ];
  for (const [pattern, key, parameters] of diagnostics) {
    const match = pattern.exec(message);
    if (match)
      return i18n.t(
        key,
        Object.fromEntries(
          parameters.map((name, index) => [name, match[index + 1]]),
        ),
      );
  }
  const scheduledWarning =
    "; scheduled AC permission off could not be confirmed";
  if (message.endsWith(scheduledWarning))
    return `${tr(message.slice(0, -scheduledWarning.length))}; ${tr("Scheduled AC permission off could not be confirmed")}`;
  const cleanupWarning = "; grid charging off could not be confirmed";
  if (message.endsWith(cleanupWarning))
    return `${tr(message.slice(0, -cleanupWarning.length))}; ${tr("Grid charging off could not be confirmed")}`;
  const pauseWarning = "; automation pause could not be recorded";
  if (message.endsWith(pauseWarning))
    return `${tr(message.slice(0, -pauseWarning.length))}; ${tr("automation pause could not be recorded")}`;
  return message;
}

export function locale(): string {
  return i18n.resolvedLanguage === "bg" ? "bg-BG" : "en-GB";
}

export function publicHomePath(): string {
  return publicPage(i18n.resolvedLanguage === "bg" ? "bg" : "en").path;
}

export { i18n };

export function LanguageSwitch(): ReactNode {
  const { i18n: instance } = useTranslation();
  const navigate = useNavigate();
  const change = (language: Language): void => {
    const current = publicRoute(window.location.pathname);
    if (current) {
      const destination = publicPage(language, current.kind).path;
      if (destination !== window.location.pathname)
        navigate(destination + window.location.hash);
    }
    void instance.changeLanguage(language);
    try {
      localStorage.setItem(storageKey, language);
    } catch {
      /* The active language still changes when storage is unavailable. */
    }
  };
  return (
    <label className="language-switch">
      <Globe2 size={15} aria-hidden="true" />
      <span className="sr-only">{tr("Language")}</span>
      <select
        aria-label={tr("Language")}
        value={instance.resolvedLanguage ?? "en"}
        onChange={(event) => change(event.target.value === "bg" ? "bg" : "en")}
      >
        <option value="en">English</option>
        <option value="bg">Български</option>
      </select>
    </label>
  );
}
