import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { createImportBatch, queryUrl, validateSources } from "../src/confluence.js";
import { documentOptions, SEVERITY_CODES, SLA_CODES, SLA_METRICS } from "../src/document-sections.js";
import { generateExcel } from "../src/excel.js";
import { buildProposal, OPTIONS } from "../src/proposal.js";
import { plainText } from "../src/rich-text.js";
import { generateWord } from "../src/word.js";
import { BASE, paginate, referenceFixture, REFERENCE_SOURCES } from "./fixtures.mjs";

const sources = validateSources(REFERENCE_SOURCES);
const read = (data = referenceFixture()) => createImportBatch().add([data], sources).data;
const packages = OPTIONS.map(({ code }) => code);
const sectionNames = ["Матрица SLA", "Уровни критичности", "Допущения и ограничения", "Глоссарий"];
const included = { sla: true, severity: true, assumptions: true, glossary: true, raci: true };

function proposal(result, selected, document) {
  return buildProposal(result.services, {
    selected, document, sections: result.sections, defaults: result.standard.values,
    documentDefaults: result.standard.includedInDocument, confluenceBases: [BASE],
  });
}

test("recognizes the two SLA tables independently within a complete paginated REST import", () => {
  const data = referenceFixture();
  const batch = createImportBatch();
  assert.equal(batch.add([paginate(data, 0, 9)], sources).complete, false);
  const { sections, issues } = batch.add([paginate(data, 9, data.size)], sources).data;
  assert.deepEqual(issues, []);
  assert.deepEqual(sections.sla.data.map(({ code, support }) => [code, support]), SLA_CODES.flatMap((code) => packages.map((support) => [code, support])));
  assert.deepEqual(sections.severity.data.map(({ code }) => code), SEVERITY_CODES);
  assert.deepEqual(sections.sla.data[0].values, [
    "Рабочие дни, 09:00–18:00", "45 минут", "Не применимо", "16 часов", "5 рабочих дней", "Не регламентируется",
  ]);
  assert.equal(sections.severity.data[0].description[1].kind, "list");
  assert.equal(plainText(sections.severity.data[1].short), "");
  assert.deepEqual(sections.assumptions.data.map(({ category }) => category), ["Допущения", "Ограничения"]);
  assert.equal(sections.glossary.data[1].english, "");
  assert.doesNotMatch(JSON.stringify(sections.glossary), /javascript:|BAD_SCRIPT/);
  const url = new URL(queryUrl(sources));
  const cql = url.searchParams.get("cql");
  for (const key of ["sla", "assumptions", "glossary"]) assert.ok(cql.includes(sources.labels[key]));
  assert.ok(!cql.includes(sources.labels.raci));
});

test("rejects invalid additional tables without disabling independent valid sections", () => {
  const badSla = [
    [() => null, /заголовки/],
    [(rows) => [...rows, rows[0]], /Повтор сочетания/],
    [(rows) => rows.slice(1), /Отсутствует сочетание/],
    [(rows) => [["0", ...rows[0].slice(1)], ...rows.slice(1)], /Код критичности/],
    [(rows) => [["11", ...rows[0].slice(1)], ...rows.slice(1)], /Код критичности/],
    [(rows) => [[rows[0][0], "Invalid", ...rows[0].slice(2)], ...rows.slice(1)], /Неизвестный уровень/],
    [(rows) => [[...rows[0].slice(0, -1), ""], ...rows.slice(1)], /Время ответа/],
  ];
  for (const [alterSla, error] of badSla) {
    const { sections, issues } = read(referenceFixture({ alterSla }));
    assert.match(sections.sla.error, error);
    assert.equal(sections.severity.data.length, 11);
    assert.ok(issues.some(({ message }) => message.includes("SLA и уровни критичности") && error.test(message)));
  }
  for (const [alterSeverity, error] of [
    [() => null, /заголовки/],
    [(rows) => [...rows, rows[0]], /Повтор кода/],
    [(rows) => rows.slice(1), /отсутствуют коды/],
    [(rows) => [[...rows[0].slice(0, -1), "<script>ignore</script>"], ...rows.slice(1)], /полное описание/],
  ]) {
    const result = read(referenceFixture({ alterSeverity }));
    assert.match(result.sections.severity.error, error);
    assert.equal(result.sections.sla.data.length, 12);
    assert.equal(proposal(result, "Extended", { included }).sections.sla.groups[0].label, "10");
  }
  const broken = referenceFixture();
  broken.results.at(-1).body.storage.value = broken.results.at(-1).body.storage.value.replace("Определение RU", "Ошибка");
  broken.results.at(-2).body.storage.value = broken.results.at(-2).body.storage.value.replace("Ограничения", "Иное");
  const result = read(broken);
  assert.match(result.sections.assumptions.error, /подраздел/);
  assert.match(result.sections.glossary.error, /заголовки/);
  assert.deepEqual(Object.keys(proposal(result, "Extended", { included }).sections), ["intro", "sla", "severity"]);
});

