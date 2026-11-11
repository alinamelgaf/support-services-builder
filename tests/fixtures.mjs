export const BASE = "https://wiki.example.invalid/confluence";
export const SOURCES = { base: BASE, space: "DEMO", labels: { catalog: "demo_catalog", defaults: "demo_defaults", intros: "demo_intros" } };
export const IDS = ["TS-1", "TS-1.A", "TS-2", "TS-5.A", "TS-10", "TS-10.A"];
export const PUBLIC_LINK = "https://manual.example.invalid/guide";
export const REFERENCE_SOURCES = {
  ...SOURCES, labels: { ...SOURCES.labels, sla: "demo_sla", raci: "demo_raci", assumptions: "demo_assumptions", glossary: "demo_glossary" },
};

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

export function referenceFixture({ alterSla = (rows) => rows, alterSeverity = (rows) => rows } = {}) {
  const data = fixture({ unknown: false, adversarial: false });
  const labels = REFERENCE_SOURCES.labels;
  const names = {
    10: "Критический", 11: "Критический · подуровень A", 12: "Критический · подуровень B",
    20: "Значительный", 21: "Значительный · подуровень A", 22: "Значительный · подуровень B",
    30: "Незначительный", 31: "Незначительный · подуровень A", 32: "Незначительный · подуровень B",
    80: "Вопрос", 90: "Учебная классификация",
  };
  const packages = ["Standard", "Extended", "Managed Service"];
  const metrics = [
    [
      ["45 минут", "Не применимо", "16 часов", "5 рабочих дней", "Не регламентируется"],
      ["20 минут", "7 часов", "28 часов", "8 рабочих дней", "50 минут"],
      ["35 минут", "3 часа", "14 часов", "6 рабочих дней", "40 минут"],
    ], [
      ["3 часа", "Не применимо", "2 рабочих дня", "8 рабочих дней", "Не регламентируется"],
      ["80 минут", "12 часов", "30 часов", "9 рабочих дней", "2 часа"],
      ["70 минут", "10 часов", "24 часа", "7 рабочих дней", "100 минут"],
    ], [
      ["6 часов", "Не применимо", "3 рабочих дня", "12 рабочих дней", "1 рабочий день"],
      ["5 часов", "2 рабочих дня", "4 рабочих дня", "11 рабочих дней", "7 часов"],
      ["4 часа", "24 часа", "3 рабочих дня", "9 рабочих дней", "6 часов"],
    ], [
      ["Не регламентируется", "Не применимо", "Не применимо", "Не применимо", "3 рабочих дня"],
      ["Не регламентируется", "Не применимо", "Не применимо", "Не применимо", "2 рабочих дня"],
      ["Не регламентируется", "Не применимо", "Не применимо", "Не применимо", "1 рабочий день"],
    ],
  ];
  const sla = alterSla(["10", "20", "30", "80"].flatMap((code, index) => packages.map((support, j) => [code, support, ...metrics[index][j]])));
  const severity = alterSeverity(Object.entries(names).map(([code, name]) => [
    code, name, code === "11" ? "" : `Учебное краткое описание ${code}.`,
    `<p><b>Учебное определение ${code}.</b> Обращение оценивается по наблюдаемому влиянию на демонстрационный сервис.</p>` +
      (code === "10" ? "<ul><li>Пользователи не могут завершить учебную операцию.</li><li>Проверена доступность учебного контура.</li></ul>" : ""),
  ]));
  data.results.push(
    page(62, labels.sla, (sla ? table([
      "Код критичности", "Уровень поддержки", "Время реакции", "Время восстановления сервиса",
      "Время предоставления временного решения", "Время предоставления постоянного решения", "Время ответа",
    ], sla) : "") + (severity ? table(["Код", "Наименование", "Краткое описание", "Полное описание"], severity) : "")),
    page(63, labels.assumptions, table(["Раздел", "Формулировка"], [
      ["Допущения", "<p>Предоставлен доступ к учебному контуру.</p><ol><li>Доступ согласован.</li><li>Назначен учебный контакт.</li></ol>"],
      ["Ограничения", "<p>Сценарий охватывает только демонстрационные операции.</p>"],
    ])),
    page(64, labels.glossary, table(["Термин RU", "Term ENG", "Определение RU"], [
      ["Учебный инцидент", "Training incident", `<p>Сбой демонстрационной операции. <a href="${BASE}/display/DEMO/Glossary">Учебная карточка</a>.</p>`],
      ["Учебное окно", "", '<p>Интервал демонстрационной поддержки. <a href="javascript:alert(1)">Пример</a>.</p><script>BAD_SCRIPT</script>'],
    ])),
  );
  return { ...data, size: data.results.length, totalSize: data.results.length, limit: 50 };
}

export const legacy = () => ({ schemaVersion: 1, source: BASE, pages: [{ pageId: "80", title: "Учебная карточка", storage: card("TS-5.A") }], failures: [] });
