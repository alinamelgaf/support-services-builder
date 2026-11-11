import { MAX_BYTES } from "./catalog.js";
import { createImportBatch, queryUrl, SOURCE_KEY, SOURCE_TYPES, validateSources } from "./confluence.js";
import { buildProposal, buildServiceRows, DEFAULT_OPTION, defaultSelection, isIncludedInDocument, OPTIONS } from "./proposal.js";
import {
  DEFAULTS_FILENAME, defaultDifferences, initialDefaults, overlayDefaults, parseDefaults, readDefaults, serializeDefaults, snapshotDefaults, writeDefaults,
} from "./package-defaults.js";
import { documentOptions, sectionReason, SECTION_LABELS } from "./document-sections.js";
import { renderRich } from "./rich-dom.js";
import { generateExcel } from "./excel.js";
import { generateWord } from "./word.js";
import { enablePwa } from "./pwa.js";
import { createDraftAutosave, openDraftStore } from "./draft.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  selected: DEFAULT_OPTION,
  services: [],
  overrides: new Map(),
  documentOverrides: new Map(),
  defaults: initialDefaults(),
  standard: initialDefaults(),
  hasStandard: false,
  local: null,
  layer: "corporate",
  base: "",
  conflict: false,
  catalog: null,
  sections: {},
  documentOptions: documentOptions(),
  busy: false,
};
const batch = createImportBatch();
let sources = validateSources();
let draft;
let draftUnavailable = false;
let draftTouched = false;
let defaultsUnsaved = false;
let sourcesUnsaved = false;
const downloads = [...document.querySelectorAll("[data-format]")];
const slaModes = [...document.querySelectorAll('input[name="sla-mode"]')];

function renderDocumentOptions() {
  for (const key of Object.keys(SECTION_LABELS)) {
    const reason = sectionReason(key, state.sections, state.selected);
    const checkbox = $(`#include-${key}`);
    checkbox.disabled = state.busy || Boolean(reason);
    checkbox.checked = !reason && state.documentOptions.included[key];
    $(`#reason-${key}`).textContent = reason;
  }
  for (const radio of slaModes) {
    radio.disabled = $("#include-sla").disabled || !$("#include-sla").checked;
    radio.checked = radio.value === state.documentOptions.slaMode;
  }
}

for (const key of Object.keys(SECTION_LABELS)) {
  $(`#include-${key}`).addEventListener("change", (event) => {
    state.documentOptions.included[key] = event.target.checked;
    renderDocumentOptions();
    draftChanged();
  });
}
for (const radio of slaModes) {
  radio.addEventListener("change", () => {
    state.documentOptions.slaMode = radio.value;
    draftChanged();
  });
}

