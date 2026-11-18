const STORAGE_KEY = (typeof __SSB_STORAGE_PREFIX__ === "string" ? __SSB_STORAGE_PREFIX__ : "") + "ssb:document-palette:v1";
const WHITE = "#FFFFFF";
const BLACK = "#000000";
export const MIN_CONTRAST = 4.5;

export function hexColor(value) {
  return typeof value === "string" && value.length === 7 && /^#[0-9A-F]{6}$/i.test(value) ? value.toUpperCase() : null;
}

export function documentPalette(value) {
  const custom = value?.mode === "custom";
  const own = value?.custom ?? value;
  function colors(setting, background) {
    return {
      background: hexColor(setting?.background) ?? background,
      textMode: ["auto", "custom"].includes(setting?.textMode) ? setting.textMode : "default",
      textColor: hexColor(setting?.textColor) ?? WHITE,
    };
  }
  return {
    mode: custom ? "custom" : "base",
    main: colors(custom ? own?.main : null, "#234C5E"),
    proposal: colors(custom ? own?.proposal : null, "#00AD21"),
  };
}

function customColors(value) {
  const { main, proposal } = documentPalette({ ...value, mode: "custom" });
  return { main, proposal };
}

export function paletteSettings(value) {
  return {
    schemaVersion: 2,
    updatedAt: Number.isSafeInteger(value?.updatedAt) && value.updatedAt >= 0 ? value.updatedAt : 0,
    mode: value?.mode === "custom" ? "custom" : "base",
    custom: customColors(value?.custom ?? value),
    ...(value?.legacyFixed ? { legacyFixed: customColors(value.legacyFixed) } : {}),
  };
}

// The current draft took precedence over the separately fixed palette in the old UI.
// Retain both when they differ; the former fixed colors remain a migration backup
// inside the same palette record, rather than a new storage key or template field.
export function restorePaletteSettings(local, draft) {
  const modern = [draft, local].filter((value) => value?.schemaVersion === 2);
  const latest = modern.reduce((chosen, value) => !chosen || (value.updatedAt ?? 0) >= (chosen.updatedAt ?? 0) ? value : chosen, null);
  const selected = latest ?? draft ?? local;
  const own = latest?.custom ?? (draft?.mode === "custom" ? draft : local?.mode === "custom" ? local : undefined);
  const result = paletteSettings({ ...selected, custom: own ?? customColors() });
  if (!result.legacyFixed && local?.schemaVersion !== 2 && local?.mode === "custom") {
    const fixed = customColors(local);
    if (JSON.stringify(fixed) !== JSON.stringify(result.custom)) result.legacyFixed = fixed;
  }
  return result;
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
  return saved === null ? null : JSON.parse(saved);
}

export function writeLocalPalette(storage, value) {
  const saved = JSON.stringify(paletteSettings(value));
  storage.setItem(STORAGE_KEY, saved);
  if (storage.getItem(STORAGE_KEY) !== saved) throw new Error("Проверьте хранилище браузера.");
}
