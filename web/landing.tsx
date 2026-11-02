import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowRight,
  BatteryCharging,
  Bell,
  Check,
  ChevronDown,
  CloudSun,
  Home,
  LockKeyhole,
  Moon,
  PlugZap,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Zap,
} from "lucide-react";
import { ChargeTarget } from "./charge-target";
import { LanguageSwitch, tr } from "./i18n";
import "./landing.css";

type PreviewMode = "solar" | "night" | "reserve";

interface LandingProps {
  signedIn: boolean;
}

const modes: { id: PreviewMode; label: string; description: string }[] = [
  {
    id: "solar",
    label: "Solar first",
    description:
      "Use your solar production at home and store the surplus for later.",
  },
  {
    id: "night",
    label: "Plan the night",
    description:
      "Bring the weather forecast, household use and your electricity tariff into one charging plan.",
  },
  {
    id: "reserve",
    label: "Be outage-ready",
    description:
      "Choose a battery target and keep that energy reserved until you return to normal mode.",
  },
];

function ProductBrand(): ReactNode {
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

function EnergyPreview(): ReactNode {
  const [mode, setMode] = useState<PreviewMode>("solar");
  const selected = modes.find((item) => item.id === mode)!;
  const status =
    mode === "solar"
      ? "Store the surplus"
      : mode === "night"
        ? "Charge with a plan"
        : "Keep your reserve";
  return (
    <div className={`landing-console landing-mode-${mode}`}>
      <div className="landing-console-head">
        <span>
          <i aria-hidden="true" />
          {tr("INTERACTIVE PREVIEW")}
        </span>
        <span className="landing-console-code" aria-hidden="true">
          SM / 01
        </span>
      </div>
      <div
        className="landing-preview-modes"
        role="group"
        aria-label={tr("Explore energy scenarios")}
      >
        {modes.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={mode === item.id}
            onClick={() => setMode(item.id)}
          >
            {tr(item.label)}
          </button>
        ))}
      </div>
      <div className="landing-flow">
        <svg
          className="landing-flow-wires"
          viewBox="0 0 520 330"
          preserveAspectRatio="none"
          fill="none"
          aria-hidden="true"
        >
          <path
            className="landing-wire landing-wire-solar"
            d="M130 85H220Q260 85 260 125V165"
          />
          <path
            className="landing-wire landing-wire-grid"
            d="M390 85H300Q260 85 260 125V165"
          />
          <path
            className="landing-wire landing-wire-battery"
            d="M260 165V285"
          />
          <circle cx="260" cy="165" r="7" />
        </svg>
        <div className="landing-device landing-solar">
          <Sun size={25} strokeWidth={1.5} aria-hidden="true" />
          <span>{tr("Solar")}</span>
          <small>
            {tr(mode === "solar" ? "Producing power" : "Weather matters")}
          </small>
        </div>
        <div className="landing-device landing-grid">
          <PlugZap size={25} strokeWidth={1.5} aria-hidden="true" />
          <span>{tr("Grid")}</span>
          <small>
            {tr(
              mode === "solar" ? "When you need it" : "Your tariff, considered",
            )}
          </small>
        </div>
        <div className="landing-device landing-house">
          <Home size={31} strokeWidth={1.3} aria-hidden="true" />
          <span>{tr("Your home")}</span>
        </div>
        <div className="landing-device landing-battery">
          <BatteryCharging size={25} strokeWidth={1.5} aria-hidden="true" />
          <span>{tr("Battery")}</span>
          <small>{tr(status)}</small>
        </div>
        <div className="landing-flow-label" aria-hidden="true">
          {tr(
            mode === "solar" ? "SOLAR" : mode === "night" ? "NIGHT" : "RESERVE",
          )}
        </div>
      </div>
      <div className="landing-console-caption" aria-live="polite">
        <span className="landing-caption-icon">
          <Radio size={17} aria-hidden="true" />
        </span>
        <p>{tr(selected.description)}</p>
      </div>
      <div className="landing-console-foot">
        <span>{tr("A preview of the possibilities")}</span>
        <span>{tr("No installation connected")}</span>
      </div>
      <span className="landing-screw landing-screw-a" aria-hidden="true" />
      <span className="landing-screw landing-screw-b" aria-hidden="true" />
    </div>
  );
}

