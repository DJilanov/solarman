const QUARTER_HOUR = 15 * 60_000;

/** @param {object} body @param {number} [now] @returns {{start:number,end:number,baselineW:number}} */
export function validateAwayPeriod(body, now = Date.now()) {
  const start = typeof body.startsAt === "string" ? Date.parse(body.startsAt) : NaN;
  const end = typeof body.returnsAt === "string" ? Date.parse(body.returnsAt) : NaN;
  if (![start, end].every(Number.isFinite) || start < now - 60_000 || end <= start ||
    end > now + 366 * 86400_000 || [start, end].some(at => at % QUARTER_HOUR !== 0) ||
    new Date(start).toISOString() !== body.startsAt || new Date(end).toISOString() !== body.returnsAt)
    throw new Error("Choose departure and return times in 15-minute steps within the next year");
  if (typeof body.baselineW !== "number" || !Number.isFinite(body.baselineW) || body.baselineW < 50 || body.baselineW > 20000)
    throw new Error("Estimate the home's essential consumption between 50 W and 20 kW");
  return { start, end, baselineW: body.baselineW };
}

/** @param {object[]} periods @param {number} at @returns {object|null} */
export function awayAt(periods, at) {
  return periods.find(period => period.start <= at && at < period.end) ?? null;
}

/** @param {object[]} periods @param {number} from @param {number} to @returns {boolean} */
export function overlapsAway(periods, from, to) {
  return periods.some(period => period.start < to && period.end > from);
}
