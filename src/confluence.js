import { parseDocument } from "htmlparser2";
import { ancestor, descendants, hasServiceProperties, loadCatalog, XML_INVALID } from "./catalog.js";
import { SECTION_LABELS, SEVERITY_CODES, SEVERITY_HEADERS, SLA_CODES, SLA_METRICS } from "./document-sections.js";
import { initialDefaults } from "./package-defaults.js";
import { OPTIONS } from "./proposal.js";
import { hasRichText, plainText, readRich } from "./rich-text.js";

export const SOURCE_TYPES = [
  ["catalog", "Каталог услуг"], ["defaults", "Базовая конфигурация"], ["intros", "Вводные тексты"],
  ["sla", "SLA и уровни критичности"], ["raci", "Матрица RACI"],
  ["assumptions", "Допущения и ограничения"], ["glossary", "Глоссарий"],
];
export const SOURCE_KEY = (typeof __SSB_STORAGE_PREFIX__ === "string" ? __SSB_STORAGE_PREFIX__ : "") + "ssb:confluence-sources:v1";
const SUPPORTED = new Set(SOURCE_TYPES.map(([key]) => key).filter((key) => key !== "raci"));
const sourceNames = new Map(SOURCE_TYPES);
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
  if (!base || !labels.catalog) return "";
  const active = [...SUPPORTED].map((key) => labels[key]).filter(Boolean);
  const terms = ["type = page", `label IN (${active.map((label) => `"${label}"`).join(", ")})`];
  if (space) terms.push(`space = "${space}"`);
  const search = new URL(base + "/rest/api/content/search");
  search.search = new URLSearchParams({ cql: terms.join(" AND "), expand: "body.storage,metadata.labels", limit: "50" });
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
        return { complete: true, count: catalog.pages, data: { ...catalog, base, standard: initialDefaults(), sections: {}, legacy: true, usableStandard: false } };
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
      const data = merged.complete ? normalizeRest(merged.results, { ...sources, base: merged.base || sources.base }) : null;
      pages = data ? new Map() : candidate;
      return { complete: merged.complete, count: merged.count, total: merged.total, data };
    },
    reset() { pages.clear(); },
  };
}

function cellRich(cell, base) {
  const blocks = readRich(cell.children, { base, source: base || undefined });
  if (XML_INVALID.test(plainText(blocks))) throw new Error("Ячейка таблицы содержит недопустимые символы.");
  return blocks;
}
const cellText = (cell) => plainText(cellRich(cell)).trim();
const keyText = (text) => text.replace(/\s+/g, " ").replace(/:$/, "").trim().toLowerCase();
const headerText = (cell) => keyText(cellText(cell));
const namedColumns = (...labels) => labels.map((label) => [keyText(label)]);
const packageCodes = OPTIONS.map(({ code }) => code);
const headers = {
  defaults: [["id услуги"], ["в документ", "включить в документ"], ...namedColumns(...packageCodes)],
  intros: [["вариант", "вариант поддержки", "вариант предложения", "пакет", "тип поддержки", "уровень поддержки"], ["вводный текст", "текст", "текст предложения"]],
  introColumns: namedColumns(...packageCodes),
  sla: namedColumns("Код критичности", "Уровень поддержки", ...SLA_METRICS),
  severity: namedColumns(...SEVERITY_HEADERS),
  assumptions: namedColumns("Раздел", "Формулировка"),
  glossary: namedColumns("Термин RU", "Term ENG", "Определение RU"),
};
headers.sla[4].push("время временного решения");
headers.sla[5].push("время постоянного решения");

function* tableRows(root) {
  for (const table of descendants(root)) {
    if (table.name !== "table" || ancestor(table, (node) => node.name === "table")) continue;
    yield [...descendants(table)].filter((node) => node.name === "tr" && ancestor(node, (n) => n.name === "table") === table)
      .map((row) => row.children.filter((cell) => cell.name === "td" || cell.name === "th"));
  }
}

