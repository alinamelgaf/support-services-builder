import { parseDocument } from "htmlparser2";
import { ancestor, descendants, loadCatalog, XML_INVALID } from "./catalog.js";
import { emptyIntroduction, validateIntroduction } from "./introductions.js";
import { initialDefaults } from "./package-defaults.js";
import { OPTIONS } from "./proposal.js";
import { plainText, readRich } from "./rich-text.js";

export const SOURCE_TYPES = [
  ["catalog", "Каталог услуг"], ["defaults", "Базовая конфигурация"], ["intros", "Вводные тексты"],
  ["sla", "SLA"], ["raci", "RACI"], ["assumptions", "Assumptions"], ["glossary", "Глоссарий"],
];
export const SOURCE_KEY = "ssb:confluence-sources:v1";
const SUPPORTED = new Set(SOURCE_TYPES.slice(0, 3).map(([key]) => key));
const record = (item) => Boolean(item && typeof item === "object" && !Array.isArray(item));
const natural = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateSources(data = {}) {
  let base = String(data.base ?? "").trim();
  if (base) {
    let url;
    try { url = new URL(base); }
    catch { throw new Error("Укажите полный базовый адрес Confluence."); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Укажите базовый адрес Confluence без учётных данных, параметров и якоря.");
    }
    base = url.href.replace(/\/+$/, "");
  }
  const space = String(data.space ?? "").trim();
  if (space && !/^[\p{L}\p{N}_~-]+$/u.test(space)) throw new Error("Недопустимый ключ пространства Confluence.");
  const labels = Object.fromEntries(SOURCE_TYPES.map(([key]) => [key, String(data.labels?.[key] ?? "").trim()]));
  const configured = Object.values(labels).filter(Boolean);
  if (configured.some((label) => !/^[\p{L}\p{N}_.-]{1,255}$/u.test(label)) || new Set(configured).size !== configured.length) {
    throw new Error("Укажите разные метки Confluence. Допустимы буквы, цифры, точки, дефисы и подчёркивания.");
  }
  return { base, space, labels };
}

export function queryUrl({ base, space, labels }) {
  const active = [...SUPPORTED].map((key) => labels[key]);
  if (!base || active.some((label) => !label)) return "";
  const terms = ["type = page", `label IN (${active.map((label) => `"${label}"`).join(", ")})`];
  if (space) terms.push(`space = "${space}"`);
  const search = new URL(base + "/rest/api/content/search");
  search.search = new URLSearchParams({ cql: terms.join(" AND "), expand: "body.storage,metadata.labels", limit: "25" });
  return search.href;
}

function linkParts(link) {
  return typeof link === "string" && link ? new URL(link, "https://pagination.invalid") : null;
}

function linkStart(link) {
  const start = linkParts(link)?.searchParams.get("start");
  if (start == null) return null;
  if (!/^\d+$/.test(start) || !natural(Number(start))) throw new Error("Некорректное смещение страницы REST.");
  return Number(start);
}

function readEnvelope(data) {
  if (!record(data) || !Array.isArray(data.results)) throw new Error("Ожидается исходный ответ REST со списком results.");
  const start = data.start ?? linkStart(data._links?.self) ?? 0;
  const size = data.size ?? data.results.length;
  const total = data.totalSize ?? data.total ?? null;
  const next = data._links?.next;
  const selfQuery = linkParts(data._links?.self)?.searchParams.get("cql");
  const nextQuery = linkParts(next)?.searchParams.get("cql");
  if (selfQuery && nextQuery && selfQuery !== nextQuery) throw new Error("Ссылка на следующую страницу относится к другому запросу.");
  if (!natural(start) || !natural(size) || !natural(start + size) || size !== data.results.length ||
      (total !== null && (!natural(total) || total < start + size)) ||
      (next && (!size || (total !== null && total === start + size)))) {
    throw new Error("Некорректные сведения о пагинации REST.");
  }
  const nextStart = linkStart(next);
  if (nextStart !== null && nextStart !== start + size) throw new Error("Выгрузка REST содержит разрыв или пересечение страниц.");
  const base = readBase(data._links?.base);
  const boundaryUnknown = total === null && !record(data._links) && natural(data.limit) && size > 0 && size === data.limit;
  return { start, size, total, base, more: Boolean(next) || boundaryUnknown || (total !== null && total > start + size), query: selfQuery ?? nextQuery ?? "", results: data.results };
}

function readBase(base) {
  if (typeof base !== "string") return "";
  try { return validateSources({ base }).base; }
  catch { return ""; }
}

