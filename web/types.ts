export interface Session {
  user: { id: string; email: string; platformAdmin: boolean };
  tenant: { id: string; name: string; timezone: string };
  csrfToken: string;
}
export interface Incident {
  id: string;
  kind:
    | "telemetry_stale"
    | "device_offline"
    | "request_failures"
    | "control_fault"
    | "cleanup_pending"
    | "api_quota"
    | "api_capacity";
  severity: "warning" | "critical";
  device: string;
  detailCode: "low" | "recovery-only" | "exhausted" | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionReason: "cleared" | "binding_changed" | null;
  acknowledgedAt: string | null;
  revision: number;
}
export interface MonitorStatus {
  checkedAt: string | null;
  state: "current" | "starting" | "delayed";
}
export interface AlertSummary {
  items: Incident[];
  active: number;
  unseen: number;
  monitor: MonitorStatus;
}
export interface OperationsData {
  backup?: BackupStatus;
  items: Incident[];
  hasMore: boolean;
  offset: number;
  total: number;
  unseen: number;
  monitor: MonitorStatus;
  deviceHealth: {
    monitoringAdmitted?: boolean;
    capacityWaiting?: boolean;
    device: string;
    attemptedAt: string | null;
    succeededAt: string | null;
    failedAt: string | null;
    uploadedAt: string | null;
    deviceState: number | null;
    failures: number;
    controlFault: boolean;
    staleAfterSeconds: number;
  } | null;
}
export type BackupIssue =
  | "backup_failed"
  | "restore_failed"
  | "backup_missing"
  | "restore_missing"
  | "backup_overdue"
  | "restore_overdue"
  | "backup_stalled"
  | "restore_stalled";
export interface BackupStatus {
  state: "healthy" | "attention" | "running" | "not-configured" | "unavailable";
  issues?: BackupIssue[];
  lastBackupAt?: string | null;
  lastRestoreAt?: string | null;
  retentionDays?: number;
  backup?: {
    state: "running" | "verified" | "failed" | "never";
    startedAt: string | null;
    completedAt: string | null;
    offsiteVerified: boolean;
  };
  restore?: {
    state: "running" | "verified" | "failed" | "never";
    startedAt: string | null;
    completedAt: string | null;
    inventoryVerified: boolean;
    credentialsVerified: boolean;
    authenticationVerified: boolean;
    controlQuarantined: boolean;
  };
}
export interface WriteSummary {
  id: string;
  executionId: string | null;
  operation: "enable" | "disable" | "window";
  status: "prepared" | "acknowledged" | "verified" | "uncertain";
  inFlight: boolean;
  createdAt: string;
  acknowledgedAt: string | null;
  verifiedAt: string | null;
  reconciledAt: string | null;
}
export interface WriteRecord extends WriteSummary {
  device: string;
  address: number;
  registerValues: number[];
}
export interface FirmwareIdentity {
  protocol: string | null;
  dsp: string | null;
  hmi: string | null;
}
export interface ControllerStatus {
  capacity?: ApiCapacity | null;
  nextPollAt?: string | null;
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
      writes: WriteSummary[];
    };
    verification: {
      firmware?: FirmwareIdentity | null;
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
    firmware?: (FirmwareIdentity & { collectedAt: string }) | null;
  };
  mode:
    | "setup"
    | "stopping"
    | "error"
    | "paused"
    | "active"
    | "read-only"
    | "capacity";
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
  supervision: {
    mode: "monitoring" | "native" | "scheduled";
    auditSeconds: number;
    lastNativeAt: string | null;
    nextAuditAt: string | null;
    issue: { code: string; message: string; observedAt: string } | null;
  };
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
export interface WriteHistoryData {
  writes: WriteRecord[];
  hasMoreWrites: boolean;
  offset: number;
}
export interface CommandDetails extends Command, WriteHistoryData {
  device: string | null;
  evidence: {
    decision: {
      charge: boolean;
      reason: string;
      dryRun: boolean | null;
      acEnabled: boolean | null;
      soc: number | null;
      pvW: number | null;
      loadW: number | null;
      gridW: number | null;
      batteryW: number | null;
    } | null;
    verification: ControllerStatus["control"]["verification"];
    events: {
      code:
        | "native_policy_check"
        | "manual_topup_expired"
        | "ac_charge_changed"
        | "write_acknowledgement_audit_recovered"
        | "write_journal_unavailable"
        | "firmware_verification_invalidated";
      enabled: boolean | null;
      reason:
        | "native_audit"
        | "observed_policy_deviation"
        | "topup_assessment"
        | null;
    }[];
  };
}
export interface OverviewData {
  backup?: BackupStatus;
  latest: Measurement | null;
  controller: ControllerStatus;
  today: Analytics;
  recent: Command[];
  alerts: AlertSummary;
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
    capacity?: ApiCapacity | null;
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
export interface ApiCapacityPlan {
  fits: boolean;
  planningLimit: number;
  reservedAnnual: number;
  monitorMs: number;
  scheduledMs: number;
  assessmentMs: number;
}
export interface ApiCapacity extends ApiCapacityPlan {
  admitted: boolean;
  controlAvailable: boolean;
  monitoringWorkspaces: number;
  controlWorkspaces: number;
  waitingWorkspaces: number;
  activation?: ApiCapacityPlan | null;
}
export interface ActivityData {
  items: Command[];
  hasMore: boolean;
  offset: number;
}
export type Action =
  | "refresh"
  | "verify"
  | "disable_controls"
  | "retry_capacity"
  | "enable_controls"
  | "topup"
  | "stop"
  | "pause"
  | "resume";
