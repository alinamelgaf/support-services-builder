import { MAX_BYTES } from "./catalog.js";
import { createImportBatch, queryUrl, SOURCE_KEY, SOURCE_TYPES, validateSources } from "./confluence.js";
import { buildProposal, DEFAULT_OPTION, defaultSelection, isIncludedInDocument, OPTIONS } from "./proposal.js";
import {
  captureTemplate, initialDefaults, LEGACY_STORAGE_KEY, overlayDefaults, readTemplate, STORAGE_KEY, TEMPLATE_STORAGE_KEY, templateServiceSettings, writeTemplate,
} from "./package-defaults.js";
import { documentOptions, restoreDocumentSources, sectionReason, SECTION_LABELS } from "./document-sections.js";
import { renderRich } from "./rich-dom.js";
import { generateExcel } from "./excel.js";
import { generateWord } from "./word.js";
import { enablePwa } from "./pwa.js";
import { createDraftAutosave, openDraftStore } from "./draft.js";
import { documentPalette, readLocalPalette } from "./export-palette.js";
import { setupPaletteDialog } from "./palette-dialog.js";

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
  draftEditsPreserved: false,
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
let sourcesUnsaved = false;
const downloads = [...document.querySelectorAll("[data-format]")];
const slaModes = [...document.querySelectorAll('input[name="sla-mode"]')];
const slaFormats = [...document.querySelectorAll('input[name="sla-format"]')];

function renderDocumentOptions() {
  for (const key of Object.keys(SECTION_LABELS)) {
    const reason = sectionReason(key, state.sections, state.selected);
    const checkbox = $(`#include-${key}`);
    checkbox.disabled = state.busy || Boolean(reason);
    checkbox.checked = !reason && state.documentOptions.included[key];
    $(`#reason-${key}`).textContent = reason;
  }
  const slaDisabled = $("#include-sla").disabled || !$("#include-sla").checked;
  for (const radio of slaModes) {
    radio.disabled = slaDisabled;
    radio.checked = radio.value === state.documentOptions.slaMode;
  }
  const showFormats = $("#include-sla").checked && state.documentOptions.slaMode === "all";
  $("#sla-formats").hidden = !showFormats;
  for (const radio of slaFormats) {
    radio.disabled = slaDisabled || !showFormats;
    radio.checked = radio.value === state.documentOptions.slaFormat;
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
    renderDocumentOptions();
    draftChanged();
  });
}
for (const radio of slaFormats) {
  radio.addEventListener("change", () => {
    state.documentOptions.slaFormat = radio.value;
    draftChanged();
  });
}

