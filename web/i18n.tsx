import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { Globe2 } from "lucide-react";
import type { ReactNode } from "react";
import english from "./locales/en.json";
import bulgarian from "./locales/bg.json";

export type Language = "en" | "bg";
const storageKey = "solarman.language";

function preferredLanguage(): Language {
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

function updateDocument(language: string): void {
  document.documentElement.lang = language === "bg" ? "bg" : "en";
  document.title = `Solarman · ${tr("Energy dashboard")}`;
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
  const cleanupWarning = "; grid charging off could not be confirmed";
  if (message.endsWith(cleanupWarning))
    return `${tr(message.slice(0, -cleanupWarning.length))}; ${tr("Grid charging off could not be confirmed")}`;
  return message;
}

export function locale(): string {
  return i18n.resolvedLanguage === "bg" ? "bg-BG" : "en-GB";
}

export function LanguageSwitch(): ReactNode {
  const { i18n: instance } = useTranslation();
  const change = (language: Language): void => {
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
