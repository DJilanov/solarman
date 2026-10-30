export function localDateTimeInput(at: number, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function localDateTimeInstant(value: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Choose a valid date and time");
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const nominal = Date.UTC(year, month - 1, day, hour, minute);
  const calendar = new Date(nominal);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59)
    throw new Error("Choose a valid date and time");
  let candidate = nominal;
  for (let i = 0; i < 3; i++) {
    const local = localDateTimeInput(candidate, timezone);
    candidate += nominal - Date.parse(local + "Z");
  }
  if (!Number.isFinite(candidate) || localDateTimeInput(candidate, timezone) !== value)
    throw new Error("This local time does not exist because the clocks change. Choose another time");
  for (const offset of [-7200000, -3600000, 3600000, 7200000])
    if (localDateTimeInput(candidate + offset, timezone) === value)
      throw new Error("This local time occurs twice because the clocks change. Choose another time");
  return new Date(candidate).toISOString();
}
