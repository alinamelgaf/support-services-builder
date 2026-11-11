import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer,
  PageOrientation, Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun,
  UnderlineType, VerticalAlignTable, WidthType,
} from "docx";
import { COMPARISON_HEADERS, CONDITIONS_TITLE } from "./proposal.js";
import { SECTION_LABELS, SEVERITY_HEADERS } from "./document-sections.js";
import { linkGroups, plainText } from "./rich-text.js";

const NAVY = "243B56";
const TEAL = "176054";
const PALE_TEAL = "E5F3EE";
const PALE_BLUE = "F3F6FA";
const WHITE = "FFFFFF";
const INK = "172B40";
const WIDTHS = [1190, 2494, 2211, 2211, 2211];
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" };

function textRuns(run, extra = {}) {
  return run.text.split("\n").map((text, index) => new TextRun({
    text, break: index ? 1 : undefined, bold: run.bold, italics: run.italics, strike: run.strike,
    underline: run.underline ? { type: UnderlineType.SINGLE } : undefined,
    color: run.color, font: run.monospace ? "Consolas" : undefined, ...extra,
  }));
}

function children(runs) {
  const result = [];
  for (const { href, runs: group } of linkGroups(runs)) {
    const content = group.flatMap((run) => textRuns(run, href ? { style: "Hyperlink" } : {}));
    if (href) result.push(new ExternalHyperlink({ link: href, children: content }));
    else result.push(...content);
  }
  return result;
}

function tableCell(text, width, { background, white = false, bold = false, center = false, keepNext, numbering }) {
  const body = typeof text === "string" ? [{
    children: textRuns({ text, bold }, { size: 20, color: white ? WHITE : INK }),
  }] : [...renderBlocks(text, numbering)];
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlignTable.CENTER,
    shading: { type: ShadingType.CLEAR, fill: background },
    children: (body.length ? body : [{}]).map((paragraph) => new Paragraph({
      ...paragraph, alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { before: 40, after: 40, line: 268 }, keepNext,
    })),
  });
}

function fixedTable(rows, widths) {
  return new Table({
    width: { size: widths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA },
    columnWidths: widths, layout: TableLayoutType.FIXED, alignment: AlignmentType.CENTER,
    margins: { top: 45, bottom: 45, left: 100, right: 100 },
    borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER, insideHorizontal: BORDER, insideVertical: BORDER },
    rows,
  });
}

function composition(proposal) {
  const selected = 2 + proposal.selectedIndex;
  const makeRow = (values, style, options) => new TableRow({
    ...options,
    children: values.map((value, index) => tableCell(value, WIDTHS[index], style(index))),
  });
  const marker = makeRow(COMPARISON_HEADERS.map((_, index) => index === selected ? "Предложение" : ""),
    (index) => ({ background: index === selected ? TEAL : PALE_BLUE, white: true, bold: true, center: true }),
    { tableHeader: true, cantSplit: true });
  const header = makeRow(COMPARISON_HEADERS, (index) => ({
    background: index === selected ? TEAL : NAVY, white: true, bold: true, center: true,
  }), { tableHeader: true, cantSplit: true });
  const rows = proposal.rows.map(({ id, name, values }, rowIndex) => {
    const cells = [id, name, ...values];
    const short = cells.every((value) => value.length <= 300 && value.split("\n").length <= 10);
    return makeRow(cells, (index) => ({
      background: index === selected ? PALE_TEAL : rowIndex % 2 ? PALE_BLUE : WHITE,
      bold: index === 0, center: index >= 2,
    }), { cantSplit: short });
  });
  return fixedTable([marker, header, ...rows], WIDTHS);
}

function* renderBlocks(blocks, numbering, depth = 0, prefix) {
  const left = depth ? 540 + 360 * (depth - 1) : 0;
  for (const [index, block] of blocks.entries()) {
    if (block.kind === "paragraph") {
      yield {
        children: [...(index === 0 && prefix ? [prefix] : []), ...children(block.runs)],
        ...(left ? { indent: { left } } : {}),
      };
      continue;
    }
    if (index === 0 && prefix) yield { children: [prefix] };
    let number = block.start;
    let reference;
    for (const item of block.items) {
      if (!reference || (block.ordered && item.value !== undefined)) {
        number = item.value ?? number;
        reference = `tt-list-${numbering.length + 1}`;
        numbering.push({ reference, levels: [{
          level: 0, format: block.ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: block.ordered ? "%1." : "•", start: block.ordered ? number : 1,
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 540 + 360 * depth, hanging: 300 } }, run: { font: "Arial" } },
        }] });
      }
      const first = item.blocks[0]?.kind === "paragraph";
      yield {
        children: first ? children(item.blocks[0].runs) : [],
        numbering: { reference, level: 0 },
      };
      yield* renderBlocks(item.blocks.slice(first ? 1 : 0), numbering, depth + 1);
      number += 1;
    }
  }
}

