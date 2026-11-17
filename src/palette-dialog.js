import {
  documentPalette, hasLocalPalette, hexColor, MIN_CONTRAST, resetLocalPalette, resolveDocumentPalette, writeLocalPalette,
} from "./export-palette.js";

const COLOR_BLOCKS = [["main", "Основной цвет"], ["proposal", "Цвет предложения"]];

export function setupPaletteDialog({ getPalette, changePalette, report }) {
  const dialog = document.querySelector("#palette-dialog");
  const confirmation = document.querySelector("#palette-reset-dialog");
  const preview = dialog.querySelector("#palette-preview");
  const save = dialog.querySelector("#save-palette");
  const reset = dialog.querySelector("#reset-palette");
  const success = dialog.querySelector("#palette-success");
  const blocks = {};

  function clearFeedback() {
    success.hidden = true;
    report("");
  }

  function showSuccess(title, detail) {
    success.querySelector("#palette-success-heading").textContent = title;
    success.querySelector("#palette-success-detail").textContent = detail;
    success.hidden = false;
  }

  function render(edited, clearErrors = false) {
    const palette = getPalette();
    dialog.querySelector(`input[name="palette-mode"][value="${palette.mode}"]`).checked = true;
    for (const [key, block] of Object.entries(blocks)) {
      const setting = palette[key];
      block.querySelector(`input[value="${setting.textMode}"]`).checked = true;
      for (const field of block.querySelectorAll("[data-color]")) {
        const property = field.dataset.color;
        field.hidden = property === "textColor" && setting.textMode !== "custom";
        const hex = field.querySelector("[data-hex]");
        if (clearErrors || field.hidden) validate(hex, true);
        if (hex !== edited && !hex.hasAttribute("aria-invalid")) hex.value = setting[property];
        field.querySelector("[data-picker]").value = setting[property];
      }
    }
    const colors = resolveDocumentPalette(palette);
    for (const [name, value] of Object.entries({
      main: colors.main.background, "main-text": colors.main.text,
      proposal: colors.proposal.background, "proposal-text": colors.proposal.text,
      band: colors.band, selected: colors.selectedFill,
    })) preview.style.setProperty(`--preview-${name}`, value);
    const warnings = COLOR_BLOCKS.filter(([key]) => colors[key].contrast < MIN_CONTRAST).map(([, label]) => label.toLowerCase());
    const warning = dialog.querySelector("#palette-warning");
    warning.textContent = warnings.length ? `Контраст текста ниже 4,5:1 (${warnings.join(", ")}). В режиме «Авто» SSB подберёт более контрастный цвет текста.` : "";
    warning.hidden = !warnings.length;
    save.disabled = Boolean(dialog.querySelector("[data-color]:not([hidden]) [aria-invalid=true]"));
  }

  function validate(input, valid) {
    if (valid) input.removeAttribute("aria-invalid");
    else input.setAttribute("aria-invalid", "true");
    input.parentElement.querySelector("[data-invalid]").hidden = valid;
  }

  function updateColor(key, property, value, edited) {
    clearFeedback();
    const current = getPalette();
    const next = { ...current, mode: "custom", [key]: { ...current[key], [property]: value ?? current[key][property] } };
    if (next.mode !== current.mode || next[key][property] !== current[key][property]) {
      changePalette(next);
    }
    render(edited);
  }

  const template = document.querySelector("#palette-fields");
  for (const [key, label] of COLOR_BLOCKS) {
    const block = template.content.firstElementChild.cloneNode(true);
    block.querySelector("[data-label]").textContent = label;
    for (const field of block.querySelectorAll("[data-color]")) {
      const property = field.dataset.color;
      const picker = field.querySelector("[data-picker]");
      const hex = field.querySelector("[data-hex]");
      const name = property === "background" ? label : `${label} — цвет текста`;
      picker.setAttribute("aria-label", name);
      hex.setAttribute("aria-label", `${name} — HEX`);
      hex.setAttribute("aria-describedby", `invalid-${key}-${property}`);
      field.querySelector("[data-invalid]").id = `invalid-${key}-${property}`;
      const pickColor = () => {
        validate(hex, true);
        updateColor(key, property, hexColor(picker.value));
      };
      picker.addEventListener("input", pickColor);
      picker.addEventListener("change", pickColor);
      hex.addEventListener("input", () => {
        const value = hexColor(hex.value);
        validate(hex, Boolean(value));
        updateColor(key, property, value, hex);
      });
      hex.addEventListener("blur", () => render());
    }
    for (const radio of block.querySelectorAll("input[type=radio]")) {
      radio.name = `palette-text-${key}`;
      radio.addEventListener("change", () => updateColor(key, "textMode", radio.value));
    }
    blocks[key] = block;
    dialog.querySelector("#palette-colors").append(block);
  }

  for (const radio of dialog.querySelectorAll('input[name="palette-mode"]')) {
    radio.addEventListener("change", () => {
      changePalette(documentPalette({ ...getPalette(), mode: radio.value }));
      clearFeedback();
      render(undefined, true);
    });
  }
  document.querySelector("#open-palette").addEventListener("click", () => {
    success.hidden = true;
    reset.disabled = true;
    try {
      reset.disabled = !hasLocalPalette(window.localStorage);
    } catch {
      report("Не удалось проверить локально сохранённую палитру.", true);
    }
    render(undefined, true);
    dialog.showModal();
  });
  dialog.querySelector("#close-palette").addEventListener("click", () => dialog.close());

  save.addEventListener("click", () => {
    clearFeedback();
    try {
      writeLocalPalette(window.localStorage, getPalette());
    } catch {
      report("Не удалось сохранить палитру локально.", true);
      return;
    }
    reset.disabled = false;
    showSuccess("Палитра сохранена локально", "Выбранная палитра будет применяться по умолчанию к новым предложениям.");
  });

  reset.addEventListener("click", () => confirmation.showModal());
  for (const button of confirmation.querySelectorAll("[data-cancel-reset]")) {
    button.addEventListener("click", () => confirmation.close());
  }
  confirmation.querySelector("#confirm-palette-reset").addEventListener("click", () => {
    clearFeedback();
    confirmation.close();
    try {
      resetLocalPalette(window.localStorage);
    } catch {
      report("Не удалось сбросить локальную палитру.", true);
      return;
    }
    changePalette(documentPalette());
    render(undefined, true);
    reset.disabled = true;
    save.focus();
    showSuccess("Локальная палитра сброшена", "Применена базовая палитра.");
  });
}
