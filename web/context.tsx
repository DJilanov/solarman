import { createContext, useContext } from "react";
import type { Action, OverviewData, Session } from "./types";

export interface WorkspaceContext {
  session: Session;
  overview: OverviewData | null;
  overviewError: string | null;
  overviewLoading: boolean;
  busy: boolean;
  submitting: boolean;
  command: (action: Action) => Promise<void>;
  reload: () => void;
  refreshSession: () => Promise<void>;
  updateSession: (session: Session) => void;
}
export const Context = createContext<WorkspaceContext | null>(null);
export function useWorkspace(): WorkspaceContext {
  const value = useContext(Context);
  if (!value) throw new Error("Workspace context is unavailable");
  return value;
}
