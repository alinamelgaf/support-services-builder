import {
  documentPalette, hexColor, paletteSettings, resolveDocumentPalette,
} from "./export-palette.js";

const COLOR_BLOCKS = [["main", "Основной цвет"], ["proposal", "Цвет предложения"]];

export function setupPaletteDialog({ getPalette, changePalette }) {
  const dialog = document.querySelector("#palette-dialog");
  const preview = dialog.querySelector("#palette-preview");
  const blocks = {};

  function render(edited, clearErrors = false) {
    const palette = documentPalette(getPalette());
    dialog.querySelector(`input[name="palette-mode"][value="${palette.mode}"]`).checked = true;
    for (const [key, block] of Object.entries(blocks)) {
      const setting = palette[key];
      for (const input of block.querySelectorAll("input")) input.disabled = palette.mode === "base";
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
  }

  function validate(input, valid) {
    if (valid) input.removeAttribute("aria-invalid");
    else input.setAttribute("aria-invalid", "true");
    input.parentElement.querySelector("[data-invalid]").hidden = valid;
  }

  function updateColor(key, property, value, edited) {
    const current = paletteSettings(getPalette());
    if (value !== null && current.mode === "custom") {
      changePalette({ ...current, custom: { ...current.custom, [key]: { ...current.custom[key], [property]: value } } });
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
      changePalette({ ...paletteSettings(getPalette()), mode: radio.value });
      render(undefined, true);
    });
  }
  document.querySelector("#open-palette").addEventListener("click", () => {
    render(undefined, true);
    dialog.showModal();
  });
  dialog.querySelector("#close-palette").addEventListener("click", () => dialog.close());

}
