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
import { BASE, paginate, referenceFixture, REFERENCE_SOURCES, SUPPORT_NAMES } from "./fixtures.mjs";

const sources = validateSources(REFERENCE_SOURCES);
const read = (data = referenceFixture()) => createImportBatch().add([data], sources).data;
const autoRead = (data) => createImportBatch().add([data], validateSources()).data;
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

test("recognizes every source structurally with no settings, including separately exported SLA tables", () => {
  const data = referenceFixture();
  data.results = data.results.map(({ metadata, ...page }) => page);
  data.results[0] = { content: data.results[0] };
  assert.deepEqual(autoRead(data), read(referenceFixture()));

  const combined = data.results.find(({ id }) => id === "62");
  const split = combined.body.storage.value.indexOf("</table>") + "</table>".length;
  data.results.push({
    id: "65", title: "Отдельный учебный справочник", body: { storage: { value: combined.body.storage.value.slice(split) } },
  });
  combined.body.storage.value = combined.body.storage.value.slice(0, split);
  data.size += 1;
  data.totalSize += 1;
  assert.deepEqual(autoRead(data).sections, read(referenceFixture()).sections);
});

test("reports conflicting structures and duplicate pages without guessing; a matching label resolves ambiguity", () => {
  const data = referenceFixture();
  const glossary = data.results.at(-1);
  const duplicate = { ...structuredClone(glossary), id: "65", title: "Другой учебный глоссарий", metadata: { labels: { results: [] } } };
  data.results.push(duplicate);
  data.size += 1;
  data.totalSize += 1;

  const ambiguous = autoRead(data);
  assert.match(ambiguous.sections.glossary.error, /неоднозначен.*64.*65/);
  assert.equal(ambiguous.sections.glossary.data, undefined);
  assert.equal(ambiguous.sections.sla.data.length, 12);
  assert.deepEqual(read(data).sections.glossary, read(referenceFixture()).sections.glossary);

  delete duplicate.metadata;
  assert.match(read(data).sections.glossary.error, /неоднозначен/);
  data.results.pop();
  data.size -= 1;
  data.totalSize -= 1;
  glossary.body.storage.value += data.results.at(-2).body.storage.value;
  const mixed = autoRead(data);
  assert.ok(mixed.issues.some(({ level, page_id, message }) => level === "error" && page_id === "64" &&
    /неоднозначен.*Допущения и ограничения.*Глоссарий/.test(message)));
  assert.equal(mixed.sections.glossary.data, undefined);
  assert.deepEqual(read(data).sections.glossary, read(referenceFixture()).sections.glossary);

  const stale = referenceFixture();
  stale.results.at(-1).metadata.labels.results[0].name = sources.labels.assumptions;
  const mismatched = createImportBatch().add([stale], validateSources({ ...sources, base: "https://older.example.invalid" })).data;
  assert.equal(mismatched.base, BASE);
  assert.ok(mismatched.issues.some(({ level, page_id, message }) => level === "warning" && page_id === "64" &&
    /метки не соответствуют содержимому/.test(message)));
  assert.deepEqual(mismatched.sections.glossary, read(referenceFixture()).sections.glossary);
});

