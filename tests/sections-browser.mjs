import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { referenceFixture, REFERENCE_SOURCES } from "./fixtures.mjs";

const home = process.env.SSB_DEV_URL ?? "http://127.0.0.1:4173/";
const output = process.env.SSB_SAMPLE_OUTPUT;
const channels = (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",");
const keys = ["sla", "severity", "assumptions", "glossary"];
const names = ["Матрица SLA", "Уровни критичности", "Допущения и ограничения", "Глоссарий"];
const include = (page, key) => page.locator("#include-" + key);
const mode = (page, value) => page.locator(`input[name="sla-mode"][value="${value}"]`);
const variant = (page, code) => page.locator(`input[name="proposal-variant"][value="${code}"]`);

async function upload(page, data) {
  await page.locator("#catalog-file").setInputFiles({
    name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)),
  });
  await page.getByText("Черновик сохранён на этом устройстве.").waitFor();
}

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
    assert.equal(await page.title(), "SSB — Тестовая версия");
    await page.locator("#sources-panel summary").click();
    await page.locator("#source-base").fill(REFERENCE_SOURCES.base);
    await page.locator("#source-space").fill(REFERENCE_SOURCES.space);
    for (const [key, label] of Object.entries(REFERENCE_SOURCES.labels)) await page.locator("#label-" + key).fill(label);
    await page.locator("#save-sources").click();
    assert.equal(await include(page, "sla").isDisabled(), true);
    assert.match(await page.locator("#reason-sla").textContent(), /Источник не загружен/);
    await upload(page, referenceFixture());
    assert.equal(await page.locator("[contenteditable], #intro-toolbar, #intro-excel, #intro-word").count(), 0);
    assert.equal(await include(page, "intro").isChecked(), true);
    assert.equal(await include(page, "raci").isDisabled(), true);
    assert.equal(await page.locator("#reason-raci").textContent(), "Пока не реализовано");
    for (const key of keys) {
      assert.equal(await include(page, key).isEnabled(), true);
      assert.equal(await include(page, key).isChecked(), false);
    }
    assert.equal(await mode(page, "selected").isDisabled(), true);
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
    for (const [code, reaction] of [["Standard", "45 минут"], ["Managed Service", "35 минут"], ["Extended", "20 минут"]]) {
      await variant(page, code).check();
      const word = await exportFile(page, "word");
      assert.ok(word.text.includes("Пример " + code));
      assert.ok(word.text.includes(reaction));
    }
    await page.locator("#client").fill("Учебная организация");
    await page.locator("#title").fill("Учебное предложение по техническому сопровождению");
    for (const slaMode of ["selected", "all"]) {
      await mode(page, slaMode).check();
      for (const format of ["excel", "word"]) {
        const extension = format === "excel" ? "xlsx" : "docx";
        const sample = output && !index ? join(output, `SLA-Extended-${slaMode}.${extension}`) : undefined;
        const file = await exportFile(page, format, sample);
        for (const name of names) assert.ok(file.sections.includes(name));
        assert.match(file.text, /Пример Extended/);
        assert.match(file.text, /Учебная организация/);
        assert.match(file.text, /20 минут/);
        assert.equal(file.text.includes("Extended ✓"), slaMode === "all");
        assert.doesNotMatch(file.text + file.sections, /wiki\.example\.invalid|BAD_SCRIPT|Матрица RACI/);
      }
    }
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
    await page.reload();
    await page.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    for (const key of keys) assert.equal(await include(page, key).isChecked(), true);
    assert.equal(await mode(page, "all").isChecked(), true);
    assert.equal(await variant(page, "Extended").isChecked(), true);
    assert.equal(await page.locator("#client").inputValue(), "Учебная организация");

    await upload(page, referenceFixture({ alterSla: () => null }));
    assert.equal(await include(page, "sla").isDisabled(), true);
    assert.equal(await include(page, "severity").isChecked(), true);
    assert.match(await page.locator("#reason-sla").textContent(), /отсутствует|заголовки/);
    const updated = referenceFixture({
      alterSla: (rows) => rows.map((row) => row[0] === "10" && row[1] === "Extended"
        ? row.map((value) => value === "20 минут" ? "25 минут" : value) : row),
    });
    await upload(page, updated);
    assert.equal(await include(page, "sla").isChecked(), true);
    assert.equal(await mode(page, "all").isChecked(), true);
    assert.match((await exportFile(page, "word")).text, /25 минут/);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log(channel + ": section toggles, SLA modes, exports, reimport, draft persistence and no external requests — OK");
  } finally {
    await browser.close();
  }
}
