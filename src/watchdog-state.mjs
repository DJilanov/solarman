import { randomUUID } from "node:crypto";
import { watchdogBindings, WatchdogError } from "./watchdog-config.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const PENDING = new Set(["queued", "retry", "sending"]);
const TERMINAL = new Set(["delivered", "failed", "unconfirmed", "cancelled"]);
const DELAYS = [60, 300, 900];
const DAY = 86400000;
const at = (now) => new Date(now).toISOString();
const timestamp = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** @returns {object} */
export function emptyWatchdogState() {
  return {
    version: 1,
    target: null,
    destination: null,
    enabled: false,
    verifiedAt: null,
    blockedCode: null,
    quarantined: false,
    condition: "unknown",
    failures: 0,
    successes: 0,
    incident: null,
    lastSample: null,
    testId: null,
    jobs: [],
  };
}

/** @param {unknown} state @returns {void} */
export function validateWatchdogState(state) {
  try {
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      state.version !== 1
    )
      throw new Error();
    for (const key of ["target", "destination"])
      if (state[key] !== null && !HASH.test(state[key])) throw new Error();
    if (
      typeof state.enabled !== "boolean" ||
      typeof state.quarantined !== "boolean" ||
      (state.verifiedAt !== null && !timestamp(state.verifiedAt)) ||
      (state.blockedCode !== null && !/^[a-z_]{1,60}$/.test(state.blockedCode))
    )
      throw new Error();
    if (
      !["unknown", "healthy", "down"].includes(state.condition) ||
      !Number.isInteger(state.failures) ||
      state.failures < 0 ||
      state.failures > 3 ||
      !Number.isInteger(state.successes) ||
      state.successes < 0 ||
      state.successes > 2
    )
      throw new Error();
    if (
      state.incident !== null &&
      (!UUID.test(state.incident.id) ||
        !timestamp(state.incident.openedAt) ||
        typeof state.incident.announced !== "boolean")
    )
      throw new Error();
    if ((state.condition === "down") !== (state.incident !== null))
      throw new Error();
    if (
      state.lastSample !== null &&
      (!timestamp(state.lastSample.at) ||
        typeof state.lastSample.healthy !== "boolean" ||
        ![
          "healthy",
          "http_error",
          "invalid_health",
          "stale_response",
          "endpoint_unreachable",
          "probe_timeout",
        ].includes(state.lastSample.code) ||
        !["reachable", "unavailable", "timeout", "cancelled"].includes(
          state.lastSample.origin,
        ) ||
        (state.lastSample.release !== null &&
          !/^[a-f0-9]{40}$/.test(state.lastSample.release)))
    )
      throw new Error();
    if (!Array.isArray(state.jobs) || state.jobs.length > 512)
      throw new Error();
    const ids = new Set();
    for (const job of state.jobs) {
      if (
        !UUID.test(job.id) ||
        ids.has(job.id) ||
        !HASH.test(job.target) ||
        !HASH.test(job.destination) ||
        !["outage", "recovery", "test"].includes(job.kind) ||
        (job.incidentId !== null && !UUID.test(job.incidentId))
      )
        throw new Error();
      ids.add(job.id);
      if (
        typeof job.text !== "string" ||
        job.text.length < 1 ||
        job.text.length > 4096 ||
        (!PENDING.has(job.state) && !TERMINAL.has(job.state)) ||
        !Number.isInteger(job.attempts) ||
        job.attempts < 0 ||
        job.attempts > 4 ||
        typeof job.hadUnconfirmed !== "boolean" ||
        typeof job.cancelRequested !== "boolean" ||
        !timestamp(job.createdAt)
      )
        throw new Error();
      if (
        (TERMINAL.has(job.state) && !timestamp(job.completedAt)) ||
        (PENDING.has(job.state) && job.completedAt !== null) ||
        (job.nextAttemptAt !== null && !timestamp(job.nextAttemptAt)) ||
        (["queued", "retry"].includes(job.state) && job.nextAttemptAt === null)
      )
        throw new Error();
      if (!Array.isArray(job.history) || job.history.length !== job.attempts)
        throw new Error();
      for (const [index, attempt] of job.history.entries()) {
        if (
          attempt.number !== index + 1 ||
          ![
            "sending",
            "delivered",
            "rejected",
            "unconfirmed",
            "cancelled",
          ].includes(attempt.state) ||
          !timestamp(attempt.startedAt) ||
          Date.parse(attempt.startedAt) < Date.parse(job.createdAt) ||
          (index > 0 &&
            Date.parse(attempt.startedAt) <
              Date.parse(job.history[index - 1].completedAt)) ||
          (attempt.state === "sending" && index !== job.history.length - 1) ||
          (attempt.state === "sending"
            ? attempt.completedAt !== null
            : !timestamp(attempt.completedAt)) ||
          (attempt.messageId !== null &&
            (!Number.isSafeInteger(attempt.messageId) ||
              attempt.messageId <= 0))
        )
          throw new Error();
        if (
          attempt.state !== "sending" &&
          Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)
        )
          throw new Error();
        if (
          attempt.code !== null &&
          (typeof attempt.code !== "string" ||
            !/^[a-z_]{1,60}$/.test(attempt.code))
        )
          throw new Error();
      }
      if (
        TERMINAL.has(job.state) &&
        Date.parse(job.completedAt) < Date.parse(job.createdAt)
      )
        throw new Error();
      if (
        job.history.some((attempt) => attempt.state === "unconfirmed") &&
        !job.hadUnconfirmed
      )
        throw new Error();
      if (
        (job.history.at(-1)?.state === "delivered") !==
        (job.state === "delivered")
      )
        throw new Error();
      if (
        (job.state === "sending") !==
        (job.history.at(-1)?.state === "sending")
      )
        throw new Error();
    }
    if (
      state.testId !== null &&
      (!UUID.test(state.testId) ||
        !state.jobs.some(
          (job) => job.id === state.testId && job.kind === "test",
        ))
    )
      throw new Error();
  } catch {
    throw new WatchdogError("state_invalid");
  }
}

