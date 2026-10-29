import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { useWorkspace } from "./context";
import { tr } from "./i18n";

export function GridChargeControl(): ReactNode {
  const { overview } = useWorkspace();
  const active = overview?.controller.outage?.active;
  return (
    <div className="grid-charge-control">
      <Link
        className="button primary full charge-trigger"
        to="/controls/outage"
      >
        <ShieldCheck size={19} aria-hidden="true" />
        {tr(active ? "Manage outage reserve" : "Prepare for an outage")}
        <ArrowRight size={17} aria-hidden="true" />
      </Link>
      <p className="charge-caption">
        {tr(
          active
            ? "Battery reserved until you return to normal"
            : "Choose a level. Charge and keep it ready.",
        )}
      </p>
    </div>
  );
}
