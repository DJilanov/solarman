import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInstance } from "i18next";

const english = JSON.parse(
  readFileSync(new URL("../web/locales/en.json", import.meta.url), "utf8"),
);
const bulgarian = JSON.parse(
  readFileSync(new URL("../web/locales/bg.json", import.meta.url), "utf8"),
);
const placeholders = (value) =>
  [...value.matchAll(/\{\{\s*([^},\s]+)/g)].map((match) => match[1]).sort();

test("Bulgarian covers the complete English catalogue with matching interpolation variables", () => {
  assert.deepEqual(Object.keys(bulgarian).sort(), Object.keys(english).sort());
  for (const [key, value] of Object.entries(english)) {
    assert.equal(typeof bulgarian[key], "string", key);
    assert.ok(bulgarian[key].trim(), key);
    assert.deepEqual(placeholders(bulgarian[key]), placeholders(value), key);
    if (key !== "App ID") assert.notEqual(bulgarian[key], value, key);
  }
});

test("every literal translation used by the interface exists in both catalogues", () => {
  for (const file of [
    "App.tsx",
    "components.tsx",
    "pages.tsx",
    "charts.tsx",
    "format.ts",
    "i18n.tsx",
  ]) {
    const source = readFileSync(
      new URL(`../web/${file}`, import.meta.url),
      "utf8",
    );
    for (const match of source.matchAll(/\btr\(\s*("(?:[^"\\]|\\.)*")/g)) {
      const key = JSON.parse(match[1]);
      assert.ok(Object.hasOwn(english, key), `${file}: ${key}`);
      assert.ok(Object.hasOwn(bulgarian, key), `${file}: ${key}`);
    }
  }
});

test("Bulgarian plurals and diagnostic placeholders render without losing values", async () => {
  const instance = createInstance();
  await instance.init({
    lng: "bg",
    fallbackLng: "en",
    keySeparator: false,
    nsSeparator: false,
    resources: { en: { translation: english }, bg: { translation: bulgarian } },
  });
  assert.equal(instance.t("{{count}} readings", { count: 1 }), "1 показание");
  assert.equal(instance.t("{{count}} readings", { count: 2 }), "2 показания");
  assert.equal(
    instance.t("{{count}} recent entries", { count: 1 }),
    "1 последен запис",
  );
  assert.equal(instance.t("{{count}} minutes", { count: 1 }), "1 минута");
  assert.equal(
    instance.t("SOLARMAN rejected request (code {{code}})", {
      code: "2101021",
    }),
    "SOLARMAN отхвърли заявката (код 2101021)",
  );
  await instance.changeLanguage("en");
  assert.equal(instance.t("{{count}} readings", { count: 1 }), "1 reading");
  assert.equal(instance.t("Energy overview"), "Energy overview");
});
