const titles = {
  telemetry_stale: [
    "Device readings are overdue",
    "Отчетите от устройството закъсняват",
  ],
  device_offline: [
    "Inverter is offline or in alarm",
    "Инверторът е офлайн или подава аларма",
  ],
  request_failures: [
    "Repeated device checks failed",
    "Последователни проверки на устройството са неуспешни",
  ],
  auth_failure: [
    "Provider authentication was rejected",
    "Удостоверяването при доставчика е отказано",
  ],
  control_fault: [
    "A control check needs attention",
    "Проверка на управлението изисква внимание",
  ],
  cleanup_pending: [
    "Scheduled charging cleanup is unconfirmed",
    "Изключването на зареждането по график не е потвърдено",
  ],
  api_quota: [
    "API allowance needs attention",
    "Лимитът за API заявки изисква внимание",
  ],
  api_capacity: [
    "Monitoring is waiting for API capacity",
    "Наблюдението изчаква капацитет за API заявки",
  ],
};

const recoveryTitles = {
  telemetry_stale: ["Device readings alert cleared", "Сигналът за отчетите от устройството е изчистен"],
  device_offline: ["Inverter status alert cleared", "Сигналът за състоянието на инвертора е изчистен"],
  request_failures: ["Device communication alert cleared", "Сигналът за връзката с устройството е изчистен"],
  auth_failure: ["SOLARMAN sign-in alert cleared", "Сигналът за входа в SOLARMAN е изчистен"],
  control_fault: ["Control alert cleared", "Сигналът за управлението е изчистен"],
  cleanup_pending: ["Charging cleanup alert cleared", "Сигналът за изключване на зареждането е изчистен"],
  api_quota: ["API allowance alert cleared", "Сигналът за лимита за API заявки е изчистен"],
  api_capacity: ["API capacity alert cleared", "Сигналът за капацитета за API заявки е изчистен"],
};

/** @param {string} value @param {number} maximum @returns {string} */
function plain(value, maximum) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, maximum);
}

/** @param {{id:string,kind:string,severity:string,device:string,detail_code?:string|null,resolution_reason?:string|null,last_seen_at:Date|string,resolved_at:Date|string|null}} incident @param {'opened'|'escalated'|'resolved'} event @param {{name:string,language:'en'|'bg',origin:string,reference:string}} options @returns {{text:string,title:string}} */
export function incidentNotification(incident, event, options) {
  const bg = options.language === "bg";
  const originalTitle = titles[incident.kind]?.[bg ? 1 : 0];
  if (!originalTitle) throw new Error("Unknown notification incident");
  const changed = event === "resolved" && incident.resolution_reason === "binding_changed";
  const title = changed
    ? bg ? "Наблюдаваното устройство е сменено" : "Monitoring target changed"
    : event === "resolved" ? recoveryTitles[incident.kind][bg ? 1 : 0] : originalTitle;
  const state =
    changed
      ? bg ? "Предишният сигнал е затворен" : "Previous alert closed"
      : event === "resolved"
      ? bg
        ? "Възстановено"
        : "Recovered"
      : incident.severity === "critical"
        ? bg
          ? "Критично"
          : "Critical"
        : bg
          ? "Необходимо е внимание"
          : "Attention needed";
  const at = new Date(
    event === "resolved" ? incident.resolved_at : incident.last_seen_at,
  ).toISOString();
  const details = changed
    ? bg ? "Предишният сигнал е затворен след промяна на наблюдаваното устройство. Това не потвърждава състоянието на старото устройство." : "The previous alert was closed after the monitored device changed. This does not confirm the old device's condition."
    : event === "resolved" ? null
    : incident.kind === "api_quota"
      ? {
          low: [
            "Routine allowance is low.",
            "Оставащият лимит за обичайни заявки е малък.",
          ],
          "recovery-only": [
            "Routine requests are blocked to preserve recovery capacity.",
            "Обичайните заявки са блокирани, за да се запази капацитет за възстановяване.",
          ],
          exhausted: [
            "Tracked allowance is exhausted, including recovery capacity.",
            "Отчетеният лимит е изчерпан, включително капацитетът за възстановяване.",
          ],
        }[incident.detail_code]?.[bg ? 1 : 0]
      : incident.kind === "cleanup_pending"
        ? bg
          ? "Потвърждаването на известието не спира зареждането. Проверете управлението и инвертора."
          : "Acknowledging the alert does not stop charging. Check Controls and the inverter."
        : null;
  return {
    title,
    text: [
      "SOLARMAN · " + state,
      plain(options.name, 120),
      title,
      (bg ? "Устройство: " : "Device: ") + plain(incident.device, 200),
      details,
      at,
      `${options.origin}/settings/health`,
      (bg ? "Номер на събитието: " : "Event reference: ") + options.reference,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** @param {{id:string,incident_id?:string|null,kind:string,payload:{title:string},channel:{language:'en'|'bg'},attemptId:string,receiptToken:string}} job @returns {{title:string,body:string,url:string,language:'en'|'bg',reference:string,incidentReference:string|null,silent:boolean,renotify:boolean,receipt:{id:string,attempt:string,token:string}}} */
export function browserNotification(job) {
  const bg = job.channel.language === "bg";
  return {
    title: job.payload.title,
    body: job.kind === "test"
      ? bg ? "Проверка на известията. Настройките на инвертора не са променени." : "Notification test. Inverter settings have not changed."
      : job.kind === "resolved"
        ? bg ? "Сигналът е затворен. Отворете таблото за подробности." : "This alert is closed. Open the dashboard for details."
        : bg ? "Отворете таблото за подробности за събитието." : "Open the dashboard for event details.",
    url: ["energy-briefing", "energy-reminder"].includes(job.kind)
      ? "/controls/energy-tools" : job.kind === "test" ? "/settings/notifications" : "/settings/health",
    language: job.channel.language,
    reference: job.id,
    incidentReference: job.incident_id ?? null,
    silent: job.kind === "resolved",
    renotify: job.kind === "escalated",
    receipt: { id: job.id, attempt: job.attemptId, token: job.receiptToken },
  };
}

/** @param {'en'|'bg'} language @param {string} origin @param {string} reference @returns {{title:string,text:string}} */
export function testNotification(language, origin, reference) {
  return language === "bg"
    ? {
        title: "Проверка на известията",
        text: `SOLARMAN · Проверка на известията\nТова съобщение проверява избраната дестинация. Настройките на инвертора не са променени.\n${origin}/settings/notifications\nНомер на събитието: ${reference}`,
      }
    : {
        title: "Notification test",
        text: `SOLARMAN · Notification test\nThis message tests the selected destination. Inverter settings have not changed.\n${origin}/settings/notifications\nEvent reference: ${reference}`,
      };
}
