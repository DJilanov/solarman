import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BatteryCharging, CloudSun, Home, RotateCcw, ShieldCheck, Sun, Zap } from "lucide-react";
import { ChargeTarget } from "./charge-target";
import { ProductBrand, PublicAccountLink, PublicFooter } from "./public-layout";
import { LanguageSwitch, tr, publicHomePath, locale } from "./i18n";
import { formatNumber } from "./format";
import { publicPage, type PublicLanguage } from "./site-seo";
import { simulateDemo, type DemoScenario, type DemoMode } from "./demo-model";
import "./landing.css";
import "./demo.css";

const scenarios: { id: DemoScenario; label: string; icon: typeof Sun }[] = [
  { id: "sunny", label: "Sunny day", icon: Sun }, { id: "cloudy", label: "Cloudy day", icon: CloudSun }, { id: "outage", label: "Six-hour power cut", icon: ShieldCheck },
];

export default function DemoPage({ language, signedIn }: { language: PublicLanguage; signedIn: boolean }): ReactNode {
  const [scenario, setScenario] = useState<DemoScenario>("sunny"), [hour, setHour] = useState(0);
  const [target, setTarget] = useState(70), [applied, setApplied] = useState(70), [mode, setMode] = useState<DemoMode>("once");
  const [draftMode, setDraftMode] = useState<DemoMode>("once"), [review, setReview] = useState(false), [saved, setSaved] = useState(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null), targetInput = useRef<HTMLInputElement>(null);
  const day = simulateDemo(scenario, applied, mode), selected = day.slots[hour];
  const curve = (key: "soc" | "solarKw" | "loadKw", scale: number): string => day.slots.map(slot => `${18 + slot.hour / 23 * 864},${188 - slot[key] / scale * 164}`).join(" ");
  const reset = (): void => { setScenario("sunny"); setHour(0); setTarget(70); setApplied(70); setMode("once"); setDraftMode("once"); setReview(false); setSaved(false); };
  return <div className="landing demo-page">
    <a className="landing-skip" href="#demo-main">{tr("Skip to content")}</a>
    <header className="landing-header landing-wrap">
      <Link to={publicHomePath()} className="landing-logo" aria-label={tr("Solarman website")}><ProductBrand /></Link>
      <div className="landing-header-actions"><LanguageSwitch /><PublicAccountLink signedIn={signedIn} /></div>
    </header>
    <main id="demo-main" className="landing-wrap">
      <div className="demo-heading"><div><span className="landing-eyebrow">{tr("YOUR ENERGY. YOUR CALL.")}</span><h1>{tr("Try a day in control.")}</h1><p>{tr("Change the weather, prepare for a power cut and watch a battery plan unfold.")}</p></div><button type="button" className="button secondary" onClick={reset}><RotateCcw size={16} />{tr("Reset demo")}</button></div>
      <div className="demo-simulation-label" role="note"><span aria-hidden="true" /><strong>{tr("SIMULATED INSTALLATION")}</strong><span>{tr("Fictional 10 kWp solar · 20 kWh battery · no connected devices")}</span></div>
      <div className="demo-scenarios" role="group" aria-label={tr("Choose a demo scenario")}>{scenarios.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={scenario === id} onClick={() => { setScenario(id); setHour(0); setSaved(false); }}><Icon size={20} /><span>{tr(label)}</span></button>)}</div>
      <div className="demo-console-grid">
        <section className="demo-console" aria-labelledby="demo-target-heading"><div className="demo-console-top"><BatteryCharging size={18} /><span>{tr("BATTERY PLAN")}</span><span className="demo-code" aria-hidden="true">SIM / 01</span></div>
          <h2 id="demo-target-heading">{tr("How much energy would you keep?")}</h2>
          <ChargeTarget id="demo-charge-target" label={tr("Demo battery target")} value={target} min={20} max={100} onChange={value => { setTarget(value); setSaved(false); }} dial currentSoc={selected.soc} inputRef={targetInput} />
          <p className="fine-print">{tr("The dial marker shows the battery at the selected hour. The coloured ring is your chosen target.")}</p>
          {!review ? <button type="button" className="button primary" onClick={() => { setDraftMode(mode); setReview(true); setTimeout(() => reviewHeading.current?.focus(), 0); }}>{tr("Review this demo plan")}<ArrowRight size={18} /></button> : <div className="demo-review">
            <h3 tabIndex={-1} ref={reviewHeading}>{tr("How should this target work?")}</h3>
            <fieldset><legend>{tr("Choose a simulated charging mode")}</legend>
              <label><input type="radio" name="demo-mode" value="once" checked={draftMode === "once"} onChange={() => setDraftMode("once")} /><span><strong>{tr("Charge once overnight")}</strong><small>{tr("Reach this target during the night, then use the battery normally.")}</small></span></label>
              <label><input type="radio" name="demo-mode" value="reserve" checked={draftMode === "reserve"} onChange={() => setDraftMode("reserve")} /><span><strong>{tr("Keep energy for a power cut")}</strong><small>{tr("Charge to this reserve and preserve it while grid power is available.")}</small></span></label>
            </fieldset>
            <div className="demo-review-actions"><button type="button" className="button primary" onClick={() => { setApplied(target); setMode(draftMode); setReview(false); setSaved(true); setHour(0); setTimeout(() => targetInput.current?.focus(), 0); }}>{tr("Apply to simulation")}</button><button type="button" className="button secondary" onClick={() => { setReview(false); targetInput.current?.focus(); }}>{tr("Back")}</button></div>
          </div>}
          <p className="demo-plan-state" role="status">{saved ? tr("Demo updated. Explore the timeline to see the result.") : tr("Current simulation: {{target}}% · {{mode}}", { target: applied, mode: tr(mode === "once" ? "Charge once overnight" : "Keep energy for a power cut") })}</p>
        </section>
        <section className="demo-console demo-day" aria-labelledby="demo-day-heading"><div className="demo-console-top"><Zap size={18} /><span>{tr("ENERGY THROUGH THE DAY")}</span><span className="demo-code" aria-hidden="true">24 H</span></div>
          <div className="demo-clock"><h2 id="demo-day-heading">{String(hour).padStart(2, "0")}:00</h2><span className={selected.gridAvailable ? "demo-online" : "demo-offline"}>{tr(selected.gridAvailable ? "Grid available" : "Grid unavailable")}</span></div>
          <div className="demo-meter-grid">{[
            { label: "Solar production", value: selected.solarKw, icon: Sun }, { label: "Household consumption", value: selected.loadKw, icon: Home },
            { label: selected.gridKw > 0.01 ? "Grid import" : selected.gridKw < -0.01 ? "Grid export" : "Grid idle", value: Math.abs(selected.gridKw), icon: Zap },
            { label: selected.batteryKw < -0.01 ? "Battery charging" : selected.batteryKw > 0.01 ? "Battery supplying" : "Battery idle", value: Math.abs(selected.batteryKw), icon: BatteryCharging },
          ].map(({ label, value, icon: Icon }) => <article key={label}><Icon size={19} /><span>{tr(label)}</span><strong>{formatNumber(value, 2)} <small>kW</small></strong></article>)}</div>
          <div className="demo-soc"><span>{tr("Battery")}</span><strong>{formatNumber(selected.soc)}%</strong><div><i style={{ width: `${selected.soc}%` }} /></div></div>
          <label className="demo-hour-label">{tr("Explore the hour")}<input aria-label={tr("Simulation hour")} type="range" min={0} max={23} step={1} value={hour} onChange={event => setHour(Number(event.target.value))} /></label>
          <div className="demo-hour-ends"><span>00:00</span><span>12:00</span><span>23:00</span></div>
          <div className="demo-step-actions"><button type="button" className="button secondary" disabled={hour === 0} onClick={() => setHour(value => value - 1)}>{tr("Previous hour")}</button><button type="button" className="button secondary" disabled={hour === 23} onClick={() => setHour(value => value + 1)}>{tr("Next hour")}</button></div>
          {!selected.gridAvailable && <p className="demo-outage-note">{tr(selected.unservedKwh > 0.01 ? "This simulated battery cannot cover all demand at this hour. Reduce the load or prepare more reserve." : "The simulated battery and solar are covering household demand during the power cut.")}</p>}
        </section>
      </div>
      <section className="demo-console demo-timeline" aria-labelledby="demo-chart-heading"><div className="demo-chart-heading"><h2 id="demo-chart-heading">{tr("One day. The whole picture.")}</h2><span>{tr("Solar and home · left scale 0–6 kW · battery · right scale 0–100%")}</span></div>
        <svg viewBox="0 0 900 218" role="img" aria-label={tr("Simulated solar, household use and battery charge across 24 hours")}>
          {[0, 1, 2, 3].map(value => <line key={value} x1="18" x2="882" y1={24 + value * 54.7} y2={24 + value * 54.7} className="demo-grid-line" />)}
          {scenario === "outage" && <rect x={18 + 15 / 23 * 864} y="16" width={6 / 23 * 864} height="172" className="demo-outage-band" />}
          <polyline points={curve("solarKw", 6)} className="demo-solar-line" /><polyline points={curve("loadKw", 6)} className="demo-load-line" /><polyline points={curve("soc", 100)} className="demo-battery-line" />
          <line x1={18 + hour / 23 * 864} x2={18 + hour / 23 * 864} y1="16" y2="188" className="demo-selected-hour" />
          {[0, 6, 12, 18, 23].map(value => <text key={value} x={18 + value / 23 * 864} y="210" textAnchor={value === 0 ? "start" : value === 23 ? "end" : "middle"}>{String(value).padStart(2, "0")}:00</text>)}
        </svg>
        <div className="demo-legend"><span className="demo-solar-key">{tr("Solar")}</span><span className="demo-load-key">{tr("Home")}</span><span className="demo-battery-key">{tr("Battery")}</span>{scenario === "outage" && <span>{tr("Shaded area: grid outage")}</span>}</div>
        <div className="demo-totals"><article><span>{tr("Solar generated")}</span><strong>{formatNumber(day.solarKwh, 1)} kWh</strong></article><article><span>{tr("Grid energy imported")}</span><strong>{formatNumber(day.gridKwh, 1)} kWh</strong></article><article><span>{tr("Illustrative grid cost")}</span><strong>{new Intl.NumberFormat(locale(), { style: "currency", currency: "EUR" }).format(day.cost)}</strong></article><article><span>{tr("Uncovered outage demand")}</span><strong>{formatNumber(day.unservedKwh, 1)} kWh</strong></article></div>
        <p className="fine-print">{tr("Illustration only: fixed example weather and household use, €0.055/kWh at night and €0.11/kWh by day. This is not a live forecast, bill or guarantee of backup power.")}</p>
        <details className="demo-data"><summary>{tr("View hourly simulation data")}</summary><div className="readings-table" role="region" aria-label={tr("Hourly demo data")} tabIndex={0}><table><thead><tr>{["Hour", "Solar · kW", "House · kW", "Grid · kW", "Battery · %"].map(label => <th key={label}>{tr(label)}</th>)}</tr></thead><tbody>{day.slots.map(slot => <tr key={slot.hour}><td>{String(slot.hour).padStart(2, "0")}:00</td>{[slot.solarKw, slot.loadKw, slot.gridKw, slot.soc].map((value, index) => <td key={index}>{formatNumber(value, 2)}</td>)}</tr>)}</tbody></table></div></details>
      </section>
      <section className="demo-cta"><div><h2>{tr("Now imagine this with your own energy.")}</h2><p>{tr("Real monitoring, weather-based night planning and phone notifications, with controls matched to a supported inverter.")}</p></div><Link className="button primary" to={publicPage(language, "pricing").path}>{tr("Arrange a personal demo")}<ArrowRight size={18} /></Link></section>
    </main><PublicFooter language={language} kind="demo" />
  </div>;
}