function serviceSections(rows, numbering) {
  const sections = [];
  for (const { name, description, conditions } of rows) {
    sections.push(new Paragraph({
      text: name, heading: HeadingLevel.HEADING_2, alignment: AlignmentType.CENTER, keepNext: true,
    }));
    const label = new TextRun({ text: `${CONDITIONS_TITLE}: `, bold: true });
    const body = [
      ...renderBlocks(description, numbering),
      ...renderBlocks(conditions, numbering, 0, label),
    ];
    const short = plainText(description).length + plainText(conditions).length <= 800 && body.length <= 8;
    body.forEach((paragraph, index) => sections.push(new Paragraph({
      ...paragraph, keepLines: short, keepNext: short && index < body.length - 1,
    })));
  }
  return sections;
}

const sectionHeading = (key) => new Paragraph({ heading: HeadingLevel.HEADING_1, text: SECTION_LABELS[key], keepNext: true });
const subheading = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, text, keepNext: true });

function referenceHeader(headers, widths, selected = -1, highlighted = false) {
  return new TableRow({
    tableHeader: true, cantSplit: true,
    children: headers.map((text, column) => tableCell(text, widths[column], {
      background: highlighted || column === selected ? TEAL : NAVY, white: true, bold: true, keepNext: true,
    })),
  });
}

function slaTable({ headers, selectedColumn, highlighted, groups, caption }) {
  const widths = caption ? [2517, 1950, 1950, 1950, 1950] : [1930, 2457, 1976, 1977, 1977];
  const rows = groups.flatMap((rows, group) => {
    const keepGroup = rows.flat().every((text) => text.length <= 110 && text.split("\n").length <= 2);
    return rows.map((cells, index) => new TableRow({
      cantSplit: cells.every((text) => text.length <= 360 && text.split("\n").length <= 8),
      children: cells.map((text, column) => tableCell(text, widths[column], {
        background: highlighted || column === selectedColumn ? PALE_TEAL : (caption ? index : group) % 2 ? PALE_BLUE : WHITE,
        bold: column === 0,
        keepNext: keepGroup && index < rows.length - 1,
      })),
    }));
  });
  return fixedTable([referenceHeader(headers, widths, selectedColumn, highlighted), ...rows], widths);
}

function referenceTable(headers, widths, records, numbering) {
  const rows = records.map((values, index) => new TableRow({
    cantSplit: values.every((value) => typeof value === "string"
      ? value.length <= 300 : plainText(value).length <= 450 && value.length <= 6),
    children: values.map((value, column) => tableCell(value, widths[column], {
      background: index % 2 ? PALE_BLUE : WHITE, bold: column === 0, numbering,
    })),
  }));
  return fixedTable([referenceHeader(headers, widths), ...rows], widths);
}

function referenceSections(sections, numbering) {
  const content = [];
  const paragraphs = (blocks) => [...renderBlocks(blocks, numbering)].map((paragraph) => new Paragraph(paragraph));
  if (sections.sla) {
    content.push(sectionHeading("sla"));
    for (const table of sections.sla) {
      if (table.caption) content.push(subheading(table.caption));
      content.push(slaTable(table));
    }
  }
  if (sections.severity) {
    content.push(sectionHeading("severity"), referenceTable(SEVERITY_HEADERS, [760, 2300, 2360, 4897],
      sections.severity.map(({ code, name, short, description }) => [code, name, short, description]), numbering));
  }
  if (sections.assumptions) {
    content.push(sectionHeading("assumptions"));
    let previous;
    for (const { category, wording } of sections.assumptions) {
      if (category !== previous) content.push(subheading(category));
      previous = category;
      content.push(...paragraphs(wording));
    }
  }
  if (sections.glossary) {
    content.push(sectionHeading("glossary"), referenceTable(["Термин RU", "Term ENG", "Определение RU"], [2000, 1800, 6517],
      sections.glossary.map(({ term, english, definition }) => [term, english, definition]), numbering));
  }
  return content;
}

export async function generateWord(proposal) {
  const numbering = [];
  const { sections } = proposal;
  const content = [
    new Paragraph({ heading: HeadingLevel.TITLE, text: proposal.title, keepNext: true }),
    ...(proposal.clientLine ? [new Paragraph({ text: proposal.clientLine, keepNext: true })] : []),
    ...(sections.intro ? [...renderBlocks(sections.intro, numbering)].map((paragraph) => new Paragraph(paragraph)) : []),
    new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Состав вариантов поддержки", keepNext: true }),
    composition(proposal),
    ...(proposal.rows.length ? [
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Описания услуг", keepNext: true }),
      ...serviceSections(proposal.rows, numbering),
    ] : []),
    ...referenceSections(sections, numbering),
  ];
  const document = new Document({
    creator: "Support Services Builder", title: proposal.title, numbering: { config: numbering },
    styles: { default: {
      document: {
        run: { font: "Arial", size: 22, color: INK },
        paragraph: { spacing: { after: 120, line: 276 }, widowControl: true },
      },
      title: { run: { font: "Arial", size: 44, bold: true, color: "000000" }, paragraph: { spacing: { after: 160 } } },
      heading1: { run: { font: "Arial", size: 32, bold: true, color: "000000" }, paragraph: { spacing: { before: 300, after: 160 } } },
      heading2: { run: { font: "Arial", size: 24, bold: true, color: "000000" }, paragraph: { spacing: { before: 360, after: 140 } } },
    } },
    sections: [{
      properties: { page: {
        size: { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT },
        margin: { left: 794, right: 794, top: 766, bottom: 766 },
      } },
      children: content,
    }],
  });
  return Packer.toBlob(document);
}