test("reports malformed or unrecognized pages and retains independent valid sources", () => {
  const data = referenceFixture({ alterSla: (rows) => rows.slice(1) });
  const glossary = data.results.at(-1);
  delete glossary.body;
  data.results.at(-2).body.storage.value = "<p>Учебная страница без таблицы.</p>";
  const result = autoRead(data);
  assert.equal(result.services.length, 6);
  assert.equal(result.usableStandard, true);
  assert.equal(result.sections.severity.data.length, 11);
  assert.match(result.sections.sla.error, /Отсутствует сочетание/);
  assert.ok(result.issues.some(({ page_id, message }) => page_id === "64" && /body.storage.value/.test(message)));
  assert.ok(result.issues.some(({ page_id, message }) => page_id === "63" && /не распознан/.test(message)));
  assert.equal(result.sections.glossary.data, undefined);
  assert.equal(result.sections.assumptions.data, undefined);
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
  assert.deepEqual(Object.fromEntries(OPTIONS.map(({ code, name }) => [code, name])), SUPPORT_NAMES);
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
    assert.equal(only.caption, selected + "\n" + SUPPORT_NAMES[selected]);
    assert.deepEqual(only.headers, ["Показатель", ...severityHeaders]);
    assert.equal(comparison.headers[2 + index], selected + " ✓\n" + SUPPORT_NAMES[selected]);
    assert.equal(comparison.selectedColumn, 2 + index);
    assert.deepEqual(split.map(({ caption }) => caption.replace(" ✓ — Предложение", "")),
      packages.map((code) => code + "\n" + SUPPORT_NAMES[code]));
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
    const proposalSheet = workbook.getWorksheet("Предложение");
    const proposalHeader = proposalSheet.getColumn(1).values.indexOf("ID услуги");
    assert.deepEqual(proposalSheet.getRow(proposalHeader).values.slice(3), packages.map((code) => code + "\n" + SUPPORT_NAMES[code]));
    const sheet = workbook.getWorksheet("Матрица SLA");
    const headerRow = 3;
    assert.equal(sheet.rowCount, slaMode === "all" ? 23 : 8);
    assert.equal(sheet.columnCount, 5);
    assert.ok((await xlsx.file("xl/workbook.xml").async("string")).includes(`&apos;Матрица SLA&apos;!$A$1:$E$${sheet.rowCount}`));
    if (slaMode === "all") {
      assert.deepEqual(sheet.getRow(headerRow).values.slice(3), proposalSheet.getRow(proposalHeader).values.slice(3));
      assert.equal(sheet.getCell("A19").value, "80 — Вопрос");
      assert.equal(sheet.getCell("D2").value, "Предложение");
      assert.equal(sheet.getCell("D4").value, "20 минут");
      assert.equal(sheet.getCell("D23").fill.fgColor.argb, "FFE5F3EE");
      assert.equal(sheet.getCell("C5").value, "Не применимо");
      assert.equal(sheet.getCell("C8").value, "Не регламентируется");
      const breaks = [...(await xlsx.file("xl/worksheets/sheet3.xml").async("string")).matchAll(/<brk id="(\d+)"/g)];
      assert.ok(breaks.length && breaks.every(([, row]) => (Number(row) - headerRow) % 5 === 0));
    } else {
      assert.deepEqual(sheet.getRow(headerRow).values.slice(1), data.sections.sla[0].headers);
      assert.equal(sheet.getCell("A2").value, "Extended\n" + SUPPORT_NAMES.Extended);
      assert.equal(sheet.getCell("B4").value, "20 минут");
    }
    for (const name of ["Описание услуг", "Матрица SLA", "Уровни критичности", "Глоссарий"]) {
      assert.equal(workbook.getWorksheet(name).views[0].xSplit ?? 0, 0);
      assert.ok(workbook.getWorksheet(name).views[0].ySplit > 0);
    }
    assert.equal(workbook.getWorksheet("Описание услуг").views[0].ySplit, 2);
    assert.deepEqual(workbook.getWorksheet("Описание услуг").columns.map(({ width }) => width), [14, 32, 76, 60]);
    assert.equal(workbook.getWorksheet("Допущения и ограничения").views[0].xSplit, 2);
    assert.equal(workbook.getWorksheet("Предложение").views[0].xSplit ?? 0, 0);
    assert.equal(workbook.getWorksheet("Уровни критичности").getCell("A13").value, "90");
    assert.match(workbook.getWorksheet("Уровни критичности").getCell("D3").text, /• Пользователи/);
    assert.equal(workbook.getWorksheet("Глоссарий").getCell("B4").text, "");
    assert.doesNotMatch(await xlsx.file("xl/sharedStrings.xml").async("string"), /wiki\.example\.invalid|javascript:|BAD_SCRIPT|Часы работы/);
    const xml = await docx.file("word/document.xml").async("string");
    const relations = await docx.file("word/_rels/document.xml.rels").async("string");
    let previous = xml.indexOf("Описания услуг");
    for (const name of sectionNames) {
      const next = xml.indexOf(name);
      assert.ok(next > previous);
      previous = next;
    }
    assert.doesNotMatch(xml + relations, /Матрица RACI|wiki\.example\.invalid|javascript:|BAD_SCRIPT/);
    const slaStart = xml.indexOf("Матрица SLA");
    const services = xml.slice(0, slaStart);
    for (const name of Object.values(SUPPORT_NAMES)) assert.ok(services.includes(name));
    const sla = xml.slice(slaStart, xml.indexOf("Уровни критичности"));
    assert.match(sla, /<w:tblHeader\/>/);
    assert.match(sla, /80 — Вопрос/);
    assert.doesNotMatch(sla, /11 —|90 —|Часы работы|<w:tblGridChange/);
    if (slaMode === "all") {
      assert.match(sla, /Предложение.*?Extended.*?w:fill="E5F3EE"/);
      assert.doesNotMatch(sla, /✓/);
    } else {
      assert.doesNotMatch(sla, /Standard|Managed Service/);
      assert.ok(sla.indexOf("Extended") < sla.indexOf("<w:tbl>"));
      assert.match(sla, /Extended<\/w:t>.*?<w:br\/>.*?Расширенная поддержка 24×7/);
    }
    const slaRows = [...sla.matchAll(/<w:tr>.*?<\/w:tr>/gs)].map(([row]) => row).slice(slaMode === "all" ? 2 : 1);
    const expectedRows = data.sections.sla[0].groups.flat();
    assert.equal(slaRows.length, expectedRows.length);
    assert.doesNotMatch(slaRows.join(""), /24×7/);
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

test("centers every table header in Word and Excel across all packages and SLA layouts", async () => {
  const result = read();
  const firstHeaders = {
    "Описание услуг": "ID услуги", "Предложение": "ID услуги", "Уровни критичности": "Код",
    "Допущения и ограничения": "Раздел", "Глоссарий": "Термин RU",
  };
  for (const selected of packages) {
    for (const [slaMode, slaFormat] of [["selected", "comparison"], ["all", "separate"], ["all", "comparison"]]) {
      const model = proposal(result, selected, { included, slaMode, slaFormat });
      const [excel, word] = await Promise.all([generateExcel(model), generateWord(model)]);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(excel);
      for (const sheet of workbook.worksheets) {
        const sla = sheet.name === "Матрица SLA";
        const firstHeader = sla ? model.sections.sla[0].headers[0] : firstHeaders[sheet.name];
        const headerWidth = sla ? model.sections.sla[0].headers.length : sheet.columnCount;
        let headers = 0;
        sheet.eachRow((row) => {
          if (row.getCell(1).value === firstHeader) {
            headers += 1;
            for (let col = 1; col <= headerWidth; col += 1) {
              assert.deepEqual(row.getCell(col).alignment, { horizontal: "center", vertical: "middle", wrapText: true });
            }
          }
          row.eachCell((cell) => {
            if (cell.value === "Предложение") {
              assert.deepEqual(cell.alignment, { horizontal: "center", vertical: "middle", wrapText: true });
            }
          });
        });
        assert.equal(headers, sla ? model.sections.sla.length : 1, sheet.name);
      }
      const zip = await JSZip.loadAsync(await word.arrayBuffer());
      const xml = await zip.file("word/document.xml").async("string");
      const headers = [...xml.matchAll(/<w:tr>.*?<\/w:tr>/gs)].map(([row]) => row)
        .filter((row) => row.includes("<w:tblHeader/>"));
      assert.equal(headers.length, 4 + model.sections.sla.length + Number(slaMode === "all" && slaFormat === "comparison"));
      for (const row of headers) {
        for (const [cell] of row.matchAll(/<w:tc>.*?<\/w:tc>/gs)) {
          assert.match(cell, /<w:vAlign w:val="center"\/>/);
          assert.match(cell, /<w:jc w:val="center"\/>/);
          assert.doesNotMatch(cell, /<w:noWrap\b/);
        }
      }
    }
  }
});

test("Word comparative SLA uses the composition table styling and marker for each selected package", async () => {
  const result = read();
  const tableRows = (table) => [...table.matchAll(/<w:tr>.*?<\/w:tr>/gs)].map(([row]) =>
    [...row.matchAll(/<w:tc>.*?<\/w:tc>/gs)].map(([cell]) => cell));
  const style = (cell) => cell.match(/<w:(?:shd|jc)\b[^>]*\/>|<w:rPr>.*?<\/w:rPr>/gs);
  for (const [index, selected] of packages.entries()) {
    const docx = await generateWord(proposal(result, selected, { included, slaMode: "all" }));
    const zip = await JSZip.loadAsync(await docx.arrayBuffer());
    const xml = await zip.file("word/document.xml").async("string");
    const [composition, sla] = [...xml.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)].map(([table]) => table);
    const [markers, headings, ...rows] = tableRows(sla);
    const [proposalMarkers, proposalHeadings, firstProposalRow] = tableRows(composition);
    assert.equal([...sla.matchAll(/<w:tblHeader\/>/g)].length, 2);
    assert.doesNotMatch(sla, /✓/);
    for (const [offset, code] of packages.entries()) {
      const column = offset + 2;
      assert.equal(markers[column].includes("Предложение"), offset === index);
      assert.deepEqual(style(markers[column]), style(proposalMarkers[column]));
      assert.ok(headings[column].includes(code) && headings[column].includes(SUPPORT_NAMES[code]));
      assert.deepEqual(style(headings[column]), style(proposalHeadings[column]));
      for (const row of rows) {
        assert.match(row[column], /<w:jc w:val="center"\/>/);
        assert.equal(row[column].includes('w:fill="E5F3EE"'), offset === index);
        if (offset === index) assert.deepEqual(style(row[column]), style(firstProposalRow[column]));
      }
    }
  }
});

test("uses the proposal marker, header and column colors for each selected package in the comparative SLA sheet", async () => {
  const result = read();
  for (const [index, selected] of packages.entries()) {
    const model = proposal(result, selected, { included, slaMode: "all" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateExcel(model));
    const proposalSheet = workbook.getWorksheet("Предложение");
    const proposalHeader = proposalSheet.getColumn(1).values.indexOf("ID услуги");
    const sla = workbook.getWorksheet("Матрица SLA");
    for (const [offset, code] of packages.entries()) {
      const column = offset + 3;
      const marker = sla.getCell(2, column);
      const proposalMarker = proposalSheet.getCell(proposalHeader - 1, column);
      assert.equal(marker.value, offset === index ? "Предложение" : null);
      assert.deepEqual(marker.style, proposalMarker.style);
      assert.equal(sla.getCell(3, column).value, code + "\n" + SUPPORT_NAMES[code]);
      assert.deepEqual(sla.getCell(3, column).style, proposalSheet.getCell(proposalHeader, column).style);
      for (let row = 4; row <= sla.rowCount; row += 1) {
        assert.equal(sla.getCell(row, column).fill.fgColor.argb === "FFE5F3EE", offset === index);
      }
    }
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
  assert.doesNotMatch(sla, /Часы работы/);
  for (const [index, code] of packages.entries()) {
    const caption = captions[index];
    assert.deepEqual(sheet.getRow(caption + 1).values.slice(1), ["Показатель", ...severityHeaders]);
    const [firstLine, secondLine] = model.sections.sla[index].caption.split("\n");
    assert.equal(sheet.getCell(caption, 1).text, firstLine + "\n" + secondLine);
    assert.match(sla, new RegExp(`>${firstLine}</w:t>.*?<w:br/>.*?>${secondLine}</w:t>`));
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