/** @param {object} job @param {string} code @param {number} now @returns {void} */
function cancel(job, code, now) {
  if (!PENDING.has(job.state)) return;
  job.cancelRequested = true;
  job.lastCode = code;
  if (job.state !== "sending") {
    job.state = "cancelled";
    job.completedAt = at(now);
    job.nextAttemptAt = null;
  }
}

/** @param {object} state @param {import('./watchdog-config.mjs').WatchdogConfig} config @param {number} now @returns {void} */
export function reconcileWatchdog(state, config, now) {
  const bindings = watchdogBindings(config);
  const targetChanged = state.target !== bindings.target;
  const destinationChanged = state.destination !== bindings.destination;
  const enabled = config.delivery?.enabled ?? false;
  if (targetChanged || destinationChanged || (state.enabled && !enabled)) {
    for (const job of state.jobs) cancel(job, "settings_changed", now);
  }
  if (targetChanged) {
    state.condition = "unknown";
    state.incident = null;
    state.lastSample = null;
    state.failures = 0;
    state.successes = 0;
  }
  if (targetChanged || destinationChanged) {
    state.verifiedAt = null;
    state.blockedCode = null;
    state.testId = null;
  }
  if (state.incident && (destinationChanged || (!state.enabled && enabled)))
    state.incident.announced = false;
  state.target = bindings.target;
  state.destination = bindings.destination;
  state.enabled = enabled;
  if (state.quarantined && enabled)
    for (const job of state.jobs)
      if (job.kind === "test") cancel(job, "restore", now);
}

/** @param {object} state @param {import('./watchdog-config.mjs').WatchdogConfig} config @returns {boolean} */
export function watchdogDeliveryEnabled(state, config) {
  const bindings = watchdogBindings(config);
  return Boolean(
    config.delivery?.enabled &&
      !state.quarantined &&
      state.target === bindings.target &&
      state.destination === bindings.destination &&
      state.verifiedAt &&
      !state.blockedCode,
  );
}