function collectPages(envelopes) {
  const queries = new Set(envelopes.map(({ query }) => query).filter(Boolean));
  const totals = new Set(envelopes.map(({ total }) => total).filter((total) => total !== null));
  const bases = new Set(envelopes.map(({ base }) => base).filter(Boolean));
  if (queries.size > 1 || totals.size > 1 || bases.size > 1) throw new Error("JSON-файлы относятся к разным запросам или версиям выгрузки.");
  const ordered = [...envelopes].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let gap = false;
  for (const [index, page] of ordered.entries()) {
    if (index && page.start < cursor) throw new Error("Страницы REST пересекаются.");
    if (page.start > cursor) gap = true;
    if (!page.more && index < ordered.length - 1) throw new Error("После последней страницы обнаружены лишние данные.");
    cursor = page.start + page.size;
  }
  const last = ordered.at(-1);
  const total = [...totals][0];
  if (total !== undefined && cursor > total) throw new Error("Размер набора превышает объявленное количество результатов.");
  const complete = Boolean(last && !gap && !last.more && (total === undefined || cursor === total));
  return { complete, count: ordered.reduce((sum, page) => sum + page.size, 0), total, base: [...bases][0], results: ordered.flatMap((page) => page.results) };
}

export function createImportBatch() {
  let pages = new Map();
  return {
    add(payloads, sources) {
      const legacy = payloads.find((item) => item?.schemaVersion === 1 && Array.isArray(item.pages));
      if (legacy) {
        if (payloads.length !== 1 || pages.size) throw new Error("Старый JSON каталога импортируйте отдельно от страниц REST.");
        const base = readBase(legacy.source) || sources.base;
        const catalog = loadCatalog(legacy, base);
        return { complete: true, count: catalog.pages, data: { ...catalog, base, standard: initialDefaults(), legacy: true, usableStandard: false } };
      }
      const candidate = new Map(pages);
      for (const payload of payloads) {
        const page = readEnvelope(payload);
        const previous = candidate.get(page.start);
        if (previous && JSON.stringify(previous) !== JSON.stringify(page)) {
          throw new Error("По одному смещению получены разные страницы. Начните новую выгрузку.");
        }
        candidate.set(page.start, page);
      }
      const merged = collectPages([...candidate.values()]);
      const data = merged.complete ? normalizeRest(merged.results, { ...sources, base: sources.base || merged.base }) : null;
      pages = data ? new Map() : candidate;
      return { complete: merged.complete, count: merged.count, total: merged.total, data };
    },
    reset() { pages.clear(); },
  };
}

const cellRich = (cell, base) => readRich(cell.children, { base, source: base || undefined });
const cellText = (cell) => plainText(cellRich(cell)).trim();
const keyText = (text) => text.replace(/\s+/g, " ").replace(/:$/, "").trim().toLowerCase();
const headerText = (cell) => keyText(cellText(cell));

function readTable(page, header, optional = false) {
  if (typeof page.storage !== "string" || XML_INVALID.test(page.storage)) throw new Error("Нет корректного body.storage.value.");
  const root = parseDocument(page.storage, { recognizeCDATA: true, recognizeSelfClosing: true });
  const matches = [];
  for (const table of descendants(root)) {
    if (table.name !== "table" || ancestor(table, (node) => node.name === "table")) continue;
    const rows = [...descendants(table)].filter((node) => node.name === "tr" && ancestor(node, (n) => n.name === "table") === table)
      .map((row) => row.children.filter((cell) => cell.name === "td" || cell.name === "th"));
    const index = rows.findIndex((row) => header.every((name) => row.filter((cell) => name.includes(headerText(cell))).length === 1));
    if (index < 0) continue;
    const positions = header.map((names) => rows[index].findIndex((cell) => names.includes(headerText(cell))));
    matches.push(rows.slice(index + 1).filter((row) => row.some(cellText)).map((row) => positions.map((position) => row[position])));
  }
  if (!matches.length && optional) return null;
  if (matches.length !== 1) throw new Error("Требуется одна таблица с ожидаемыми заголовками.");
  if (matches[0].some((row) => row.some((cell) => !cell))) throw new Error("В таблице есть строки с пропущенными ячейками.");
  return matches[0];
}

function readStandard(page, ids, standard, warn) {
  const codes = OPTIONS.map(({ code }) => code);
  const rows = readTable(page, [["id услуги"], ["в документ", "включить в документ"], ...codes.map((code) => [keyText(code)])]);
  const seen = new Set();
  const values = [];
  const included = [];
  for (const cells of rows) {
    const [id, document, ...packages] = cells.map(cellText);
    const key = id.toLowerCase();
    if (!id || /\s/.test(id) || XML_INVALID.test(id) || seen.has(key)) throw new Error("Отсутствует ID или найден повтор ID в базовой конфигурации.");
    seen.add(key);
    if (!['+', '-'].includes(document) || packages.some((value) => !value || XML_INVALID.test(value))) {
      throw new Error(`Недопустимые значения конфигурации для ${id}.`);
    }
    if (!ids.has(key)) {
      warn(`В базовой конфигурации есть ${id}, но карточка отсутствует.`);
      continue;
    }
    values.push([ids.get(key), Object.fromEntries(codes.map((code, index) => [code, packages[index]]))]);
    included.push([ids.get(key), document === "+"]);
  }
  for (const [key, id] of ids) if (!seen.has(key)) warn(`Для ${id} нет строки базовой конфигурации. Услуга исключена из пакетов и включена в документ.`);
  standard.values = Object.fromEntries(values);
  standard.includedInDocument = Object.fromEntries(included);
}

