const STORAGE_KEY = (typeof __SSB_STORAGE_PREFIX__ === "string" ? __SSB_STORAGE_PREFIX__ : "") + "ssb:document-palette:v1";
const WHITE = "#FFFFFF";
const BLACK = "#000000";
export const MIN_CONTRAST = 4.5;

export function hexColor(value) {
  return typeof value === "string" && value.length === 7 && /^#[0-9A-F]{6}$/i.test(value) ? value.toUpperCase() : null;
}

export function documentPalette(value) {
  const custom = value?.mode === "custom";
  function colors(setting, background) {
    return {
      background: hexColor(setting?.background) ?? background,
      textMode: ["auto", "custom"].includes(setting?.textMode) ? setting.textMode : "default",
      textColor: hexColor(setting?.textColor) ?? WHITE,
    };
  }
  return {
    mode: custom ? "custom" : "base",
    main: colors(custom ? value.main : null, "#234C5E"),
    proposal: colors(custom ? value.proposal : null, "#00AD21"),
  };
}

function channels(hex) {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

function luminance(hex) {
  const [red, green, blue] = channels(hex).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function mix(source, dest, amount) {
  const target = channels(dest);
  return "#" + channels(source).map((value, index) =>
    Math.round(value + (target[index] - value) * amount).toString(16).padStart(2, "0").toUpperCase(),
  ).join("");
}

export function resolveDocumentPalette(value) {
  const { main, proposal } = documentPalette(value);
  function heading({ background, textMode, textColor }) {
    let text = WHITE;
    if (textMode === "custom") text = textColor;
    if (textMode === "auto" && contrast(background, BLACK) > contrast(background, WHITE)) text = BLACK;
    return { background, text, contrast: contrast(background, text) };
  }
  // Worksheet title text sits on white rather than on a colored heading background.
  let titleText = main.background;
  for (let amount = 1; contrast(WHITE, titleText) < MIN_CONTRAST; amount += 1) {
    titleText = mix(main.background, BLACK, amount / 16);
  }
  let selectedFill = mix(proposal.background, WHITE, 0.88);
  const darkest = Math.min(...channels(selectedFill));
  // Keep the selected column visible even when the proposal color is white.
  if (darkest > 238) selectedFill = mix(selectedFill, BLACK, 1 - 238 / darkest);
  return {
    main: heading(main), proposal: heading(proposal), titleText,
    band: mix(main.background, WHITE, 0.95), selectedFill,
  };
}

export function readLocalPalette(storage) {
  const saved = storage.getItem(STORAGE_KEY);
  return documentPalette(saved === null ? undefined : JSON.parse(saved));
}

export function writeLocalPalette(storage, value) {
  const palette = documentPalette(value);
  if (palette.mode === "base") {
    storage.removeItem(STORAGE_KEY);
    if (storage.getItem(STORAGE_KEY) !== null) throw new Error("Проверьте хранилище браузера.");
    return;
  }
  const saved = JSON.stringify(palette);
  storage.setItem(STORAGE_KEY, saved);
  if (storage.getItem(STORAGE_KEY) !== saved) throw new Error("Проверьте хранилище браузера.");
}
