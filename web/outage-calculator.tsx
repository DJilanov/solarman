import { useState, type ReactNode, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { request, useData } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { formatNumber, when } from "./format";
import { Notice, Loading } from "./components";
import { localDateTimeInput, localDateTimeInstant } from "./local-date-time";
import type { OutageEstimate, OutageNotice } from "./energy-tools-types";

export function OutageCalculator({ onTarget }: { onTarget: (target: number) => void }): ReactNode {
  const [search] = useSearchParams(), notice = search.get("notice");
  return notice ? <NoticeCalculator key={notice} id={notice} onTarget={onTarget} /> : <CalculatorForm onTarget={onTarget} />;
}

function NoticeCalculator({ id, onTarget }: { id: string; onTarget: (target: number) => void }): ReactNode {
  const { data, loading, error } = useData<OutageNotice>(`/energy/tools/outage-notices/${encodeURIComponent(id)}`, 60000);
  const [confirmed, setConfirmed] = useState(false), { session } = useWorkspace();
  if (!data) return loading ? <Loading /> : <Notice tone="danger">{tr(error ?? "Outage notice is unavailable")} <Link to="/controls/energy-tools">{tr("Review published power cuts")}</Link></Notice>;
  return <div className="energy-notice-review">
    <strong>{tr("Review this published notice")}</strong><p>{data.detail}</p><p>{when(data.startsAt, session.tenant.timezone)} → {when(data.endsAt, session.tenant.timezone)}</p>
    <a className="text-link" href={data.sourceUrl} target="_blank" rel="noreferrer">{tr("Confirm your property in the official portal")}</a>
    <p className="fine-print">{tr(data.scope === "area" ? "Only part of this area may be affected. Confirm your property in the official portal before preparing." : "Confirm this notice and its times with the provider before preparing.")}</p>
    {error && <Notice tone="danger">{tr(error)}</Notice>}
    <label className="check-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{tr("I confirmed that this notice applies to my property")}</label>
    {confirmed && !error && <CalculatorForm key={`${data.startsAt}:${data.endsAt}`} onTarget={onTarget} notice={data} />}
  </div>;
}

function CalculatorForm({ onTarget, notice }: { onTarget: (target: number) => void; notice?: OutageNotice }): ReactNode {
  const { session } = useWorkspace(), timezone = session.tenant.timezone;
  const [start, setStart] = useState(() => localDateTimeInput(notice ? Math.max(Date.now(), Date.parse(notice.startsAt)) : Date.now() + 4 * 3600000, timezone));
  const [hours, setHours] = useState(() => notice ? String(Math.max(0.25, Math.round((Date.parse(notice.endsAt) - Math.max(Date.now(), Date.parse(notice.startsAt))) / 3600000 * 100) / 100)) : "10"), [mode, setMode] = useState<"household" | "essential">("household");
  const [essential, setEssential] = useState("500"), [result, setResult] = useState<OutageEstimate | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const calculate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setPending(true); setError(null); setResult(null);
    try {
      setResult(await request<OutageEstimate>("/energy/tools/outage", { method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ startsAt: localDateTimeInstant(start, timezone), hours: Number(hours), mode, essentialW: Number(essential) }) }));
    } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "Unable to calculate an outage plan"); }
    finally { setPending(false); }
  };
  return <details className="energy-outage-calculator" open={notice ? true : undefined}>
    <summary>{tr("Plan an outage by hours")}</summary>
    <p className="fine-print">{tr("Enter the expected power cut and choose the loads you want to support.")} {timezone}</p>
    <form onSubmit={event => { void calculate(event); }} className="energy-tools-form">
      <label>{tr("Outage starts")}<input type="datetime-local" required value={start} onChange={event => { setStart(event.target.value); setResult(null); }} /></label>
      <label>{tr("Outage duration · hours")}<input type="number" min="0.25" max="72" step="0.01" required value={hours} onChange={event => { setHours(event.target.value); setResult(null); }} /></label>
      <label>{tr("Loads to support")}<select value={mode} onChange={event => { setMode(event.target.value as typeof mode); setResult(null); }}>
        <option value="household">{tr("Normal household use")}</option><option value="essential">{tr("Essential loads only")}</option>
      </select></label>
      {mode === "essential" && <label>{tr("Essential loads · W")}<input type="number" min="50" max="50000" required value={essential} onChange={event => { setEssential(event.target.value); setResult(null); }} /></label>}
      <button className="button secondary" disabled={pending} type="submit">{tr(pending ? "Calculating outage coverage…" : "Calculate outage coverage")}</button>
    </form>
    {error && <Notice tone="danger">{tr(error)} <Link to="/controls/night-savings">{tr("Review installation settings")}</Link></Notice>}
    {result && <div className="energy-outage-result" aria-live="polite">
      <strong>{tr("Recommended charge target")}: {formatNumber(result.targetSoc)}%</strong>
      <p>{tr("Expected load: {{load}} kWh · conservative solar: {{solar}} kWh", { load: formatNumber(result.loadKwh, 1), solar: formatNumber(result.conservativeSolarKwh, 1) })}</p>
      <p>{tr("Grid charging needed: {{energy}} kWh · about {{hours}} hours", { energy: formatNumber(result.chargingKwh, 1), hours: formatNumber(result.chargingHours, 1) })}</p>
      {!result.feasible && <Notice tone="danger">{tr("Even a full battery has an estimated {{energy}} kWh shortfall. Reduce the planned loads or duration.", { energy: formatNumber(result.shortfallKwh, 1) })}</Notice>}
      {result.powerShortfallKwh > 0.01 && <Notice>{tr("Some planned demand exceeds the battery power used in this estimate.")}</Notice>}
      {result.powerAssumed && <Notice>{tr("Battery power is an unconfirmed planning assumption. Review the installation settings before relying on this estimate.")} <Link to="/controls/night-savings">{tr("Review installation settings")}</Link></Notice>}
      {!result.readyBeforeStart && <Notice>{tr("The estimated charging finish is after the outage starts.")} {when(result.readyAt, timezone)}</Notice>}
      {result.solarCoverage < 0.99 && <p className="fine-print">{tr("Solar outside the available forecast is excluded from this estimate.")}</p>}
      <p className="fine-print">{tr("Coverage is an estimate based on your battery, load and power assumptions.")}</p>
      <button type="button" className="button secondary" onClick={() => onTarget(result.targetSoc)}>{tr("Use this target in the charging controls")}</button>
    </div>}
  </details>;
}