function readIntros(page, standard, base) {
  const codes = OPTIONS.map(({ code }) => code);
  const names = new Map(codes.map((code) => [keyText(code), code]));
  const introduction = (cell) => validateIntroduction({ ...emptyIntroduction(), blocks: cellRich(cell, base) });
  const rows = readTable(page, [["вариант", "вариант поддержки", "вариант предложения", "пакет", "тип поддержки", "уровень поддержки"], ["вводный текст", "текст", "текст предложения"]], true);
  if (!rows) {
    const columns = readTable(page, codes.map((code) => [keyText(code)]));
    if (columns.length !== 1) throw new Error("Под заголовками трёх вариантов нужна одна строка вводных текстов.");
    standard.introductions = Object.fromEntries(codes.map((code, index) => [code, introduction(columns[0][index])]));
    return;
  }
  const values = new Map();
  for (const [variant, text] of rows) {
    const code = names.get(headerText(variant));
    if (!code || values.has(code)) throw new Error("В таблице вводных текстов найден неизвестный или повторный вариант.");
    values.set(code, introduction(text));
  }
  if (values.size !== codes.length) throw new Error("В таблице нужны все три варианта поддержки.");
  standard.introductions = Object.fromEntries(values);
}

function normalizeRest(results, sources) {
  if (!sources.labels.catalog) throw new Error("Укажите локальные метки источников перед импортом REST.");
  const labels = new Map(SOURCE_TYPES.filter(([key]) => sources.labels[key]).map(([key]) => [sources.labels[key], key]));
  const sourcesByType = new Map([...SUPPORTED].map((key) => [key, []]));
  const byId = new Map();
  const issues = [];
  for (const raw of results) {
    const page = raw?.content ?? raw;
    const id = String(page?.id ?? "");
    const title = typeof page?.title === "string" ? page.title : "";
    if (!/^\d+$/.test(id)) throw new Error("В результатах REST отсутствует корректный ID страницы.");
    const labelContainer = page.metadata?.labels;
    const entries = labelContainer?.results ?? labelContainer;
    if (!Array.isArray(entries) || labelContainer?._links?.next || labelContainer?.totalSize > entries.length) {
      throw new Error("REST-ответ не содержит полного metadata.labels. Сохраните ответ запроса с нужным expand.");
    }
    const types = [...new Set(entries.map((label) => labels.get(typeof label === "string" ? label : label?.name)).filter(Boolean))];
    if (types.length > 1) throw new Error("На одной странице обнаружены метки разных источников.");
    const type = types[0];
    const storage = page.body?.storage?.value;
    const data = { pageId: id, title, storage, type };
    const previous = byId.get(id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(data)) throw new Error("Один ID страницы присутствует с разным содержимым.");
      issues.push({ level: "warning", page_id: id, title, message: "Повтор страницы пропущен. Если каталог менялся во время выгрузки, повторите её." });
      continue;
    }
    byId.set(id, data);
    if (sourcesByType.has(type)) sourcesByType.get(type).push(data);
    else issues.push({ level: "warning", page_id: id, title, message: "Страница не относится к обрабатываемым источникам." });
  }
  const catalog = loadCatalog({ schemaVersion: 1, pages: sourcesByType.get("catalog") }, sources.base);
  const standard = initialDefaults();
  const ids = new Map(catalog.services.map(({ id }) => [id.toLowerCase(), id]));
  let usableStandard = true;
  for (const [key, read] of [["defaults", (page, warn) => readStandard(page, ids, standard, warn)], ["intros", (page) => readIntros(page, standard, sources.base)]]) {
    const pages = sourcesByType.get(key);
    const name = SOURCE_TYPES.find(([type]) => type === key)[1];
    const issue = (level, message) => issues.push({ level, page_id: pages[0]?.pageId, title: pages[0]?.title, message: `${name}. ${message}` });
    if (pages.length !== 1) {
      issue("warning", pages.length ? "Найдено больше одной страницы источника." : "Страница источника отсутствует.");
      usableStandard = false;
      continue;
    }
    try { read(pages[0], (message) => issue("warning", message)); }
    catch (error) { issue("error", error.message); usableStandard = false; }
  }
  return { ...catalog, issues: [...catalog.issues, ...issues], base: sources.base, standard, usableStandard, legacy: false };
}
