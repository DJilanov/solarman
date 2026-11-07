import test from "node:test";
import assert from "node:assert/strict";
import { parseUtilityIndex, parseUtilityPublication, parseUtilityPoint, utilityInstant, utilityAreaKey, validateUtilityReference } from "../src/energy-utility-model.mjs";
import { EnergyUtility, readUtilityResponse } from "../src/energy-utility.mjs";

const publication = `Електроразпределителни мрежи Запад ЕАД
Планирани прекъсвания за 09.11.2026 г.
област ПРИМЕРНА Част от населено място в интервала между
община ТЕСТОВА За индивидуална проверка натиснете ТУК
Част от ПРИМЕРЕН РАЙОН 09.11.2026 08:30 09.11.2026 16:30
Част от МНОГОРЕДОВ
ПРИМЕР 09.11.2026 09:00 09.11.2026 10:30`;
test("the utility parser retains exact area scope, wrapped place names and Sofia-local outage times", () => {
  const notices = parseUtilityPublication(publication);
  assert.equal(notices.length, 2);
  assert.equal(notices[0].scope, "area");
  assert.equal(notices[0].municipality, "ТЕСТОВА");
  assert.equal(notices[0].startsAt, "2026-11-09T06:30:00.000Z");
  assert.equal(notices[1].area, "МНОГОРЕДОВ ПРИМЕР");
  assert.equal(utilityAreaKey("жк. Примерен-район"), utilityAreaKey("ЖК ПРИМЕРЕН РАЙОН"));
  assert.throws(() => parseUtilityPublication("Unknown portal response"));
  assert.throws(() => parseUtilityPublication(publication.replace("16:30", "06:30")));
  assert.throws(() => utilityInstant("25.10.2026", "03:30"));
  assert.throws(() => utilityInstant("29.03.2026", "03:30"));
  assert.throws(() => utilityInstant("31.02.2026", "12:30"));
});
test("only bounded current/future public document identifiers are read; unknown empty point replies remain unavailable", () => {
  const html = `планирани прекъсвания <a href="javascript:previewdoc(123);">за 09.11.2026</a><a href="javascript:previewdoc(122);">за 01.01.2020</a>`;
  assert.deepEqual(parseUtilityIndex(html, Date.parse("2026-11-07T12:00Z")), [{ id: "123", day: "2026-11-09" }]);
  assert.throws(() => parseUtilityIndex("tomuch"));
  assert.throws(() => parseUtilityPoint("Няма информация"));
  assert.throws(() => parseUtilityPoint("Планирани: unknown"));
  const result = parseUtilityPoint("Планирани прекъсвания: <td>09.11.2026 08:30</td><td>09.11.2026 16:30</td>");
  assert.equal(result[0].scope, "supply-point");
  assert.equal(result[0].detail.includes("32Z"), false);
  assert.throws(() => validateUtilityReference({ kind: "supply-point", point: "123" }));
  assert.throws(() => validateUtilityReference({ kind: "area", municipality: "https://host", area: "<script>" }));
});
test("utility HTTP reads reject oversized, failed, redirected and incorrect-content replies without following arbitrary URLs", async () => {
  await assert.rejects(readUtilityResponse(new Response("12345"), 4), /too-large/);
  await assert.rejects(readUtilityResponse(new Response("error", { status: 503 }), 100), /unavailable/);
  const queries = [], client = { query: async sql => { queries.push(sql); return { rows: [{ n: 0 }] }; }, release() {} };
  let called = 0;
  const experience = { pool: { connect: async () => client }, hub: { energy: { abort: new AbortController() } } };
  const utility = new EnergyUtility(experience, async (url, options) => {
    called++; assert.equal(url, "https://info.ermzapad.bg/webint/vok/avplan.php"); assert.equal(options.redirect, "error"); assert.equal(options.method, "POST"); assert.ok(options.signal);
    return new Response("<html>Unsupported</html>", { headers: { "content-type": "text/html" } });
  });
  await assert.rejects(utility.request({ action: "showdocid", doc_id: "123" }, true), /format/);
  assert.equal(called, 1);
  assert.ok(queries.some(sql => sql.includes("energy_utility_requests")));
  client.query = async sql => ({ rows: [{ n: sql.includes("count") ? 80 : 0 }] });
  await assert.rejects(utility.request({ action: "showpdf" }), /capacity/);
  assert.equal(called, 1);
});