function node(tag, text = "", className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function notice(selector, message, error = false) {
  const box = $(selector);
  box.textContent = message;
  box.classList.toggle("error", error);
  box.hidden = !message;
}

function hasDraftChanges() {
  return state.overrides.size || state.documentOverrides.size;
}

function draftChanged() {
  notice("#export-notice", "");
  draftTouched = true;
  draft?.change();
}

function setBusy(busy) {
  state.busy = busy;
  $("#upload").disabled = $("#catalog-file").disabled = busy;
  $("#reset").disabled = busy || !state.local;
  $("#apply-standard").disabled = busy || !state.hasStandard;
  $("#save-defaults").disabled = busy || !state.services.length;
  $("#import-defaults").disabled = $("#defaults-file").disabled = busy;
  $("#export-defaults").disabled = busy || !state.local;
  $("#save-sources").disabled = $("#reset-batch").disabled = busy;
  for (const button of downloads) button.disabled = busy || !state.services.length;
  renderDocumentOptions();
}

function renderOptions() {
  for (const { code, name } of OPTIONS) {
    const radio = node("input");
    radio.type = "radio";
    radio.name = "proposal-variant";
    radio.value = code;
    radio.checked = code === state.selected;
    radio.addEventListener("change", () => {
      state.selected = code;
      renderDocumentOptions();
      markSelected();
      draftChanged();
    });
    const label = node("label", "", "variant");
    const text = node("span");
    text.append(node("strong", code), node("small", name));
    label.append(radio, text);
    $("#variants").append(label);

    const header = node("th");
    header.scope = "col";
    header.dataset.variant = code;
    header.append(node("span", "", "proposal-marker"), node("strong", code), node("small", name));
    $("#columns").append(header);
  }
  markSelected();
}

function markSelected() {
  for (const cell of document.querySelectorAll("[data-variant]")) {
    const selected = cell.dataset.variant === state.selected;
    cell.classList.toggle("selected", selected);
    const marker = cell.querySelector(".proposal-marker");
    if (marker) marker.textContent = selected ? "Предложение" : "";
  }
}

function showDetails(service) {
  $("#detail-id").textContent = service.id;
  $("#service-heading").textContent = service.name;
  $("#detail-description").replaceChildren(renderRich(service.description));
  $("#detail-conditions").replaceChildren(service.conditions.length ? renderRich(service.conditions) : "Условия отсутствуют");
  $("#detail-base").replaceChildren(service.base_service.length ? renderRich(service.base_service) : "Основная услуга не указана");
  const source = $("#detail-source");
  source.hidden = !service.source;
  if (service.source) source.href = service.source;
  else source.removeAttribute("href");
  $("#service-dialog").showModal();
}

function setting(service, code) {
  const original = defaultSelection(service.id, code, state.defaults.values);
  const current = state.overrides.get(service.id)?.get(code) ?? original;
  const cell = node("td", "", "setting");
  cell.dataset.variant = code;
  const label = node("label");
  const input = node("input");
  input.type = "checkbox";
  input.checked = current.included;
  input.setAttribute("aria-label", `Включена ${service.id} в ${code}`);
  const caption = node("span", current.included ? "Включена" : "Исключена");
  label.append(input, caption);
  const parameter = node("textarea");
  parameter.rows = 1;
  parameter.placeholder = "Параметр";
  parameter.value = current.parameter;
  parameter.disabled = !input.checked;
  parameter.setAttribute("aria-invalid", String(input.checked && parameter.value.trim() === "-"));
  parameter.setAttribute("aria-label", `Параметр ${service.id} в ${code}`);
  const update = () => {
    caption.textContent = input.checked ? "Включена" : "Исключена";
    parameter.disabled = !input.checked;
    parameter.setAttribute("aria-invalid", String(input.checked && parameter.value.trim() === "-"));
    const edits = state.overrides.get(service.id) ?? new Map();
    if (input.checked === original.included && parameter.value === original.parameter) edits.delete(code);
    else edits.set(code, { included: input.checked, parameter: parameter.value });
    if (edits.size) state.overrides.set(service.id, edits);
    else state.overrides.delete(service.id);
    draftChanged();
  };
  input.addEventListener("change", update);
  parameter.addEventListener("input", update);
  cell.append(label, parameter);
  return cell;
}

function documentSetting(service, row) {
  const cell = node("td", "", "document-setting");
  const label = node("label");
  const input = node("input");
  const caption = node("span");
  input.type = "checkbox";
  input.setAttribute("aria-label", `Включить в документ ${service.id}`);
  const baseline = isIncludedInDocument(service.id, state.defaults.includedInDocument);
  input.checked = isIncludedInDocument(service.id, state.defaults.includedInDocument, state.documentOverrides);
  function render() {
    caption.textContent = input.checked ? "Включена" : "Исключена";
    row.classList.toggle("excluded", !input.checked);
  }
  input.addEventListener("change", () => {
    if (input.checked === baseline) state.documentOverrides.delete(service.id);
    else state.documentOverrides.set(service.id, input.checked);
    render();
    draftChanged();
  });
  render();
  label.append(input, caption);
  cell.append(label);
  return cell;
}

function renderServices() {
  const rows = document.createDocumentFragment();
  for (const service of state.services) {
    const row = node("tr");
    const id = node("th", service.id, "service-id");
    id.scope = "row";
    const name = node("td");
    const detail = node("button", "Описание и условия", "button detail-button");
    detail.type = "button";
    detail.setAttribute("aria-label", `Описание и условия ${service.id}`);
    detail.addEventListener("click", () => showDetails(service));
    name.append(node("span", service.name, "service-name"), detail);
    row.append(id, name, documentSetting(service, row), ...OPTIONS.map(({ code }) => setting(service, code)));
    rows.append(row);
  }
  $("#services").replaceChildren(rows);
  $("#table-wrap").hidden = !state.services.length;
  $("#scroll-hint").hidden = !state.services.length;
  $("#empty").hidden = Boolean(state.services.length);
  markSelected();
}

function renderIssues(issues) {
  const errors = issues.filter(({ level }) => level === "error").length;
  $("#issues").hidden = !issues.length;
  $("#issues").open = errors > 0;
  $("#issues-summary").textContent = `Ошибок ${errors} · Предупреждений ${issues.length - errors}`;
  const list = document.createDocumentFragment();
  for (const { level, message, page_id, title } of issues) {
    const subject = [page_id ? `Страница ${page_id}` : "", title].filter(Boolean).join(" · ");
    list.append(node("li", subject ? `${subject}. ${message}` : message, level));
  }
  $("#issue-list").replaceChildren(list);
  return errors;
}

async function importCatalog(files) {
  if (!files.length || state.busy) return;
  setBusy(true);
  notice("#catalog-notice", "Проверяем каталог…");
  notice("#export-notice", "");
  try {
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) throw new Error("Выберите не более 64 МБ JSON за один раз.");
    const payloads = [];
    for (const file of files) {
      try { payloads.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()))); }
      catch { throw new Error(`Не удалось прочитать «${file.name}» как JSON в UTF-8.`); }
    }
    const pending = batch.add(payloads, sources);
    $("#reset-batch").hidden = pending.complete;
    if (!pending.complete) {
      notice("#catalog-notice", `Неполная выгрузка REST. Получено записей: ${pending.count}${pending.total === undefined ? "" : ` из ${pending.total}`}. Загрузите остальные страницы JSON. Рабочий каталог пока не заменён.`, true);
      return;
    }
    const result = pending.data;
    const errors = renderIssues(result.issues);
    if (!result.services.length) throw new Error("В выбранном файле нет корректных карточек услуг.");
    const dirty = Boolean(hasDraftChanges());
    const initial = !state.services.length;
    const next = result.usableStandard || !state.hasStandard ? result.standard : state.standard;
    state.hasStandard ||= result.usableStandard;
    state.standard = next;
    state.base = result.base;
    state.services = result.services;
    state.sections = result.sections;
    const conflicts = result.usableStandard ? defaultDifferences(next, state.local, state.services) : [];
    state.conflict = dirty || conflicts.length > 0;
    if (dirty) {
      state.defaults = overlayDefaults(next, state.defaults);
      renderServices();
    } else {
      if (initial && state.local) state.layer = "local";
      state.defaults = overlayDefaults(next, state.layer === "local" ? state.local : null);
      clearDraft();
    }
    const kind = result.legacy ? "прежний формат каталога" : "страницы REST объединены";
    const catalogMessage = errors
      ? "Есть ошибки импорта. Проверьте список ниже. Некорректные дополнительные разделы недоступны."
      : !result.usableStandard ? "Эта загрузка не содержит полного стандарта. Проверьте источники перед использованием настроек Confluence." : "";
    state.catalog = {
      issues: result.issues, summary: `Услуг загружено ${state.services.length} из ${result.pages} карточек · ${kind}`,
      message: catalogMessage, error: Boolean(errors || !result.usableStandard),
    };
    $("#catalog-summary").textContent = state.catalog.summary;
    notice("#catalog-notice", state.catalog.message, state.catalog.error);
    showLayer();
    notice("#conflict-notice", [
      dirty ? "Сохранены текущие правки предложения. Проверьте их перед применением нового стандарта." : "",
      conflicts.length ? `Локальные настройки отличаются от стандарта: ${conflicts.slice(0, 8).join(", ")}${conflicts.length > 8 ? ` и ещё ${conflicts.length - 8}` : ""}. Выберите, какой слой применить.` : "",
    ].filter(Boolean).join(" "), state.conflict);
    draftChanged();
  } catch (error) {
    notice("#catalog-notice", error.message, true);
  } finally {
    $("#catalog-file").value = "";
    setBusy(false);
  }
}

