export interface OutageEstimate {
  startsAt: string; endsAt: string; mode: "household" | "essential";
  targetSoc: number; currentSoc: number; shortfallKwh: number; currentShortfallKwh: number;
  powerShortfallKwh: number; loadKwh: number; conservativeSolarKwh: number; solarCoverage: number;
  chargingHours: number; chargingKwh: number; readyAt: string; readyBeforeStart: boolean;
  feasible: boolean; powerAssumed: boolean; estimated: true;
}
export interface EnergyToolsData {
  away: AwayData;
  insights?: EnergyInsightsData;
  outageWatch?: OutageWatchData;
  ready: boolean; energyRevision: string; forecastFresh: boolean;
  preferences: { revision: string; briefingsEnabled: boolean; morningMinute: number; eveningMinute: number;
    insightsEnabled?: boolean; autoReplan?: boolean; loadRevision?: string; lastReplanAt?: string | null; replanCode?: string | null };
  tasks: { id: string; revision: string; name: string; powerKw: number; durationMinutes: number;
    earliestAt: string; deadlineAt: string; suggestedAt: string; reminderEnabled: boolean;
    remindedAt: string | null; state: "planned" | "done" | "cancelled"; currentBinding: boolean; scheduleCode?: string | null;
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
export interface InsightEvidence {
  state: "unavailable" | "stale" | "learning" | "active" | "healthy" | "curtailment-possible";
  kind?: "consumption-high" | "solar-low"; minutes?: number;
  actualKw?: number; typicalKw?: number; referenceDays?: number;
  actualKwh?: number; conservativeKwh?: number;
}
export interface EnergyInsightsData {
  enabled: boolean; checkedAt: string | null;
  assessment: { at: string; consumption: InsightEvidence; solar: InsightEvidence } | null;
  incidents: { id: string; kind: string; evidence: InsightEvidence; firstSeenAt: string;
    lastSeenAt: string; resolvedAt: string | null; seenAt: string | null; snoozedUntil: string | null }[];
}
export interface OutageNotice {
  id: string; startsAt: string; endsAt: string; detail: string; scope: "area" | "supply-point";
  sourceUrl: string; fetchedAt: string; seenAt: string | null;
}
export interface OutageWatchData {
  watch: { id: string; revision: string; kind: "area" | "supply-point"; hint: string; enabled: boolean;
    quarantined: boolean; checkedAt: string | null; attemptedAt: string | null; code: string | null } | null;
  notices: OutageNotice[]; sourceUrl: string;
}
export interface EnergyBriefing {
  kind: "morning" | "evening"; at: string; day: string; currentSoc: number | null; readingAt: string | null;
  forecastDay: string; forecastSolarKwh: number | null; currency: string;
  plan: { state: string; targetSoc: number; startsAt: string; endsAt: string; estimatedSavings: number } | null;
  result: { state: string; targetSoc: number; gridChargeObserved: boolean; targetStopObserved: boolean; normalRestored: boolean; restoredAt: string | null } | null;
}

export interface AwayData {
  canChange: boolean;
  revision: string;
  periods: { id: string; startsAt: string; returnsAt: string; baselineW: number;
    normalHistoryAt?: string | null; state: "planned" | "cancelled" | "quarantined"; cancelledAt: string | null; currentBinding: boolean }[];
}
export interface AwayPreview {
  energyRevision: string; awayRevision: string;
  from: string; through: string; normalLoadKwh: number; awayLoadKwh: number;
  targetBefore: number; targetAfter: number; appliesInHorizon: boolean; reserveSoc: number;
  timeline: { at: string; normalKw: number; awayKw: number; away: boolean }[];
  estimated: true; changesInverter: false;
}
