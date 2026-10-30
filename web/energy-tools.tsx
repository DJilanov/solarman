import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Bell, CalendarClock, Download, Lightbulb, TrendingUp } from "lucide-react";
import { useWorkspace } from "./context";
import { request, useData, isUnconfirmedResponse } from "./api";
import { tr, locale } from "./i18n";
import { formatNumber, when } from "./format";
import { Heading, Loading, Notice, Panel } from "./components";
import { localDateTimeInput, localDateTimeInstant } from "./local-date-time";
import type { EnergyToolsData } from "./energy-tools-types";

function minuteInput(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function parseMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
function money(value: number, currency: string): string {
  return new Intl.NumberFormat(locale(), { style: "currency", currency }).format(value);
}
function downloadReport(report: NonNullable<EnergyToolsData["report"]>): void {
  const columns = [tr("Date"), tr("Coverage"), tr("Solar · kWh"), tr("House · kWh"), tr("Grid import · kWh"), tr("Grid export · kWh"), tr("Recorded grid cost")];
  const lines = report.days.map(day => [day.day, day.coverage, ...[day.solarKwh, day.loadKwh, day.importKwh, day.exportKwh, day.gridCost].map(v => day.coverage > 0 ? v : "")]);
  const csv = [columns, ...lines].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `solarman-week-${report.fromDay}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function EnergyToolsPage(): ReactNode {
  const { session } = useWorkspace(), timezone = session.tenant.timezone;
  const { data, loading, error: loadError, reload } = useData<EnergyToolsData>("/energy/tools", 30000);
  const [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [failed, setFailed] = useState(false);
  const [dirty, setDirty] = useState(false), [enabled, setEnabled] = useState(false);
  const [morning, setMorning] = useState("07:15"), [evening, setEvening] = useState("19:00"), [password, setPassword] = useState("");
  const [name, setName] = useState(""), [power, setPower] = useState("2"), [duration, setDuration] = useState("120");
  const [earliest, setEarliest] = useState(() => localDateTimeInput(Date.now() + 15 * 60000, timezone));
  const [deadline, setDeadline] = useState(() => localDateTimeInput(Date.now() + 8 * 3600000, timezone));
  const [reminder, setReminder] = useState(false), taskId = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!data || dirty) return;
    setEnabled(data.preferences.briefingsEnabled);
    setMorning(minuteInput(data.preferences.morningMinute)); setEvening(minuteInput(data.preferences.eveningMinute));
  }, [data, dirty]);
  const onError = (cause: unknown): void => {
    setFailed(true); setUncertain(isUnconfirmedResponse(cause));
    setMessage(cause instanceof Error ? cause.message : "Unable to save energy tools");
  };
  const post = async (path: string, body: object): Promise<unknown> => request(path, {
    method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify(body),
  });
  const refreshConfirmed = async (): Promise<void> => {
    setPending(true);
    try {
      const current = await request<EnergyToolsData>("/energy/tools");
      if (current.tasks.some(task => task.id === taskId.current)) { taskId.current = crypto.randomUUID(); setName(""); }
      setUncertain(false); setMessage(null); reload();
    } catch (cause: unknown) { onError(cause); }
    finally { setPending(false); }
  };
  const savePreferences = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); if (!data || pending || uncertain) return;
    setPending(true); setMessage(null);
    try {
      await post("/energy/tools/preferences", { revision: data.preferences.revision, briefingsEnabled: enabled,
        morningMinute: parseMinute(morning), eveningMinute: parseMinute(evening), currentPassword: password });
      setDirty(false); setFailed(false); setMessage("Energy briefings updated"); reload();
    } catch (cause: unknown) { onError(cause); }
    finally { setPassword(""); setPending(false); }
  };
  const saveTask = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); if (pending || uncertain) return;
    setPending(true); setMessage(null);
    try {
      await post("/energy/tools/task", { action: "save", id: taskId.current, revision: "0", name,
        powerKw: Number(power), durationMinutes: Number(duration), earliestAt: localDateTimeInstant(earliest, timezone),
        deadlineAt: localDateTimeInstant(deadline, timezone), reminderEnabled: reminder });
      taskId.current = crypto.randomUUID(); setName(""); setFailed(false); setMessage("Appliance plan saved"); reload();
    } catch (cause: unknown) { onError(cause); }
    finally { setPending(false); }
  };
  const taskAction = async (task: EnergyToolsData["tasks"][number], action: "done" | "cancel"): Promise<void> => {
    if (pending || uncertain) return; setPending(true); setMessage(null);
    try { await post("/energy/tools/task", { action, id: task.id, revision: task.revision }); setFailed(false); setMessage("Appliance plan updated"); reload(); }
    catch (cause: unknown) { onError(cause); }
    finally { setPending(false); }
  };
  if (!data) return loading ? <Loading /> : <Notice tone="danger">{loadError ?? tr("Energy tools are unavailable")}</Notice>;
  const locked = pending || uncertain, report = data.report, learning = data.learning;
  return <div className="energy-assistant">
    <Heading eyebrow={tr("PLAN YOUR ENERGY")} title={tr("Energy assistant")}
      description={tr("Plan a power cut, choose appliance times and see what your system achieved.")}
      action={<Link className="button secondary" to="/controls"><ArrowLeft size={16} />{tr("Back to controls")}</Link>} />
    {loadError && <Notice tone="danger">{loadError}</Notice>}
    {message && <Notice tone={failed ? "danger" : undefined}>{tr(message)}</Notice>}
    {uncertain && <Notice><p>{tr("The change is unconfirmed. Refresh the saved state before trying again.")}</p><button className="button secondary" disabled={pending} onClick={() => { void refreshConfirmed(); }}>{tr("Refresh saved state")}</button></Notice>}
    {!data.ready && <Notice>{tr("Complete your installation and tariff settings to use energy planning.")} <Link to="/controls/night-savings">{tr("Review installation settings")}</Link></Notice>}
    <div className="energy-tools-grid">
      <Panel title={tr("Plan a power cut")} action={<CalendarClock size={22} />}>
        <p>{tr("Choose the expected start, duration and essential loads. Get a charge target and review it in the normal charging controls.")}</p>
        <Link className="button secondary" to="/controls/outage">{tr("Plan an outage by hours")}</Link>
      </Panel>
      <Panel title={tr("Daily energy briefings")} action={<Bell size={22} />}>
        <p className="fine-print">{tr("An evening plan and a morning result, delivered to your verified notification devices.")} {timezone}</p>
        <form className="energy-tools-form" onSubmit={event => { void savePreferences(event); }}>
          <label className="check-label"><input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setDirty(true); }} />{tr("Send daily energy briefings")}</label>
          <label>{tr("Morning briefing")}<input required type="time" value={morning} onChange={event => { setMorning(event.target.value); setDirty(true); }} /></label>
          <label>{tr("Evening briefing")}<input required type="time" value={evening} onChange={event => { setEvening(event.target.value); setDirty(true); }} /></label>
          <label>{tr("Current dashboard password")}<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
          <button className="button secondary" type="submit" disabled={locked || !password}>{tr("Save briefing preferences")}</button>
        </form>
        <Link className="text-link" to="/settings/notifications">{tr("Manage notification devices")}</Link>
      </Panel>
    </div>
    <Panel title={tr("Appliance planner")} action={<Lightbulb size={22} />}>
      <p>{tr("Choose a deadline and running time. The planner compares conservative solar surplus and your tariff. Reminders prompt you to start the appliance manually.")}</p>
      <p className="fine-print">{tr("Plans are calculated individually. Avoid overlapping appliances when relying on the same solar surplus.")}</p>
      {!data.forecastFresh && <Notice>{tr("Refresh the solar forecast before saving an appliance plan.")} <Link to="/controls/night-savings">{tr("Review night savings")}</Link></Notice>}
      <form className="energy-tools-form energy-tools-appliance" onSubmit={event => { void saveTask(event); }}>
        <label>{tr("Appliance name")}<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>{tr("Appliance power · kW")}<input type="number" min="0.05" max="50" step="0.05" required value={power} onChange={event => setPower(event.target.value)} /></label>
        <label>{tr("Running time · minutes")}<input type="number" min="15" max="1440" step="1" required value={duration} onChange={event => setDuration(event.target.value)} /></label>
        <label>{tr("Earliest start")}<input type="datetime-local" required value={earliest} onChange={event => setEarliest(event.target.value)} /></label>
        <label>{tr("Finish before")}<input type="datetime-local" required value={deadline} onChange={event => setDeadline(event.target.value)} /></label>
        <label className="check-label"><input type="checkbox" checked={reminder} onChange={event => setReminder(event.target.checked)} />{tr("Remind me when it is time to start")}</label>
        <button className="button secondary" type="submit" disabled={locked || !data.ready || !data.forecastFresh}>{tr("Find the best time")}</button>
      </form>
      {!data.tasks.length ? <p className="fine-print">{tr("Your appliance plans will appear here.")}</p> : <div className="energy-tools-task-list">{data.tasks.map(task => <article className="energy-tools-task" key={task.id}>
        <strong>{task.name}</strong><span>{when(task.suggestedAt, timezone)} → {when(task.recommendation.finishesAt, timezone)}</span>
        <span>{formatNumber(task.recommendation.energyKwh, 1)} kWh · {tr("Estimated cost")}: {money(task.recommendation.estimatedCost, report?.currency ?? "EUR")}</span>
        {!task.currentBinding && <p className="fine-print">{tr("This appliance plan belongs to earlier installation settings. Create a new plan before using its timing.")}</p>}
        <span className="fine-print">{tr(task.state === "done" ? "Marked as completed" : task.state === "cancelled" ? "Cancelled" : task.remindedAt ? "Reminder processed" : task.reminderEnabled ? "Reminder enabled" : "Manual reminder off")}</span>
        {task.state === "planned" && <div className="readiness-actions"><button className="button secondary" disabled={locked} onClick={() => { void taskAction(task, "done"); }}>{tr("Mark completed")}</button><button className="button secondary" disabled={locked} onClick={() => { void taskAction(task, "cancel"); }}>{tr("Cancel plan")}</button></div>}
      </article>)}</div>}
    </Panel>
    {report && <Panel title={tr("Your last seven complete days")} action={<button className="button secondary" onClick={() => downloadReport(report)}><Download size={16} />{tr("Export weekly report")}</button>}>
      <p className="fine-print">{report.fromDay} → {report.throughDay} · {tr("Measured coverage")}: {formatNumber(report.coverage * 100, 1)}%</p>
      <div className="energy-costs"><span>{tr("Recorded grid cost")} <b>{report.coverage > 0 ? money(report.gridCost, report.currency) : "—"}</b></span><span>{tr("Estimated savings from completed plans")} <b>{report.estimatedSavings === null ? "—" : money(report.estimatedSavings, report.currency)}</b></span></div>
      <p className="fine-print">{tr("Costs cover recorded periods at your configured tariffs. Savings compare completed plans with a modelled baseline.")} {!report.wearIncluded && tr("Battery wear is not priced in these estimates.")}</p>
      <div className="readings-table" role="region" aria-label={tr("Weekly energy report")} tabIndex={0}><table><thead><tr>{["Date", "Coverage", "Solar · kWh", "House · kWh", "Grid import · kWh", "Recorded grid cost"].map(label => <th key={label}>{tr(label)}</th>)}</tr></thead><tbody>{report.days.map(day => <tr key={day.day}><td>{day.day}</td><td>{formatNumber(day.coverage * 100, 1)}%</td>{[day.solarKwh, day.loadKwh, day.importKwh].map((value, index) => <td key={index}>{day.coverage > 0 ? formatNumber(value, 1) : "—"}</td>)}<td>{day.coverage > 0 ? money(day.gridCost, report.currency) : "—"}</td></tr>)}</tbody></table></div>
    </Panel>}
    {learning && <Panel title={tr("How the estimates are learning")} action={<TrendingUp size={22} />}>
      <div className="energy-costs"><span>{tr("Qualifying forecast days")} <b>{learning.forecastDays} / 7</b></span><span>{tr("Average absolute solar error")} <b>{learning.meanAbsoluteErrorKwh === null ? "—" : `${formatNumber(learning.meanAbsoluteErrorKwh, 1)} kWh`}</b></span><span>{tr("Observed battery capacity estimate")} <b>{learning.observedFullCapacityKwh === null ? "—" : `${formatNumber(learning.observedFullCapacityKwh, 1)} kWh`}</b></span></div>
      <p className="fine-print">{tr("Forecast learning uses complete measured days and excludes suspected solar curtailment.")}</p>
      {learning.qualifyingCycles === 0 && <p className="fine-print">{tr("Battery learning needs a continuous discharge cycle spanning at least {{change}} percentage points.", { change: learning.requiredSocChange })}</p>}
      <p className="fine-print">{tr("Hourly solar adjustments activate after seven qualifying days for that hour. This can capture recurring morning or evening shading.")}</p>
    </Panel>}
    <Panel title={tr("Recent energy briefings")}>
      {!data.briefings.length ? <p className="fine-print">{tr("Scheduled briefings will appear here after their delivery time.")}</p> : data.briefings.map(briefing => <article className="energy-tools-task" key={`${briefing.day}:${briefing.kind}`}>
        <strong>{tr(briefing.kind === "morning" ? "Morning briefing" : "Evening briefing")} · {when(briefing.createdAt, timezone)}</strong>
        {briefing.payload.currentSoc !== null && <span>{tr("Battery")}: {formatNumber(briefing.payload.currentSoc)}%</span>}
        {briefing.payload.forecastSolarKwh !== null && <span>{tr(briefing.kind === "morning" ? "Expected solar today" : "Expected solar tomorrow")}: {formatNumber(briefing.payload.forecastSolarKwh, 1)} kWh</span>}
        {briefing.payload.plan && <span>{tr("Night target")}: {formatNumber(briefing.payload.plan.targetSoc)}% · {tr("Return to normal")}: {when(briefing.payload.plan.endsAt, timezone)}</span>}
        {briefing.kind === "morning" && briefing.payload.result && <span>{tr(briefing.payload.result.normalRestored ? "Restoration of normal settings is confirmed." : "Review the previous night plan result in the dashboard.")}</span>}
      </article>)}
    </Panel>
  </div>;
}