function* matchingTables(page, header, exact = false) {
  for (const { rows, names } of page.tables) {
    const index = names.findIndex((row) => (!exact || row.filter(Boolean).length === header.length) &&
      header.every((aliases) => row.some((name) => aliases.includes(name))));
    if (index < 0) continue;
    const positions = header.map((aliases) => names[index].flatMap((name, i) => aliases.includes(name) ? [i] : []));
    yield { positions, rows: rows.slice(index + 1) };
  }
}

function readTable(page, header, optional = false, exact = false) {
  if (!page.tables) throw new Error("Нет корректного body.storage.value.");
  const matches = [...matchingTables(page, header, exact)];
  if (!matches.length && optional) return null;
  if (matches.length !== 1) throw new Error(matches.length
    ? "Найдено несколько таблиц с одинаковыми ожидаемыми заголовками."
    : "Таблица отсутствует или содержит неверные заголовки.");
  const { positions, rows } = matches[0];
  if (positions.some((indices) => indices.length !== 1)) throw new Error("В таблице повторяются ожидаемые заголовки.");
  const cells = rows.filter((row) => row.some(cellText)).map((row) => positions.map(([position]) => row[position]));
  if (cells.some((row) => row.some((cell) => !cell))) throw new Error("В таблице есть строки с пропущенными ячейками.");
  return cells;
}

function readStandard(page, ids, standard, warn) {
  const rows = readTable(page, headers.defaults);
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
    values.push([ids.get(key), Object.fromEntries(packageCodes.map((code, index) => [code, packages[index]]))]);
    included.push([ids.get(key), document === "+"]);
  }
  for (const [key, id] of ids) if (!seen.has(key)) warn(`Для ${id} нет строки базовой конфигурации. Услуга исключена из пакетов и включена в документ.`);
  standard.values = Object.fromEntries(values);
  standard.includedInDocument = Object.fromEntries(included);
}

function readIntros(page, base) {
  const names = new Map(packageCodes.map((code) => [keyText(code), code]));
  const introduction = (cell) => cellRich(cell, base);
  const rows = readTable(page, headers.intros, true);
  if (!rows) {
    const columns = readTable(page, headers.introColumns, true, true) ?? readTable(page, headers.introColumns);
    if (columns.length !== 1) throw new Error("Под заголовками трёх вариантов нужна одна строка вводных текстов.");
    return Object.fromEntries(packageCodes.map((code, index) => [code, introduction(columns[0][index])]));
  }
  const values = new Map();
  for (const [variant, text] of rows) {
    const code = names.get(headerText(variant));
    if (!code || values.has(code)) throw new Error("В таблице вводных текстов найден неизвестный или повторный вариант.");
    values.set(code, introduction(text));
  }
  if (values.size !== packageCodes.length) throw new Error("В таблице нужны все три варианта поддержки.");
  return Object.fromEntries(values);
}

function readSla(page) {
  const codes = new Map(OPTIONS.map(({ code }) => [keyText(code), code]));
  const pairs = new Set();
  const rows = readTable(page, headers.sla).map(([codeCell, supportCell, ...metrics]) => {
    const code = cellText(codeCell);
    const support = codes.get(headerText(supportCell));
    if (!SLA_CODES.includes(code)) throw new Error(`Код критичности «${code}» недопустим для базовой матрицы SLA.`);
    if (!support) throw new Error(`Неизвестный уровень поддержки «${cellText(supportCell)}».`);
    const key = code + "|" + support;
    if (pairs.has(key)) throw new Error(`Повтор сочетания ${code} и ${support}.`);
    pairs.add(key);
    const blocks = metrics.map((cell) => cellRich(cell));
    const missing = blocks.findIndex((value) => !hasRichText(value));
    if (missing >= 0) throw new Error(`Показатель «${SLA_METRICS[missing]}» пуст для ${code} и ${support}.`);
    return { code, support, values: blocks.map(plainText) };
  });
  for (const code of SLA_CODES) for (const support of codes.values()) {
    if (!pairs.has(code + "|" + support)) throw new Error(`Отсутствует сочетание ${code} и ${support}.`);
  }
  return rows;
}

