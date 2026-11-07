import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CalendarClock } from "lucide-react";
import { Panel, Notice } from "./components";
import { request, isUnconfirmedResponse } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { when } from "./format";
import type { OutageWatchData } from "./energy-tools-types";

export function OutageWatch({ data, reload }: { data: OutageWatchData; reload: () => void }): ReactNode {
  const { session } = useWorkspace(), timezone = session.tenant.timezone, watch = data.watch;
  const [editing, setEditing] = useState(false), [kind, setKind] = useState<"area" | "supply-point">("area");
  const [municipality, setMunicipality] = useState(""), [area, setArea] = useState(""), [point, setPoint] = useState("");
  const [areas, setAreas] = useState<{ municipality: string; area: string }[]>([]);
  const [password, setPassword] = useState(""), [consent, setConsent] = useState(false), [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [uncertain, setUncertain] = useState(false);
  const post = async <T,>(path: string, body: object): Promise<T> => request<T>(`/energy/tools/outage-watch${path}`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify(body) });
  const perform = async (action: "save" | "disable" | "check" | "areas"): Promise<void> => {
    if (pending || uncertain) return;
    setPending(true); setMessage(null);
    try {
      if (action === "areas") setAreas(await post("/areas", {}));
      else if (action === "check") {
        const result = await post<{ accepted: boolean; reason?: string }>("/check", {});
        setMessage(result.accepted ? "Outage notices refreshed" : result.reason === "cooldown-or-disabled" ? "Checks are limited to once every five minutes. Refresh the saved state shortly." : "The provider check is unavailable. Use the official portal; no absence of outages has been confirmed.");
      } else {
        await post("", { action, revision: watch?.revision ?? "0", currentPassword: password, consent, reference: kind === "area" ? { kind, municipality, area } : { kind, point } });
        setEditing(false); setPoint(""); setConsent(false); setMessage(action === "save" ? "Outage watch enabled. The first read-only check is pending." : "Outage watch disabled");
      }
      reload();
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save the outage watch");
      if (["save", "disable"].includes(action)) setUncertain(isUnconfirmedResponse(cause));
    } finally { setPassword(""); setPending(false); }
  };
  const stale = !watch?.checkedAt || Date.now() - Date.parse(watch.checkedAt) > 6 * 3600000;
  return <Panel title={tr("Published power cuts")} action={<CalendarClock size={22} />}>
    <p>{tr("Optional read-only checks of ERM Zapad's published plans. Review every notice before preparing the battery.")}</p>
    <a className="text-link" href={data.sourceUrl} target="_blank" rel="noreferrer">{tr("Open ERM Zapad's official portal")}</a>
    {message && <Notice>{tr(message)}</Notice>}
    {uncertain && <Notice><p>{tr("The change is unconfirmed. Refresh the saved state before trying again.")}</p><button className="button secondary" onClick={async () => {
      setPending(true);
      try { await request("/energy/tools"); reload(); setUncertain(false); setEditing(false); }
      catch (cause: unknown) { setMessage(cause instanceof Error ? cause.message : "Unable to refresh saved state"); }
      finally { setPending(false); }
    }} disabled={pending}>{tr("Refresh saved state")}</button></Notice>}
    {watch?.enabled && <>
      <p><strong>{watch.hint}</strong> · {tr(watch.kind === "area" ? "Area notices only" : "Supply-point lookup")}</p>
      {watch.checkedAt && <p className="fine-print">{tr("Last confirmed check")}: {when(watch.checkedAt, timezone)}</p>}
      {!watch.attemptedAt && !watch.checkedAt ? <p>{tr("The first check is pending")}</p> : (watch.code && watch.code !== "ready") || stale ? <Notice>{tr("The provider check is unavailable or old. Existing notices may have changed. Confirm the current situation in the official portal.")}</Notice> : !data.notices.length && <p>{tr("No exact matches in the currently published notices. This does not rule out an outage at your address.")}</p>}
      <button className="button secondary" disabled={pending || uncertain} onClick={() => { void perform("check"); }}>{tr(pending ? "Checking…" : "Check published notices")}</button>
      {data.notices.map(notice => <article className="energy-tools-task" key={notice.id}>
        <strong>{notice.detail}</strong><span>{when(notice.startsAt, timezone)} → {when(notice.endsAt, timezone)}</span>
        <p className="fine-print">{tr(notice.scope === "area" ? "Only part of this area may be affected. Confirm your property in the official portal before preparing." : "Confirm this notice and its times with the provider before preparing.")}</p>
        <Link className={`button secondary${stale || watch.code !== "ready" ? " disabled-link" : ""}`} aria-disabled={stale || watch.code !== "ready"} to={`/controls/outage?notice=${notice.id}`}>{tr("Review battery preparation")}</Link>
      </article>)}
    </>}
    <p className="fine-print">{tr("Published plans can change and do not cover every unannounced outage. One notification summary per day; no automatic charging.")}</p>
    {!editing ? <button className="button secondary" disabled={uncertain} onClick={() => setEditing(true)}>{tr(watch?.enabled ? "Edit outage watch" : "Set up an outage watch")}</button> : <form className="energy-tools-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void perform("save"); }}>
      <label>{tr("Match notices by")}<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="area">{tr("Published municipality and area")}</option><option value="supply-point">{tr("Supply-point code from your bill")}</option></select></label>
      {kind === "area" ? <>
        <button type="button" className="button secondary" disabled={pending || uncertain} onClick={() => { void perform("areas"); }}>{tr("Load currently published areas")}</button>
        {areas.length > 0 && <label>{tr("Choose a published area")}<select defaultValue="" onChange={event => { const selected = areas[Number(event.target.value)]; if (selected) { setMunicipality(selected.municipality); setArea(selected.area); } }}><option value="" disabled>{tr("Choose an area")}</option>{areas.map((item, index) => <option key={`${item.municipality}:${item.area}`} value={index}>{item.municipality} · {item.area}</option>)}</select></label>}
        <label>{tr("Published municipality or city district")}<input required maxLength={80} value={municipality} onChange={event => setMunicipality(event.target.value)} /></label>
        <label>{tr("Published settlement or neighbourhood")}<input required maxLength={80} value={area} onChange={event => setArea(event.target.value)} /></label>
        <p className="fine-print">{tr("Use the provider's exact published names. Area matching cannot confirm an individual address.")}</p>
      </> : <>
        <label>{tr("Supply-point code · 32Z…")}<input required minLength={16} maxLength={16} autoComplete="off" spellCheck={false} value={point} onChange={event => setPoint(event.target.value)} /></label>
        <p className="fine-print">{tr("The code is encrypted and sent only to ERM Zapad for your check. The portal may return an unsupported response; use its official lookup if so.")}</p>
      </>}
      <label className="check-label"><input type="checkbox" required checked={consent} onChange={event => setConsent(event.target.checked)} />{tr("Allow periodic read-only provider checks and a daily notification summary for new notices")}</label>
      <label>{tr("Password to save the outage watch")}<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <div className="readiness-actions"><button className="button secondary" disabled={pending || uncertain || !password || !consent}>{tr("Save outage watch")}</button>{watch?.enabled && <button type="button" className="button secondary" disabled={pending || uncertain || !password} onClick={() => { void perform("disable"); }}>{tr("Disable outage watch")}</button>}<button type="button" className="button secondary" disabled={pending} onClick={() => { setEditing(false); setPassword(""); setPoint(""); }}>{tr("Cancel")}</button></div>
    </form>}
  </Panel>;
}
