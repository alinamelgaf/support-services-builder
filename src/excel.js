import ExcelJS from "exceljs";
import JSZip from "jszip";
import { COMPARISON_HEADERS, CONDITIONS_TITLE } from "./proposal.js";
import { SECTION_LABELS } from "./document-sections.js";
import { flattenRich } from "./rich-text.js";

const NAVY = "FF243B56";
const TEAL = "FF176054";
const PALE_TEAL = "FFE5F3EE";
const PALE_BLUE = "FFF3F6FA";
const WHITE = "FFFFFFFF";
const INK = "FF183246";
const GRAY = "FFDCE4ED";
const DESCRIPTION_SHEET = "Описание услуг";
const DESCRIPTION_WIDTHS = [14, 32, 76, 60];
const MATRIX_WIDTHS = [14, 32, 25, 25, 25];
const LINK_COLOR = "FF0563C1";
const FONT = { name: "Arial", size: 10, color: { argb: INK } };
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const runs = (text) => [{ text }];

function header(cell, value, background = NAVY) {
  cell.value = value;
  cell.font = { ...FONT, bold: true, color: { argb: WHITE } };
  cell.fill = fill(background);
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
}

function layout(workbook, name, title, widths, headers, headerRow, { comparison = false, freezeRows = true } = {}) {
  const lastColumn = String.fromCharCode(64 + widths.length);
  const xSplit = comparison ? 0 : 2;
  const ySplit = freezeRows ? headerRow : 0;
  const sheet = workbook.addWorksheet(name, {
    views: [xSplit || ySplit
      ? { state: "frozen", xSplit, ySplit, showGridLines: false }
      : { state: "normal", showGridLines: false }],
    properties: { tabColor: { argb: NAVY } },
    pageSetup: {
      orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 },
    },
  });
  sheet.pageSetup.printTitlesRow = `${comparison ? headerRow - 1 : headerRow}:${headerRow}`;
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.mergeCells(`A1:${lastColumn}1`);
  const titleCell = sheet.getCell("A1");
  titleCell.value = title;
  titleCell.font = { ...FONT, size: 16, bold: true, color: { argb: NAVY } };
  titleCell.alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(1).height = 36;
  headers.forEach((label, index) => header(sheet.getCell(headerRow, index + 1), label));
  sheet.getRow(headerRow).height = comparison ? 58 : 26;
  return sheet;
}

function chunks(source, width) {
  const lineWidth = Math.max(8, Math.floor(width * 0.8));
  const pieces = [];
  let segments = [];
  let column = 0;
  let lines = 1;
  // Разбиение не добавляет символов и не разрывает суррогатные пары.
  for (const run of source) {
    let text = "";
    for (const char of run.text) {
      if (char !== "\n" && column >= lineWidth) {
        lines += 1;
        column = 0;
      }
      if (lines > 19 || (lines === 19 && char === "\n")) {
        if (text) segments.push({ ...run, text });
        pieces.push({ segments, lines: 19 });
        segments = [];
        lines = 1;
        column = 0;
        text = "";
      }
      text += char;
      if (char === "\n") {
        lines += 1;
        column = 0;
      } else {
        column += char === "\t" ? 4 : 1;
      }
    }
    if (text) segments.push({ ...run, text });
  }
  pieces.push({ segments, lines });
  return pieces;
}

function cellValue(segments, bold) {
  if (!segments.some((run) => run.bold || run.italics || run.underline || run.strike || run.color || run.monospace)) {
    return segments.map(({ text }) => text).join("");
  }
  return { richText: segments.map((run) => ({
    text: run.text,
    font: {
      ...FONT, bold: bold || Boolean(run.bold), italic: Boolean(run.italics),
      underline: Boolean(run.underline), strike: Boolean(run.strike),
      color: run.color ? { argb: "FF" + run.color } : FONT.color,
      name: run.monospace ? "Consolas" : FONT.name,
    },
  })) };
}

