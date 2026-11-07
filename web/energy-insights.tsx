import { useState, type ReactNode } from "react";
import { Activity } from "lucide-react";
import { Panel, Notice } from "./components";
import { request } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { formatNumber, when } from "./format";
import type { EnergyInsightsData, InsightEvidence } from "./energy-tools-types";

function evidenceText(evidence: InsightEvidence): string {
  if (evidence.kind === "consumption-high" && evidence.actualKw !== undefined && evidence.typicalKw !== undefined)
    return tr("One-hour average {{actual}} kW · typical {{typical}} kW · {{days}} reference days", { actual: formatNumber(evidence.actualKw, 1), typical: formatNumber(evidence.typicalKw, 1), days: evidence.referenceDays ?? 0 });
  if (evidence.kind === "solar-low" && evidence.actualKwh !== undefined && evidence.conservativeKwh !== undefined)
    return tr("Two-hour solar {{actual}} kWh · conservative forecast {{expected}} kWh", { actual: formatNumber(evidence.actualKwh, 1), expected: formatNumber(evidence.conservativeKwh, 1) });
  return "";
}
const states: Record<InsightEvidence["state"], string> = {
  unavailable: "More complete readings or a daylight forecast are needed",
  stale: "Waiting for fresh, online inverter readings",
  learning: "Learning your usual household use",
  healthy: "No sustained deviation detected",
  active: "Sustained deviation detected",
  "curtailment-possible": "Solar comparison paused: a full battery may limit production",
};

export function EnergyInsights({ data, reload }: { data: EnergyInsightsData; reload: () => void }): ReactNode {
  const { session } = useWorkspace(), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const acknowledge = async (id: string, action: "seen" | "snooze"): Promise<void> => {
    setPending(true); setError(null);
    try { await request("/energy/tools/insight", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify({ id, action }) }); reload(); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "Unable to update this insight"); }
    finally { setPending(false); }
  };
  const stale = data.checkedAt && Date.now() - Date.parse(data.checkedAt) > 20 * 60000;
  return <Panel title={tr("Energy observations")} action={<Activity size={22} />}>
    <p className="fine-print">{tr("Checks use sustained measured changes, not individual spikes. They do not identify faulty appliances.")}</p>
    {!data.enabled ? <p>{tr("Enable energy observations in the preferences below to start checks and receive bounded advisories.")}</p> : <>
      {data.checkedAt && <p className="fine-print">{tr("Last checked")}: {when(data.checkedAt, session.tenant.timezone)}</p>}
      {stale && <Notice>{tr("These observations are old. Waiting for a fresh check.")}</Notice>}
      <div className="energy-observations">{(["consumption", "solar"] as const).map(kind => {
        const evidence = data.assessment?.[kind];
        return <article key={kind}><strong>{tr(kind === "consumption" ? "Household consumption" : "Solar production")}</strong><p>{tr(evidence ? states[evidence.state] : "The first check is pending")}</p>{evidence && evidenceText(evidence) && <span className="fine-print">{evidenceText(evidence)}</span>}</article>;
      })}</div>
      {data.incidents.filter(item => !item.resolvedAt).map(item => <article key={item.id} className="energy-tools-task">
        <strong>{tr(item.kind === "consumption-high" ? "Sustained high household use" : "Solar below the conservative forecast")}</strong>
        <p>{evidenceText(item.evidence)}</p><p className="fine-print">{tr(item.kind === "consumption-high" ? "Check whether any high-power appliances were left running. Compare with your planned loads." : "Compare the array, shading and inverter status. Cloud forecasts and production estimates can be wrong.")}</p>
        {item.snoozedUntil && Date.parse(item.snoozedUntil) > Date.now() ? <span>{tr("Advisory snoozed until")} {when(item.snoozedUntil, session.tenant.timezone)}</span> : <div className="readiness-actions">
          {!item.seenAt && <button className="button secondary" disabled={pending} onClick={() => { void acknowledge(item.id, "seen"); }}>{tr("Mark as seen")}</button>}
          <button className="button secondary" disabled={pending} onClick={() => { void acknowledge(item.id, "snooze"); }}>{tr("Snooze this advisory for 24 hours")}</button>
        </div>}
      </article>)}
      <p className="fine-print">{tr("At most one opening advisory per type in 24 hours. No recovery notifications.")}</p>
    </>}
    {error && <Notice tone="danger">{tr(error)}</Notice>}
  </Panel>;
}
