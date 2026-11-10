import { XML_INVALID } from "./catalog.js";
import { emptyIntroduction, introductionFor, validateIntroduction } from "./introductions.js";
import { BUILTIN_DEFAULTS, OPTIONS } from "./proposal.js";

const FORMAT = "support-services-builder-defaults";
export const LEGACY_STORAGE_KEY = FORMAT + ":v1";
export const STORAGE_KEY = FORMAT + ":v2";
export const DEFAULTS_FILENAME = "ssb-defaults.json";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function initialDefaults(values = BUILTIN_DEFAULTS) {
  return {
    values, includedInDocument: {},
    introductions: Object.fromEntries(OPTIONS.map(({ code }) => [code, emptyIntroduction()])),
  };
}

export function overlayDefaults(standard, local) {
  if (!local) return standard;
  return {
    values: { ...standard.values, ...local.values },
    includedInDocument: { ...standard.includedInDocument, ...local.includedInDocument },
    introductions: { ...standard.introductions, ...local.introductions },
  };
}

export function defaultDifferences(standard, local, services) {
  if (!local) return [];
  const differences = services.filter(({ id }) => OPTIONS.some(({ code }) =>
    Object.hasOwn(local.values, id) && local.values[id][code] !== (standard.values[id]?.[code] ?? "-")) ||
    Object.hasOwn(local.includedInDocument, id) && local.includedInDocument[id] !== (standard.includedInDocument[id] ?? true))
    .map(({ id }) => id);
  for (const { code } of OPTIONS) {
    if (JSON.stringify(standard.introductions[code]) !== JSON.stringify(local.introductions[code])) differences.push(`Вводный текст ${code}`);
  }
  return differences;
}

export function snapshotDefaults(previous, rows, introductions) {
  const loaded = rows.map(({ id, values }) => [
    id, Object.fromEntries(OPTIONS.map(({ code }, index) => [code, values[index]])),
  ]);
  return {
    values: { ...previous.values, ...Object.fromEntries(loaded) },
    includedInDocument: { ...previous.includedInDocument, ...Object.fromEntries(
      rows.map(({ id, includedInDocument }) => [id, includedInDocument]),
    ) },
    introductions: Object.fromEntries(OPTIONS.map(({ code }) => [
      code, validateIntroduction(introductionFor(introductions, code)),
    ])),
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
  if (data.introductions !== undefined) {
    if (!isRecord(data.introductions)) throw new Error("Некорректные вводные тексты пакетов.");
    settings.introductions = Object.fromEntries(OPTIONS.map(({ code }) => [
      code, validateIntroduction(introductionFor(data.introductions, code)),
    ]));
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
