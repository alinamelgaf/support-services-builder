import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { referenceFixture, REFERENCE_SOURCES, SUPPORT_NAMES } from "./fixtures.mjs";

const home = process.env.SSB_DEV_URL ?? "http://127.0.0.1:4173/";
const production = process.env.SSB_SECTIONS_PRODUCTION === "1";
const output = process.env.SSB_SAMPLE_OUTPUT;
const channels = (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",");
const keys = ["sla", "severity", "assumptions", "glossary"];
const names = ["Матрица SLA", "Уровни критичности", "Допущения и ограничения", "Глоссарий"];
const include = (page, key) => page.locator("#include-" + key);
const mode = (page, value) => page.locator(`input[name="sla-mode"][value="${value}"]`);
const slaFormat = (page, value) => page.locator(`input[name="sla-format"][value="${value}"]`);
const variant = (page, code) => page.locator(`input[name="proposal-variant"][value="${code}"]`);

async function upload(page, data) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Загрузить JSON" }).click(),
  ]);
  await chooser.setFiles({
    name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)),
  });
  await page.getByText("Черновик сохранён на этом устройстве.").waitFor();
}

const withoutMetadata = (data) => ({ ...data, results: data.results.map(({ metadata, ...item }) => item) });

async function exportFile(page, format, sample) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(`[data-format=${format}]`).click(),
  ]);
  if (sample) await download.saveAs(sample);
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const xml = (path) => zip.file(path).async("string");
  return format === "excel" ? {
    text: await xml("xl/sharedStrings.xml"), sections: await xml("xl/workbook.xml"),
  } : {
    text: await xml("word/document.xml"), sections: await xml("word/document.xml"),
  };
}