function node(tag, text = "", className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

const noticeTimers = new Map();

function notice(selector, message, error = false, temporary = false) {
  clearTimeout(noticeTimers.get(selector));
  noticeTimers.delete(selector);
  const box = $(selector);
  box.textContent = message;
  box.classList.toggle("error", error);
  box.classList.toggle("success", Boolean(message && temporary && !error));
  box.hidden = !message;
  if (message && temporary && !error) {
    noticeTimers.set(selector, setTimeout(() => {
      box.hidden = true;
      noticeTimers.delete(selector);
    }, 5000));
  }
}

function hasDraftChanges() {
  try { return JSON.stringify(currentConfiguration()) !== JSON.stringify(basisConfiguration(state.layer)); }
  catch { return true; }
}

function draftChanged() {
  notice("#export-notice", "");
  draftTouched = true;
  showDefaultsStatus();
  draft?.change();
}

function paletteForNewProposal() {
  notice("#palette-notice", "");
  try {
    return readLocalPalette(window.localStorage);
  } catch {
    notice("#palette-notice", "Не удалось прочитать локальную палитру. Используется базовая.", true);
    return documentPalette();
  }
}

function setBusy(busy) {
  state.busy = busy;
  $("#upload").disabled = $("#catalog-file").disabled = busy;
  $("#save-sources").disabled = $("#reset-batch").disabled = busy;
  $("#open-palette").disabled = busy;
  $("#open-sources").disabled = busy;
  for (const button of downloads) button.disabled = busy || !state.services.length;
  renderDocumentOptions();
  showDefaultsStatus();
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

function renderCatalog() {
  const catalog = state.catalog;
  const attempt = catalog?.attempt;
  const issues = attempt?.issues ?? catalog?.issues ?? [];
  const errors = issues.some(({ level }) => level === "error");
  const warnings = issues.some(({ level }) => level === "warning");
  const loaded = state.services.length > 0;
  // Earlier drafts have only the full summary, including the original card count.
  const pages = catalog?.pages ?? catalog?.summary?.match(/^Услуг загружено \d+ из (\d+) карточек/)?.[1];
  const count = `${state.services.length}${pages === undefined ? "" : ` из ${pages}`} услуг`;
  const status = $("#confluence-status");
  let kind = "";
  let message = "Данные Confluence не загружены";
  if (attempt) {
    kind = "error";
    message = "Ошибка загрузки JSON. Подробнее — «Источники Confluence».";
    if (loaded) message += ` Сохранены ранее загруженные данные: ${count}.`;
  } else if (loaded) {
    kind = catalog?.error || errors ? "error" : warnings || catalog?.message ? "warning" : "success";
    message = kind === "success" ? `Данные Confluence загружены: ${count}`
      : `Загружено ${count}. ${kind === "error" ? "Есть ошибки импорта" : "Есть предупреждения"}. Подробнее — «Источники Confluence».`;
  }
  status.className = `confluence-status${kind ? ` ${kind}` : ""}`;
  status.textContent = message;
  renderIssues(issues);
  notice("#catalog-notice", attempt?.message ?? catalog?.message ?? "", attempt ? true : Boolean(catalog?.error));
}

function importProblem(message, issues = []) {
  state.catalog = { ...state.catalog, attempt: { message, issues } };
  renderCatalog();
  draftChanged();
}

async function importCatalog(files) {
  if (!files.length || state.busy) return;
  setBusy(true);
  notice("#catalog-notice", "Проверяем каталог…");
  $("#confluence-status").className = "confluence-status";
  $("#confluence-status").textContent = "Проверяем JSON…";
  notice("#export-notice", "");
  let importIssues = [];
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
      importProblem(`Неполная выгрузка REST. Получено записей: ${pending.count}${pending.total === undefined ? "" : ` из ${pending.total}`}. Загрузите остальные страницы JSON. Рабочий каталог пока не заменён.`);
      return;
    }
    const result = pending.data;
    importIssues = result.issues;
    const errors = renderIssues(result.issues);
    if (!result.services.length) {
      if (result.issues.length) $("#issues").open = true;
      throw new Error("В выбранном файле нет корректных карточек услуг. Проверьте поля Page Properties и сообщения импорта.");
    }
    const dirty = Boolean(state.services.length && hasDraftChanges());
    const initial = !state.services.length;
    const next = result.usableStandard || !state.hasStandard ? result.standard : state.standard;
    state.hasStandard ||= result.usableStandard;
    state.standard = next;
    state.base = result.base;
    state.services = result.services;
    state.sections = result.sections;
    state.draftEditsPreserved = dirty;
    if (dirty) {
      state.defaults = overlayDefaults(next, state.defaults);
      renderServices();
    } else {
      if (initial && state.local) state.layer = "local";
      applyLayer(state.layer, false);
    }
    const kind = result.legacy ? "прежний формат каталога" : "страницы REST объединены";
    const recognized = [
      ...(result.usableStandard ? ["Базовая конфигурация"] : []),
      ...Object.entries(result.sections).filter(([, section]) => section.data).map(([key]) => SECTION_LABELS[key]),
    ];
    const catalogMessage = errors
      ? "Есть ошибки импорта. Проверьте список ниже. Некорректные дополнительные разделы недоступны."
      : !result.usableStandard ? "В этой выгрузке нет применимой базовой конфигурации. Проверьте содержимое JSON." : "";
    state.catalog = {
      pages: result.pages,
      completeness: result.legacy ? "Проверен загруженный каталог прежнего формата." : "Полнота REST-выгрузки проверена.",
      issues: result.issues,
      summary: `Услуг загружено ${state.services.length} из ${result.pages} карточек · ${kind}` +
        (recognized.length ? `. Распознано: ${recognized.join(", ")}.` : ""),
      message: catalogMessage, error: Boolean(errors),
    };
    renderCatalog();
    showDefaultsStatus();
    draftChanged();
  } catch (error) {
    importProblem(error.message, importIssues);
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

function serviceSettings() {
  return {
    overrides: state.overrides, defaults: state.defaults.values,
    documentDefaults: state.defaults.includedInDocument, documentOverrides: state.documentOverrides,
  };
}

function currentConfiguration() {
  return captureTemplate(state.services, serviceSettings(), state.selected, state.documentOptions);
}

function basisConfiguration(layer) {
  const template = layer === "local" ? state.local : null;
  return captureTemplate(state.services, templateServiceSettings(state.standard, template, state.services),
    template?.selected ?? DEFAULT_OPTION, template?.documentOptions);
}

function showDefaultsStatus() {
  for (const radio of document.querySelectorAll('input[name="proposal-basis"]')) {
    radio.checked = radio.value === state.layer;
    radio.disabled = state.busy || !state.services.length || (radio.value === "local" ? !state.local : !state.hasStandard);
  }
  let valid = true;
  try { currentConfiguration(); } catch { valid = false; }
  $("#save-template").disabled = state.busy || !state.services.length || !valid;
  const status = $("#basis-status");
  status.textContent = !state.services.length ? "Загрузите каталог Confluence"
    : state.layer === "corporate" && !state.hasStandard ? "Стандарт Confluence не загружен"
    : state.layer === "local" && !state.local ? "Мой шаблон недоступен. Показана конфигурация черновика."
    : hasDraftChanges() ? "Есть изменения текущего предложения" : "";
  status.hidden = !status.textContent;
}

function applyLayer(layer, save = true) {
  const template = layer === "local" ? state.local : null;
  const settings = templateServiceSettings(state.standard, template, state.services);
  state.layer = layer;
  state.defaults = { values: settings.defaults, includedInDocument: settings.documentDefaults };
  state.overrides = settings.overrides;
  state.documentOverrides = settings.documentOverrides;
  state.selected = template?.selected ?? DEFAULT_OPTION;
  state.documentOptions = documentOptions(template?.documentOptions);
  state.draftEditsPreserved = false;
  for (const radio of document.querySelectorAll('input[name="proposal-variant"]')) radio.checked = radio.value === state.selected;
  renderServices();
  renderDocumentOptions();
  showDefaultsStatus();
  notice("#export-notice", "");
  if (save) draftChanged();
}

let confirmedBasisAction;
function confirmBasis(title, detail, label, action) {
  $("#basis-dialog-heading").textContent = title;
  $("#basis-dialog-detail").textContent = detail;
  $("#confirm-basis").textContent = label;
  confirmedBasisAction = action;
  $("#basis-dialog").showModal();
}
$("#basis-dialog").addEventListener("close", () => { confirmedBasisAction = undefined; });
for (const button of document.querySelectorAll("[data-close-basis]")) {
  button.addEventListener("click", () => $("#basis-dialog").close());
}
$("#confirm-basis").addEventListener("click", () => {
  const action = confirmedBasisAction;
  confirmedBasisAction = undefined;
  $("#basis-dialog").close();
  action?.();
});

function chooseBasis(layer) {
  showDefaultsStatus();
  const changed = hasDraftChanges();
  let sameTarget = false;
  try { sameTarget = JSON.stringify(currentConfiguration()) === JSON.stringify(basisConfiguration(layer)); } catch { /* Invalid edits require confirmation. */ }
  if (changed && !sameTarget) {
    confirmBasis("Применить другую основу?",
      "Текущие изменения предложения будут заменены настройками выбранной основы. Сохранённый личный шаблон и палитра документа не изменятся",
      "Применить", () => applyLayer(layer));
  } else applyLayer(layer);
}
for (const radio of document.querySelectorAll('input[name="proposal-basis"]')) {
  radio.addEventListener("change", () => chooseBasis(radio.value));
  radio.addEventListener("click", () => {
    if (radio.value === state.layer && hasDraftChanges()) chooseBasis(radio.value);
  });
}

function saveMyTemplate() {
  try {
    const template = currentConfiguration();
    writeTemplate(window.localStorage, template);
    const existed = Boolean(state.local);
    state.local = template;
    state.layer = "local";
    showDefaultsStatus();
    draftChanged();
    notice("#defaults-notice", existed ? "Мой шаблон обновлён" : "Мой шаблон сохранён локально", false, true);
  } catch {
    notice("#defaults-notice", "Не удалось сохранить мой шаблон. Проверьте хранилище браузера.", true);
  }
}
$("#save-template").addEventListener("click", () => {
  try { state.local = readTemplate(window.localStorage); }
  catch {
    notice("#defaults-notice", "Не удалось прочитать мой шаблон. Сохранение отменено.", true);
    return;
  }
  if (state.local) {
    confirmBasis("Заменить мой шаблон?",
      "Текущие настройки предложения заменят ранее сохранённый шаблон. Предыдущую версию шаблона восстановить не получится",
      "Заменить шаблон", saveMyTemplate);
  } else saveMyTemplate();
});

async function exportProposal(format) {
  if (state.busy || !state.services.length) return;
  const invalid = $("#services tr:not(.excluded) [aria-invalid=true]");
  if (invalid) {
    invalid.focus();
    notice("#export-notice", "Чтобы исключить услугу, снимите отметку «Включена».", true);
    return;
  }
  const form = {
    selected: state.selected,
    ...serviceSettings(),
    sections: state.sections,
    document: state.documentOptions,
    palette: state.palette,
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
    notice("#export-notice", `Файл ${label} сформирован.`, false, true);
  } catch (error) {
    notice("#export-notice", error.message, true);
  } finally {
    setBusy(false);
  }
}

$("#upload").addEventListener("click", () => $("#catalog-file").click());
$("#catalog-file").addEventListener("change", (event) => importCatalog([...event.target.files]));
$("#close-dialog").addEventListener("click", () => $("#service-dialog").close());
$("#open-sources").addEventListener("click", () => $("#sources-dialog").showModal());
$("#close-sources").addEventListener("click", () => $("#sources-dialog").close());
$("#show-release-notes").addEventListener("click", () => $("#release-notes").showModal());
$("#close-release-notes").addEventListener("click", () => $("#release-notes").close());
for (const button of downloads) {
  button.addEventListener("click", () => exportProposal(button.dataset.format));
}

try {
  const saved = readTemplate(window.localStorage);
  if (saved) {
    state.local = saved;
    state.defaults = saved;
    state.layer = "local";
    state.selected = saved.selected;
    state.documentOptions = documentOptions(saved.documentOptions);
  }
} catch {
  notice("#defaults-notice", "Не удалось прочитать мой шаблон из хранилища браузера.", true);
}
renderOptions();
showDefaultsStatus();
setBusy(false);

window.addEventListener("storage", (event) => {
  if (event.storageArea !== window.localStorage || (event.key !== null && ![TEMPLATE_STORAGE_KEY, STORAGE_KEY, LEGACY_STORAGE_KEY].includes(event.key))) return;
  try {
    state.local = readTemplate(window.localStorage);
    showDefaultsStatus();
  } catch {
    notice("#defaults-notice", "Не удалось прочитать мой шаблон из хранилища браузера.", true);
  }
});

function resetBatch() {
  batch.reset();
  $("#reset-batch").hidden = true;
  if (state.catalog) delete state.catalog.attempt;
  renderCatalog();
  if (!state.catalog?.message) notice("#catalog-notice", "Ожидающие страницы очищены. Можно начать новую загрузку.", false, true);
  draftChanged();
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
      notice("#sources-notice", "Источники сохранены в этом браузере.", false, true);
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
  const { selected, services, overrides, documentOverrides, defaults, standard, hasStandard, layer, base, catalog, draftEditsPreserved } = state;
  return {
    selected, services, overrides, documentOverrides, defaults, standard, hasStandard, layer, base, catalog, draftEditsPreserved,
    sections: state.sections, documentOptions: state.documentOptions,
    palette: state.palette,
  };
}

function restoreProposal(saved) {
  const { selected, services, overrides, documentOverrides, defaults, standard, hasStandard, layer, base, catalog } = saved;
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
    hasStandard, layer: layer === "local" ? "local" : "corporate", base, catalog, documentOptions: documentOptions(saved.documentOptions),
    palette: documentPalette(saved.palette),
    draftEditsPreserved: saved.draftEditsPreserved ?? Boolean(saved.conflict && (overrides.size || documentOverrides.size)),
    sections: restoreDocumentSources(saved.sections ?? (previousIntro ? { intro: { data: previousIntro } } : {})),
  });
  for (const radio of document.querySelectorAll('input[name="proposal-variant"]')) radio.checked = radio.value === selected;
  renderServices();
  showDefaultsStatus();
  renderCatalog();
}

function hasUnsavedWork() {
  return Boolean(draft?.unsaved || (draftUnavailable && draftTouched) || sourcesUnsaved);
}

async function startDraft() {
  const main = $("main");
  const draftStatus = (message, error) => {
    notice("#draft-notice", message, error);
    if (!error) $("#draft-notice").hidden = true;
  };
  main.inert = true;
  setBusy(true);
  try {
    const store = await openDraftStore(new URL(".", location.href).pathname);
    const saved = await store.load();
    if (saved) {
      restoreProposal(saved);
      notice("#draft-notice", "Черновик восстановлен", false, true);
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

state.palette = paletteForNewProposal();
setupPaletteDialog({
  getPalette: () => state.palette,
  changePalette: (palette) => { state.palette = palette; draftChanged(); },
  report: (message, error) => notice("#palette-notice", message, error),
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
