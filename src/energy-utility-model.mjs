import { createHash } from "node:crypto";
import { energyLocalTime } from "./energy-time.mjs";

export const UTILITY_SOURCE = "https://ermzapad.bg/bg/za-klienta/prekusvania/";
export const UTILITY_ENDPOINT = "https://info.ermzapad.bg/webint/vok/avplan.php";

/** @param {string} value @returns {string} */
export function utilityAreaKey(value) { return value.normalize("NFKC").toLocaleUpperCase("bg").replace(/[.,\s-]+/g, " ").trim(); }

/** @param {object} body @returns {object} */
export function validateUtilityReference(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Enter the municipality and settlement or district as published by ERM Zapad");
  if (body.kind === "supply-point") {
    if (typeof body.point !== "string" || !/^32Z[A-Z0-9]{13}$/.test(body.point.trim().toUpperCase())) throw new Error("Enter the 16-character supply-point code starting with 32Z from your bill");
    return { kind: "supply-point", point: body.point.trim().toUpperCase() };
  }
  if (body.kind !== "area" || [body.municipality, body.area].some(value => typeof value !== "string" || !/^[\p{L}\p{N} .,'()/-]{2,80}$/u.test(value.trim())))
    throw new Error("Enter the municipality and settlement or district as published by ERM Zapad");
  return { kind: "area", municipality: body.municipality.trim(), area: body.area.trim() };
}

/** @param {string} html @param {number} [now] @returns {object[]} */
export function parseUtilityIndex(html, now = Date.now()) {
  if (!html.includes("планирани прекъсвания")) throw new Error("utility-format");
  const today = energyLocalTime(now, "Europe/Sofia").day, through = energyLocalTime(now + 7 * 86400000, "Europe/Sofia").day;
  const entries = [...html.matchAll(/previewdoc\((\d{1,10})\)[\s\S]{0,300}?([0-3]\d)\.([01]\d)\.(20\d\d)/g)]
    .map(match => ({ id: match[1], day: `${match[4]}-${match[3]}-${match[2]}` })).filter(value => value.day >= today && value.day <= through);
  if (!entries.length) throw new Error("utility-no-publication");
  return [...new Map(entries.map(value => [value.id, value])).values()].slice(0, 8);
}

/** @param {string} date @param {string} time @returns {number} */
export function utilityInstant(date, time) {
  const [day, month, year] = date.split(".").map(Number), [hour, minute] = time.split(":").map(Number);
  const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, guess = Date.UTC(year, month - 1, day, hour, minute), matches = [];
  if (hour > 23 || minute > 59 || new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== key) throw new Error("utility-format");
  for (let offset = -180; offset <= 180; offset += 15) {
    const at = guess + offset * 60000, local = energyLocalTime(at, "Europe/Sofia");
    if (local.day === key && local.minute === hour * 60 + minute) matches.push(at);
  }
  if (matches.length !== 1) throw new Error("utility-ambiguous-time");
  return matches[0];
}

/** @param {string} text @returns {object[]} */
export function parseUtilityPublication(text) {
  if (!text.includes("Планирани прекъсвания за") || !text.includes("Електроразпределителни мрежи Запад")) throw new Error("utility-format");
  let municipality = "", province = "", pending = "";
  const notices = [];
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    if (line.startsWith("област ")) { province = line.slice(7).split(" Част от ")[0].trim(); municipality = ""; pending = ""; continue; }
    if (line.startsWith("община ")) { municipality = line.slice(7).split(" За индивидуална")[0].trim(); pending = ""; continue; }
    if (line.startsWith("Част от ")) pending = line;
    else if (pending && line && !line.startsWith("община")) pending += ` ${line}`;
    if (!pending || !municipality) continue;
    const match = pending.match(/^Част от (.{1,250}?)\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})/);
    if (!match) { if (pending.length > 500) throw new Error("utility-format"); continue; }
    const start = utilityInstant(match[2], match[3]), end = utilityInstant(match[4], match[5]);
    if (end <= start || end - start > 3 * 86400000) throw new Error("utility-format");
    const area = match[1].trim(), key = createHash("sha256").update(JSON.stringify([province, municipality, area, start, end])).digest("hex");
    notices.push({ key, municipality, province, area, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), detail: `${province} · ${municipality} · ${area}`, scope: "area", sourceUrl: UTILITY_SOURCE });
    pending = "";
  }
  if (pending || !notices.length) throw new Error("utility-format");
  return notices;
}

/** @param {string} html @returns {object[]} */
export function parseUtilityPoint(html) {
  const text = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  if (!/планиран/iu.test(text)) throw new Error("utility-format");
  const notices = [...text.matchAll(/(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})[^\d]{0,40}(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})/g)].map(match => {
    const start = utilityInstant(match[1], match[2]), end = utilityInstant(match[3], match[4]);
    if (end <= start || end - start > 3 * 86400000) throw new Error("utility-format");
    return { key: createHash("sha256").update(`${start}:${end}`).digest("hex"), startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), detail: "ERM Zapad · planned work", scope: "supply-point", sourceUrl: UTILITY_SOURCE };
  });
  // The portal has no documented empty-result contract. Unknown replies are unavailable.
  if (!notices.length || notices.length > 30) throw new Error("utility-format");
  return notices;
}
