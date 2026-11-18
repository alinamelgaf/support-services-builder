import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import JSZip from "jszip";
import { fixture, referenceFixture } from "./fixtures.mjs";
import { applyBasis, saveTemplate } from "./basis-helper.mjs";

const home = process.env.SSB_DEV_URL ?? "http://127.0.0.1:4173/";
const output = process.env.SSB_SAMPLE_OUTPUT;
const key = "ssb-dev:support-services-builder-defaults:v3";
const channels = (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",");
const basis = (page, name) => page.locator(`input[name="proposal-basis"][value="${name}"]`);
const parameter = (page, code = "Standard", id = "TS-1") => page.getByRole("textbox", { name: `Параметр ${id} в ${code}`, exact: true });
const saved = (page) => page.getByText("Черновик сохранён на этом устройстве.", { exact: true }).waitFor({ state: "attached" });
const stored = (page) => page.evaluate((key) => localStorage.getItem(key), key);
async function upload(page, data) {
  await page.locator("#catalog-file").setInputFiles({ name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });
  await page.waitForFunction(() => !document.querySelector("#upload").disabled && !document.querySelector("#catalog-file").files.length);
  await saved(page);
}
async function record(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("ssb-dev:support-services-builder-drafts", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("proposals");
      const get = tx.objectStore("proposals").get("/");
      tx.oncomplete = () => {
        const result = get.result;
        result.proposal.overrides = [...result.proposal.overrides].map(([id, values]) => [id, [...values]]);
        result.proposal.documentOverrides = [...result.proposal.documentOverrides];
        db.close(); resolve(result);
      };
      tx.onabort = () => reject(tx.error);
    };
  }));
}
async function checkExports(page) {
  for (const format of ["word", "excel"]) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-format="${format}"]`).click()]);
    const zip = await JSZip.loadAsync(await readFile(await download.path()));
    const xml = await zip.file(format === "word" ? "word/document.xml" : "xl/sharedStrings.xml").async("string");
    assert.match(xml, /Предложение по техническому сопровождению/);
    assert.doesNotMatch(xml, /Старый клиент|Старое название|Клиент —/);
  }
}
async function customPalette(page) {
  await page.locator("#open-palette").click();
  await page.getByRole("textbox", { name: "Основной цвет — HEX", exact: true }).fill("#334455");
  await page.locator('[name="palette-text-main"][value="auto"]').check();
  await page.locator("#close-palette").click();
  await saved(page);
}

if (output) await mkdir(output, { recursive: true });
for (const channel of channels) {
  const browser = await chromium.launch({ channel });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => { errors.push("Unexpected native dialog: " + dialog.message()); void dialog.dismiss(); });
    context.on("request", (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith(home)) external.push(request.url()); });
    await page.goto(home);
    await page.waitForFunction(() => !document.querySelector("#upload").disabled);
    assert.equal(await page.locator("#client, #title, #new-proposal, #apply-standard, #reset, #save-defaults, #export-defaults, #import-defaults, #defaults-file").count(), 0);
    assert.equal(await basis(page, "corporate").isDisabled(), true);
    assert.equal(await basis(page, "local").isDisabled(), true);
    await upload(page, referenceFixture());
    assert.equal(await basis(page, "corporate").isChecked(), true);
    assert.equal(await basis(page, "local").isDisabled(), true);
    assert.equal(await page.locator("#save-template").isEnabled(), true);
    await page.locator('#variants input[value="Managed Service"]').check();
    await page.locator("#include-intro").uncheck();
    for (const name of ["sla", "severity", "glossary"]) await page.locator("#include-" + name).check();
    await page.locator('[name="sla-mode"][value="all"]').check();
    await page.locator('[name="sla-format"][value="separate"]').check();
    await parameter(page).fill("8 часов");
    await page.getByRole("checkbox", { name: "Включена TS-1 в Managed Service", exact: true }).check();
    await parameter(page, "Managed Service").fill("Сохранённый исключённый параметр");
    await page.getByRole("checkbox", { name: "Включена TS-1 в Managed Service", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "Включить в документ TS-1.A", exact: true }).uncheck();
    await customPalette(page);
    const palette = (await record(page)).proposal.palette;
    await page.evaluate(() => localStorage.setItem("synthetic-unrelated-preference", "preserved"));
    await saveTemplate(page);
    await page.getByText("Мой шаблон сохранён локально", { exact: true }).waitFor();
    assert.equal(await basis(page, "local").isChecked(), true);
    assert.equal(await page.locator("#basis-status").isVisible(), false);
    const first = await stored(page);
    const template = JSON.parse(first);
    assert.equal(template.selected, "Managed Service");
    assert.equal(template.documentOptions.slaMode, "all");
    assert.equal(template.documentOptions.slaFormat, "separate");
    assert.equal(template.excludedParameters["TS-1"]["Managed Service"], "Сохранённый исключённый параметр");
    for (const field of ["palette", "client", "title", "services", "sections"]) assert.equal(Object.hasOwn(template, field), false);
    await parameter(page).fill("9 часов");
    await page.locator('#variants input[value="Extended"]').check();
    await saved(page);
    assert.equal(await stored(page), first);
    assert.equal(await page.locator("#draft-notice").isVisible(), false);
    const edited = await record(page);
    for (const cancel of [() => page.getByRole("button", { name: "Отмена", exact: true }).click(),
      () => page.keyboard.press("Escape"), () => page.getByRole("button", { name: "Закрыть подтверждение", exact: true }).click()]) {
      await basis(page, "corporate").click();
      await page.getByRole("heading", { name: "Применить другую основу?", exact: true }).waitFor();
      await cancel();
      assert.equal(await basis(page, "local").isChecked(), true);
      assert.deepEqual(await record(page), edited);
    }
    await applyBasis(page, "corporate");
    assert.equal(await parameter(page).inputValue(), "12 часов");
    assert.equal(await page.locator('#variants input[value="Standard"]').isChecked(), true);
    assert.equal(await page.locator("#include-sla").isChecked(), true);
    assert.equal(await page.locator('[name="sla-mode"][value="selected"]').isChecked(), true);
    assert.equal(await page.locator('[name="sla-format"][value="comparison"]').isChecked(), true);
    assert.equal(await page.getByRole("checkbox", { name: "Включить в документ TS-1.A", exact: true }).isChecked(), true);
    await applyBasis(page, "local");
    assert.equal(await page.locator("#basis-dialog").isVisible(), false);
    assert.equal(await parameter(page).inputValue(), "8 часов");
    assert.equal(await parameter(page, "Managed Service").inputValue(), "Сохранённый исключённый параметр");
    assert.equal(await page.locator('#variants input[value="Managed Service"]').isChecked(), true);
    assert.equal(await page.locator('[name="sla-format"][value="separate"]').isChecked(), true);
    assert.equal(await page.locator("#include-sla").isChecked(), true);
    assert.deepEqual((await record(page)).proposal.palette, palette);
    await parameter(page).fill("9 часов");
    await page.locator("#save-template").click();
    await page.getByRole("heading", { name: "Заменить мой шаблон?", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await stored(page), first);
    await saveTemplate(page, false);
    assert.equal(await stored(page), first);
    await saveTemplate(page);
    await page.getByText("Мой шаблон обновлён", { exact: true }).waitFor();
    const updated = await stored(page);
    assert.notEqual(updated, first);
    assert.equal(await page.locator("#basis-status").isVisible(), false);

    await page.evaluate((key) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException("Synthetic write failure", "QuotaExceededError");
        return original.call(this, name, value);
      };
      window.restoreTemplateStorage = () => { Storage.prototype.setItem = original; };
    }, key);
    await parameter(page).fill("11 часов");
    await saveTemplate(page);
    await page.locator("#defaults-notice.error").waitFor();
    assert.equal(await stored(page), updated);
    assert.equal(await parameter(page).inputValue(), "11 часов");
    await page.evaluate(() => window.restoreTemplateStorage());
    await page.reload();
    await page.getByText("Черновик восстановлен", { exact: true }).waitFor();
    assert.equal(await basis(page, "local").isChecked(), true);
    assert.equal(await parameter(page).inputValue(), "11 часов");
    assert.equal(await stored(page), updated);
    await applyBasis(page, "local");
    assert.equal(await parameter(page).inputValue(), "9 часов");
    assert.deepEqual((await record(page)).proposal.palette, palette);
    await checkExports(page);

    const next = fixture({ parameter: "20 часов", extra: true, unknown: false, adversarial: false });
    next.results = next.results.filter((item) => !item.body.storage.value.includes('<th>ID услуги</th><td>TS-10</td>'));
    next.size = next.totalSize = next.results.length;
    await upload(page, next);
    assert.equal(await stored(page), updated);
    assert.equal(await parameter(page).inputValue(), "9 часов");
    assert.equal(await parameter(page, "Extended", "TS-3.B").inputValue(), "6 часов");
    assert.equal(await page.locator("#services .service-id").getByText("TS-10", { exact: true }).count(), 0);
    assert.equal(await page.locator("#include-sla").isDisabled(), true);
    await checkExports(page);
    await applyBasis(page, "corporate");
    assert.equal(await parameter(page).inputValue(), "20 часов");
    await applyBasis(page, "local");
    assert.equal(await parameter(page).inputValue(), "9 часов");
    await upload(page, referenceFixture());
    if (channel === channels[0] && output) {
      await page.mouse.move(2, 2);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(output, "SSB_TEMPLATE_TOP.png") });
      await page.locator(".defaults-tools").screenshot({ path: join(output, "SSB_TEMPLATE_BASIS.png") });
    }
    await parameter(page).fill("-");
    assert.equal(await page.locator("#save-template").isDisabled(), true);
    await applyBasis(page, "local");
    assert.equal(await parameter(page).inputValue(), "9 часов");
    assert.equal(await page.evaluate(() => localStorage.getItem("synthetic-unrelated-preference")), "preserved");
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator("#save-template").click();
      assert.ok(await page.locator("#basis-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().bottom <= innerHeight));
      await page.keyboard.press("Escape");
    }

    // Reproduce the previous draft and manager-settings formats in another isolated profile.
    const previousRecord = await record(page);
    const legacy = await browser.newContext();
    const oldPage = await legacy.newPage();
    await oldPage.goto(home);
    await oldPage.waitForFunction(() => !document.querySelector("#upload").disabled);
    const oldSettings = { format: template.format, schemaVersion: 2, values: template.values, includedInDocument: template.includedInDocument };
    await oldPage.evaluate(async ({ record, settings }) => {
      localStorage.setItem("ssb-dev:support-services-builder-defaults:v2", JSON.stringify(settings));
      record.proposal.client = "Старый клиент";
      record.proposal.title = "Старое название";
      record.proposal.selected = "Extended";
      record.proposal.overrides = new Map(record.proposal.overrides.map(([id, variants]) => [id, new Map(variants)]));
      record.proposal.documentOverrides = new Map(record.proposal.documentOverrides);
      await new Promise((done, reject) => {
        const request = indexedDB.open("ssb-dev:support-services-builder-drafts", 1);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("proposals", "readwrite");
          tx.objectStore("proposals").put(record, "/");
          tx.oncomplete = () => { db.close(); done(); };
          tx.onabort = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    }, { record: previousRecord, settings: oldSettings });
    await oldPage.reload();
    await oldPage.getByText("Черновик восстановлен", { exact: true }).waitFor();
    assert.equal(await oldPage.locator('#variants input[value="Extended"]').isChecked(), true);
    assert.equal(await basis(oldPage, "local").isEnabled(), true);
    assert.equal(await stored(oldPage), null);
    await checkExports(oldPage);
    await applyBasis(oldPage, "corporate");
    await applyBasis(oldPage, "local");
    assert.equal(await oldPage.locator('#variants input[value="Standard"]').isChecked(), true);
    assert.equal(await oldPage.locator("#include-sla").isChecked(), false);
    await saveTemplate(oldPage);
    assert.ok(await stored(oldPage));
    assert.deepEqual(await oldPage.evaluate(() => JSON.parse(localStorage.getItem("ssb-dev:support-services-builder-defaults:v2"))), oldSettings);
    await legacy.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(channel + ": full personal template, confirmations, quiet drafts, migration, catalog updates and universal exports OK");
  } finally { await browser.close(); }
}
