import { UTILITY_ENDPOINT, parseUtilityIndex, parseUtilityPoint, utilityAreaKey } from "./energy-utility-model.mjs";
import { energyLocalTime } from "./energy-time.mjs";

/** @param {Response} response @param {number} limit @returns {Promise<Uint8Array>} */
export async function readUtilityResponse(response, limit) {
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > limit || !response.body) throw new Error("utility-unavailable");
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error("utility-too-large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export class EnergyUtility {
  /** @param {object} experience @param {typeof fetch} [transport] */
  constructor(experience, transport = fetch) { this.experience = experience; this.pool = experience.pool; this.transport = transport; this.publicPending = null; }

  /** @param {object} body @param {boolean} [pdf] @returns {Promise<Uint8Array>} */
  async request(body, pdf = false) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(790231)");
      const used = (await client.query("SELECT count(*)::int AS n FROM energy_utility_requests WHERE created_at>clock_timestamp()-interval '24 hours'")).rows[0].n;
      if (used >= 80) throw new Error("utility-capacity");
      await client.query("INSERT INTO energy_utility_requests DEFAULT VALUES");
      await client.query("DELETE FROM energy_utility_requests WHERE created_at<clock_timestamp()-interval '2 days'");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const signal = AbortSignal.any([this.experience.hub.energy.abort.signal, AbortSignal.timeout(10000)]);
    const response = await this.transport(UTILITY_ENDPOINT, { method: "POST", body: new URLSearchParams(body), headers: { accept: pdf ? "application/pdf" : "text/html" }, redirect: "error", signal });
    const content = response.headers.get("content-type") ?? "";
    if (!(pdf ? content.includes("application/pdf") : content.includes("text/html"))) throw new Error("utility-format");
    const bytes = await readUtilityResponse(response, pdf ? 5 * 1024 * 1024 : 1024 * 1024);
    if (!pdf && new TextDecoder().decode(bytes).trim() === "tomuch") throw new Error("utility-capacity");
    return bytes;
  }

  /** @returns {Promise<object[]>} */
  async publications() {
    if (this.publicPending) return this.publicPending;
    this.publicPending = this.loadPublications().finally(() => { this.publicPending = null; });
    return this.publicPending;
  }

  /** @returns {Promise<object[]>} */
  async loadPublications() {
    const today = energyLocalTime(Date.now(), "Europe/Sofia").day;
    let index = (await this.pool.query("SELECT notices FROM energy_utility_publications WHERE source_id='index' AND fetched_at>clock_timestamp()-interval '3 hours' AND day=$1", [today])).rows[0]?.notices;
    if (!index) {
      index = parseUtilityIndex(new TextDecoder().decode(await this.request({ action: "showpdf" })));
      await this.pool.query("INSERT INTO energy_utility_publications(source_id,day,fetched_at,notices) VALUES('index',$1,clock_timestamp(),$2) ON CONFLICT(source_id) DO UPDATE SET day=$1,fetched_at=clock_timestamp(),notices=$2", [today, JSON.stringify(index)]);
    }
    const output = [];
    for (const entry of index) {
      let cached = (await this.pool.query("SELECT notices FROM energy_utility_publications WHERE source_id=$1 AND fetched_at>clock_timestamp()-interval '3 hours'", [entry.id])).rows[0]?.notices;
      if (!cached) {
        const bytes = await this.request({ action: "showdocid", doc_id: entry.id }, true);
        cached = await this.experience.calculate("publication", {}, { bytes });
        await this.pool.query("INSERT INTO energy_utility_publications(source_id,day,fetched_at,notices) VALUES($1,$2,clock_timestamp(),$3) ON CONFLICT(source_id) DO UPDATE SET day=$2,fetched_at=clock_timestamp(),notices=$3", [entry.id, entry.day, JSON.stringify(cached)]);
      }
      output.push(...cached);
    }
    await this.pool.query("DELETE FROM energy_utility_publications WHERE day<current_date-7");
    return output;
  }

  /** @param {object} reference @returns {Promise<object[]>} */
  async notices(reference) {
    if (reference.kind === "supply-point") return parseUtilityPoint(new TextDecoder().decode(await this.request({ action: "viewpod_plan", pod: reference.point, user: "", lat: "0", lon: "0" })));
    const published = await this.publications();
    return published.filter(notice => utilityAreaKey(notice.municipality) === utilityAreaKey(reference.municipality) && utilityAreaKey(notice.area) === utilityAreaKey(reference.area));
  }
}
