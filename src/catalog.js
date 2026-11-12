import { parseDocument } from "htmlparser2";
import { pageUrl, plainText, readRich } from "./rich-text.js";

const FIELDS = new Map([
  ["id услуги", "id"], ["наименование", "name"], ["наименование услуги", "name"],
  ["описание услуги", "description"], ["условия предоставления", "conditions"], ["основная услуга", "base_service"],
]);
const LABELS = {
  id: "ID услуги", name: "Наименование", description: "Описание услуги",
  conditions: "Условия предоставления", base_service: "Основная услуга",
};
export const XML_INVALID = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
export const MAX_BYTES = 64 * 1024 * 1024;
const serviceId = /^TS-(\d+)(?:\.(.+))?$/i;
const alphabetic = new Intl.Collator("en", { sensitivity: "base" });
const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const isMacro = (node) => ["ac:structured-macro", "ac:macro"].includes(node.name);

function compareServiceIds(left, right) {
  const a = serviceId.exec(left.id);
  const b = serviceId.exec(right.id);
  if (!a || !b) return Number(Boolean(b)) - Number(Boolean(a));
  // Сравниваем числа без ведущих нулей по длине и цифрам.
  const aNumber = a[1].replace(/^0+(?=\d)/, "");
  const bNumber = b[1].replace(/^0+(?=\d)/, "");
  return aNumber.length - bNumber.length || alphabetic.compare(aNumber, bNumber) ||
    Number(Boolean(a[2])) - Number(Boolean(b[2])) || alphabetic.compare(a[2] ?? "", b[2] ?? "");
}

export function* descendants(root) {
  const stack = [...(root.children ?? [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    yield node;
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }
}

export function ancestor(node, matches) {
  for (let parent = node.parent; parent; parent = parent.parent) if (matches(parent)) return parent;
  return null;
}

function fieldKey(cell) {
  const label = plainText(readRich(cell.children)).trim().replace(/:\s*$/, "").replace(/\s+/g, " ").toLowerCase();
  return FIELDS.get(label);
}

function propertyTables(root) {
  const tables = [];
  for (const macro of descendants(root)) {
    if (!isMacro(macro) || macro.attribs["ac:name"] !== "details") continue;
    for (const table of descendants(macro)) {
      if (table.name !== "table" || ancestor(table, isMacro) !== macro) continue;
      const enclosingTable = ancestor(table, (node) => node.name === "table");
      if (enclosingTable && ancestor(enclosingTable, isMacro) === macro) continue;
      const rows = [...descendants(table)]
        .filter((row) => row.name === "tr" && ancestor(row, (n) => n.name === "table") === table)
        .map((row) => row.children.filter((cell) => ["td", "th"].includes(cell.name)));
      const mapped = [];
      for (const [index, cells] of rows.entries()) {
        const keys = cells.map(fieldKey);
        if (cells.length >= 3 && keys.every(Boolean)) {
          if (rows[index + 1]) keys.forEach((key, i) => {
            if (rows[index + 1][i]) mapped.push([key, rows[index + 1][i]]);
          });
          break;
        }
        if (cells.length === 2 && keys[0]) mapped.push([keys[0], cells[1]]);
      }
      if (mapped.length) tables.push(mapped);
    }
  }
  return tables;
}

export function hasServiceProperties(root) {
  return propertyTables(root).some((table) => {
    const keys = new Set(table.map(([key]) => key));
    return keys.size >= 2 && (keys.has("id") || keys.has("description"));
  });
}

function properties(storage) {
  const root = parseDocument(storage, { recognizeCDATA: true, recognizeSelfClosing: true });
  const tables = propertyTables(root);
  if (!tables.length) throw new Error("Таблица Page Properties с полями услуги не найдена.");
  if (tables.length > 1) throw new Error("Найдено несколько таблиц Page Properties с полями услуги.");
  const fields = new Map();
  for (const [key, cell] of tables[0]) {
    if (fields.has(key)) throw new Error(`Поле «${LABELS[key]}» указано несколько раз.`);
    fields.set(key, cell.children);
  }
  return fields;
}

export function loadCatalog(data, base = "") {
  if (!isRecord(data) || data.schemaVersion !== 1 || !Array.isArray(data.pages)) {
    throw new Error("Требуется JSON из экспортёра каталога версии 1.");
  }
  const failures = Object.hasOwn(data, "failures") ? data.failures : [];
  if (!Array.isArray(failures)) throw new Error("Некорректный список ошибок в JSON.");

  const issues = [];
  const issue = (level, message, page_id = "", title = "") => issues.push({ level, message, page_id, title });
  for (const failure of failures) {
    if (isRecord(failure)) issue("error", "В выгрузке отсутствует содержимое карточки.", String(failure.pageId ?? ""), String(failure.title ?? ""));
    else issue("error", "Некорректная запись об ошибке экспортёра.");
  }

  const candidates = [];
  for (const [index, page] of data.pages.entries()) {
    if (!isRecord(page)) {
      issue("error", `Запись ${index + 1} в списке страниц имеет неверный формат.`);
      continue;
    }
    const page_id = String(page.pageId ?? "");
    const title = String(page.title ?? "");
    try {
      if (!/^\d+$/.test(page_id)) throw new Error(`Запись ${index + 1} не содержит корректный ID страницы Confluence.`);
      if (typeof page.storage !== "string" || !page.storage.trim()) throw new Error("Пустое содержимое body.storage.value.");
      if (XML_INVALID.test(page.storage)) throw new Error("Содержимое страницы содержит недопустимые управляющие символы.");
      const fields = properties(page.storage);
      const warnings = new Set();
      const parsed = Object.fromEntries([...fields].map(([key, nodes]) => [
        key, readRich(nodes, { base, source: pageUrl(page_id, base), warn: (message) => warnings.add(message) }),
      ]));
      const value = (key) => plainText(parsed[key] ?? []).trim();
      const missing = ["id", "name", "description"].filter((key) => !value(key));
      if (missing.length) throw new Error(`Не заполнены обязательные поля. ${missing.map((key) => LABELS[key]).join(", ")}.`);
      if ([...fields.keys()].some((key) => XML_INVALID.test(plainText(parsed[key])))) {
        throw new Error("Поля услуги содержат недопустимые управляющие символы.");
      }
      const id = value("id");
      if (/\s/.test(id)) throw new Error("ID услуги содержит пробельные символы.");
      for (const key of ["conditions", "base_service"]) {
        if (!fields.has(key)) warnings.add(`Отсутствует поле «${LABELS[key]}».`);
      }
      for (const message of warnings) issue("warning", message, page_id, title);
      const optional = (key) => value(key) && value(key) !== "-" ? parsed[key] : [];
      candidates.push({
        id, name: value("name"), description: parsed.description, conditions: optional("conditions"),
        base_service: optional("base_service"), page_id, source: pageUrl(page_id, base), title,
      });
    } catch (error) {
      issue("error", error instanceof RangeError ? "Слишком глубокая вложенность разметки карточки." : error.message, page_id, title);
    }
  }

  const counts = new Map();
  for (const { id } of candidates) counts.set(id.toLowerCase(), (counts.get(id.toLowerCase()) ?? 0) + 1);
  const services = [];
  for (const { title, ...service } of candidates) {
    if (counts.get(service.id.toLowerCase()) > 1) {
      issue("error", `ID ${service.id} встречается в нескольких карточках.`, service.page_id, title);
    } else {
      services.push(service);
    }
  }
  services.sort(compareServiceIds);
  return { services, issues, pages: data.pages.length + failures.length };
}