if (output) await mkdir(output, { recursive: true });
for (const [index, channel] of channels.entries()) {
  const browser = await chromium.launch({ channel });
  try {
    const context = await browser.newContext();
    const external = [];
    const errors = [];
    context.on("request", (request) => {
      if (request.url().startsWith("http") && !request.url().startsWith(home)) external.push(request.url());
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(home);
    assert.equal(await page.title(), production ? "Support Services Builder" : "SSB — Тестовая версия");
    assert.equal(await page.locator("#sources-panel").getAttribute("open"), null);
    assert.deepEqual(await page.locator("#sources-panel input").evaluateAll((fields) => fields.map((field) => field.value)), Array(9).fill(""));
    assert.equal(await page.locator("#sources-notice").isVisible(), false);
    assert.equal(await page.locator("#source-link").isVisible(), false);
    assert.equal(await include(page, "sla").isDisabled(), true);
    assert.match(await page.locator("#reason-sla").textContent(), /Источник не загружен/);
    await upload(page, withoutMetadata(referenceFixture()));
    const summary = await page.locator("#catalog-summary").textContent();
    assert.match(summary, /Услуг загружено 6 из 6/);
    for (const name of ["Базовая конфигурация", "Вводный текст", ...names]) assert.ok(summary.includes(name));
    assert.equal(await page.locator("#catalog-notice").isVisible(), false);
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [code, name] of Object.entries(SUPPORT_NAMES)) {
        const label = page.getByRole("radio", { name: code + " " + name, exact: true }).locator("..").locator("small");
        assert.equal(await label.textContent(), name);
        assert.ok(await label.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1));
        assert.equal(await page.locator(`#columns th[data-variant="${code}"] small`).textContent(), name);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.locator("[contenteditable], #intro-toolbar, #intro-excel, #intro-word").count(), 0);
    assert.equal(await include(page, "intro").isChecked(), true);
    assert.equal(await include(page, "raci").isDisabled(), true);
    assert.equal(await page.locator("#reason-raci").textContent(), "Пока не реализовано");
    for (const key of keys) {
      assert.equal(await include(page, key).isEnabled(), true);
      assert.equal(await include(page, key).isChecked(), false);
    }
    assert.equal(await mode(page, "selected").isDisabled(), true);
    assert.equal(await page.locator("#sla-formats").isVisible(), false);
    await include(page, "intro").uncheck();
    for (const format of ["excel", "word"]) {
      const empty = await exportFile(page, format);
      for (const name of names) assert.ok(!empty.sections.includes(name));
      assert.doesNotMatch(empty.text, /Пример Standard|Пример Extended|Учебное определение 10/);
      assert.match(empty.text, /TS-1/);
    }
    await include(page, "intro").check();
    for (const key of keys) await include(page, key).check();
    assert.equal(await mode(page, "selected").isChecked(), true);
    assert.equal(await page.locator("#sla-formats").isVisible(), false);
    for (const [code, reaction] of [["Standard", "45 минут"], ["Managed Service", "35 минут"], ["Extended", "20 минут"]]) {
      await variant(page, code).check();
      const word = await exportFile(page, "word");
      assert.ok(word.text.includes("Пример " + code));
      assert.ok(word.text.includes(reaction));
    }
    await page.locator("#client").fill("Учебная организация");
    await page.locator("#title").fill("Учебное предложение по техническому сопровождению");
    await mode(page, "all").check();
    assert.equal(await slaFormat(page, "comparison").isChecked(), true);
    const samplePath = (layout, format) => output && !index
      ? join(output, `SLA-Extended-${layout}.${format === "excel" ? "xlsx" : "docx"}`) : undefined;
    for (const layout of ["comparison", "separate"]) {
      await slaFormat(page, layout).check();
      for (const format of ["excel", "word"]) {
        const file = await exportFile(page, format, samplePath(layout, format));
        for (const name of names) assert.ok(file.sections.includes(name));
        assert.match(file.text, /Пример Extended/);
        assert.match(file.text, /Учебная организация/);
        assert.match(file.text, /20 минут/);
        if (layout === "separate") assert.match(file.text, /Extended ✓/);
        else if (format === "word") {
          const sla = file.text.slice(file.text.indexOf("Матрица SLA"), file.text.indexOf("Уровни критичности"));
          assert.match(sla, /Предложение.*?Extended/);
          assert.doesNotMatch(sla, /✓/);
        }
        for (const name of Object.values(SUPPORT_NAMES)) assert.ok(file.text.includes(name));
        assert.equal(file.text.includes("Extended ✓ — Предложение"), layout === "separate");
        assert.doesNotMatch(file.text + file.sections, /wiki\.example\.invalid|BAD_SCRIPT|Матрица RACI|Часы работы/);
      }
    }
    await mode(page, "selected").check();
    assert.equal(await page.locator("#sla-formats").isVisible(), false);
    for (const format of ["excel", "word"]) {
      const single = await exportFile(page, format, samplePath("selected", format));
      assert.match(single.text, /20 минут/);
      assert.match(single.text, /10 — Критический/);
      assert.doesNotMatch(single.text, /Extended ✓|35 минут|45 минут|Часы работы/);
    }
    await mode(page, "all").check();
    assert.equal(await slaFormat(page, "separate").isChecked(), true);
    for (const [i, key] of keys.entries()) {
      await include(page, key).uncheck();
      for (const format of ["excel", "word"]) {
        const file = await exportFile(page, format);
        assert.ok(!file.sections.includes(names[i]));
        for (const name of names.filter((_, j) => j !== i)) assert.ok(file.sections.includes(name));
      }
      await include(page, key).check();
    }
    await page.getByText("Черновик сохранён на этом устройстве.").waitFor();
    await page.evaluate((prefix) => new Promise((resolve, reject) => {
      const open = indexedDB.open(prefix + "support-services-builder-drafts");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("proposals", "readwrite");
        const store = tx.objectStore("proposals");
        const scope = new URL(".", location.href).pathname;
        const read = store.get(scope);
        read.onsuccess = () => {
          const record = read.result;
          for (const row of record.proposal.sections.sla.data) row.values.unshift("Старые часы из черновика");
          store.put(record, scope);
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), production ? "" : "ssb-dev:");
    await page.reload();
    await page.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    for (const key of keys) assert.equal(await include(page, key).isChecked(), true);
    assert.equal(await mode(page, "all").isChecked(), true);
    assert.equal(await slaFormat(page, "separate").isChecked(), true);
    assert.equal(await variant(page, "Extended").isChecked(), true);
    assert.equal(await page.locator("#client").inputValue(), "Учебная организация");
    for (const format of ["excel", "word"]) {
      const restored = await exportFile(page, format);
      assert.match(restored.text, /20 минут/);
      assert.match(restored.text, /50 минут/);
      assert.doesNotMatch(restored.text, /Старые часы из черновика/);
    }

    await upload(page, withoutMetadata(referenceFixture({ alterSla: () => null })));
    assert.equal(await include(page, "sla").isDisabled(), true);
    assert.equal(await include(page, "severity").isChecked(), true);
    assert.match(await page.locator("#reason-sla").textContent(), /отсутствует|заголовки/);
    const updated = referenceFixture({
      alterSla: (rows) => rows.map((row) => row[0] === "10" && row[1] === "Extended"
        ? row.map((value) => value === "20 минут" ? "25 минут" : value) : row),
    });
    await upload(page, withoutMetadata(updated));
    assert.equal(await include(page, "sla").isChecked(), true);
    assert.equal(await mode(page, "all").isChecked(), true);
    assert.equal(await slaFormat(page, "separate").isChecked(), true);
    assert.match((await exportFile(page, "word")).text, /25 минут/);
    const duplicate = { ...structuredClone(updated.results.at(-1)), id: "66", title: "Другой учебный глоссарий", metadata: { labels: [] } };
    const ambiguous = { ...updated, results: [...updated.results, duplicate], size: updated.size + 1, totalSize: updated.totalSize + 1 };
    await upload(page, ambiguous);
    assert.equal(await include(page, "glossary").isDisabled(), true);
    assert.match(await page.locator("#issue-list").textContent(), /Глоссарий.*неоднозначен.*64.*66/);
    assert.equal(await include(page, "sla").isEnabled(), true);

    await page.locator("#sources-panel summary").click();
    await page.locator("#source-base").fill(REFERENCE_SOURCES.base);
    await page.locator("#source-space").fill(REFERENCE_SOURCES.space);
    for (const [key, label] of Object.entries(REFERENCE_SOURCES.labels)) await page.locator("#label-" + key).fill(label);
    await page.locator("#save-sources").click();
    assert.equal(await page.locator("#source-link").isVisible(), true);
    await upload(page, ambiguous);
    assert.equal(await include(page, "glossary").isEnabled(), true);
    assert.equal(await page.locator("#catalog-notice").isVisible(), false);

    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log(channel + ": empty-settings import, source recognition and ambiguity, configured import, reimport, exports and draft — OK");
  } finally {
    await browser.close();
  }
}
