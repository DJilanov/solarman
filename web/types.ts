export interface Session {
  user: { id: string; email: string; platformAdmin: boolean };
  tenant: { id: string; name: string; timezone: string };
  csrfToken: string;
}
export interface RetentionPolicy {
  enabled: boolean;
  measurementDays: number;
  activityDays: number;
  revision: string;
  lastRunAt: string | null;
  lastFailedAt: string | null;
  lastCounts: Record<string, number>;
  events: {
    revision: string;
    enabled: boolean;
    measurementDays: number;
    activityDays: number;
    at: string;
  }[];
}
export interface TenantLifecycleStatus {
  state: LifecycleState;
  revision: string;
  changedAt: string | null;
  message: string;
  protected: boolean;
  cleanupPending: boolean;
  events: {
    id: string;
    revision: string;
    state: LifecycleState;
    message: string;
    at: string;
  }[];
}
export interface TenantMetadata {
  id: string;
  name: string;
  created_at: string;
  members: number;
  connection_status: string | null;
  lifecycle: LifecycleState;
  revision: string;
  protected: boolean;
  cleanup_pending: boolean;
}
export type LifecycleState = "active" | "suspended" | "offboarding" | "removed";
export interface OffboardingStatus {
  id: string | null;
  state: LifecycleState;
  requestedAt: string | null;
  authorizedAt: string | null;
  acknowledgedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  processedRows: number;
  lastFailedAt: string | null;
  cleanupPending: boolean;
  receiptService: boolean;
  receiptReady: boolean;
  phase:
    | "none"
    | "cleanup"
    | "ready"
    | "awaiting-receipt"
    | "queued"
    | "erasing"
    | "removed";
}
export interface BrowserSession {
  id: string;
  current: boolean;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
}
export interface AccountSecurityData {
  passwordChangedAt: string | null;
  recovery: { keyCreatedAt: string | null; linkExpiresAt: string | null };
  sessions: BrowserSession[];
  sessionCount: number;
  hasMoreSessions: boolean;
  offset: number;
  events: {
    id: string;
    kind:
      | "signed_in"
      | "signed_out"
      | "password_changed"
      | "session_revoked"
      | "other_sessions_revoked"
      | "recovery_key_created"
      | "recovery_access_revoked"
      | "recovery_link_created"
      | "recovery_link_revoked"
      | "password_recovered";
    affectedSessions: number;
    at: string;
  }[];
}
export interface Incident {
  id: string;
  kind:
    | "telemetry_stale"
    | "device_offline"
    | "request_failures"
    | "auth_failure"
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
  erasure?: ErasureServiceStatus;
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
export interface ErasureServiceStatus {
  state: "verified" | "stale" | "unavailable" | "not-configured";
  checkedAt: string | null;
  receipts: number | null;
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
  operation:
    "enable" | "disable" | "window" | "outage_apply" | "outage_restore";
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
  outage?: {
    active: boolean;
    state: OutagePreparation["state"];
    purpose?: "outage" | "night";
    endsAt?: string | null;
    targetSoc: number;
    test: boolean;
  } | null;
  capacity?: ApiCapacity | null;
  nextPollAt?: string | null;
  apiConfigured: boolean;
  writesEnabled: boolean;
  control: {
    serverAllowed: boolean;
    workspaceEnabled: boolean;
    canVerify: boolean;
    canCommission: boolean;
    canEnable: boolean;
    canStart: boolean;
    canStop: boolean;
    commissioning: {
      id: string | null;
      state: "missing" | "preparing" | "attending" | "approved";
      approved: boolean;
      attended: boolean;
      attendedUntil: string | null;
    };
    verificationStatus: {
      state: "missing" | "failed" | "outdated" | "expired" | "verified";
      checkedAt: string | null;
      expiresAt: string | null;
    };
    clock: {
      passed: boolean;
      skewSeconds: number | null;
      reportedTime: string | null;
      collectedAt: string;
      fresh: boolean;
      maximumSkewSeconds: number;
    } | null;
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
      holdingRegisters?: Partial<
        Record<
          "2504" | "2505" | "3005" | "3022" | "3023" | "3036",
          number | null
        >
      >;
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
  recoveryTesting?: boolean;
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
    solarPowerLimit: "native";
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
export interface OutagePreparation {
  purpose?: "outage" | "night";
  endsAt?: string | null;
  id: string;
  state:
    | "queued"
    | "applying"
    | "active"
    | "restoring"
    | "recovery-required"
    | "restored"
    | "failed"
    | "quarantined";
  revision: string;
  targetSoc: number;
  normalTargetSoc: number;
  test: boolean;
  attendedUntil: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
  endedAt: string | null;
  error: string | null;
  proof: {
    gridChargingObservedAt?: string;
    targetHoldObservedAt?: string;
    holdObservedAt?: string;
    backupUseObservedAt?: string;
    restoredAt?: string;
  };
  approvedAt: string | null;
  canApprove: boolean;
}
export interface OutageData {
  supported: boolean;
  minTarget: number;
  maxTarget: number;
  acChargeKw: number;
  solarTargetSoc: number;
  canPrepare: boolean;
  canTest: boolean;
  canRestore: boolean;
  capabilityApproved: boolean;
  preparation: OutagePreparation | null;
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
  | "commission_controls"
  | "commission_topup"
  | "commission_recovery"
  | "topup"
  | "stop"
  | "pause"
  | "resume";

export interface ObservationIdentity {
  accountId: string;
  device: string;
  profile: string;
  model: string;
  timezone: string;
  mapping: string;
  policy: string;
  firmware: { protocol: string; dsp: string; hmi: string };
}
export interface ObservationSample {
  id: string;
  at: string;
  receivedAt: string;
  samplingSeconds: number;
  soc: number;
  pvW: number;
  loadW: number;
  gridW: number;
  batteryW: number;
  source: "provider" | "register";
}
export interface ObservationEvidence {
  count: number;
  first: ObservationSample | null;
  last: ObservationSample | null;
  observedAt: string | null;
}
export interface ObservationProgress {
  version: 1;
  accepted: number;
  rejected: number;
  firstAt: string | null;
  last: ObservationSample | null;
  coveredSeconds: number;
  solarSeen: boolean;
  nightSeen: boolean;
  approach: ObservationSample | null;
  solar: ObservationEvidence;
  discharge: ObservationEvidence;
  gridCharge: ObservationEvidence;
  gridStop: ObservationEvidence;
}
export type ObservationState = "observing" | "stopped" | "invalidated";
export interface PolicyObservationRun {
  id: string;
  state: ObservationState;
  reason: string | null;
  startedAt: string;
  endedAt: string | null;
  checkedAt: string | null;
  failedAt: string | null;
  identity: ObservationIdentity;
  verification: NonNullable<ControllerStatus["control"]["verification"]>;
  currentBinding: boolean | null;
  progress: ObservationProgress;
  window: { spanSeconds: number; coverage: number; cycleObserved: boolean };
}
export interface PolicyObservationData {
  canStart: boolean;
  activeRunId: string | null;
  identity: ObservationIdentity | null;
  run: PolicyObservationRun | null;
  history: {
    id: string;
    state: ObservationState;
    reason: string | null;
    started_at: string;
    ended_at: string | null;
  }[];
}

export interface CommissioningRequirement {
  code:
    "solar" | "discharge" | "gridCharge" | "gridStop" | "dayNight" | "recovery";
  passed: boolean;
}
export interface CommissioningHistoryReview {
  source: "stored-measurements";
  anchorRunId: string;
  throughId: string;
  hash: string;
  startedAt: string;
  checkedAt: string;
  sampleCount: number;
  excluded: number;
  progress: ObservationProgress;
  window: { spanSeconds: number; coverage: number; cycleObserved: boolean };
  requirements: CommissioningRequirement[];
}
export interface CommissioningData {
  identity: ObservationIdentity | null;
  canPrepare: boolean;
  attendedMinutes: number;
  availableObservation: {
    id: string;
    checkedAt: string | null;
    requirements: CommissioningRequirement[];
  } | null;
  recoveryCommands: {
    id: string;
    action: "stop" | "pause" | "disable_controls" | "commission_recovery";
    completedAt: string;
  }[];
  run: {
    id: string;
    state: "preparing" | "attending" | "approved";
    revision: string;
    createdAt: string;
    updatedAt: string;
    attendedUntil: string | null;
    currentBinding: boolean | null;
    identity: ObservationIdentity;
    verification: NonNullable<ControllerStatus["control"]["verification"]>;
    evidence: {
      observation?: {
        id: string;
        checkedAt: string;
        progress: ObservationProgress;
      };
      recovery?: { commandId: string; completedAt: string };
    };
    requirements: CommissioningRequirement[];
    events: { action: string; revision: string; created_at: string }[];
  } | null;
  history: {
    id: string;
    state: string;
    reason: string | null;
    created_at: string;
    ended_at: string | null;
  }[];
}

export interface NotificationChannel {
  id: string;
  kind: "telegram";
  chatId: string;
  language: "en" | "bg";
  enabled: boolean;
  quarantined: boolean;
  revision: string;
  verifiedAt: string | null;
  lastTestAt: string | null;
  configured: boolean;
  blockedCode: string | null;
}

export interface BrowserPushDevice {
  id: string;
  label: string;
  endpointHash: string;
  language: "en" | "bg";
  enabled: boolean;
  pending: boolean;
  quarantined: boolean;
  revision: string;
  verifiedAt: string | null;
  lastTestAt: string | null;
  blockedCode: string | null;
  createdAt: string;
  lastDelivery: {
    id: string;
    state: NotificationDelivery["state"];
    code: string | null;
    displayedAt: string | null;
  } | null;
}
export interface BrowserPushSettingsData {
  configured: boolean;
  publicKey: string | null;
  lifecycle: NotificationSettingsData["lifecycle"];
  devices: BrowserPushDevice[];
}
export interface NotificationAttempt {
  number: number;
  state: "sending" | "delivered" | "rejected" | "unconfirmed" | "cancelled";
  code: string | null;
  startedAt: string;
  completedAt: string | null;
  messageId: string | null;
}
export interface NotificationDelivery {
  id: string;
  kind: "opened" | "escalated" | "resolved" | "test" | "platform";
  state:
    | "queued"
    | "sending"
    | "retry"
    | "delivered"
    | "failed"
    | "unconfirmed"
    | "cancelled";
  attempts: number;
  hadUnconfirmed: boolean;
  createdAt: string;
  nextAttemptAt: string;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  lastCode: string | null;
  messageId: string | null;
  payload: { title: string; text: string };
  history: NotificationAttempt[];
}
export interface NotificationSettingsData {
  channel: NotificationChannel | null;
  deliveries: NotificationDelivery[];
  events: { actor: string; action: string; revision: string; at: string }[];
  offset: number;
  hasMore: boolean;
  lifecycle: TenantLifecycleStatus["state"];
  worker: {
    state: "starting" | "current" | "delayed";
    checkedAt: string | null;
  };
}
