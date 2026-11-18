import { XML_INVALID } from "./catalog.js";
import { BUILTIN_DEFAULTS, buildServiceRows, DEFAULT_OPTION, defaultSelection, OPTIONS } from "./proposal.js";
import { documentOptions } from "./document-sections.js";

const FORMAT = "support-services-builder-defaults";
export const LEGACY_STORAGE_KEY = typeof __SSB_STORAGE_PREFIX__ === "string" && __SSB_STORAGE_PREFIX__
  ? __SSB_STORAGE_PREFIX__ + FORMAT + ":v1" : FORMAT + ":v1";
export const STORAGE_KEY = typeof __SSB_STORAGE_PREFIX__ === "string" && __SSB_STORAGE_PREFIX__
  ? __SSB_STORAGE_PREFIX__ + FORMAT + ":v2" : FORMAT + ":v2";
export const DEFAULTS_FILENAME = "ssb-defaults.json";
export const TEMPLATE_STORAGE_KEY = (typeof __SSB_STORAGE_PREFIX__ === "string" ? __SSB_STORAGE_PREFIX__ : "") + FORMAT + ":v3";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function initialDefaults(values = BUILTIN_DEFAULTS) {
  return {
    values, includedInDocument: {},
  };
}

export function overlayDefaults(standard, local) {
  if (!local) return standard;
  return {
    values: { ...standard.values, ...local.values },
    includedInDocument: { ...standard.includedInDocument, ...local.includedInDocument },
  };
}

export function defaultDifferences(standard, local, services) {
  if (!local) return [];
  return services.filter(({ id }) => OPTIONS.some(({ code }) =>
    Object.hasOwn(local.values, id) && local.values[id][code] !== (standard.values[id]?.[code] ?? "-")) ||
    Object.hasOwn(local.includedInDocument, id) && local.includedInDocument[id] !== (standard.includedInDocument[id] ?? true))
    .map(({ id }) => id);
}

export function snapshotDefaults(previous, rows) {
  const loaded = rows.map(({ id, values }) => [
    id, Object.fromEntries(OPTIONS.map(({ code }, index) => [code, values[index]])),
  ]);
  return {
    values: { ...previous.values, ...Object.fromEntries(loaded) },
    includedInDocument: { ...previous.includedInDocument, ...Object.fromEntries(
      rows.map(({ id, includedInDocument }) => [id, includedInDocument]),
    ) },
  };
}

export function serializeDefaults(settings) {
  return JSON.stringify({ format: FORMAT, schemaVersion: 2, ...settings }, null, 2);
}

export function parseDefaults(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Файл настроек должен содержать корректный JSON.");
  }
  if (data?.format !== FORMAT || ![1, 2].includes(data.schemaVersion) || !isRecord(data.values)) {
    throw new Error("Выберите файл настроек пакетов, скачанный из конструктора.");
  }
  const entries = Object.entries(data.values).map(([id, variants]) => {
    if (!id || /\s/.test(id) || XML_INVALID.test(id) || !isRecord(variants)) {
      throw new Error("В файле настроек указан некорректный ID услуги или состав пакетов.");
    }
    const values = OPTIONS.map(({ code }) => {
      const value = variants[code];
      if (!Object.hasOwn(variants, code) || typeof value !== "string" || XML_INVALID.test(value) ||
          !value.trim() || (value.trim() === "-" && value !== "-")) {
        throw new Error(`Некорректное значение пакета «${code}» для услуги ${id}.`);
      }
      return [code, value.replace(/\r\n?/g, "\n")];
    });
    return [id, Object.fromEntries(values)];
  });
  const settings = initialDefaults(Object.fromEntries(entries));
  if (data.schemaVersion === 1) return settings;
  if (data.includedInDocument !== undefined) {
    if (!isRecord(data.includedInDocument)) throw new Error("Некорректные признаки включения в документ.");
    const flags = Object.entries(data.includedInDocument);
    if (flags.some(([id, flag]) => !id || /\s/.test(id) || XML_INVALID.test(id) || typeof flag !== "boolean")) {
      throw new Error("Некорректные признаки включения в документ.");
    }
    settings.includedInDocument = Object.fromEntries(flags);
  }
  return settings;
}

