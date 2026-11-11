import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { createImportBatch, queryUrl, validateSources } from "../src/confluence.js";
import { generateExcel } from "../src/excel.js";
import { generateWord } from "../src/word.js";
import { defaultDifferences, initialDefaults, overlayDefaults, parseDefaults, readDefaults, serializeDefaults, snapshotDefaults, writeDefaults } from "../src/package-defaults.js";
import { buildProposal, buildServiceRows } from "../src/proposal.js";
import { flattenRich, plainText } from "../src/rich-text.js";
import { BASE, fixture, IDS, legacy, paginate, PUBLIC_LINK, SOURCES } from "./fixtures.mjs";

const sources = validateSources(SOURCES);
const importRest = (data = fixture()) => createImportBatch().add([data], sources).data;

test("maps three REST sources by label and IDs, preserving rich content and independent modifications", () => {
  const data = fixture({ extra: true });
  data.results[0] = { content: data.results[0] };
  const { services, standard, issues, usableStandard } = importRest(data);
  assert.equal(usableStandard, true);
  assert.deepEqual(services.map(({ id }) => id), [...IDS.slice(0, 3), "TS-3.B", "TS-4", ...IDS.slice(3)]);
  assert.equal(services[0].name, "Пример TS-1");
  assert.equal(standard.values["TS-1"].Standard, "12 часов");
  assert.equal(standard.values["TS-3.B"].Extended, "6 часов");
  assert.equal(standard.includedInDocument["TS-2"], false);
  assert.match(plainText(services[0].description), /Демонстрация.*Справочная карточка.*инструкция/);
  assert.equal(flattenRich(standard.introductions.Extended.blocks)[0].italics, true);
  assert.equal(standard.introductions.Standard.blocks[1].kind, "list");
  assert.equal(standard.introductions["Managed Service"].blocks[1].ordered, true);
  assert.equal(standard.introductions.Standard.excel, false);
  assert.equal(standard.introductions.Standard.word, true);
  assert.ok(issues.some(({ message }) => message.includes("TS-99")));
  assert.ok(issues.some(({ message }) => message.includes("TS-4")));
  assert.ok(!JSON.stringify(services).includes("pixel.example.invalid"));
});

test("waits for consecutive pages, deduplicates and rejects conflicting or incomplete batches", () => {
  const data = fixture();
  const batch = createImportBatch();
  const tail = paginate(data, 5, data.size);
  assert.equal(batch.add([tail], sources).complete, false);
  assert.equal(batch.add([tail], sources).count, 3);
  const wrong = structuredClone(tail);
  wrong.results[0].title += " изменено";
  assert.throws(() => batch.add([wrong], sources), /смещению/);
  assert.equal(batch.add([paginate(data, 0, 3)], sources).complete, false);
  assert.equal(batch.add([paginate(data, 3, 5)], sources).data.services.length, IDS.length);
  assert.equal(batch.add([paginate(data, 0, 5)], sources).complete, false);
  assert.throws(() => batch.add([legacy()], sources), /отдельно/);
  batch.reset();
  assert.equal(batch.add([legacy()], sources).data.services[0].id, "TS-5.A");
  const duplicate = { ...data, results: [...data.results, data.results[0]], size: data.size + 1, totalSize: data.size + 1 };
  assert.equal(importRest(duplicate).services.length, IDS.length);
  assert.throws(() => importRest({ ...data, results: data.results.map((item) => ({ ...item, metadata: {} })) }), /metadata.labels/);
  assert.equal(importRest(fixture({ duplicate: true })).usableStandard, false);
});

test("creates an explicit read-only URL from local settings without embedding a default host", () => {
  assert.equal(queryUrl(validateSources()), "");
  assert.throws(() => validateSources({ base: `https://${"u"}:${"p"}@wiki.example.invalid` }), /учётных данных/);
  assert.throws(() => validateSources({ labels: { catalog: "bad' label" } }), /метки/);
  const url = new URL(queryUrl(sources));
  assert.equal(url.pathname, "/confluence/rest/api/content/search");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("expand"), "body.storage,metadata.labels");
  assert.match(url.searchParams.get("cql"), /"demo_catalog", "demo_defaults", "demo_intros"/);
});

for (const pageCount of [28, 50, 51]) {
  test(`imports ${pageCount} REST results with a 50-result limit`, () => {
    const catalogCount = pageCount - 2;
    const data = fixture({ catalogCount, unknown: false, adversarial: false });
    delete data.totalSize;
    const batch = createImportBatch();
    const first = { ...paginate(data, 0, Math.min(50, pageCount)), limit: 50 };
    let imported = batch.add([first], sources);

    if (pageCount === 51) {
      assert.equal(new URL(first._links.next, BASE).searchParams.get("start"), "50");
      assert.equal(imported.complete, false);
      assert.equal(imported.count, 50);
      assert.equal(imported.data, null);
      imported = batch.add([{ ...paginate(data, 50, pageCount), limit: 50 }], sources);
    } else {
      assert.equal(first._links.next, undefined);
    }

    assert.equal(imported.complete, true);
    assert.equal(imported.count, pageCount);
    assert.equal(imported.data.services.length, catalogCount);
    assert.equal(imported.data.usableStandard, true);
    assert.equal(Object.keys(imported.data.standard.values).length, catalogCount);
    assert.match(plainText(imported.data.standard.introductions.Extended.blocks), /Пример Extended/);
    assert.deepEqual(imported.data.issues, []);
  });
}