export default function LandingPage({ signedIn }: LandingProps): ReactNode {
  useTranslation();
  const [target, setTarget] = useState(80);
  const workspaceUrl = signedIn ? "/dashboard" : "/login";
  const demoUrl = `mailto:djilanov@gmail.com?subject=${encodeURIComponent(tr("Solarman demo request"))}`;
  return (
    <div className="landing">
      <a className="landing-skip" href="#landing-main">
        {tr("Skip to content")}
      </a>
      <header className="landing-header landing-wrap">
        <Link
          to="/"
          className="landing-logo"
          aria-label={tr("Solarman website")}
        >
          <ProductBrand />
        </Link>
        <nav aria-label={tr("Product navigation")}>
          <a href="#possibilities">{tr("What you can do")}</a>
          <a href="#getting-started">{tr("How it works")}</a>
          <a href="#questions">{tr("Questions")}</a>
        </nav>
        <div className="landing-header-actions">
          <LanguageSwitch />
          <Link
            className="button secondary landing-login"
            to={workspaceUrl}
            aria-label={tr(signedIn ? "Open dashboard" : "Log in")}
          >
            {tr(signedIn ? "Dashboard" : "Log in")}
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </header>
      <main id="landing-main">
        <section
          className="landing-hero landing-wrap"
          aria-labelledby="landing-title"
        >
          <div className="landing-hero-copy">
            <span className="landing-eyebrow">
              <span className="landing-signal" aria-hidden="true" />
              {tr("A LITTLE MORE CONTROL. A LOT MORE CLARITY.")}
            </span>
            <h1 id="landing-title">
              {tr("Your home energy,")}
              <br />
              <span>{tr("working together.")}</span>
            </h1>
            <p className="landing-lead">
              {tr(
                "Solar, battery and grid in one clear view. Understand your energy, prepare for the unexpected and make a plan for tomorrow.",
              )}
            </p>
            <div className="landing-hero-actions">
              <a className="button primary" href={demoUrl}>
                {tr("Request a demo")}
                <ArrowRight size={18} aria-hidden="true" />
              </a>
              <a className="landing-explore" href="#possibilities">
                {tr("See what is possible")}
                <ArrowDown size={16} aria-hidden="true" />
              </a>
            </div>
            <p className="landing-hero-note">
              <LockKeyhole size={14} aria-hidden="true" />
              {tr("Your installation. Your own private workspace.")}
            </p>
          </div>
          <div className="landing-hero-visual">
            <EnergyPreview />
          </div>
        </section>
        <div
          className="landing-capabilities landing-wrap"
          aria-label={tr("At a glance")}
        >
          <span>
            <Sun size={18} aria-hidden="true" />
            {tr("Solar monitoring")}
          </span>
          <span>
            <BatteryCharging size={18} aria-hidden="true" />
            {tr("Battery reserve")}
          </span>
          <span>
            <CloudSun size={18} aria-hidden="true" />
            {tr("Weather-aware planning")}
          </span>
          <span>
            <Bell size={18} aria-hidden="true" />
            {tr("Phone notifications")}
          </span>
        </div>
        <section
          className="landing-section landing-wrap"
          id="possibilities"
          aria-labelledby="possibilities-title"
        >
          <div className="landing-section-heading">
            <span className="landing-eyebrow">
              {tr("LESS GUESSWORK. MORE UNDERSTANDING.")}
            </span>
            <h2 id="possibilities-title">
              {tr("Built around the things")}
              <br />
              {tr("you actually want to do.")}
            </h2>
            <p>
              {tr(
                "A useful energy tool should make everyday decisions feel simple.",
              )}
            </p>
          </div>
          <div className="landing-feature-grid">
            <article className="landing-feature">
              <span className="landing-feature-number">
                01 / {tr("UNDERSTAND")}
              </span>
              <div
                className="landing-feature-art landing-insight-art"
                aria-hidden="true"
              >
                <Sun />
                <span />
                <Home />
                <span />
                <BatteryCharging />
              </div>
              <h3>{tr("Where is my power going?")}</h3>
              <p>
                {tr(
                  "See solar production, household demand, battery activity and grid use together. Explore your history when you want the fuller picture.",
                )}
              </p>
              <span className="landing-feature-detail">
                <ActivityMark />
                {tr("A clear overview, with history behind it")}
              </span>
            </article>
            <article className="landing-feature">
              <span className="landing-feature-number">
                02 / {tr("PREPARE")}
              </span>
              <div
                className="landing-feature-art landing-reserve-art"
                aria-hidden="true"
              >
                <ShieldCheck size={45} strokeWidth={1.1} />
                <span>{tr("YOUR RESERVE")}</span>
              </div>
              <h3>{tr("Can I keep energy for later?")}</h3>
              <p>
                {tr(
                  "Choose a battery reserve target before an expected outage. With supported controls, charge towards it and keep it reserved until you return to normal.",
                )}
              </p>
              <a className="landing-feature-detail" href="#reserve-preview">
                {tr("Try the reserve slider")}
                <ArrowRight size={15} aria-hidden="true" />
              </a>
            </article>
            <article className="landing-feature">
              <span className="landing-feature-number">03 / {tr("PLAN")}</span>
              <div
                className="landing-feature-art landing-plan-art"
                aria-hidden="true"
              >
                <Moon size={29} />
                <ArrowRight size={20} />
                <CloudSun size={37} />
                <ArrowRight size={20} />
                <BatteryCharging size={29} />
              </div>
              <h3>{tr("What about tomorrow?")}</h3>
              <p>
                {tr(
                  "Combine the solar forecast, recent household use and your day and night prices. Compare a charging recommendation before choosing a plan.",
                )}
              </p>
              <span className="landing-feature-detail">
                <CloudSun size={16} aria-hidden="true" />
                {tr("Forecasts and costs, with assumptions visible")}
              </span>
            </article>
          </div>
        </section>
        <section
          className="landing-reserve-section"
          id="reserve-preview"
          aria-labelledby="reserve-title"
        >
          <div className="landing-wrap landing-reserve-layout">
            <div>
              <span className="landing-eyebrow">
                {tr("A CONTROL THAT MAKES SENSE")}
              </span>
              <h2 id="reserve-title">
                {tr("Choose a target.")}
                <br />
                <span>{tr("Keep a little peace of mind.")}</span>
              </h2>
              <p>
                {tr(
                  "Know about a long power cut ahead of time? Prepare the battery for the energy you want to keep, then return to your normal reserve when you are ready.",
                )}
              </p>
              <ul className="landing-checks">
                <li>
                  <Check size={17} aria-hidden="true" />
                  {tr("A percentage you choose")}
                </li>
                <li>
                  <Check size={17} aria-hidden="true" />
                  {tr("A clear review before sending commands")}
                </li>
                <li>
                  <Check size={17} aria-hidden="true" />
                  {tr("Return to normal when you decide")}
                </li>
              </ul>
            </div>
            <div className="landing-reserve-preview">
              <span className="landing-eyebrow">{tr("TRY THE CONTROL")}</span>
              <ChargeTarget
                id="landing-target"
                label={tr("Preview your reserve target")}
                value={target}
                min={50}
                max={100}
                onChange={setTarget}
                dial
              />
              <p>
                {tr(
                  "This is a preview. Moving the slider does not control an inverter.",
                )}
              </p>
            </div>
          </div>
        </section>
        <section
          className="landing-section landing-wrap landing-connection"
          id="getting-started"
          aria-labelledby="getting-started-title"
        >
          <div className="landing-section-heading">
            <span className="landing-eyebrow">
              {tr("YOUR SYSTEM, IN YOUR SPACE")}
            </span>
            <h2 id="getting-started-title">
              {tr("A familiar system.")}
              <br />
              {tr("A more useful view.")}
            </h2>
            <p>
              {tr(
                "Solarman brings together monitoring and supported controls for installations connected through SOLARMAN OpenAPI.",
              )}
            </p>
          </div>
          <ol className="landing-steps">
            <li>
              <span className="landing-step-icon">
                <LockKeyhole size={24} strokeWidth={1.5} aria-hidden="true" />
              </span>
              <small>01</small>
              <h3>{tr("Get your workspace")}</h3>
              <p>
                {tr(
                  "Access is currently by invitation. Each workspace keeps its installation, account and preferences separate.",
                )}
              </p>
            </li>
            <li>
              <span className="landing-step-icon">
                <PlugZap size={24} strokeWidth={1.5} aria-hidden="true" />
              </span>
              <small>02</small>
              <h3>{tr("Connect your installation")}</h3>
              <p>
                {tr(
                  "Link your SOLARMAN account and the required OpenAPI credentials. Monitoring starts with your own installation data.",
                )}
              </p>
            </li>
            <li>
              <span className="landing-step-icon">
                <SlidersHorizontal
                  size={24}
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              </span>
              <small>03</small>
              <h3>{tr("Make it yours")}</h3>
              <p>
                {tr(
                  "Set your tariff and battery preferences. Hardware control is enabled only after compatibility and commissioning checks.",
                )}
              </p>
            </li>
          </ol>
        </section>
        <section className="landing-details-band">
          <div className="landing-wrap">
            <div>
              <Bell size={25} strokeWidth={1.4} aria-hidden="true" />
              <h3>{tr("Stay in the loop")}</h3>
              <p>
                {tr(
                  "Receive supported browser notifications on your phone for system alerts and energy briefings.",
                )}
              </p>
            </div>
            <div>
              <LockKeyhole size={25} strokeWidth={1.4} aria-hidden="true" />
              <h3>{tr("A workspace of your own")}</h3>
              <p>
                {tr(
                  "Your installation’s readings, preferences and control history stay together in your own private workspace.",
                )}
              </p>
            </div>
            <div>
              <CloudSun size={25} strokeWidth={1.4} aria-hidden="true" />
              <h3>{tr("An honest forecast")}</h3>
              <p>
                {tr(
                  "Solar production and savings are estimates. See the forecast, its age and the assumptions behind each recommendation.",
                )}
              </p>
            </div>
          </div>
        </section>
        <section
          className="landing-section landing-wrap landing-faq"
          id="questions"
          aria-labelledby="questions-title"
        >
          <div className="landing-section-heading">
            <span className="landing-eyebrow">{tr("GOOD TO KNOW")}</span>
            <h2 id="questions-title">{tr("A few clear answers.")}</h2>
          </div>
          <div className="landing-faq-list">
            {[
              [
                "Will it work with my inverter?",
                "Monitoring requires a compatible SOLARMAN OpenAPI connection. Battery commands are available only for specifically supported and verified inverter profiles. Compatibility is checked before control is enabled.",
              ],
              [
                "Does it replace my inverter or battery protections?",
                "No. Your inverter and battery management system keep their native protections. The dashboard helps you monitor and request supported settings; it does not provide the physical backup equipment.",
              ],
              [
                "What happens if the internet goes down?",
                "The inverter continues according to its native settings. Cloud readings and commands can be delayed or unavailable, and a planned setting change cannot be guaranteed while the inverter is unreachable.",
              ],
              [
                "Can I use it on my phone?",
                "Yes. The dashboard adapts to smaller screens, supports English and Bulgarian, and can be added to your home screen. Notifications depend on your browser and device permissions.",
              ],
              [
                "Can I create an account today?",
                "New workspaces are currently set up by invitation. Request a demo and we can discuss access and installation compatibility.",
              ],
            ].map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {tr(question)}
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <p>{tr(answer)}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="landing-wrap landing-final" id="demo">
          <div>
            <span className="landing-eyebrow">
              {tr("LET’S TALK ABOUT YOUR HOME")}
            </span>
            <h2>{tr("See it with your own eyes.")}</h2>
            <p>
              {tr(
                "We can walk you through a demo and check what makes sense for your installation.",
              )}
            </p>
          </div>
          <div className="landing-final-actions">
            <a className="button primary" href={demoUrl}>
              {tr("Request a demo")}
              <ArrowRight size={18} aria-hidden="true" />
            </a>
            <a className="landing-email" href="mailto:djilanov@gmail.com">
              djilanov@gmail.com
            </a>
          </div>
        </section>
      </main>
      <footer className="landing-footer landing-wrap">
        <Link to="/" aria-label={tr("Solarman website")}>
          <ProductBrand />
        </Link>
        <p>{tr("An independent home energy workspace.")}</p>
        <a href="#questions">{tr("Compatibility & questions")}</a>
      </footer>
    </div>
  );
}

function ActivityMark(): ReactNode {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M1 11h4l3-7 4 13 3-6h4" />
    </svg>
  );
}