export function readDefaults(storage) {
  const saved = storage.getItem(STORAGE_KEY) ?? storage.getItem(LEGACY_STORAGE_KEY);
  return saved === null ? null : parseDefaults(saved);
}

export function writeDefaults(storage, settings) {
  const text = serializeDefaults(settings);
  storage.setItem(STORAGE_KEY, text);
  if (storage.getItem(STORAGE_KEY) !== text) throw new Error("Запись в хранилище браузера не подтверждена.");
}

export function templateFromDefaults(settings) {
  return { ...settings, selected: DEFAULT_OPTION, documentOptions: documentOptions(), excludedParameters: {} };
}

export function parseTemplate(text) {
  const data = JSON.parse(text);
  if (data?.schemaVersion !== 3) return templateFromDefaults(parseDefaults(text));
  const settings = parseDefaults(JSON.stringify({ ...data, schemaVersion: 2 }));
  if (!OPTIONS.some(({ code }) => code === data.selected) || !isRecord(data.documentOptions) || !isRecord(data.excludedParameters)) {
    throw new Error("Не удалось прочитать настройки моего шаблона.");
  }
  const excludedParameters = Object.fromEntries(Object.entries(data.excludedParameters).map(([id, variants]) => {
    if (!Object.hasOwn(settings.values, id) || !isRecord(variants)) throw new Error("Некорректные параметры моего шаблона.");
    const entries = Object.entries(variants).map(([code, parameter]) => {
      if (!OPTIONS.some((option) => option.code === code) || settings.values[id][code] !== "-" ||
          typeof parameter !== "string" || XML_INVALID.test(parameter)) throw new Error("Некорректные параметры моего шаблона.");
      return [code, parameter.replace(/\r\n?/g, "\n")];
    });
    return [id, Object.fromEntries(entries)];
  }));
  return { ...settings, selected: data.selected, documentOptions: documentOptions(data.documentOptions), excludedParameters };
}

export function readTemplate(storage) {
  const current = storage.getItem(TEMPLATE_STORAGE_KEY);
  if (current !== null) return parseTemplate(current);
  const previous = readDefaults(storage);
  return previous ? templateFromDefaults(previous) : null;
}

export function writeTemplate(storage, template) {
  const normalized = parseTemplate(JSON.stringify({ ...template, format: FORMAT, schemaVersion: 3 }));
  const text = JSON.stringify({ format: FORMAT, schemaVersion: 3, ...normalized });
  storage.setItem(TEMPLATE_STORAGE_KEY, text);
  if (storage.getItem(TEMPLATE_STORAGE_KEY) !== text) throw new Error("Браузер не подтвердил сохранение моего шаблона.");
}

export function captureTemplate(services, settings, selected, document) {
  if (!OPTIONS.some(({ code }) => code === selected)) throw new Error("Выберите вариант поддержки.");
  const rows = buildServiceRows(services, settings);
  const excludedParameters = new Map();
  for (const { id } of services) {
    const entries = OPTIONS.flatMap(({ code }) => {
      const setting = settings.overrides?.get(id)?.get(code) ?? defaultSelection(id, code, settings.defaults);
      return !setting.included && setting.parameter ? [[code, setting.parameter.replace(/\r\n?/g, "\n")]] : [];
    });
    if (entries.length) excludedParameters.set(id, Object.fromEntries(entries));
  }
  return { ...snapshotDefaults(initialDefaults({}), rows), selected, documentOptions: documentOptions(document), excludedParameters: Object.fromEntries(excludedParameters) };
}

export function templateServiceSettings(standard, template, services) {
  const defaults = overlayDefaults(standard, template);
  const overrides = new Map();
  for (const { id } of services) {
    const entries = Object.entries(template?.excludedParameters?.[id] ?? {}).map(([code, parameter]) => [code, { included: false, parameter }]);
    if (entries.length) overrides.set(id, new Map(entries));
  }
  return { defaults: defaults.values, documentDefaults: defaults.includedInDocument, overrides, documentOverrides: new Map() };
}
