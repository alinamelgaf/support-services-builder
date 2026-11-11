import { hasRichText, withoutSourceLinks } from "./rich-text.js";

export const SECTION_LABELS = {
  intro: "Вводный текст",
  sla: "Матрица SLA",
  severity: "Уровни критичности",
  raci: "Матрица RACI",
  assumptions: "Допущения и ограничения",
  glossary: "Глоссарий",
};

export const SEVERITY_HEADERS = ["Код", "Наименование", "Краткое описание", "Полное описание"];
export const SLA_CODES = ["10", "20", "30", "80"];
export const SEVERITY_CODES = ["10", "11", "12", "20", "21", "22", "30", "31", "32", "80", "90"];
export const SLA_METRICS = [
  "Часы работы", "Время реакции", "Время восстановления сервиса",
  "Время предоставления временного решения", "Время предоставления постоянного решения", "Время ответа",
];

export function documentOptions(saved) {
  return {
    included: Object.fromEntries(Object.keys(SECTION_LABELS).map((key) => [
      key, key !== "raci" && (typeof saved?.included?.[key] === "boolean" ? saved.included[key] : key === "intro"),
    ])),
    slaMode: saved?.slaMode === "all" ? "all" : "selected",
    slaFormat: saved?.slaFormat === "separate" ? "separate" : "comparison",
  };
}

export function sectionReason(key, sources, selected) {
  if (key === "raci") return "Пока не реализовано";
  const section = sources[key];
  if (!section?.data) return section?.error ?? "Источник не загружен.";
  if (key === "intro" && !hasRichText(section.data[selected] ?? [])) return "Для выбранного уровня поддержки текст отсутствует.";
  return "";
}

export function buildDocumentSections(sources, options, selected, codes, bases) {
  const { included, slaMode, slaFormat } = documentOptions(options);
  const data = (key) => included[key] && !sectionReason(key, sources, selected) ? sources[key].data : null;
  const clean = (blocks) => withoutSourceLinks(blocks, bases);
  const intro = data("intro");
  const matrix = data("sla");
  const severity = data("severity");
  const assumptions = data("assumptions");
  const glossary = data("glossary");
  let sla;
  if (matrix) {
    const packages = slaMode === "all" ? codes : [selected];
    // The reference can supply labels even when its section is excluded.
    const names = new Map(sources.severity?.data?.map(({ code, name }) => [code, name]));
    const records = new Map(matrix.map(({ code, support, values }) => [code + "|" + support, values]));
    const table = (columns) => ({
      headers: ["Уровень критичности", "Показатель", ...columns.map((code) => code === selected && columns.length > 1 ? code + " ✓" : code)],
      selectedColumn: columns.length > 1 ? 2 + columns.indexOf(selected) : -1,
      groups: SLA_CODES.map((code) => ({
        label: names.has(code) ? code + " — " + names.get(code) : code,
        rows: SLA_METRICS.map((metric, index) => [metric, ...columns.map((support) => records.get(code + "|" + support)[index])]),
      })),
    });
    sla = slaMode === "all" && slaFormat === "separate"
      ? packages.map((code) => ({
        ...table([code]), caption: code === selected ? code + " ✓ — Предложение" : code, highlighted: code === selected,
      }))
      : [table(packages)];
  }
  return {
    ...(intro && { intro: clean(intro[selected]) }),
    ...(sla && { sla }),
    ...(severity && { severity: severity.map(({ short, description, ...row }) => ({
      ...row, short: clean(short), description: clean(description),
    })) }),
    ...(assumptions && { assumptions: assumptions.map(({ category, wording }) => ({ category, wording: clean(wording) })) }),
    ...(glossary && { glossary: glossary.map(({ term, english, definition }) => ({ term, english, definition: clean(definition) })) }),
  };
}
