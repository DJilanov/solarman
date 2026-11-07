import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plane, ArrowRight, ArrowLeft } from "lucide-react";
import { useWorkspace } from "./context";
import { request, isUnconfirmedResponse } from "./api";
import { Notice, Panel } from "./components";
import { tr } from "./i18n";
import { when, formatNumber } from "./format";
import { localDateTimeInput, localDateTimeInstant } from "./local-date-time";
import type { AwayData, AwayPreview, EnergyToolsData } from "./energy-tools-types";

interface AwayModeProps { data: AwayData; ready: boolean; onSaved: () => void }
type Period = AwayData["periods"][number];
type Review = { action: "save"; id: string; key: string; revision: string; startsAt: string; returnsAt: string; baselineW: number; preview: AwayPreview }
  | { action: "cancel"; id: string; key: string; revision: string; period: Period };

export function AwayMode({ data, ready, onSaved }: AwayModeProps): ReactNode {
  useTranslation();
  const { session } = useWorkspace(), timezone = session.tenant.timezone;
  const initial = Math.ceil((Date.now() + 900000) / 900000) * 900000;
  const [expanded, setExpanded] = useState(false);
  const [departure, setDeparture] = useState(() => localDateTimeInput(initial, timezone));
  const [returns, setReturns] = useState(() => localDateTimeInput(initial + 7 * 86400000, timezone));
  const [baseline, setBaseline] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [failed, setFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const locked = pending || uncertain || !data.canChange;
  useEffect(() => { if (review) heading.current?.focus(); }, [review]);
  const handleError = (cause: unknown): void => {
    setFailed(true); setUncertain(isUnconfirmedResponse(cause));
    setMessage(cause instanceof Error ? cause.message : "Away mode could not be confirmed");
  };
  const preview = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); if (locked) return;
    setPending(true); setMessage(null);
    try {
      const body = { startsAt: localDateTimeInstant(departure, timezone), returnsAt: localDateTimeInstant(returns, timezone), baselineW: Number(baseline) };
      const result = await request<AwayPreview>("/energy/tools/away/preview", {
        method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify(body),
      });
      setReview({ action: "save", id: crypto.randomUUID(), key: crypto.randomUUID(), revision: result.awayRevision, ...body, preview: result });
      setFailed(false);
    } catch (cause: unknown) {
      setFailed(true); setMessage(cause instanceof Error ? cause.message : "Away mode could not be previewed");
    } finally { setPending(false); }
  };
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); if (!review || locked) return;
    setPending(true); setMessage(null);
    try {
      await request("/energy/tools/away", {
        method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken, "idempotency-key": review.key },
        body: JSON.stringify({ action: review.action, id: review.id, revision: review.revision, currentPassword: password,
          ...(review.action === "save" ? { energyRevision: review.preview.energyRevision, startsAt: review.startsAt, returnsAt: review.returnsAt, baselineW: review.baselineW } : {}) }),
      });
      setMessage(review.action === "save" ? "Away dates saved. Normal planning returns automatically." : "Away dates cancelled. Future plans use normal household demand.");
      setFailed(false); setReview(null); setExpanded(false); onSaved();
    } catch (cause: unknown) { handleError(cause); }
    finally { setPassword(""); setPending(false); }
  };
  const refresh = async (): Promise<void> => {
    setPending(true);
    try {
      const current = await request<EnergyToolsData>("/energy/tools");
      const period = current.away.periods.find(p => p.id === review?.id);
      const confirmed = review?.action === "save" ? period?.state === "planned" && period.currentBinding : period?.state === "cancelled";
      setUncertain(false); setFailed(!confirmed);
      setMessage(confirmed ? "The saved Away change is confirmed." : "No matching Away change was found. Review before trying again.");
      if (confirmed) { setReview(null); setExpanded(false); }
      onSaved();
    } catch (cause: unknown) { handleError(cause); }
    finally { setPending(false); }
  };
  const active = data.periods.find(p => p.currentBinding && p.state === "planned" && Date.parse(p.startsAt) <= Date.now() && Date.parse(p.returnsAt) > Date.now());
  const future = data.periods.filter(p => p.state === "planned" && Date.parse(p.returnsAt) > Date.now());
  const previewData = review?.action === "save" ? review.preview : null;
  const max = previewData ? Math.max(0.1, ...previewData.timeline.flatMap(s => [s.normalKw, s.awayKw])) : 1;
  const points = (key: "normalKw" | "awayKw"): string => previewData?.timeline.map((s, index) =>
    `${10 + index / Math.max(1, previewData.timeline.length - 1) * 380},${110 - s[key] / max * 90}`).join(" ") ?? "";
  return <Panel title={tr("Away mode")} action={<Plane size={22} />} className="energy-away-panel">
    <p>{active ? tr("Away planning is active until {{time}}", { time: when(active.returnsAt, timezone) }) : tr("Plan for lower consumption while nobody is home.")}</p>
    <p className="fine-print">{tr("Your reserve and charging limits stay the same. Normal household planning returns on your return date.")}</p>
    {!data.canChange && <Notice>{tr("Away changes are unavailable while this workspace is not active.")}</Notice>}
    {message && <Notice tone={failed ? "danger" : "success"}>{tr(message)}</Notice>}
    {uncertain && <button type="button" className="button secondary" disabled={pending} onClick={() => { void refresh(); }}>{tr("Check saved Away dates")}</button>}
    {review ? <section className="energy-away-review" aria-labelledby="away-review-heading">
      <h3 id="away-review-heading" ref={heading} tabIndex={-1}>{tr(review.action === "save" ? "Review Away planning" : "Cancel this Away period?")}</h3>
      {review.action === "save" ? <>
        <p>{when(review.startsAt, timezone)} <ArrowRight size={14} /> {when(review.returnsAt, timezone)}</p>
        <p>{tr("Essential household demand")}: <strong>{formatNumber(review.baselineW)} W</strong> · {timezone}</p>
        {previewData && <>
          <div className="energy-costs"><span>{tr("Normal forecast demand")} <b>{formatNumber(previewData.normalLoadKwh, 1)} kWh</b></span><span>{tr("With these Away dates")} <b>{formatNumber(previewData.awayLoadKwh, 1)} kWh</b></span></div>
          <figure className="energy-away-chart"><svg viewBox="0 0 400 130" role="img" aria-label={tr("Normal and Away household demand forecast")}><path d="M10 110H390" stroke="currentColor" opacity="0.2" /><polyline points={points("normalKw")} fill="none" stroke="var(--muted)" strokeDasharray="5 4" strokeWidth="2" /><polyline points={points("awayKw")} fill="none" stroke="var(--accent)" strokeWidth="3" /></svg><figcaption>{tr("Dashed: normal demand. Solid: demand with Away mode.")}</figcaption></figure>
          <p className="fine-print">{when(previewData.from, timezone)} → {when(previewData.through, timezone)} · {tr("Estimated next night target")}: {previewData.targetBefore}% → {previewData.targetAfter}%</p>
          {!previewData.appliesInHorizon && <Notice>{tr("These dates are outside the current forecast. They will be used when planning reaches your departure date.")}</Notice>}
        </>}
        <p className="fine-print">{tr("An active night hold stays unchanged. Future automatic plans will use your Away estimate, then return to normal.")}</p>
      </> : <p>{when(review.period.startsAt, timezone)} → {when(review.period.returnsAt, timezone)}</p>}
      <form className="form-grid" onSubmit={event => { void save(event); }}>
        <label>{tr("Current dashboard password")}<input type="password" autoComplete="current-password" required value={password} disabled={locked} onChange={event => setPassword(event.target.value)} /></label>
        <div className="readiness-actions"><button type="button" className="button secondary" disabled={pending || uncertain} onClick={() => { setReview(null); setPassword(""); }}><ArrowLeft size={15} />{tr("Back")}</button><button type="submit" className="button primary" disabled={locked}>{tr(review.action === "save" ? "Confirm Away dates" : "Confirm cancellation")}</button></div>
      </form>
    </section> : <>
      {future.map(period => <article className="energy-tools-task" key={period.id}><strong>{when(period.startsAt, timezone)} → {when(period.returnsAt, timezone)}</strong><span>{tr("Essential household demand")}: {formatNumber(period.baselineW)} W</span>
        {period.normalHistoryAt && <span className="fine-print">{tr("Saved normal-use reference")}: {when(period.normalHistoryAt, timezone)}</span>}
        {!period.currentBinding && <p className="fine-print">{tr("These dates belong to earlier installation settings and are not applied.")}</p>}
        <button type="button" className="button secondary" disabled={locked} onClick={() => { setReview({ action: "cancel", id: period.id, key: crypto.randomUUID(), revision: data.revision, period }); setMessage(null); }}>{tr("Cancel Away period")}</button>
      </article>)}
      {!expanded ? <button type="button" className="button secondary" disabled={locked || !ready} onClick={() => setExpanded(true)}>{tr("Plan Away dates")}</button> : <form className="form-grid" onSubmit={event => { void preview(event); }}>
        <label>{tr("Departure")}<input type="datetime-local" step={900} required value={departure} disabled={locked} onChange={event => setDeparture(event.target.value)} /></label>
        <label>{tr("Return home")}<input type="datetime-local" step={900} required value={returns} disabled={locked} onChange={event => setReturns(event.target.value)} /></label>
        <label>{tr("Essential household demand · W")}<input type="number" min={50} max={20000} step={1} required value={baseline} disabled={locked} onChange={event => setBaseline(event.target.value)} /></label>
        <p className="fine-print">{tr("Estimate what stays on: refrigeration, networking and any heating. This is a planning estimate, not an appliance measurement.")} {timezone}</p>
        <p className="fine-print">{tr("A normal-use estimate is saved for long absences. Fresh household readings refine it after your return.")}</p>
        <button type="submit" className="button primary" disabled={locked}>{tr(pending ? "Calculating…" : "Preview Away plan")}</button>
      </form>}
    </>}
  </Panel>;
}
