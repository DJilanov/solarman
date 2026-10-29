import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Moon } from "lucide-react";
import { useData } from "./api";
import { Panel, Notice } from "./components";
import { tr } from "./i18n";
import { formatNumber, when } from "./format";
import type { EnergyData } from "./energy-types";
export function EnergySummary(): ReactNode {
  const { data, error } = useData<EnergyData>("/energy", 30000);
  if (!data)
    return error ? (
      <Notice tone="danger">
        {tr("Energy planning is unavailable.")}{" "}
        <Link to="/controls/night-savings">{tr("Review night savings")}</Link>
      </Notice>
    ) : null;
  const night = data.control.active && data.control.purpose === "night",
    nightLabel =
      data.control.state === "active"
        ? "Night savings active"
        : ["restoring", "recovery-required", "quarantined"].includes(
              data.control.state ?? "",
            )
          ? "Returning to normal"
          : "Applying night settings",
    outage = data.control.active && data.control.purpose === "outage",
    plan = data.plan;
  return (
    <Panel title={tr("Energy outlook")} action={<Moon size={20} />}>
      <div className="energy-summary">
        <div>
          <span className="eyebrow">{tr("ACTIVE MODE")}</span>
          <strong>
            {tr(
              outage
                ? "Outage reserve"
                : night
                  ? nightLabel
                  : data.automatic
                    ? "Automatic night savings"
                    : "Normal solar and reserve policy",
            )}
          </strong>
          <p className="fine-print">
            {night &&
            data.control.endsAt &&
            Date.parse(data.control.endsAt) <= Date.now()
              ? tr(
                  "Restoration is pending. Review the confirmed inverter state.",
                )
              : night && data.control.endsAt
                ? tr("Return to daytime use at {{time}}", {
                    time: when(data.control.endsAt, data.profile.timezone),
                  })
                : outage
                  ? tr("Battery reserved until you return to normal")
                  : plan?.state === "scheduled"
                    ? tr("Next night plan starts at {{time}}", {
                        time: when(plan.startsAt, data.profile.timezone),
                      })
                    : tr(
                        "Review tomorrow’s solar before choosing a night top-up.",
                      )}
          </p>
        </div>
        {data.endurance && (
          <div>
            <span className="eyebrow">{tr("ESTIMATED BACKUP")}</span>
            <strong>
              {formatNumber(data.endurance.lowHours, 1)}–
              {formatNumber(data.endurance.highHours, 1)} {tr("hours")}
            </strong>
            <p className="fine-print">
              {tr(
                data.endurance.loadSource === "configured-essential-load"
                  ? "Based on your essential load estimate"
                  : "Based on recent household consumption",
              )}
            </p>
          </div>
        )}
        <Link className="button secondary" to="/controls/night-savings">
          {tr(
            data.missing.length
              ? "Set up energy planning"
              : "Review night savings",
          )}{" "}
          <ArrowRight size={16} />
        </Link>
      </div>
    </Panel>
  );
}