/** @param {import('./watchdog-config.mjs').WatchdogConfig} config @param {'outage'|'recovery'|'test'} kind @param {string} reference @param {number} now @param {object|null} sample @returns {string} */
function message(config, kind, reference, now, sample) {
  const bg = config.language === "bg";
  const title = {
    outage: bg
      ? "Таблото за соларната система не отговаря нормално"
      : "Solar dashboard health check failed",
    recovery: bg
      ? "Таблото за соларната система е възстановено"
      : "Solar dashboard recovered",
    test: bg
      ? "Проверка на независимото наблюдение"
      : "Independent monitoring test",
  }[kind];
  const detail =
    kind === "test"
      ? bg
        ? "Това е проверка на избраната дестинация за известия."
        : "This tests the selected alert destination."
      : kind === "recovery"
        ? bg
          ? "Две последователни проверки потвърдиха актуално и нормално състояние."
          : "Two consecutive fresh health checks passed."
        : sample?.origin === "reachable"
          ? bg
            ? "TCP връзката със сървъра е достъпна. Проверете HTTPS услугата и работните процеси."
            : "The origin TCP connection answered. Check the HTTPS service and workers."
          : bg
            ? "TCP връзката със сървъра не е потвърдена. Това не установява причината за проблема."
            : "The origin TCP connection was not confirmed. This does not establish the cause.";
  return [
    "SOLARMAN · " + title,
    config.label,
    detail,
    at(now),
    config.url,
    (bg ? "Номер на събитието: " : "Event reference: ") + reference,
  ].join("\n");
}

/** @param {object} state @param {import('./watchdog-config.mjs').WatchdogConfig} config @param {'outage'|'recovery'|'test'} kind @param {number} now @param {string|null} incidentId @returns {object} */
function enqueue(state, config, kind, now, incidentId) {
  if (!state.destination) throw new WatchdogError("destination_missing");
  const id = randomUUID(),
    full = state.jobs.filter((job) => PENDING.has(job.state)).length >= 100;
  const job = {
    id,
    target: state.target,
    destination: state.destination,
    kind,
    incidentId,
    text: message(config, kind, id, now, state.lastSample),
    state: full ? "failed" : "queued",
    createdAt: at(now),
    completedAt: full ? at(now) : null,
    nextAttemptAt: full ? null : at(now),
    attempts: 0,
    history: [],
    hadUnconfirmed: false,
    cancelRequested: false,
    lastCode: full ? "queue_limit" : null,
  };
  state.jobs.push(job);
  return job;
}

/** @param {object} state @param {import('./watchdog-config.mjs').WatchdogConfig} config @param {{healthy:boolean,code:string,release:string|null,origin:string,at:string}} sample @returns {void} */
export function observeWatchdog(state, config, sample) {
  const now = Date.parse(sample.at),
    previous = state.lastSample ? Date.parse(state.lastSample.at) : null;
  if (!Number.isFinite(now) || (previous !== null && now < previous))
    throw new WatchdogError("clock_regressed");
  if (previous !== null && now - previous > 150000) {
    state.failures = 0;
    state.successes = 0;
  }
  state.lastSample = sample;
  if (sample.healthy) {
    state.failures = 0;
    state.successes = Math.min(2, state.successes + 1);
  } else {
    state.successes = 0;
    state.failures = Math.min(3, state.failures + 1);
  }
  if (state.failures === 3 && state.condition !== "down") {
    state.condition = "down";
    state.incident = {
      id: randomUUID(),
      openedAt: sample.at,
      announced: false,
    };
  }
  if (state.successes === 2 && state.condition !== "healthy") {
    if (state.incident) {
      for (const job of state.jobs)
        if (job.incidentId === state.incident.id && job.kind === "outage")
          cancel(job, "recovered_before_delivery", now);
      if (state.incident.announced && watchdogDeliveryEnabled(state, config))
        enqueue(state, config, "recovery", now, state.incident.id);
    }
    state.condition = "healthy";
    state.incident = null;
  }
  if (
    state.incident &&
    !state.incident.announced &&
    watchdogDeliveryEnabled(state, config)
  ) {
    enqueue(state, config, "outage", now, state.incident.id);
    state.incident.announced = true;
  }
}

