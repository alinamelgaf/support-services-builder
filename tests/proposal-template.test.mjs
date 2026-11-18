import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureTemplate, initialDefaults, LEGACY_STORAGE_KEY, parseTemplate, readTemplate, serializeDefaults,
  STORAGE_KEY, TEMPLATE_STORAGE_KEY, templateServiceSettings, writeTemplate,
} from "../src/package-defaults.js";
import { buildProposal, DEFAULT_TITLE } from "../src/proposal.js";
import { documentOptions } from "../src/document-sections.js";
import { createImportBatch, validateSources } from "../src/confluence.js";
import { referenceFixture } from "./fixtures.mjs";

const catalog = () => createImportBatch().add([referenceFixture()], validateSources()).data;
const memory = () => {
  const data = new Map();
  return { data, storage: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } };
};

test("converts legacy manager settings without overwriting a complete personal template", () => {
  const { data, storage } = memory();
  const old = initialDefaults({ "TS-1": { Standard: "2 часа", Extended: "+", "Managed Service": "-" } });
  data.set(LEGACY_STORAGE_KEY, serializeDefaults(old).replace('"schemaVersion": 2', '"schemaVersion": 1'));
  const upgraded = readTemplate(storage);
  assert.deepEqual(upgraded.documentOptions, documentOptions());
  assert.equal(upgraded.selected, "Standard");
  assert.equal(data.has(TEMPLATE_STORAGE_KEY), false);
  data.set(STORAGE_KEY, serializeDefaults({ ...old, includedInDocument: { "TS-1": false } }));
  assert.equal(readTemplate(storage).includedInDocument["TS-1"], false);
  writeTemplate(storage, { ...upgraded, selected: "Managed Service", documentOptions: documentOptions({ included: { sla: true }, slaMode: "all", slaFormat: "separate" }) });
  data.set(STORAGE_KEY, serializeDefaults(initialDefaults()));
  assert.equal(readTemplate(storage).selected, "Managed Service");
  assert.equal(data.has(LEGACY_STORAGE_KEY), true);
  assert.equal(data.has(STORAGE_KEY), true);
  const stored = data.get(TEMPLATE_STORAGE_KEY);
  assert.throws(() => writeTemplate({ ...storage, setItem() {} }, { ...readTemplate(storage), selected: "Extended" }));
  assert.equal(data.get(TEMPLATE_STORAGE_KEY), stored);
  data.set(TEMPLATE_STORAGE_KEY, "broken");
  assert.throws(() => readTemplate(storage));
});

test("captures all services, excluded parameters and document choices without source content or palette", () => {
  const result = catalog();
  const settings = templateServiceSettings(result.standard, null, result.services);
  settings.overrides.set("TS-1", new Map([["Managed Service", { included: false, parameter: "Параметр исключённой услуги" }]]));
  settings.documentOverrides.set("TS-1.A", false);
  const options = documentOptions({ included: { intro: false, sla: true, severity: true, glossary: true }, slaMode: "all", slaFormat: "separate" });
  const template = captureTemplate(result.services, settings, "Extended", options);
  assert.equal(Object.keys(template.values).length, result.services.length);
  assert.equal(template.excludedParameters["TS-1"]["Managed Service"], "Параметр исключённой услуги");
  const { storage, data } = memory();
  writeTemplate(storage, { ...template, palette: { mode: "custom" }, title: "Старое название", services: result.services });
  const stored = JSON.parse(data.get(TEMPLATE_STORAGE_KEY));
  assert.deepEqual(Object.keys(stored).sort(), ["format", "schemaVersion", "values", "includedInDocument", "selected", "documentOptions", "excludedParameters"].sort());
  assert.deepEqual(readTemplate(storage), template);
  const applied = templateServiceSettings(result.standard, readTemplate(storage), result.services);
  assert.deepEqual(captureTemplate(result.services, applied, template.selected, template.documentOptions), template);
});

test("maps saved service IDs to an updated catalog and uses the new standard for new IDs", () => {
  const result = catalog();
  const template = captureTemplate(result.services, templateServiceSettings(result.standard, null, result.services), "Extended", documentOptions());
  template.values["TS-1"].Standard = "7 часов";
  const updated = result.services.filter(({ id }) => id !== "TS-10");
  updated.push({ ...updated[0], id: "TS-100" });
  const standard = { ...result.standard, values: { ...result.standard.values, "TS-1": { Standard: "20 часов", Extended: "+", "Managed Service": "+" },
    "TS-100": { Standard: "4 часа", Extended: "-", "Managed Service": "+" } } };
  const applied = captureTemplate(updated, templateServiceSettings(standard, template, updated), template.selected, template.documentOptions);
  assert.equal(applied.values["TS-1"].Standard, "7 часов");
  assert.equal(applied.values["TS-100"].Standard, "4 часа");
  assert.equal(Object.hasOwn(applied.values, "TS-10"), false);
});

test("rejects malformed personal templates and exports universal names from old proposals", () => {
  const result = catalog();
  const template = captureTemplate(result.services, templateServiceSettings(result.standard, null, result.services), "Standard", documentOptions());
  for (const bad of [{ selected: "Unknown" }, { excludedParameters: { "TS-1": { Standard: "invalid" } } }]) {
    assert.throws(() => parseTemplate(JSON.stringify({ ...template, ...bad, format: "support-services-builder-defaults", schemaVersion: 3 })));
  }
  const proposal = buildProposal(result.services, { selected: "Standard", title: "Старое название", client: "Старый клиент" });
  assert.equal(proposal.title, DEFAULT_TITLE);
  assert.equal(proposal.clientLine, "");
});
