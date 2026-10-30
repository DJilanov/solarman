export interface OutageEstimate {
  startsAt: string; endsAt: string; mode: "household" | "essential";
  targetSoc: number; currentSoc: number; shortfallKwh: number; currentShortfallKwh: number;
  powerShortfallKwh: number; loadKwh: number; conservativeSolarKwh: number; solarCoverage: number;
  chargingHours: number; chargingKwh: number; readyAt: string; readyBeforeStart: boolean;
  feasible: boolean; powerAssumed: boolean; estimated: true;
}
export interface EnergyToolsData {
  ready: boolean; energyRevision: string; forecastFresh: boolean;
  preferences: { revision: string; briefingsEnabled: boolean; morningMinute: number; eveningMinute: number };
  tasks: { id: string; revision: string; name: string; powerKw: number; durationMinutes: number;
    earliestAt: string; deadlineAt: string; suggestedAt: string; reminderEnabled: boolean;
    remindedAt: string | null; state: "planned" | "done" | "cancelled"; currentBinding: boolean;
    recommendation: { finishesAt: string; estimatedCost: number; solarKwh: number; energyKwh: number } }[];
  briefings: { day: string; kind: "morning" | "evening"; createdAt: string; payload: EnergyBriefing }[];
  nextBriefing: EnergyBriefing | null;
  report: { fromDay: string; throughDay: string; currency: string; gridCost: number; solarKwh: number;
    importKwh: number; coverage: number; estimatedSavings: number | null; assessedPlans: number; wearIncluded: boolean;
    days: { day: string; coverage: number; solarKwh: number; loadKwh: number; importKwh: number;
      exportKwh: number; batteryDischargeKwh: number; gridCost: number }[] } | null;
  learning: { forecastDays: number; forecastStage: "learning" | "measured-history";
    meanAbsoluteErrorKwh: number | null; forecastBiasKwh: number | null; observedFullCapacityKwh: number | null;
    qualifyingCycles: number; requiredSocChange: number; measuredHours: number; batteryEstimateChangesSettings: false;
    hourlySolar: { hour: number; days: number; rawScale: number; meanAbsoluteErrorKwh: number | null }[] } | null;
}
export interface EnergyBriefing {
  kind: "morning" | "evening"; at: string; day: string; currentSoc: number | null; readingAt: string | null;
  forecastDay: string; forecastSolarKwh: number | null; currency: string;
  plan: { state: string; targetSoc: number; startsAt: string; endsAt: string; estimatedSavings: number } | null;
  result: { state: string; targetSoc: number; gridChargeObserved: boolean; targetStopObserved: boolean; normalRestored: boolean; restoredAt: string | null } | null;
}