/** @param {object} state @param {number} now @returns {void} */
export function recoverWatchdog(state, now) {
  for (const job of state.jobs) {
    if (
      PENDING.has(job.state) &&
      (now < Date.parse(job.createdAt) ||
        (job.history.length && now < Date.parse(job.history.at(-1).startedAt)))
    )
      throw new WatchdogError("clock_regressed");
    if (job.state === "sending") {
      const attempt = job.history.at(-1);
      attempt.state = "unconfirmed";
      attempt.code = "result_not_saved";
      attempt.completedAt = at(now);
      job.hadUnconfirmed = true;
      job.lastCode = "result_not_saved";
      job.state = job.cancelRequested
        ? "cancelled"
        : job.attempts >= 4 || now - Date.parse(job.createdAt) >= DAY - 60000
          ? "unconfirmed"
          : "retry";
      job.completedAt = job.state === "retry" ? null : at(now);
      job.nextAttemptAt = job.state === "retry" ? at(now + 60000) : null;
    }
    if (
      ["queued", "retry"].includes(job.state) &&
      (job.attempts >= 4 || now - Date.parse(job.createdAt) >= DAY)
    ) {
      job.state = job.hadUnconfirmed ? "unconfirmed" : "failed";
      job.lastCode = "delivery_expired";
      job.completedAt = at(now);
      job.nextAttemptAt = null;
    }
  }
}

/** @param {object} state @param {import('./watchdog-config.mjs').WatchdogConfig} config @param {boolean} newTest @param {number} now @returns {object} */
export function requestWatchdogTest(state, config, newTest, now) {
  if (!config.delivery) throw new WatchdogError("destination_missing");
  if (state.quarantined && config.delivery.enabled)
    throw new WatchdogError("disable_delivery_before_testing");
  const previous = state.jobs.find((job) => job.id === state.testId);
  if (previous && !newTest) return previous;
  if (
    previous &&
    (PENDING.has(previous.state) ||
      now - Date.parse(previous.createdAt) < 60000)
  )
    throw new WatchdogError("test_pending_or_cooling_down");
  const job = enqueue(state, config, "test", now, null);
  state.testId = job.id;
  return job;
}

/** @param {object} state @param {number} now @returns {void} */
export function cancelWatchdogTest(state, now) {
  const job = state.jobs.find((job) => job.id === state.testId);
  if (job) cancel(job, "operator_cancelled", now);
}

/** @param {object} state @param {number} now @returns {void} */
export function quarantineWatchdog(state, now) {
  for (const job of state.jobs) cancel(job, "restore", now);
  state.quarantined = true;
  state.verifiedAt = null;
  state.blockedCode = "restore";
  state.testId = null;
  if (state.incident) state.incident.announced = false;
}

/** @param {object} state @param {import('./watchdog-config.mjs').WatchdogConfig} config @param {number} now @param {string|null} [onlyId] @returns {object|null} */
export function dueWatchdog(state, config, now, onlyId = null) {
  if (!config.delivery) return null;
  return (
    state.jobs
      .filter(
        (job) =>
          (!onlyId || job.id === onlyId) &&
          ["queued", "retry"].includes(job.state) &&
          Date.parse(job.nextAttemptAt) <= now &&
          ((job.kind === "test" &&
            (!state.quarantined || !config.delivery.enabled)) ||
            watchdogDeliveryEnabled(state, config)),
      )
      .sort(
        (a, b) =>
          Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) ||
          Date.parse(a.createdAt) - Date.parse(b.createdAt),
      )[0] ?? null
  );
}

/** @param {object} job @param {number} now @returns {void} */
export function beginWatchdogDelivery(job, now) {
  if (
    !["queued", "retry"].includes(job.state) ||
    job.attempts >= 4 ||
    now - Date.parse(job.createdAt) >= DAY
  )
    throw new WatchdogError("delivery_not_due");
  job.state = "sending";
  job.attempts++;
  job.nextAttemptAt = null;
  job.history.push({
    number: job.attempts,
    state: "sending",
    code: null,
    startedAt: at(now),
    completedAt: null,
    messageId: null,
  });
}