function downloadFile(file, filename) {
  const url = URL.createObjectURL(file);
  const link = node("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearDraft() {
  state.overrides.clear();
  state.documentOverrides.clear();
  renderServices();
  notice("#export-notice", "");
}

function serviceSettings() {
  return {
    overrides: state.overrides, defaults: state.defaults.values,
    documentDefaults: state.defaults.includedInDocument, documentOverrides: state.documentOverrides,
  };
}

function applyDefaults(settings) {
  let saved = false;
  try {
    writeDefaults(window.localStorage, settings);
    saved = true;
  } catch {
    // Копия в памяти доступна для скачивания независимо от хранилища.
  }
  state.local = settings;
  defaultsUnsaved = !saved;
  applyLayer("local");
  notice("#defaults-notice", saved
    ? "Настройки по умолчанию сохранены в этом браузере. Для переноса можно скачать файл."
    : "Настройки применены в этой вкладке. Браузер не подтвердил сохранение. Скачайте файл настроек и загрузите его при следующем открытии.", !saved);
}

function showLayer() {
  $("#defaults-layer").textContent = state.layer === "local" ? "Основа предложения — локальные настройки с дополнениями из Confluence."
    : state.hasStandard ? "Основа предложения — стандарт Confluence." : "Полный стандарт Confluence пока не загружен.";
}

function applyLayer(layer) {
  state.layer = layer;
  state.defaults = overlayDefaults(state.standard, layer === "local" ? state.local : null);
  state.conflict = false;
  clearDraft();
  showLayer();
  notice("#conflict-notice", "");
  setBusy(state.busy);
  draftChanged();
}

function fixDefaults() {
  if (state.busy || !state.services.length) return;
  if (!window.confirm("Сохранить состав и параметры пакетов и включение услуг в документ по умолчанию? Ранее сохранённые настройки будут заменены.")) return;
  try {
    const rows = buildServiceRows(state.services, serviceSettings());
    applyDefaults(snapshotDefaults(state.local ?? initialDefaults(), rows));
  } catch (error) {
    notice("#defaults-notice", error.message, true);
  }
}

async function importDefaults(file) {
  if (!file || state.busy) return;
  setBusy(true);
  try {
    if (file.size > MAX_BYTES) throw new Error("Размер файла настроек превышает 64 МБ.");
    const settings = parseDefaults(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()));
    if (!window.confirm("Заменить локальные настройки настройками из файла? Текущие правки пакетов будут сброшены.")) return;
    applyDefaults(settings);
  } catch (error) {
    notice("#defaults-notice", error instanceof TypeError ? "Не удалось прочитать файл настроек в кодировке UTF-8." : error.message, true);
  } finally {
    $("#defaults-file").value = "";
    setBusy(false);
  }
}

