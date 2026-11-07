import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Zap, ArrowRight } from "lucide-react";
import { tr, publicHomePath } from "./i18n";
import { publicPage, type PublicPageKind } from "./site-seo";
import { business } from "./business";

export function ProductBrand(): ReactNode {
  return (
    <span className="landing-brand">
      <span className="landing-brand-icon">
        <Zap size={23} strokeWidth={1.7} aria-hidden="true" />
      </span>
      <strong>
        solarman<span>.</span>
      </strong>
    </span>
  );
}

export function PublicAccountLink({
  signedIn,
}: {
  signedIn: boolean;
}): ReactNode {
  return (
    <Link
      className="button secondary landing-login"
      to={signedIn ? "/dashboard" : "/login"}
      aria-label={tr(signedIn ? "Open dashboard" : "Log in")}
    >
      {tr(signedIn ? "Dashboard" : "Log in")}
      <ArrowRight size={15} aria-hidden="true" />
    </Link>
  );
}

export function PublicFooter({
  kind = "home",
  language,
}: {
  kind?: PublicPageKind;
  language: "en" | "bg";
}): ReactNode {
  return (
    <footer className="landing-footer landing-wrap">
      <Link to={publicHomePath()} aria-label={tr("Solarman website")}>
        <ProductBrand />
      </Link>
      <p>
        {business.name}
        <br />
        {tr("Company number")}: {business.companyNumber}
      </p>
      <nav className="landing-language-links" aria-label={tr("Language")}>
        <a href={publicPage("en", kind).path} lang="en" hrefLang="en">
          English
        </a>
        <a href={publicPage("bg", kind).path} lang="bg" hrefLang="bg">
          Български
        </a>
      </nav>
      <nav
        className="public-legal-links"
        aria-label={tr("Service information")}
      >
        <Link to={publicPage(language, "demo").path}>{tr("Try the interactive demo")}</Link>
        <Link to={publicPage(language, "pricing").path}>
          {tr("Services & support")}
        </Link>
        <Link to={publicPage(language, "privacy").path}>{tr("Privacy")}</Link>
        <Link to={publicPage(language, "terms").path}>{tr("Terms")}</Link>
      </nav>
    </footer>
  );
}