test("builds both SLA views and automatically selects the introduction for each package", () => {
  const result = read();
  assert.equal(documentOptions().slaMode, "selected");
  assert.deepEqual(Object.keys(proposal(result, "Extended").sections), ["intro"]);
  assert.deepEqual(proposal(result, "Extended", { included: { intro: false } }).sections, {});
  for (const [index, selected] of packages.entries()) {
    const single = proposal(result, selected, { included }).sections;
    const all = proposal(result, selected, { included, slaMode: "all" }).sections;
    assert.equal(single.sla.headers.at(-1), selected);
    assert.equal(all.sla.headers[2 + index], selected + " ✓");
    assert.equal(all.sla.selectedColumn, 2 + index);
    assert.match(plainText(single.intro), new RegExp("Пример " + selected));
    assert.equal(single.sla.groups.length, 4);
    assert.deepEqual(single.sla.groups[0].rows.map(([label]) => label), SLA_METRICS);
    for (const [i, group] of single.sla.groups.entries()) {
      assert.deepEqual(group.rows.map((row) => row[1]), all.sla.groups[i].rows.map((row) => row[1 + index]));
    }
  }
});

test("exports optional Word sections and Excel sheets in order with selected SLA styling and print layout", async () => {
  const result = read();
  for (const slaMode of ["selected", "all"]) {
    const data = proposal(result, "Extended", { included, slaMode });
    const [excel, word] = await Promise.all([generateExcel(data), generateWord(data)]);
    const [xlsx, docx] = await Promise.all([JSZip.loadAsync(excel), JSZip.loadAsync(await word.arrayBuffer())]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excel);
    assert.deepEqual(workbook.worksheets.map(({ name }) => name), ["Описание услуг", "Предложение", ...sectionNames]);
    const sheet = workbook.getWorksheet("Матрица SLA");
    assert.equal(sheet.rowCount, 26);
    assert.equal(sheet.columnCount, slaMode === "all" ? 5 : 3);
    assert.match(await xlsx.file("xl/workbook.xml").async("string"), /&apos;Матрица SLA&apos;!\$A\$1:\$[CE]\$26/);
    assert.match(await xlsx.file("xl/worksheets/sheet3.xml").async("string"), /<brk id="14"/);
    assert.equal(sheet.getCell("A21").value, "80 — Вопрос");
    assert.equal(sheet.getCell(slaMode === "all" ? "D4" : "C4").value, "20 минут");
    if (slaMode === "all") {
      assert.equal(sheet.getCell("D2").value, "Extended ✓");
      assert.equal(sheet.getCell("D26").fill.fgColor.argb, "FFE5F3EE");
      assert.equal(sheet.getCell("C5").value, "Не применимо");
      assert.equal(sheet.getCell("C8").value, "Не регламентируется");
    }
    assert.equal(workbook.getWorksheet("Уровни критичности").getCell("A13").value, "90");
    assert.match(workbook.getWorksheet("Уровни критичности").getCell("D3").text, /• Пользователи/);
    assert.equal(workbook.getWorksheet("Глоссарий").getCell("B4").text, "");
    assert.doesNotMatch(await xlsx.file("xl/sharedStrings.xml").async("string"), /wiki\.example\.invalid|javascript:|BAD_SCRIPT/);
    const xml = await docx.file("word/document.xml").async("string");
    const relations = await docx.file("word/_rels/document.xml.rels").async("string");
    let previous = xml.indexOf("Описания услуг");
    for (const name of sectionNames) {
      const next = xml.indexOf(name);
      assert.ok(next > previous);
      previous = next;
    }
    assert.doesNotMatch(xml + relations, /Матрица RACI|wiki\.example\.invalid|javascript:|BAD_SCRIPT/);
    const sla = xml.slice(xml.indexOf("Матрица SLA"), xml.indexOf("Уровни критичности"));
    assert.match(sla, /<w:tblHeader\/>/);
    assert.match(sla, /80 — Вопрос/);
    assert.doesNotMatch(sla, /11 —|90 —|<w:tblGridChange/);
    if (slaMode === "all") assert.match(sla, /Extended ✓.*?w:fill="E5F3EE"/);
    else assert.doesNotMatch(sla, /Standard|Managed Service/);
  }
});

test("preserves a long full definition across Excel continuation rows and Word paragraphs", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `Учебный абзац ${i + 1} с пояснением уровня критичности.`);
  const result = read(referenceFixture({
    alterSeverity: ([first, ...rows]) => [[...first.slice(0, 3), lines.map((line) => `<p>${line}</p>`).join("")], ...rows],
  }));
  const model = proposal(result, "Extended", { included: { severity: true } });
  const [bytes, docx] = await Promise.all([generateExcel(model), generateWord(model)]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet("Уровни критичности");
  let text = sheet.getCell("D3").text;
  let row = 4;
  while (row <= sheet.rowCount && !sheet.getCell(row, 1).value) text += sheet.getCell(row++, 4).text;
  assert.ok(row > 4);
  assert.equal(text, lines.join("\n"));
  const zip = await JSZip.loadAsync(await docx.arrayBuffer());
  const document = await zip.file("word/document.xml").async("string");
  for (const line of lines) assert.ok(document.includes(line));
});