function readSeverity(page, base) {
  const seen = new Set();
  const rows = readTable(page, headers.severity)
    .map(([codeCell, nameCell, shortCell, fullCell]) => {
      const code = cellText(codeCell);
      if (!SEVERITY_CODES.includes(code)) throw new Error(`Неизвестный код критичности «${code}».`);
      if (seen.has(code)) throw new Error(`Повтор кода критичности ${code}.`);
      seen.add(code);
      const name = cellText(nameCell);
      const description = cellRich(fullCell, base);
      if (!name || !hasRichText(description)) throw new Error(`Для кода ${code} требуется наименование и полное описание.`);
      return { code, name, short: cellRich(shortCell, base), description };
    });
  const missing = SEVERITY_CODES.filter((code) => !seen.has(code));
  if (missing.length) throw new Error(`В справочнике отсутствуют коды ${missing.join(", ")}.`);
  return rows;
}

function readAssumptions(page, base) {
  const rows = readTable(page, headers.assumptions).map(([section, text]) => {
    const category = ["Допущения", "Ограничения"].find((name) => keyText(name) === headerText(section));
    const wording = cellRich(text, base);
    if (!category) throw new Error(`Неизвестный подраздел «${cellText(section)}».`);
    if (!hasRichText(wording)) throw new Error(`Пустая формулировка в подразделе «${category}».`);
    return { category, wording };
  });
  if (!rows.length) throw new Error("Таблица не содержит формулировок.");
  return rows;
}

function readGlossary(page, base) {
  const rows = readTable(page, headers.glossary).map(([ru, eng, text]) => {
    const term = cellText(ru);
    const definition = cellRich(text, base);
    if (!term || !hasRichText(definition)) throw new Error("Нужны русский термин и его определение.");
    return { term, english: cellText(eng), definition };
  });
  if (!rows.length) throw new Error("Таблица не содержит терминов.");
  return rows;
}

const hasHeaders = (page, header, exact) => !matchingTables(page, header, exact).next().done;

function identifyPage(storage) {
  if (typeof storage !== "string" || !storage.trim() || XML_INVALID.test(storage)) {
    throw new Error("Отсутствует корректное body.storage.value. Нужна выгрузка с содержимым страниц.");
  }
  const root = parseDocument(storage, { recognizeCDATA: true, recognizeSelfClosing: true });
  const tables = Array.from(tableRows(root), (rows) => ({ rows, names: rows.map((row) => row.map(headerText)) }));
  const page = { tables };
  const types = [];
  if (hasServiceProperties(root)) types.push("catalog");
  if (hasHeaders(page, headers.defaults)) types.push("defaults");
  if (hasHeaders(page, headers.intros) || hasHeaders(page, headers.introColumns, true)) types.push("intros");
  if (hasHeaders(page, headers.sla) || hasHeaders(page, headers.severity)) types.push("sla");
  if (hasHeaders(page, headers.assumptions)) types.push("assumptions");
  if (hasHeaders(page, headers.glossary)) types.push("glossary");
  return { types, tables };
}

function labelHints(page, labels) {
  const container = page.metadata?.labels;
  const entries = container?.results ?? container;
  const complete = Array.isArray(entries) && !container?._links?.next && !(container?.totalSize > entries.length);
  const hints = complete ? [...new Set(entries.map((label) =>
    labels.get(typeof label === "string" ? label : label?.name)).filter(Boolean))].sort() : [];
  return { hints, complete };
}

