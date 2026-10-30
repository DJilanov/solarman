import type { ReactNode } from "react";
import type { OverviewData } from "./types";
import { tr } from "./i18n";
import { formatNumber } from "./format";

export function PowerExplanation({ data, stale }: { data: OverviewData; stale: boolean }): ReactNode {
  const { latest, controller } = data;
  if (!latest || stale) return null;
  const reserve = controller.policy.reserveSoc, holding = controller.outage?.active;
  let message: string;
  if (controller.control.recovery.pending)
    message = tr("A previous change is being reconciled. Check the confirmed control state.");
  else if (holding && controller.outage?.state !== "active")
    message = tr("The requested battery mode is being applied or restored. Review its confirmed state before relying on it.");
  else if (holding)
    message = tr(controller.outage?.purpose === "night"
      ? "The battery is being held for daytime use. The night plan will restore your normal reserve."
      : "Stored energy is reserved for an outage. Return to normal when you are ready to use it.");
  else if (latest.batteryW < -100)
    message = latest.pvW - latest.loadW >= 250 && latest.gridW <= 250
      ? tr("Solar surplus is charging the battery after supplying your home.")
      : latest.pvW <= 100 && latest.gridW > latest.loadW + 250
        ? tr("The grid is supplying your home and charging the battery.")
        : tr("The battery is charging. Solar, household demand and grid readings determine the available contribution.");
  else if (latest.batteryW > 100)
    message = tr("The battery is supplying your home and can discharge down to the {{reserve}}% reserve.", { reserve: formatNumber(reserve) });
  else if (latest.soc <= reserve && latest.gridW >= 250)
    message = tr("The battery is preserving the {{reserve}}% reserve. The grid is supplying the remaining household demand.", { reserve: formatNumber(reserve) });
  else if (latest.soc > reserve && latest.soc < reserve + 6 && Math.abs(latest.batteryW) <= 10 && latest.loadW - latest.pvW >= 250 && latest.gridW >= 250)
    message = tr("Near the reserve, the inverter may wait for more charge before using the battery again. Grid import here supplies the home; the battery is idle.");
  else if (latest.pvW >= latest.loadW && latest.pvW > 100)
    message = tr("Solar is covering your household demand. Available surplus can charge the battery or be exported.");
  else message = tr("The battery is idle. Review the latest power flow and the next planned action.");
  return <p className="fine-print" role="status">{message}</p>;
}