function writeRows(sheet, rows, widths, start, { selected = -1, groupSize = 1 } = {}) {
  let rowNumber = start;
  const firstRows = [];
  rows.forEach((row, index) => {
    firstRows.push(rowNumber);
    const columns = row.map((value, column) => chunks(value, widths[column]));
    const size = Math.max(...columns.map((column) => column.length));
    for (let part = 0; part < size; part += 1) {
      let height = 23;
      columns.forEach((column, col) => {
        const piece = column[part];
        const cell = sheet.getCell(rowNumber, col + 1);
        cell.value = cellValue(piece?.segments ?? [], col === 0);
        cell.font = { ...FONT, bold: col === 0 };
        cell.alignment = { vertical: "middle", horizontal: selected >= 0 && col >= 2 ? "center" : "left", wrapText: true };
        cell.fill = fill(col === selected ? PALE_TEAL : Math.floor(index / groupSize) % 2 ? PALE_BLUE : WHITE);
        if (part === 0 && index % groupSize === 0) cell.border = { top: { style: "thin", color: { argb: GRAY } } };
        height = Math.max(height, 8 + 15 * (piece?.lines ?? 1));
      });
      sheet.getRow(rowNumber).height = height;
      rowNumber += 1;
    }
  });
  // ExcelJS adds the absolute column markers. Add the row markers here.
  sheet.pageSetup.printArea = `A$1:${String.fromCharCode(64 + widths.length)}$${rowNumber - 1}`;
  return firstRows;
}

function addReferenceSheets(workbook, sections) {
  function referenceSheet(key, headers, widths, rows, style) {
    const title = SECTION_LABELS[key];
    const sheet = layout(workbook, title, title, widths, headers, 2);
    sheet.getRow(2).height = 32;
    if (style?.selected >= 0) header(sheet.getCell(2, style.selected + 1), headers[style.selected], TEAL);
    const firstRows = writeRows(sheet, rows, widths, 3, style);
    return { sheet, firstRows };
  }
  if (sections.sla) {
    const { headers, groups, selectedColumn } = sections.sla;
    const comparative = headers.length > 3;
    const groupSize = groups[0].rows.length;
    const rows = groups.flatMap(({ label, rows }) => rows.map((cells, index) => [
      runs(index ? "" : label), ...cells.map(runs),
    ]));
    const { sheet, firstRows } = referenceSheet("sla", headers, comparative ? [24, 38, 23, 23, 23] : [27, 48, 39], rows, {
      selected: comparative ? selectedColumn : -1,
      groupSize,
    });
    // Keep each severity group together when it fits an A4 landscape page.
    sheet.pageSetup.fitToPage = false;
    sheet.headerFooter.differentFirst = true;
    sheet.headerFooter.oddHeader = "&LМатрица SLA&R" + headers.slice(2).join("  |  ");
    const groupStarts = groups.map((_, index) => firstRows[index * groupSize]);
    let height = sheet.getRow(1).height + sheet.getRow(2).height;
    groupStarts.forEach((start, index) => {
      const end = groupStarts[index + 1] ?? sheet.rowCount + 1;
      let groupHeight = 0;
      for (let row = start; row < end; row += 1) groupHeight += sheet.getRow(row).height;
      if (index && height + groupHeight > 520) {
        sheet.getRow(start - 1).addPageBreak(1, 16384);
        height = sheet.getRow(2).height;
      }
      height += groupHeight;
    });
  }
  if (sections.severity) {
    referenceSheet("severity", ["Код", "Наименование", "Краткое описание", "Полное описание"], [10, 28, 34, 84],
      sections.severity.map(({ code, name, short, description }) => [
        runs(code), runs(name), flattenRich(short, true), flattenRich(description, true),
      ]));
  }
  if (sections.assumptions) {
    referenceSheet("assumptions", ["Раздел", "Формулировка"], [23, 104],
      sections.assumptions.map(({ category, wording }) => [runs(category), flattenRich(wording, true)]));
  }
  if (sections.glossary) {
    referenceSheet("glossary", ["Термин RU", "Term ENG", "Определение RU"], [25, 24, 84],
      sections.glossary.map(({ term, english, definition }) => [runs(term), runs(english), flattenRich(definition, true)]));
  }
}

