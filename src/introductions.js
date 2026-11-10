import { parseDocument } from "htmlparser2";
import { XML_INVALID } from "./catalog.js";
import { readRich, safeUrl } from "./rich-text.js";

const MARKS = ["bold", "italics", "underline", "strike", "monospace"];
const MAX_DEPTH = 20;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new Error("В файле настроек указан некорректный вводный текст.");

export const emptyIntroduction = () => ({ blocks: [], excel: false, word: true });

export function introductionFor(introductions, code) {
  return Object.hasOwn(introductions, code) ? introductions[code] : emptyIntroduction();
}

export function hasIntroText(blocks) {
  return blocks.some((block) => block.kind === "paragraph"
    ? block.runs.some(({ text }) => text.trim())
    : block.items.some(({ blocks: content }) => hasIntroText(content)));
}

function validateRun(run) {
  if (!isRecord(run) || typeof run.text !== "string" || XML_INVALID.test(run.text)) throw invalid();
  const clean = { text: run.text.replace(/\r\n?/g, "\n") };
  for (const mark of MARKS) {
    if (run[mark] === true) clean[mark] = true;
  }
  if (typeof run.color === "string" && /^[0-9a-f]{6}$/i.test(run.color)) clean.color = run.color.toUpperCase();
  if (run.href !== undefined) {
    const href = safeUrl(run.href);
    if (!href) throw invalid();
    clean.href = href;
  }
  return clean;
}

function validateBlocks(blocks, depth = 0) {
  if (!Array.isArray(blocks) || depth > MAX_DEPTH) throw invalid();
  return blocks.map((block) => {
    if (!isRecord(block)) throw invalid();
    if (block.kind === "paragraph" && Array.isArray(block.runs)) {
      return { kind: "paragraph", runs: block.runs.map(validateRun) };
    }
    if (block.kind !== "list" || typeof block.ordered !== "boolean" ||
        !Number.isSafeInteger(block.start) || !Array.isArray(block.items)) throw invalid();
    return { kind: "list", ordered: block.ordered, start: block.start, items: block.items.map((item) => {
      if (!isRecord(item) || (item.value !== undefined && !Number.isSafeInteger(item.value))) throw invalid();
      return { ...(item.value === undefined ? {} : { value: item.value }), blocks: validateBlocks(item.blocks, depth + 1) };
    }) };
  });
}

export function validateIntroduction(value) {
  if (!isRecord(value) || typeof value.excel !== "boolean" || typeof value.word !== "boolean") throw invalid();
  return { blocks: validateBlocks(value.blocks), excel: value.excel, word: value.word };
}

export function readIntroductionHtml(html) {
  const tree = parseDocument(html, { recognizeSelfClosing: true });
  // Chromium использует одиночный BR как заполнитель пустой строки редактора.
  const blocks = readRich(tree.children, { preserveEmptyLines: true });
  return hasIntroText(blocks) ? validateBlocks(blocks) : [];
}
