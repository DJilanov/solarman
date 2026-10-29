import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { tr } from "./i18n";

export function HistoryNavigation(): ReactNode {
  return (
    <nav className="history-navigation" aria-label={tr("History sections")}>
      <NavLink to="/analytics">{tr("Energy history")}</NavLink>
      <NavLink to="/activity">{tr("Actions and events")}</NavLink>
    </nav>
  );
}
