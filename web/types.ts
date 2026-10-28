export interface Session {
  user: { id: string; email: string; platformAdmin: boolean };
  tenant: { id: string; name: string; timezone: string };
  csrfToken: string;
}
export interface ControllerStatus {
  apiConfigured: boolean;
  writesEnabled: boolean;
  control: {
    serverAllowed: boolean;
    workspaceEnabled: boolean;
    canVerify: boolean;
    canEnable: boolean;
    canStart: boolean;
    canStop: boolean;
    reasons: { code: string; message: string }[];
    recovery: {
      state: "none" | "clear" | "owned" | "uncertain" | "cleanup-required";
      pending: boolean;
      inFlight: boolean;
      confirmedOffAt: string | null;
      updatedAt: string | null;
      writes: {
        id: string;
        operation: "enable" | "disable" | "window";
        status: "prepared" | "acknowledged" | "verified" | "uncertain";
        inFlight: boolean;
        createdAt: string;
        acknowledgedAt: string | null;
        verifiedAt: string | null;
        reconciledAt: string | null;
      }[];
    };
    verification: {
      checkedAt: string;
      passed: boolean;
      checks: {
        label: string;
        actual: number | null;
        expected: number;
        unit: string;
        passed: boolean;
        comparison?: "at_most";
      }[];
    } | null;
  };
  mode: "setup" | "stopping" | "error" | "paused" | "active" | "read-only";
  paused: boolean;
  manualTopup: boolean;
  topupExpiresAt: string | null;
  lastSuccessAt: string | null;
  telemetry: {
    source: "provider" | "register";
    collectedAt: string;
    receivedAt: string;
    deviceState: number;
    clock: {
      passed: boolean;
      skewSeconds: number | null;
      reportedTime: string | null;
      collectedAt: string;
    } | null;
  } | null;
  error: string | null;
  setupError: string | null;
  pollSeconds: number;
  annualProjectedCalls: number;
  policy: {
    reserveSoc: number;
    solarTargetSoc: number;
    acChargeKw: number;
    solarPowerCapVerified: boolean;
  };
  profile: string;
  deviceSelected: boolean;
  timezone: string;
}
export interface Measurement {
  at: string;
  receivedAt: string;
  source: "provider" | "register";
  samplingSeconds: number;
  soc: number;
  pvW: number;
  loadW: number;
  gridW: number;
  batteryW: number;
  temperatureC: number;
  acEnabled: boolean | null;
}
export interface Energy {
  solarKwh: number;
  loadKwh: number;
  importKwh: number;
  exportKwh: number;
  chargeKwh: number;
  dischargeKwh: number;
  coveredSeconds: number;
}
export interface Point {
  at: number;
  pvW: number | null;
  loadW: number | null;
  gridW: number | null;
  batteryW: number | null;
  soc: number | null;
  temperatureC: number | null;
}
export interface Analytics {
  start: string;
  end: string;
  timezone: string;
  estimated: boolean;
  sampleCount: number;
  coverage: number;
  totals: Energy | null;
  daily: (Energy & { day: string })[];
  points: Point[];
}
export interface Command {
  id: string;
  actor: string;
  action: string;
  status: "queued" | "running" | "succeeded" | "failed" | "interrupted";
  message: string | null;
  created_at: string;
  completed_at: string | null;
}
export interface OverviewData {
  latest: Measurement | null;
  controller: ControllerStatus;
  today: Analytics;
  recent: Command[];
}
export interface SettingsData {
  controller: ControllerStatus;
  timezone: string;
  apiUsage: { today: number; year: number };
  quota: number;
  budget: {
    limit: number;
    reserve: number;
    tracked: number;
    remaining: number;
    routineRemaining: number;
    state: "available" | "recovery-only" | "exhausted";
    workspaces: number;
    projected: number;
    providerRemaining: number | null;
    providerCheckedAt: string | null;
    balanceAttemptedAt: string | null;
  } | null;
  profile: string;
  release: string;
  account: {
    id: string;
    email: string;
    device_sn: string | null;
    profile: string;
    connection_status: string;
    connection_message: string | null;
    validated_at: string | null;
    timezone: string;
    discovered_devices: {
      deviceSn: string;
      stationId: number;
      stationName: string;
    }[];
  } | null;
  readings: {
    collected_at: string;
    data_list: { key: string; name: string; value: string; unit: string }[];
  } | null;
  platformApiConfigured: boolean;
}
export interface ActivityData {
  items: Command[];
  hasMore: boolean;
  offset: number;
}
export type Action =
  | "refresh"
  | "verify"
  | "enable_controls"
  | "topup"
  | "stop"
  | "pause"
  | "resume";