test("reads a horizontal table of introductory texts and rejects incomplete label metadata", () => {
  const data = fixture();
  data.results.at(-1).body.storage.value = "<table><tr><th>Standard</th><th>Extended</th><th>Managed Service</th></tr>" +
    "<tr><td><b>Первый</b></td><td></td><td><ul><li>Третий</li></ul></td></tr></table>";
  const { standard, usableStandard } = importRest(data);
  assert.equal(usableStandard, true);
  assert.equal(flattenRich(standard.introductions.Standard.blocks)[0].bold, true);
  assert.equal(standard.introductions.Extended.blocks.length, 0);
  assert.equal(standard.introductions["Managed Service"].blocks[0].kind, "list");
  data.results[0].metadata.labels.totalSize = 5;
  assert.throws(() => importRest(data), /metadata.labels/);
});

test("keeps local settings separate from updated standard, with corporate fallback for new IDs", () => {
  const { services, standard } = importRest();
  const overrides = new Map([["TS-1", new Map([["Standard", { included: true, parameter: "7 часов локально" }]])]]);
  const rows = buildServiceRows(services, { defaults: standard.values, overrides, documentDefaults: standard.includedInDocument,
    documentOverrides: new Map([["TS-1.A", false]]) });
  const saved = snapshotDefaults(initialDefaults(), rows, standard.introductions);
  const values = new Map();
  const storage = { setItem: (key, value) => values.set(key, value), getItem: (key) => values.get(key) ?? null };
  writeDefaults(storage, saved);
  assert.deepEqual(parseDefaults(serializeDefaults(saved)), saved);
  const legacySettings = { ...JSON.parse(serializeDefaults(saved)), schemaVersion: 1 };
  assert.deepEqual(parseDefaults(JSON.stringify(legacySettings)), initialDefaults(saved.values));
  const updated = importRest(fixture({ parameter: "18 часов", extra: true }));
  const local = readDefaults(storage);
  const merged = overlayDefaults(updated.standard, local);
  assert.equal(standard.values["TS-1"].Standard, "12 часов");
  assert.equal(updated.standard.values["TS-1"].Standard, "18 часов");
  assert.equal(merged.values["TS-1"].Standard, "7 часов локально");
  assert.equal(merged.values["TS-3.B"].Extended, "6 часов");
  assert.equal(merged.includedInDocument["TS-1.A"], false);
  assert.deepEqual(defaultDifferences(updated.standard, local, updated.services), ["TS-1", "TS-1.A"]);
  assert.throws(() => writeDefaults({ setItem() {}, getItem: () => null }, saved), /не подтверждена/);
});

test("generates the same ordered selection in Excel and Word with rich intros and internal links only in Excel", async () => {
  const { services, standard } = importRest();
  const introduction = { ...standard.introductions.Extended, excel: true };
  const proposal = buildProposal(services, { selected: "Extended", defaults: standard.values,
    documentDefaults: standard.includedInDocument, introductions: { ...standard.introductions, Extended: introduction }, confluenceBases: [BASE] });
  assert.deepEqual(proposal.rows.map(({ id }) => id), IDS.filter((id) => id !== "TS-2"));
  const [bytes, docx] = await Promise.all([generateExcel(proposal), generateWord(proposal)]);
  const [xlsx, word] = await Promise.all([JSZip.loadAsync(bytes), JSZip.loadAsync(await docx.arrayBuffer())]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  assert.deepEqual(workbook.worksheets.map(({ name }) => name), ["Описание услуг", "Предложение"]);
  const overview = workbook.getWorksheet("Описание услуг");
  const comparison = workbook.getWorksheet("Предложение");
  assert.deepEqual(overview.getColumn(1).values.slice(3), proposal.rows.map(({ id }) => id));
  assert.match(overview.getCell("C3").text, /Демонстрация.*Справочная карточка/);
  assert.equal(overview.getCell("D3").text, "Учебное условие.");
  assert.match(comparison.getCell("A3").text, /Пример Extended/);
  const sheet = await xlsx.file("xl/worksheets/sheet2.xml").async("string");
  assert.doesNotMatch(sheet, /xSplit=|r:id="[^"]+"[^>]*location/);
  assert.equal([...sheet.matchAll(/<hyperlink ref="[AB]\d+" location="'Описание услуг'!A\d+"/g)].length, proposal.rows.length * 2);
  const document = await word.file("word/document.xml").async("string");
  const relations = await word.file("word/_rels/document.xml.rels").async("string");
  assert.ok(document.indexOf("Пример Extended") < document.indexOf("<w:tbl>"));
  assert.match(document, /<w:pStyle w:val="Heading2"\/>.*?<w:jc w:val="center"\/>.*?Пример TS-1/);
  assert.doesNotMatch(document, /TS-2/);
  assert.ok(relations.includes(PUBLIC_LINK));
  assert.doesNotMatch(relations, /wiki\.example\.invalid/);
  assert.doesNotMatch(await xlsx.file("xl/sharedStrings.xml").async("string"), /wiki\.example\.invalid/);
});
