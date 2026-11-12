import presets from "../config/presets.json" with { type: "json" };
import { XML_INVALID } from "./catalog.js";
import { buildDocumentSections, supportHeading } from "./document-sections.js";
import { withoutSourceLinks } from "./rich-text.js";

export const OPTIONS = presets.options;
export const DEFAULT_OPTION = presets.default_option;
export const DEFAULT_TITLE = "Предложение по техническому сопровождению";
export const CONDITIONS_TITLE = "Условия предоставления";
export const BUILTIN_DEFAULTS = presets.values;
export const COMPARISON_HEADERS = [
  "ID услуги", "Наименование услуги",
  ...OPTIONS.map((option) => supportHeading(option)),
];

export function defaultSelection(id, code, defaults = BUILTIN_DEFAULTS) {
  const value = Object.hasOwn(defaults, id) ? defaults[id][code] ?? "-" : "-";
  return { included: value !== "-", parameter: ["+", "-"].includes(value) ? "" : value };
}

function textInput(value, label, singleLine = false) {
  if (typeof value !== "string" || XML_INVALID.test(value)) {
    throw new Error(`Поле «${label}» содержит недопустимое значение.`);
  }
  const normalized = value.replace(/\r\n?/g, "\n");
  if (singleLine && (normalized.includes("\n") || normalized.length > 180)) {
    throw new Error(`Поле «${label}» должно содержать до 180 символов в одной строке.`);
  }
  return normalized;
}

export function isIncludedInDocument(id, defaults, overrides) {
  return overrides?.get(id) ?? (Object.hasOwn(defaults, id) ? defaults[id] : true);
}

export function buildServiceRows(services, {
  overrides = new Map(), defaults = BUILTIN_DEFAULTS, documentDefaults = {}, documentOverrides = new Map(),
  forExport = false,
} = {}) {
  const included = (id) => isIncludedInDocument(id, documentDefaults, documentOverrides);
  const source = forExport ? services.filter(({ id }) => included(id)) : services;
  return source.map(({ id, name, description, conditions }) => ({
    id, name, description, conditions, includedInDocument: included(id),
    values: OPTIONS.map(({ code }) => {
      const { included, parameter } = overrides.get(id)?.get(code) ?? defaultSelection(id, code, defaults);
      if (typeof included !== "boolean") throw new Error(`Некорректное состояние услуги ${id} в варианте ${code}.`);
      const text = textInput(parameter, "Параметр услуги");
      if (included && text.trim() === "-") throw new Error(`Чтобы исключить ${id} из ${code}, снимите отметку «Включена».`);
      return included ? (text.trim() ? text : "+") : "-";
    }),
  }));
}

export function buildProposal(services, {
  title = "", client = "", selected, sections = {}, document, confluenceBases = [], ...settings
}) {
  if (!services.length) throw new Error("Загрузите каталог с корректными карточками услуг.");
  const titleText = textInput(title, "Название предложения", true).trim() || DEFAULT_TITLE;
  const clientText = textInput(client, "Клиент", true).trim();
  const selectedIndex = OPTIONS.findIndex(({ code }) => code === selected);
  if (selectedIndex < 0) throw new Error("Выберите один вариант поддержки.");
  return {
    title: titleText, clientLine: clientText ? `Клиент — ${clientText}` : "", selectedIndex,
    rows: buildServiceRows(services, { ...settings, forExport: true }).map((row) => ({
      ...row, description: withoutSourceLinks(row.description, confluenceBases),
      conditions: withoutSourceLinks(row.conditions, confluenceBases),
    })),
    sections: buildDocumentSections(sections, document, selected, OPTIONS, confluenceBases),
  };
}