async function exportProposal(format) {
  if (state.busy || !state.services.length) return;
  const invalid = $("#services tr:not(.excluded) [aria-invalid=true]");
  if (invalid) {
    invalid.focus();
    notice("#export-notice", "Чтобы исключить услугу, снимите отметку «Включена».", true);
    return;
  }
  const form = {
    client: $("#client").value,
    title: $("#title").value,
    selected: state.selected,
    ...serviceSettings(),
    sections: state.sections,
    document: state.documentOptions,
    confluenceBases: [state.base, sources.base],
  };
  const label = format === "excel" ? "Excel" : "Word";
  setBusy(true);
  notice("#export-notice", `Формируем ${label}…`);
  try {
    const proposal = buildProposal(state.services, form);
    const file = format === "excel"
      ? new Blob([await generateExcel(proposal)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
      : await generateWord(proposal);
    downloadFile(file, format === "excel" ? "ssb-proposal.xlsx" : "ssb-proposal.docx");
    notice("#export-notice", `Файл ${label} сформирован.`);
  } catch (error) {
    notice("#export-notice", error.message, true);
  } finally {
    setBusy(false);
  }
}

$("#upload").addEventListener("click", () => $("#catalog-file").click());
$("#catalog-file").addEventListener("change", (event) => importCatalog([...event.target.files]));
$("#close-dialog").addEventListener("click", () => $("#service-dialog").close());
$("#show-release-notes").addEventListener("click", () => $("#release-notes").showModal());
$("#close-release-notes").addEventListener("click", () => $("#release-notes").close());
$("#save-defaults").addEventListener("click", fixDefaults);
$("#export-defaults").addEventListener("click", () => downloadFile(
  new Blob([serializeDefaults(state.local)], { type: "application/json" }), DEFAULTS_FILENAME,
));
$("#import-defaults").addEventListener("click", () => $("#defaults-file").click());
$("#defaults-file").addEventListener("change", (event) => importDefaults(event.target.files[0]));
$("#reset").addEventListener("click", () => {
  if (!window.confirm("Восстановить локальные настройки? Текущие правки пакетов будут сброшены.")) return;
  applyLayer("local");
  notice("#defaults-notice", "Восстановлены локальные настройки менеджера.");
});
$("#apply-standard").addEventListener("click", () => {
  if (!window.confirm("Применить стандарт Confluence? Текущие правки пакетов будут сброшены. Сохранённые настройки менеджера останутся доступны.")) return;
  applyLayer("corporate");
  notice("#defaults-notice", "Применён стандарт Confluence.");
});
for (const button of downloads) {
  button.addEventListener("click", () => exportProposal(button.dataset.format));
}

try {
  const saved = readDefaults(window.localStorage);
  if (saved) {
    state.local = saved;
    state.defaults = saved;
    state.layer = "local";
    notice("#defaults-notice", "Восстановлены локальные настройки менеджера из этого браузера.");
  }
} catch {
  notice("#defaults-notice", "Не удалось прочитать настройки из хранилища браузера. Можно загрузить файл настроек.", true);
}
renderOptions();
showLayer();
setBusy(false);

function resetBatch() {
  batch.reset();
  $("#reset-batch").hidden = true;
  notice("#catalog-notice", "Ожидающие страницы очищены. Можно начать новую загрузку.");
}

function updateSourcesLink() {
  const href = queryUrl(sources);
  const link = $("#source-link");
  link.hidden = !href;
  if (href) link.href = href;
  else link.removeAttribute("href");
}

try {
  const saved = window.localStorage.getItem(SOURCE_KEY);
  if (saved) sources = validateSources(JSON.parse(saved));
} catch {
  notice("#sources-notice", "Не удалось восстановить локальные настройки источников.", true);
}
$("#source-base").value = sources.base;
$("#source-space").value = sources.space;
for (const [key, label] of SOURCE_TYPES) {
  const field = node("label", label);
  const input = node("input");
  input.id = `label-${key}`;
  input.autocomplete = "off";
  input.value = sources.labels[key];
  field.append(input);
  $("#source-labels").append(field);
}
updateSourcesLink();
$("#save-sources").addEventListener("click", () => {
  try {
    const next = validateSources({ base: $("#source-base").value, space: $("#source-space").value,
      labels: Object.fromEntries(SOURCE_TYPES.map(([key]) => [key, $(`#label-${key}`).value])), });
    if (JSON.stringify(next) !== JSON.stringify(sources)) {
      const pending = !$("#reset-batch").hidden;
      const configured = sources.base || sources.space || Object.values(sources.labels).some(Boolean);
      if ((pending || configured) && !window.confirm(pending
        ? "Изменить источники и сбросить ожидающие страницы REST?" : "Заменить сохранённые настройки источников Confluence?")) return;
      if (pending) resetBatch();
    }
    sources = next;
    updateSourcesLink();
    const text = JSON.stringify(sources);
    try {
      window.localStorage.setItem(SOURCE_KEY, text);
      if (window.localStorage.getItem(SOURCE_KEY) !== text) throw new Error();
      sourcesUnsaved = false;
      notice("#sources-notice", "Источники сохранены в этом браузере.");
    } catch {
      sourcesUnsaved = true;
      notice("#sources-notice", "Источники доступны в этой вкладке. Браузер не подтвердил сохранение между запусками.", true);
    }
  } catch (error) {
    notice("#sources-notice", error.message, true);
  }
});
$("#reset-batch").addEventListener("click", () => {
  if (window.confirm("Удалить ожидающие страницы и начать новую выгрузку?")) resetBatch();
});

function snapshotProposal() {
  const { selected, services, overrides, documentOverrides, defaults, standard, hasStandard, layer, base, catalog, conflict } = state;
  return {
    selected, services, overrides, documentOverrides, defaults, standard, hasStandard, layer, base, catalog, conflict,
    client: $("#client").value, title: $("#title").value, sections: state.sections, documentOptions: state.documentOptions,
    conflictText: $("#conflict-notice").textContent,
  };
}

function restoreProposal(saved) {
  const { selected, services, overrides, documentOverrides, defaults, standard, hasStandard, layer, base, catalog, conflict } = saved;
  if (!OPTIONS.some(({ code }) => code === selected) || !Array.isArray(services) ||
      !(overrides instanceof Map) || !(documentOverrides instanceof Map) || !defaults?.values || !standard?.values) {
    throw new Error("Сохранённый черновик не удалось прочитать.");
  }
  const packageSettings = ({ values, includedInDocument }) => ({ values, includedInDocument });
  const previousIntro = standard.introductions && Object.fromEntries(OPTIONS.map(({ code }) => [
    code, standard.introductions[code]?.blocks ?? [],
  ]));
  Object.assign(state, {
    selected, services, overrides, documentOverrides, defaults: packageSettings(defaults), standard: packageSettings(standard),
    hasStandard, layer, base, catalog, conflict, documentOptions: documentOptions(saved.documentOptions),
    sections: saved.sections ?? (previousIntro ? { intro: { data: previousIntro } } : {}),
  });
  $("#client").value = saved.client;
  $("#title").value = saved.title;
  for (const radio of document.querySelectorAll('input[name="proposal-variant"]')) radio.checked = radio.value === selected;
  renderServices();
  showLayer();
  if (catalog) {
    $("#catalog-summary").textContent = catalog.summary;
    renderIssues(catalog.issues);
    notice("#catalog-notice", catalog.message, catalog.error);
  }
  notice("#conflict-notice", saved.conflictText, conflict);
}

for (const field of ["#client", "#title"]) $(field).addEventListener("input", draftChanged);

function hasUnsavedWork() {
  return Boolean(draft?.unsaved || (draftUnavailable && draftTouched) || defaultsUnsaved || sourcesUnsaved);
}

async function startDraft() {
  const main = $("main");
  const draftStatus = (message, error) => notice("#draft-notice", message, error);
  main.inert = true;
  setBusy(true);
  try {
    const store = await openDraftStore(new URL(".", location.href).pathname);
    const saved = await store.load();
    if (saved) {
      restoreProposal(saved);
      draftStatus("Черновик восстановлен на этом устройстве.");
    }
    draft = createDraftAutosave(store, snapshotProposal, draftStatus);
  } catch {
    draftUnavailable = true;
    draftStatus("Хранилище черновиков недоступно. Правки в этой вкладке могут пропасть после закрытия.", true);
  } finally {
    main.inert = false;
    setBusy(false);
  }
}

window.addEventListener("beforeunload", (event) => {
  if (!hasUnsavedWork()) return;
  event.preventDefault();
  event.returnValue = "";
});

void startDraft();
enablePwa({
  saveDraft: async () => (await (draft?.flush() ?? true)) && !hasUnsavedWork(),
  hasPendingImport: () => !$("#reset-batch").hidden,
  isBusy: () => state.busy,
});

if (typeof __SSB_STORAGE_PREFIX__ === "string" && __SSB_STORAGE_PREFIX__) {
  window.addEventListener("ssb-dev-refresh", async (event) => {
    const respond = event.detail;
    if (typeof respond !== "function") return;
    if (state.busy) return respond("Дождитесь завершения импорта или экспорта.");
    if (!$("#reset-batch").hidden) return respond("Завершите импорт всех страниц JSON или очистите ожидающие страницы.");
    if (!await (draft?.flush() ?? true) || hasUnsavedWork()) return respond("Сначала сохраните черновик и локальные настройки.");
    if (state.busy || !$("#reset-batch").hidden) return respond("Сначала завершите текущую операцию.");
    try {
      const fields = validateSources({
        base: $("#source-base").value, space: $("#source-space").value,
        labels: Object.fromEntries(SOURCE_TYPES.map(([key]) => [key, $(`#label-${key}`).value])),
      });
      if (JSON.stringify(fields) !== JSON.stringify(sources)) return respond("Сохраните изменённые настройки источников.");
    } catch {
      return respond("Проверьте и сохраните настройки источников.");
    }
    respond("");
  });
}
