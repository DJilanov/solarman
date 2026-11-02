import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Mail } from "lucide-react";
import { publicDocuments, type InformationKind } from "./public-content";
import { LanguageSwitch, publicHomePath, tr } from "./i18n";
import { ProductBrand, PublicFooter, PublicAccountLink } from "./public-layout";
import { publicPage, type PublicLanguage } from "./site-seo";
import { business } from "./business";
import "./landing.css";
import "./public-information.css";

export default function PublicInformation({
  kind,
  language,
  signedIn,
}: {
  kind: InformationKind;
  language: PublicLanguage;
  signedIn: boolean;
}): ReactNode {
  const document = publicDocuments[language][kind];
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    const section = anchor ? globalThis.document.getElementById(anchor) : null;
    if (section) section.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [kind, language]);
  return (
    <div className="landing public-information">
      <a className="landing-skip" href="#public-main">
        {tr("Skip to content")}
      </a>
      <header className="landing-header landing-wrap">
        <Link
          to={publicHomePath()}
          className="landing-logo"
          aria-label={tr("Solarman website")}
        >
          <ProductBrand />
        </Link>
        <nav className="public-top-links" aria-label={tr("Website navigation")}>
          <Link to={publicPage(language, "pricing").path}>
            {tr("Services & support")}
          </Link>
        </nav>
        <div className="landing-header-actions">
          <LanguageSwitch />
          <PublicAccountLink signedIn={signedIn} />
        </div>
      </header>
      <main id="public-main" className="landing-wrap">
        <div className="public-document-heading">
          <span className="landing-eyebrow">{document.eyebrow}</span>
          <h1>{document.title}</h1>
          <p>{document.introduction}</p>
          {kind === "pricing" && (
            <a
              className="button primary"
              href={`mailto:${business.email}?subject=${encodeURIComponent(tr("Solarman demo request"))}`}
            >
              {tr("Request a demo")}
              <ArrowRight size={18} aria-hidden="true" />
            </a>
          )}
        </div>
        <div className="public-document-grid">
          <aside>
            <nav aria-label={tr("On this page")}>
              {document.sections.map((section) => (
                <a key={section.id} href={`#${section.id}`}>
                  {section.title}
                </a>
              ))}
            </nav>
          </aside>
          <article className="public-document-content">
            {document.sections.map((section) => (
              <section key={section.id} id={section.id}>
                <h2>{section.title}</h2>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {section.link && (
                  <a className="public-reference" href={section.link.url}>
                    {section.link.text}
                    <ArrowRight size={14} aria-hidden="true" />
                  </a>
                )}
              </section>
            ))}
            <address className="public-provider">
              <strong>{business.name}</strong>
              <span>
                {tr("Company number")}: {business.companyNumber} ·{" "}
                {tr("VAT number")}: {business.vatNumber}
              </span>
              <span>{business.address}</span>
              <span>
                {tr("Representative")}: {business.representative}
              </span>
              <a href={`mailto:${business.email}`}>
                <Mail size={16} aria-hidden="true" />
                {business.email}
              </a>
            </address>
            <p className="public-version">
              {tr("Version")}: {business.policyVersion}
            </p>
          </article>
        </div>
      </main>
      <PublicFooter kind={kind} language={language} />
    </div>
  );
}