function normalizeRest(results, sources) {
  const labels = new Map(SOURCE_TYPES.filter(([key]) => sources.labels[key]).map(([key]) => [sources.labels[key], key]));
  const sourcesByType = new Map([...SUPPORTED].map((key) => [key, []]));
  const byId = new Map();
  const issues = [];
  for (const raw of results) {
    const page = raw?.content ?? raw;
    const id = String(page?.id ?? "");
    const title = typeof page?.title === "string" ? page.title : "";
    if (!/^\d+$/.test(id)) throw new Error("В результатах REST отсутствует корректный ID страницы.");
    const storage = page.body?.storage?.value;
    const data = { pageId: id, title, storage, ...labelHints(page, labels) };
    const previous = byId.get(id);
    if (previous) {
      if (previous.storage !== data.storage || previous.title !== data.title ||
          (previous.complete && data.complete && previous.hints.join() !== data.hints.join())) {
        throw new Error("Один ID страницы присутствует с разным содержимым.");
      }
      if (!previous.complete && data.complete) byId.set(id, data);
      issues.push({ level: "warning", page_id: id, title, message: "Повтор страницы пропущен. Если каталог менялся во время выгрузки, повторите её." });
      continue;
    }
    byId.set(id, data);
  }
  for (const page of byId.values()) {
    const issue = (level, message) => issues.push({ level, page_id: page.pageId, title: page.title, message });
    let shape;
    try {
      shape = identifyPage(page.storage);
    } catch (failure) {
      if (page.hints.length === 1 && sourcesByType.has(page.hints[0])) {
        sourcesByType.get(page.hints[0]).push(page);
      } else if (page.hints[0] !== "raci" || page.hints.length > 1) {
        issue("error", failure instanceof RangeError ? "Слишком глубокая вложенность разметки страницы." : failure.message);
      }
      continue;
    }
    const { types, tables } = shape;
    const compatible = types.length ? types.filter((type) => page.hints.includes(type)) : page.hints;
    if ((types.length > 1 && compatible.length !== 1) || (!types.length && compatible.length > 1)) {
      const candidates = (types.length ? types : compatible).map((type) => sourceNames.get(type)).join(", ");
      issue("error", `Тип источника неоднозначен. ${types.length ? "Найдены структуры" : "Найдены настроенные метки"}: ${candidates}.`);
      continue;
    }
    const type = types.length === 1 ? types[0] : compatible[0];
    if (types.length === 1 && page.hints.some((hint) => hint !== type)) {
      issue("warning", `Настроенные метки не соответствуют содержимому. Распознан источник «${sourceNames.get(type)}».`);
    }
    if (sourcesByType.has(type)) sourcesByType.get(type).push(type === "catalog" ? page : { ...page, tables });
    else if (type !== "raci") issue("warning", "Тип источника не распознан по полям Page Properties или заголовкам таблиц.");
  }
  const catalog = loadCatalog({ schemaVersion: 1, pages: sourcesByType.get("catalog") }, sources.base);
  const standard = initialDefaults();
  const ids = new Map(catalog.services.map(({ id }) => [id.toLowerCase(), id]));
  function readSource(key, read, section, header) {
    const candidates = sourcesByType.get(key);
    const matching = header ? candidates.filter((page) => page.tables && hasHeaders(page, header)) : [];
    const pages = matching.length ? matching : candidates;
    const name = sourceNames.get(key);
    const labeled = pages.filter(({ hints }) => hints.length === 1 && hints[0] === key);
    const page = pages.length === 1 ? pages[0] : labeled.length === 1 && pages.every((item) => item.complete) ? labeled[0] : null;
    const issue = (level, message) => issues.push({
      level, page_id: page?.pageId, title: page?.title, message: [name, section, message].filter(Boolean).join(". "),
    });
    if (!page) {
      const error = pages.length
        ? `Источник неоднозначен. Подходящие страницы: ${pages.map(({ pageId, title }) => title ? `${pageId} «${title}»` : pageId).join(", ")}. Оставьте в выгрузке нужную страницу или уточните источник меткой.`
        : "Страница источника не найдена в JSON.";
      if (pages.length || sources.labels[key] || key === "defaults") issue(pages.length ? "error" : "warning", error);
      return { error };
    }
    try {
      return { data: read(page, (message) => issue("warning", message)) };
    } catch (failure) {
      issue("error", failure.message);
      return { error: failure.message };
    }
  }
  const defaults = readSource("defaults", (page, warn) => readStandard(page, ids, standard, warn));
  const sections = {
    intro: readSource("intros", (page) => readIntros(page, sources.base)),
    sla: readSource("sla", readSla, SECTION_LABELS.sla, headers.sla),
    severity: readSource("sla", (page) => readSeverity(page, sources.base), SECTION_LABELS.severity, headers.severity),
    assumptions: readSource("assumptions", (page) => readAssumptions(page, sources.base)),
    glossary: readSource("glossary", (page) => readGlossary(page, sources.base)),
  };
  return { ...catalog, issues: [...catalog.issues, ...issues], base: sources.base, standard, sections, usableStandard: !defaults.error, legacy: false };
}