async function addInternalLinks(workbook, sheet, locations) {
  if (!locations.length) return workbook.xlsx.writeBuffer();
  // ExcelJS 4.4.0 записывает отношения TargetMode=External и для внутренних
  // ссылок. Ссылкам внутри книги достаточно атрибута location в XML листа.
  const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const path = `xl/worksheets/sheet${sheet.id}.xml`;
  const xml = await archive.file(path).async("string");
  const beforePrint = /<(?:printOptions|pageMargins)\b/;
  if (!beforePrint.test(xml)) throw new Error("Не удалось добавить внутренние ссылки в Excel.");
  const links = locations.map(([from, to]) =>
    `<hyperlink ref="${from}" location="'${DESCRIPTION_SHEET}'!A${to}"/>`,
  ).join("");
  archive.file(path, xml.replace(beforePrint, (tag) => `<hyperlinks>${links}</hyperlinks>${tag}`));
  return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export async function generateExcel(proposal) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Support Services Builder";
  const descriptions = layout(workbook, DESCRIPTION_SHEET, DESCRIPTION_SHEET, DESCRIPTION_WIDTHS, [
    "ID услуги", "Наименование услуги", "Описание услуги", CONDITIONS_TITLE,
  ], 2);
  const descriptionRows = writeRows(descriptions, proposal.rows.map(({ id, name, description, conditions }) => [
    runs(id), runs(name), flattenRich(description, true), flattenRich(conditions, true),
  ]), DESCRIPTION_WIDTHS, 3);

  const { sections } = proposal;
  const introRows = sections.intro
    ? chunks(flattenRich(sections.intro, true), MATRIX_WIDTHS.reduce((sum, width) => sum + width, 0)) : [];
  const headerRow = 4 + introRows.length;
  const comparison = layout(workbook, "Предложение", proposal.title, MATRIX_WIDTHS, COMPARISON_HEADERS, headerRow, {
    comparison: true, freezeRows: !introRows.length,
  });
  comparison.mergeCells("A2:E2");
  const client = comparison.getCell("A2");
  client.value = proposal.clientLine;
  client.font = { ...FONT, size: 11, color: { argb: NAVY } };
  client.alignment = { vertical: "middle", wrapText: true };
  comparison.getRow(2).height = 30;
  comparison.getRow(2).hidden = !proposal.clientLine;
  introRows.forEach(({ segments, lines }, index) => {
    const row = 3 + index;
    comparison.mergeCells(`A${row}:E${row}`);
    const cell = comparison.getCell(row, 1);
    cell.value = cellValue(segments, false);
    cell.font = { ...FONT, size: 11 };
    cell.alignment = { vertical: "middle", wrapText: true };
    comparison.getRow(row).height = Math.max(23, 8 + 15 * lines);
  });
  comparison.getRow(headerRow - 1).height = 23;
  const selected = 2 + proposal.selectedIndex;
  header(comparison.getCell(headerRow - 1, selected + 1), "Предложение", TEAL);
  header(comparison.getCell(headerRow, selected + 1), COMPARISON_HEADERS[selected], TEAL);
  const matrix = proposal.rows.map(({ id, name, values }) => [runs(id), runs(name), ...values.map(runs)]);
  const matrixRows = writeRows(comparison, matrix, MATRIX_WIDTHS, headerRow + 1, { selected });
  const locations = matrixRows.flatMap((row, index) => ["A", "B"].map((column) => {
    const address = column + row;
    const cell = comparison.getCell(address);
    cell.font = { ...cell.font, underline: true, color: { argb: LINK_COLOR } };
    return [address, descriptionRows[index]];
  }));
  addReferenceSheets(workbook, sections);
  return addInternalLinks(workbook, comparison, locations);
}
