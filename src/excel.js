import ExcelJS from "exceljs";
import JSZip from "jszip";
import { COMPARISON_HEADERS, CONDITIONS_TITLE } from "./proposal.js";
import { SECTION_LABELS, SEVERITY_HEADERS } from "./document-sections.js";
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

function markProposalColumn(sheet, headerRow, selected, heading) {
  sheet.getRow(headerRow - 1).height = 23;
  header(sheet.getCell(headerRow - 1, selected + 1), "Предложение", TEAL);
  header(sheet.getCell(headerRow, selected + 1), heading, TEAL);
}

function layout(workbook, name, title, widths, headers, headerRow, {
  comparison = false, freezeRows = true, freezeColumns = !comparison,
} = {}) {
  const lastColumn = String.fromCharCode(64 + widths.length);
  const xSplit = freezeColumns ? 2 : 0;
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

function writeRows(sheet, rows, widths, start, { selected = -1, groupSize = 1, highlighted = false } = {}) {
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
        cell.fill = fill(highlighted || col === selected ? PALE_TEAL : Math.floor(index / groupSize) % 2 ? PALE_BLUE : WHITE);
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

function rowsHeight(sheet, start, end) {
  let height = 0;
  for (let row = start; row < end; row += 1) {
    height += sheet.getRow(row).height ?? sheet.properties.defaultRowHeight;
  }
  return height;
}

// A4 landscape with the margins in layout().
const SLA_PRINT_HEIGHT = 520;

function paginateSla(sheet, groupStarts, height, repeatedHeight) {
  groupStarts.forEach((start, index) => {
    const end = groupStarts[index + 1] ?? sheet.rowCount + 1;
    const groupHeight = rowsHeight(sheet, start, end);
    if (index && height + groupHeight > SLA_PRINT_HEIGHT) {
      sheet.getRow(start - 1).addPageBreak(1, 16384);
      height = repeatedHeight;
    }
    height += groupHeight;
  });
}

function addSlaSheet(workbook, tables) {
  const title = SECTION_LABELS.sla;
  const separate = tables.length > 1;
  const packageTables = Boolean(tables[0].caption);
  const widths = packageTables ? [39, 24, 24, 26, 23] : [24, 38, 23, 23, 23];
  const headings = packageTables ? tables[0].headers : [...tables[0].headers.slice(0, 2), ...COMPARISON_HEADERS.slice(2)];
  const sheet = layout(workbook, title, title, widths, headings, 3, {
    comparison: !packageTables, freezeColumns: false, freezeRows: !separate,
  });
  sheet.pageSetup.fitToPage = false;
  if (separate) sheet.pageSetup.printTitlesRow = undefined;
  sheet.headerFooter.differentFirst = true;
  const printLabel = (tables[0].caption ? [tables[0].caption] : tables[0].headers.slice(2))
    .map((label) => label.split("\n")[0]).join("  |  ");
  sheet.headerFooter.oddHeader = separate ? "&L" + title : "&L" + title + "&R" + printLabel;

  let pageHeight = sheet.getRow(1).height;
  for (const [index, { headers, groups, selectedColumn = -1, caption, highlighted }] of tables.entries()) {
    const captionRow = index ? sheet.rowCount + 2 : 2;
    const headerRow = caption ? captionRow + 1 : 3;
    if (caption) {
      sheet.mergeCells(`A${captionRow}:E${captionRow}`);
      header(sheet.getCell(captionRow, 1), caption, highlighted ? TEAL : NAVY);
      sheet.getRow(captionRow).height = 36;
      headers.forEach((label, col) => header(sheet.getCell(headerRow, col + 1), label, highlighted ? TEAL : NAVY));
      sheet.getRow(headerRow).height = 32;
    } else {
      markProposalColumn(sheet, headerRow, selectedColumn, headings[selectedColumn]);
    }
    const groupSize = packageTables ? 1 : groups[0].length;
    const rows = groups.flat().map((cells) => cells.map(runs));
    const firstRows = writeRows(sheet, rows, widths, headerRow + 1, { selected: selectedColumn, groupSize, highlighted });
    if (packageTables) {
      const height = rowsHeight(sheet, captionRow, sheet.rowCount + 1);
      const gap = index ? rowsHeight(sheet, captionRow - 1, captionRow) : 0;
      if (index && pageHeight + gap + height > SLA_PRINT_HEIGHT) {
        sheet.getRow(captionRow - 1).addPageBreak(1, 16384);
        pageHeight = height;
      } else {
        pageHeight += gap + height;
      }
    } else {
      const repeatedHeight = rowsHeight(sheet, 2, headerRow + 1);
      paginateSla(sheet, groups.map((_, index) => firstRows[index * groupSize]), pageHeight + repeatedHeight, repeatedHeight);
    }
  }
}

function addReferenceSheets(workbook, sections) {
  function referenceSheet(key, headers, widths, rows, options) {
    const title = SECTION_LABELS[key];
    const sheet = layout(workbook, title, title, widths, headers, 2, options);
    sheet.getRow(2).height = 32;
    writeRows(sheet, rows, widths, 3);
  }
  if (sections.sla) addSlaSheet(workbook, sections.sla);
  if (sections.severity) {
    referenceSheet("severity", SEVERITY_HEADERS, [10, 28, 34, 84],
      sections.severity.map(({ code, name, short, description }) => [
        runs(code), runs(name), flattenRich(short, true), flattenRich(description, true),
      ]), { freezeColumns: false });
  }
  if (sections.assumptions) {
    referenceSheet("assumptions", ["Раздел", "Формулировка"], [23, 104],
      sections.assumptions.map(({ category, wording }) => [runs(category), flattenRich(wording, true)]));
  }
  if (sections.glossary) {
    referenceSheet("glossary", ["Термин RU", "Term ENG", "Определение RU"], [25, 24, 84],
      sections.glossary.map(({ term, english, definition }) => [runs(term), runs(english), flattenRich(definition, true)]),
      { freezeColumns: false });
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
  ], 2, { freezeColumns: false });
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
  const selected = 2 + proposal.selectedIndex;
  markProposalColumn(comparison, headerRow, selected, COMPARISON_HEADERS[selected]);
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
