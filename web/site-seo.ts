import english from "./locales/en.json";
import bulgarian from "./locales/bg.json";

export type PublicLanguage = "en" | "bg";

export interface PublicPage {
  language: PublicLanguage;
  path: string;
  url: string;
  title: string;
  description: string;
  locale: string;
}

export const SITE_ORIGIN = "https://solarman.jilanov.com";

const paths: Record<PublicLanguage, string> = { en: "/", bg: "/bg/" };
const messages = { en: english, bg: bulgarian };

export function publicLanguage(pathname: string): PublicLanguage | null {
  if (pathname === "/" || pathname === "/welcome") return "en";
  if (pathname === "/bg/" || pathname === "/bg") return "bg";
  return null;
}

export function publicPage(language: PublicLanguage): PublicPage {
  return {
    language,
    path: paths[language],
    url: SITE_ORIGIN + paths[language],
    title: messages[language]["Solar and battery monitoring | Solarman"],
    description:
      messages[language][
        "Monitor solar production, battery reserve and grid use. Plan night charging with the weather forecast. Request a demo for your installation."
      ],
    locale: language === "bg" ? "bg_BG" : "en_GB",
  };
}
