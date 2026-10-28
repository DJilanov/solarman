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

/** @param {string} value @param {number} maximum @returns {string} */
function plain(value, maximum) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, maximum);
}

/** @param {{id:string,kind:string,severity:string,device:string,detail_code?:string|null,last_seen_at:Date|string,resolved_at:Date|string|null}} incident @param {'opened'|'escalated'|'resolved'} event @param {{name:string,language:'en'|'bg',origin:string,reference:string}} options @returns {{text:string,title:string}} */
export function incidentNotification(incident, event, options) {
  const bg = options.language === "bg";
  const title = titles[incident.kind]?.[bg ? 1 : 0];
  if (!title) throw new Error("Unknown notification incident");
  const state =
    event === "resolved"
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
  const details =
    incident.kind === "api_quota"
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
