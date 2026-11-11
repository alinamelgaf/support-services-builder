export const BASE = "https://wiki.example.invalid/confluence";
export const SOURCES = { base: BASE, space: "DEMO", labels: { catalog: "demo_catalog", defaults: "demo_defaults", intros: "demo_intros" } };
export const IDS = ["TS-1", "TS-1.A", "TS-2", "TS-5.A", "TS-10", "TS-10.A"];
export const PUBLIC_LINK = "https://manual.example.invalid/guide";

export function card(id, { description = `<p>Учебное описание <b>${id}</b>.</p><ul><li>Пункт примера.</li></ul>`, conditions = "<p>Учебное условие.</p>" } = {}) {
  const field = (key, value) => `<tr><th>${key}</th><td>${value}</td></tr>`;
  return '<ac:structured-macro ac:name="details"><ac:rich-text-body><table>' +
    field("ID услуги", id) + field("Наименование", `Пример ${id}`) + field("Описание услуги", description) +
    field("Условия предоставления", conditions) + field("Основная услуга", id.includes(".") ? id.split(".")[0] : "-") +
    "</table></ac:rich-text-body></ac:structured-macro>";
}

function page(id, label, storage) {
  return { id: String(id), title: `Учебная страница ${id}`, metadata: { labels: { results: [{ name: label }] } }, body: { storage: { value: storage } } };
}

const tr = (values, tag = "td") => `<tr>${values.map((value) => `<${tag}>${value}</${tag}>`).join("")}</tr>`;
const table = (columns, rows) => `<table>${tr(columns, "th")}${rows.map((row) => tr(row)).join("")}</table>`;

export function fixture({ parameter = "12 часов", extra = false, unknown = true, duplicate = false, adversarial = true, catalogCount = IDS.length } = {}) {
  const link = `<a href="${BASE}/display/DEMO/Example">Справочная карточка</a>`;
  const results = [...IDS].reverse().map((id, index) => page(10 + index, "demo_catalog", card(id, id === "TS-1" ? {
    description: `<p><strong>Демонстрация</strong> ${link} и <a href="${PUBLIC_LINK}">открытая инструкция</a>.</p><ul><li>Учебный пункт</li></ul>` +
      (adversarial ? '<img src="https://pixel.example.invalid/track"><script>fetch("https://pixel.example.invalid/track")</script>' : ""),
  } : {})));
  const rows = [
    [link, "ts-1", "+", parameter, "+", "-"], [link, "TS-1.A", "+", "-", "3 часа", "+"],
    [link, "TS-2", "-", "+", "-", "+"], [link, "TS-5.A", "+", "+", "-", "-"],
    [link, "TS-10", "+", "-", "+", "+"], [link, "TS-10.A", "+", "-", "-", "По запросу"],
  ];
  if (unknown) rows.push([link, "TS-99", "+", "+", "-", "-"]);
  if (duplicate) rows.push([link, "TS-1", "+", "+", "-", "-"]);
  if (extra) {
    results.push(page(21, "demo_catalog", card("TS-3.B")), page(22, "demo_catalog", card("TS-4")));
    rows.push([link, "TS-3.B", "+", "-", "6 часов", "-"]);
  }
  for (let index = IDS.length; index < catalogCount; index += 1) {
    const id = `TS-${index + 5}`;
    results.push(page(100 + index, "demo_catalog", card(id)));
    rows.push([link, id, "+", "+", "-", "-"]);
  }
  results.push(page(60, "demo_defaults", table(["Карточка услуги", "ID услуги", "В документ", "Standard", "Extended", "Managed Service"], rows)));
  results.push(page(61, "demo_intros", table(["Вариант поддержки", "Вводный текст"], [
    ["Standard", `<p><b>Пример Standard</b> ${link}</p><ul><li>Учебный список</li></ul>`],
    ["Extended", `<p><em>Пример Extended</em> и <a href="${PUBLIC_LINK}">инструкция</a>.</p><p>Второй абзац.</p>`],
    ["Managed Service", "<p><u>Пример Managed Service</u></p><ol><li>Учебный шаг</li></ol>"],
  ])));
  return { results, start: 0, limit: 25, size: results.length, totalSize: results.length, _links: { base: BASE } };
}

export function paginate(data, start, end) {
  return { ...data, start, limit: end - start, size: end - start, results: data.results.slice(start, end), _links: {
    base: BASE, self: `/rest/api/content/search?cql=type+%3D+page&start=${start}`,
    ...(end < data.results.length ? { next: `/rest/api/content/search?cql=type+%3D+page&start=${end}` } : {}),
  } };
}

export const legacy = () => ({ schemaVersion: 1, source: BASE, pages: [{ pageId: "80", title: "Учебная карточка", storage: card("TS-5.A") }], failures: [] });