/** @param {object} state @param {object} job @param {import('./telegram.mjs').DeliveryResult} result @param {number} now @returns {void} */
export function completeWatchdogDelivery(state, job, result, now) {
  if (job.state !== "sending") throw new WatchdogError("delivery_not_sending");
  if (now < Date.parse(job.history.at(-1).startedAt))
    throw new WatchdogError("clock_regressed");
  const delivered = result.state === "delivered",
    uncertain = result.state === "unconfirmed";
  const delay =
    ("retryAfter" in result ? result.retryAfter : undefined) ??
    DELAYS[job.attempts - 1] ??
    900;
  const retryCandidate =
    !delivered &&
    !job.cancelRequested &&
    ["retry", "unconfirmed"].includes(result.state) &&
    job.attempts < 4;
  const retry =
    retryCandidate && now + delay * 1000 < Date.parse(job.createdAt) + DAY;
  const cancelled = job.cancelRequested || result.state === "cancelled";
  job.hadUnconfirmed ||= uncertain;
  job.state = delivered
    ? "delivered"
    : cancelled
      ? "cancelled"
      : retry
        ? "retry"
        : job.hadUnconfirmed
          ? "unconfirmed"
          : "failed";
  job.lastCode =
    retryCandidate && !retry ? "retry_after_deadline" : result.code;
  job.completedAt = retry ? null : at(now);
  job.nextAttemptAt = retry ? at(now + delay * 1000) : null;
  const attempt = job.history.at(-1);
  attempt.state = delivered
    ? "delivered"
    : uncertain
      ? "unconfirmed"
      : result.state === "cancelled"
        ? "cancelled"
        : "rejected";
  attempt.completedAt = at(now);
  attempt.code = result.code;
  attempt.messageId = delivered ? result.messageId : null;
  const current =
    job.target === state.target &&
    job.destination === state.destination &&
    !job.cancelRequested;
  if (delivered && job.kind === "test" && current) {
    if ((!state.verifiedAt || state.blockedCode) && state.incident)
      state.incident.announced = false;
    state.verifiedAt = at(now);
    state.blockedCode = null;
    state.quarantined = false;
  }
  if (
    current &&
    result.state === "rejected" &&
    [
      "bot_unauthorized",
      "destination_rejected",
      "invalid_configuration",
    ].includes(result.code)
  ) {
    state.verifiedAt = null;
    state.blockedCode = result.code;
    for (const pending of state.jobs)
      cancel(pending, "destination_blocked", now);
  }
}

/** @param {object} state @param {number} now @returns {void} */
export function pruneWatchdog(state, now) {
  const recent = new Set(
    state.jobs
      .filter(
        (job) =>
          TERMINAL.has(job.state) &&
          now - Date.parse(job.completedAt) < 30 * DAY,
      )
      .slice(-100)
      .map((job) => job.id),
  );
  state.jobs = state.jobs.filter(
    (job) =>
      PENDING.has(job.state) || recent.has(job.id) || job.id === state.testId,
  );
}

/** @param {object} state @param {import('./watchdog-config.mjs').WatchdogConfig} config @returns {object} */
export function watchdogStatus(state, config) {
  const binding = watchdogBindings(config);
  const matches =
    state.target === binding.target &&
    state.destination === binding.destination;
  return {
    version: 1,
    condition: state.target === binding.target ? state.condition : "unknown",
    lastSample: state.target === binding.target ? state.lastSample : null,
    failures: state.failures,
    successes: state.successes,
    configured: config.delivery !== null,
    verified: matches && state.verifiedAt !== null,
    quarantined: state.quarantined,
    enabled: watchdogDeliveryEnabled(state, config),
    blockedCode: matches ? state.blockedCode : null,
    configurationChanged: !matches,
    testId: matches ? state.testId : null,
    pending: state.jobs.filter((job) => PENDING.has(job.state)).length,
    recent: state.jobs
      .slice(-20)
      .reverse()
      .map(
        ({
          id,
          kind,
          state,
          attempts,
          hadUnconfirmed,
          createdAt,
          completedAt,
          nextAttemptAt,
          lastCode,
          history,
        }) => ({
          id,
          kind,
          state,
          attempts,
          hadUnconfirmed,
          createdAt,
          completedAt,
          nextAttemptAt,
          lastCode,
          history,
        }),
      ),
  };
}
