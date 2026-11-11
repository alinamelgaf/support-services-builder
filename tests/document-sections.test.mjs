import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { createImportBatch, queryUrl, validateSources } from "../src/confluence.js";
import { documentOptions, restoreDocumentSources, SEVERITY_CODES, SLA_CODES, SLA_METRICS } from "../src/document-sections.js";
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
const severityHeaders = ["10 — Критический", "20 — Значительный", "30 — Незначительный", "80 — Вопрос"];

function proposal(result, selected, document) {
  return buildProposal(result.services, {
    selected, document, sections: result.sections, defaults: result.standard.values,
    documentDefaults: result.standard.includedInDocument, confluenceBases: [BASE],
  });
}

test("recognizes the two SLA tables without working hours in a complete paginated REST import", () => {
  const data = referenceFixture();
  const batch = createImportBatch();
  assert.equal(batch.add([paginate(data, 0, 9)], sources).complete, false);
  const { sections, issues } = batch.add([paginate(data, 9, data.size)], sources).data;
  assert.deepEqual(issues, []);
  assert.deepEqual(sections.sla.data.map(({ code, support }) => [code, support]), SLA_CODES.flatMap((code) => packages.map((support) => [code, support])));
  assert.deepEqual(sections.severity.data.map(({ code }) => code), SEVERITY_CODES);
  assert.ok(sections.sla.data.every(({ values }) => values.length === 5));
  assert.deepEqual(sections.sla.data[0].values, [
    "45 минут", "Не применимо", "16 часов", "5 рабочих дней", "Не регламентируется",
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

test("restores SLA from old drafts without shifting or retaining obsolete working hours", () => {
  const { sections } = read();
  const old = { ...sections, sla: {
    data: sections.sla.data.map(({ code, support, values }) => ({ code, support, values: ["Старые часы", ...values] })),
  } };
  assert.deepEqual(restoreDocumentSources(old), sections);
  assert.deepEqual(restoreDocumentSources(sections), sections);
  assert.deepEqual(restoreDocumentSources({ sla: { error: "Нет данных" } }), { sla: { error: "Нет данных" } });
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
    assert.deepEqual(proposal(result, "Extended", { included }).sections.sla[0].headers, ["Показатель", ...SLA_CODES]);
  }
  const broken = referenceFixture();
  broken.results.at(-1).body.storage.value = broken.results.at(-1).body.storage.value.replace("Определение RU", "Ошибка");
  broken.results.at(-2).body.storage.value = broken.results.at(-2).body.storage.value.replace("Ограничения", "Иное");
  const result = read(broken);
  assert.match(result.sections.assumptions.error, /подраздел/);
  assert.match(result.sections.glossary.error, /заголовки/);
  assert.deepEqual(Object.keys(proposal(result, "Extended", { included }).sections), ["intro", "sla", "severity"]);
});

test("builds all SLA views and automatically selects the introduction for each package", () => {
  const result = read();
  assert.equal(documentOptions().slaMode, "selected");
  assert.equal(documentOptions({ slaMode: "all" }).slaFormat, "comparison");
  assert.deepEqual(Object.keys(proposal(result, "Extended").sections), ["intro"]);
  assert.deepEqual(proposal(result, "Extended", { included: { intro: false } }).sections, {});
  for (const [index, selected] of packages.entries()) {
    const single = proposal(result, selected, { included, slaFormat: "separate" }).sections;
    const all = proposal(result, selected, { included, slaMode: "all" }).sections;
    const split = proposal(result, selected, { included, slaMode: "all", slaFormat: "separate" }).sections.sla;
    const [only] = single.sla;
    const [comparison] = all.sla;
    assert.equal(single.sla.length, 1);
    assert.equal(only.caption, selected);
    assert.deepEqual(only.headers, ["Показатель", ...severityHeaders]);
    assert.equal(comparison.headers[2 + index], selected + " ✓");
    assert.equal(comparison.selectedColumn, 2 + index);
    assert.deepEqual(split.map(({ caption }) => caption.replace(" ✓ — Предложение", "")), packages);
    assert.ok(split.every(({ headers }) => headers.join("|") === only.headers.join("|")));
    assert.equal(split.filter(({ highlighted }) => highlighted).length, 1);
    assert.equal(split[index].highlighted, true);
    assert.match(plainText(single.intro), new RegExp("Пример " + selected));
    assert.equal(only.groups.length, 1);
    assert.deepEqual(only.groups[0].map(([label]) => label), SLA_METRICS);
    assert.deepEqual(only.groups, split[index].groups);
    for (const [i, group] of comparison.groups.entries()) {
      assert.deepEqual(group.map((row) => row[2 + index]), only.groups[0].map((row) => row[1 + i]));
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
    const headerRow = slaMode === "all" ? 2 : 3;
    assert.equal(sheet.rowCount, slaMode === "all" ? 22 : 8);
    assert.equal(sheet.columnCount, 5);
    assert.ok((await xlsx.file("xl/workbook.xml").async("string")).includes(`&apos;Матрица SLA&apos;!$A$1:$E$${sheet.rowCount}`));
    assert.deepEqual(sheet.getRow(headerRow).values.slice(1), data.sections.sla[0].headers);
    if (slaMode === "all") {
      assert.equal(sheet.getCell("A18").value, "80 — Вопрос");
      assert.equal(sheet.getCell("D2").value, "Extended ✓");
      assert.equal(sheet.getCell("D3").value, "20 минут");
      assert.equal(sheet.getCell("D22").fill.fgColor.argb, "FFE5F3EE");
      assert.equal(sheet.getCell("C4").value, "Не применимо");
      assert.equal(sheet.getCell("C7").value, "Не регламентируется");
      const breaks = [...(await xlsx.file("xl/worksheets/sheet3.xml").async("string")).matchAll(/<brk id="(\d+)"/g)];
      assert.ok(breaks.length && breaks.every(([, row]) => (Number(row) - 2) % 5 === 0));
    } else {
      assert.equal(sheet.getCell("A2").value, "Extended");
      assert.equal(sheet.getCell("B4").value, "20 минут");
    }
    for (const name of ["Матрица SLA", "Уровни критичности", "Глоссарий"]) {
      assert.equal(workbook.getWorksheet(name).views[0].xSplit ?? 0, 0);
      assert.ok(workbook.getWorksheet(name).views[0].ySplit > 0);
    }
    for (const name of ["Описание услуг", "Допущения и ограничения"]) assert.equal(workbook.getWorksheet(name).views[0].xSplit, 2);
    assert.equal(workbook.getWorksheet("Предложение").views[0].xSplit ?? 0, 0);
    assert.equal(workbook.getWorksheet("Уровни критичности").getCell("A13").value, "90");
    assert.match(workbook.getWorksheet("Уровни критичности").getCell("D3").text, /• Пользователи/);
    assert.equal(workbook.getWorksheet("Глоссарий").getCell("B4").text, "");
    assert.doesNotMatch(await xlsx.file("xl/sharedStrings.xml").async("string"), /wiki\.example\.invalid|javascript:|BAD_SCRIPT|Часы работы|24×7/);
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
    assert.doesNotMatch(sla, /11 —|90 —|Часы работы|24×7|<w:tblGridChange/);
    if (slaMode === "all") assert.match(sla, /Extended ✓.*?w:fill="E5F3EE"/);
    else {
      assert.doesNotMatch(sla, /Standard|Managed Service/);
      assert.ok(sla.indexOf("Extended") < sla.indexOf("<w:tbl>"));
    }
    const slaRows = [...sla.matchAll(/<w:tr>.*?<\/w:tr>/gs)].map(([row]) => row).slice(1);
    const expectedRows = data.sections.sla[0].groups.flat();
    assert.equal(slaRows.length, expectedRows.length);
    for (const [index, values] of expectedRows.entries()) {
      for (const [col, value] of values.entries()) {
        assert.equal(sheet.getCell(headerRow + index + 1, col + 1).text, value);
        assert.ok(slaRows[index].includes(value));
      }
    }
    const severity = xml.slice(xml.indexOf("Уровни критичности"), xml.indexOf("Допущения и ограничения"));
    assert.equal([...severity.matchAll(/<w:tbl>/g)].length, 1);
    assert.equal([...severity.matchAll(/<w:tr>/g)].length, 12);
    assert.match(severity, /<w:tblHeader\/>.*?Код.*?Наименование.*?Краткое описание.*?Полное описание/);
    assert.match(severity, /<w:numPr>.*?Пользователи не могут/);
    const level11 = [...severity.matchAll(/<w:tr>.*?<\/w:tr>/gs)][2][0];
    const cells = [...level11.matchAll(/<w:tc>.*?<\/w:tc>/gs)].map(([cell]) => cell);
    assert.equal(cells.length, 4);
    assert.match(cells[0], />11<\/w:t>/);
    assert.doesNotMatch(cells[2], /<w:t[ >]/);
    assert.match(cells[3], /Учебное определение 11/);
  }
});

test("exports three sequential SLA tables with every original value and highlights only the selected table", async () => {
  const result = read();
  const model = proposal(result, "Extended", { included, slaMode: "all", slaFormat: "separate" });
  const [bytes, docx] = await Promise.all([generateExcel(model), generateWord(model)]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet("Матрица SLA");
  const zip = await JSZip.loadAsync(await docx.arrayBuffer());
  const xml = await zip.file("word/document.xml").async("string");
  const sla = xml.slice(xml.indexOf("Матрица SLA"), xml.indexOf("Уровни критичности"));
  const tables = [...sla.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)].map(([table]) => table);
  assert.equal(tables.length, 3);
  const captions = [];
  sheet.eachRow((row) => {
    if (model.sections.sla.some(({ caption }) => caption === row.getCell(1).value)) captions.push(row.number);
  });
  assert.equal(captions.length, 3);
  assert.equal(sheet.columnCount, 5);
  assert.equal(sheet.views[0].xSplit ?? 0, 0);
  assert.doesNotMatch(sla, /Часы работы|24×7/);
  for (const [index, code] of packages.entries()) {
    const caption = captions[index];
    assert.deepEqual(sheet.getRow(caption + 1).values.slice(1), ["Показатель", ...severityHeaders]);
    assert.ok(sla.includes(model.sections.sla[index].caption));
    for (const header of severityHeaders) assert.ok(tables[index].includes(header));
    assert.equal(tables[index].includes('w:fill="E5F3EE"'), code === "Extended");
    assert.equal(sheet.getCell(caption + 2, 1).fill.fgColor.argb === "FFE5F3EE", code === "Extended");
    assert.equal(sheet.getCell(caption + 2, 3).fill.fgColor.argb === "FFE5F3EE", code === "Extended");
    const expected = result.sections.sla.data.filter(({ support }) => support === code).map(({ values }) => values);
    const rows = [...tables[index].matchAll(/<w:tr>.*?<\/w:tr>/gs)].map(([row]) => row).slice(1);
    assert.equal(rows.length, 5);
    if (index) assert.equal(caption - captions[index - 1], 8);
    for (const [i, values] of expected.entries()) {
      for (const [metric, value] of values.entries()) {
        assert.equal(sheet.getCell(caption + 2 + metric, i + 2).text, value);
        assert.ok(rows[metric].includes(value));
      }
    }
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
