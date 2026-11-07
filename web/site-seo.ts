import english from "./locales/en.json";
import bulgarian from "./locales/bg.json";
import routes from "../src/public-site.json";
import { publicDocuments, type InformationKind } from "./public-content";

export type PublicLanguage = "en" | "bg";
export type PublicPageKind = "home" | "demo" | InformationKind;

export interface PublicPage {
  kind: PublicPageKind;
  language: PublicLanguage;
  path: string;
  url: string;
  title: string;
  description: string;
  locale: string;
}

export const SITE_ORIGIN = "https://solarman.jilanov.com";

const paths: Record<PublicPageKind, Record<PublicLanguage, string>> = routes;
const messages = { en: english, bg: bulgarian };

export function publicLanguage(pathname: string): PublicLanguage | null {
  return publicRoute(pathname)?.language ?? null;
}

export function publicRoute(pathname: string): PublicPage | null {
  if (pathname === "/welcome") return publicPage("en");
  for (const kind of Object.keys(paths) as PublicPageKind[]) {
    for (const language of ["en", "bg"] as const) {
      const path = paths[kind][language];
      if (path === pathname || (path !== "/" && path.slice(0, -1) === pathname))
        return publicPage(language, kind);
    }
  }
  return null;
}

export function publicPages(): PublicPage[] {
  return (Object.keys(paths) as PublicPageKind[]).flatMap((kind) =>
    (["en", "bg"] as const).map((language) => publicPage(language, kind)),
  );
}

export function publicPage(
  language: PublicLanguage,
  kind: PublicPageKind = "home",
): PublicPage {
  const document = kind === "home" || kind === "demo" ? null : publicDocuments[language][kind];
  return {
    kind,
    language,
    path: paths[kind][language],
    url: SITE_ORIGIN + paths[kind][language],
    title: kind === "demo" ? (language === "bg" ? "Интерактивно соларно демо | Solarman" : "Interactive solar and battery demo | Solarman") : document
      ? `${document.eyebrow} | Solarman · JILANOVI`
      : messages[language]["Solar and battery app with phone alerts | Solarman"],
    description:
      (kind === "demo" ? (language === "bg" ? "Опитайте без регистрация: променете времето и заряда на примерна батерия и разгледайте плана за дома при спиране на тока." : "Try solar and battery planning without signing up. Change the weather, choose a charge target and explore a simulated household power cut.") : document?.description) ??
      messages[language][
        "Install Solarman on iPhone or Android. Monitor solar, battery and grid, receive phone alerts and plan night charging. Request a demo for your home."
      ],
    locale: language === "bg" ? "bg_BG" : "en_GB",
  };
}
