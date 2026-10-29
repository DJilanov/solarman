export interface EnergyProfile {
  version: 1;
  timezone: string;
  site: {
    latitude: number | null;
    longitude: number | null;
    inverterKw: number | null;
    arrays: EnergyRoof[];
  };
  battery: {
    capacityKwh: number | null;
    reserveSoc: number;
    backupFloorSoc: number;
    gridChargeKw: number;
    pvChargeKw: number;
    dischargeKw: number;
    chargeEfficiency: number;
    dischargeEfficiency: number;
    powerConfirmed: boolean;
    essentialLoadW: number | null;
  };
  tariff: {
    currency: string;
    dayPrice: number | null;
    nightPrice: number | null;
    exportPrice: number;
    cyclingCost: number | null;
    windows: EnergyTariffWindow[];
  };
  planning: {
    maximumSoc: number;
    solarMargin: number;
    loadMargin: number;
    fallbackDailyKwh: number | null;
    heatingKwPerDegree: number;
    heatingBaseC: number;
  };
  loads: { name: string; powerKw: number; durationMinutes: number }[];
}
export interface EnergyRoof {
  name: string;
  kwp: number;
  tilt: number;
  azimuth: number;
  lossFraction: number;
  geometryConfirmed: boolean;
}
export interface EnergyTariffWindow {
  months: number[];
  startMinute: number;
  endMinute: number;
}
export interface EnergySlot {
  start: number;
  end: number;
  expectedKw: number;
  lowKw: number;
  highKw: number;
  rawKw: number;
  temperatureC: number;
  cloudCover: number;
}
export interface EnergyForecast {
  provider: string;
  sourceUrl: string;
  attribution: string;
  fetchedAt: string;
  expiresAt: string;
  slots: EnergySlot[];
  calibration: { days: number; source: string };
}
export interface EnergyTimeline {
  start: number;
  end: number;
  solarKw: number;
  loadKw: number;
  soc: number;
  gridChargeKwh: number;
  exportKwh: number;
  night: boolean;
}
export interface EnergyTotals {
  gridCost: number;
  totalCost: number;
  solarKwh: number;
  loadKwh: number;
  importKwh: number;
}
export interface EnergyPrediction {
  horizon: { start: number; end: number };
  night: { start: number; end: number; releaseAt: number };
  action: "charge-and-hold" | "normal";
  targetSoc: number;
  chargeStart: number | null;
  chargeEnd: number | null;
  maximumChargeKw: number;
  chargingHours: number;
  estimatedSavings: number;
  conservativeSavings: number;
  baseline: EnergyTotals;
  selected: EnergyTotals & {
    timeline: EnergyTimeline[];
    gridChargeKwh: number;
    exportKwh: number;
    finalSoc: number;
  };
  conservative: EnergyTotals & { finalSoc: number };
  reasons: string[];
  flexibleLoads: {
    name: string;
    powerKw: number;
    durationMinutes: number;
    slot: { start: number; end: number; surplusKw: number } | null;
  }[];
}
export interface EnergyPlan {
  currency: string;
  timezone: string;
  approvedTargetSoc: number | null;
  id: string;
  state: string;
  code: string | null;
  createdAt: string;
  settingsRevision: string;
  startsAt: string;
  endsAt: string;
  prediction: EnergyPrediction;
  reading: { soc: number; at: string };
  demandQuality: string;
  demandDays: number;
  demandCoveredHours: number;
  forecast: EnergyForecast;
  assessment: {
    coverage: number;
    observedGridCost: number;
    predictedGridCost: number;
    estimatedCounterfactualGridCost: number;
    estimatedCounterfactualSavings: number | null;
  } | null;
}
export interface EnergyOutcome {
  day: string;
  coverage: number;
  actualSolarKwh: number;
  forecastSolarKwh: number;
  actualLoadKwh: number;
  actualGridCost: number;
  curtailedPossible: boolean;
}
export interface EnergyData {
  revision: string;
  profile: EnergyProfile;
  automatic: boolean;
  missing: string[];
  providerAvailable: boolean;
  calculating: boolean;
  code: string | null;
  attemptedAt: string | null;
  plan: EnergyPlan | null;
  history: EnergyPlan[];
  outcomes: EnergyOutcome[];
  endurance: {
    hours: number;
    lowHours: number;
    highHours: number;
    floorSoc: number;
    loadW: number;
    loadSource: string;
    powerLimitExceeded: boolean;
    powerLimitKnown: boolean;
    assumedFloor: boolean;
  } | null;
  control: {
    canActivate: boolean;
    supported: boolean;
    enabled: boolean;
    holdApproved: boolean;
    active: boolean;
    purpose: "outage" | "night" | null;
    state: string | null;
    targetSoc: number | null;
    endsAt: string | null;
  };
}
