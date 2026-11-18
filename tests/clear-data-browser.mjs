import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { paginate, referenceFixture, REFERENCE_SOURCES } from "./fixtures.mjs";
import { applyBasis, saveTemplate } from "./basis-helper.mjs";

const home = process.env.SSB_DEV_URL ?? "http://127.0.0.1:4173/";
const output = process.env.SSB_SAMPLE_OUTPUT;
const channels = (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",");
const sourceKey = "ssb-dev:ssb:confluence-sources:v1";
const storage = (page) => page.evaluate(() => ({ ...localStorage }));
const sectionKeys = ["intro", "sla", "severity", "assumptions", "glossary"];
const saved = (page) => page.getByText("Черновик сохранён на этом устройстве.", { exact: true }).waitFor({ state: "attached" });
async function record(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("ssb-dev:support-services-builder-drafts", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("proposals");
      const entry = tx.objectStore("proposals").get("/");
      tx.oncomplete = () => { db.close(); resolve(JSON.stringify(entry.result, (_, value) => value instanceof Map ? [...value] : value)); };
      tx.onabort = () => reject(tx.error);
    };
  }));
}
async function upload(page, data) {
  await page.locator("#catalog-file").setInputFiles({ name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });
  await page.waitForFunction(() => !document.querySelector("#upload").disabled && !document.querySelector("#catalog-file").files.length);
  await saved(page);
}
const openSources = (page) => page.locator("#open-sources").click();
const closeSources = (page) => page.locator("#close-sources").click();
const confirm = (page) => page.locator("#confirm-basis").click();
async function standardSelected(page) {
  for (const key of sectionKeys) assert.equal(await page.locator("#include-" + key).isChecked(), true, key);
  assert.equal(await page.locator("#include-raci").isDisabled(), true);
  assert.equal(await page.locator('[name="sla-mode"][value="selected"]').isChecked(), true);
}
if (output) await mkdir(output, { recursive: true });
for (const channel of channels) {
  const browser = await chromium.launch({ channel });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let page = await context.newPage();
    const errors = [];
    context.on("page", (next) => next.on("pageerror", (error) => errors.push(error.message)));
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => { errors.push("Unexpected native dialog"); void dialog.dismiss(); });
    await page.goto(home);
    await page.waitForFunction(() => !document.querySelector("#upload").disabled);
    assert.equal(await page.locator("#clear-data").isDisabled(), true);
    await openSources(page);
    assert.equal(await page.locator("#clear-sources").isDisabled(), true);
    await page.locator("#source-space").fill("UNSAVED");
    assert.equal(await page.locator("#clear-sources").isEnabled(), true);
    await page.locator("#clear-sources").click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#source-space").inputValue(), "UNSAVED");
    await page.locator("#source-base").fill(REFERENCE_SOURCES.base);
    await page.locator("#source-space").fill(REFERENCE_SOURCES.space);
    for (const [key, value] of Object.entries(REFERENCE_SOURCES.labels)) await page.locator("#label-" + key).fill(value);
    await page.locator("#save-sources").click();
    await page.locator("#source-space").fill("DEMO_UPDATED");
    await page.locator("#save-sources").click();
    await page.locator("#source-space").fill(REFERENCE_SOURCES.space);
    await page.locator("#save-sources").click();
    await closeSources(page);
    const full = referenceFixture();
    await upload(page, full);
    await standardSelected(page);
    await page.locator("#include-sla").uncheck();
    await page.locator("#include-glossary").uncheck();
    await saved(page);
    await page.reload();
    await page.getByText("Черновик восстановлен", { exact: true }).waitFor();
    assert.equal(await page.locator('input[name="proposal-basis"][value="corporate"]').isChecked(), true);
    assert.equal(await page.locator("#include-sla").isChecked(), false);
    assert.equal(await page.locator("#include-glossary").isChecked(), false);
    await saveTemplate(page);
    await page.locator("#open-palette").click();
    await page.getByRole("textbox", { name: "Основной цвет — HEX", exact: true }).fill("#556677");
    await page.locator("#save-palette").click();
    await page.locator("#close-palette").click();
    await saved(page);
    const palette = JSON.parse(await record(page)).proposal.palette;
    const beforeStorage = await storage(page);
    await applyBasis(page, "corporate");
    await standardSelected(page);
    await applyBasis(page, "local");
    assert.equal(await page.locator("#include-sla").isChecked(), false);
    assert.equal(await page.locator("#include-glossary").isChecked(), false);
    await saved(page);
    await page.reload();
    await page.getByText("Черновик восстановлен", { exact: true }).waitFor();
    assert.equal(await page.locator("#include-sla").isChecked(), false);
    const baseRecord = await record(page);
    for (const cancel of [() => page.getByRole("button", { name: "Отмена", exact: true }).click(),
      () => page.keyboard.press("Escape"), () => page.getByRole("button", { name: "Закрыть подтверждение", exact: true }).click()]) {
      await page.locator("#clear-data").click();
      await page.getByRole("heading", { name: "Очистить загруженные данные?", exact: true }).waitFor();
      await cancel();
      assert.equal(await record(page), baseRecord);
      assert.deepEqual(await storage(page), beforeStorage);
    }
    if (channel === channels[0] && output) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.mouse.move(1, 1);
      await page.screenshot({ path: join(output, "SSB_DATA_CONTROLS.png") });
      await page.locator("#clear-data").click();
      await page.locator("#basis-dialog").screenshot({ path: join(output, "SSB_CLEAR_DATA_CONFIRM.png") });
      await page.keyboard.press("Escape");
    }
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, mode, options) {
        if (mode === "readwrite") throw new DOMException("Synthetic storage failure", "InvalidStateError");
        return original.call(this, names, mode, options);
      };
      window.restoreDraftWrites = () => { IDBDatabase.prototype.transaction = original; };
    });
    await page.locator("#clear-data").click();
    await confirm(page);
    await page.locator("#data-notice.error").waitFor();
    assert.equal(await record(page), baseRecord);
    assert.equal(await page.locator("#services tr").count(), 6);
    await page.evaluate(() => window.restoreDraftWrites());
    await upload(page, paginate(full, 0, 5));
    await page.locator("#clear-data").click();
    await confirm(page);
    await page.getByText("Данные Confluence очищены", { exact: true }).waitFor();
    assert.equal(await page.locator("#services tr").count(), 0);
    assert.equal(await page.locator("#clear-data").isDisabled(), true);
    assert.equal(await page.locator('[data-format="excel"]').isDisabled(), true);
    assert.equal(await page.locator('[data-format="word"]').isDisabled(), true);
    const empty = JSON.parse(await record(page)).proposal;
    assert.deepEqual(empty.services, []);
    assert.deepEqual(empty.sections, {});
    assert.deepEqual(empty.standard.values, {});
    assert.deepEqual(empty.overrides, []);
    assert.equal(empty.catalog, null);
    assert.deepEqual(empty.palette, palette);
    assert.deepEqual(await storage(page), beforeStorage);
    await upload(page, paginate(full, 5, full.size));
    assert.equal(await page.locator("#services tr").count(), 0);
    await page.locator("#clear-data").click();
    await confirm(page);
    await page.getByText("Данные Confluence очищены", { exact: true }).waitFor();
    await page.close();
    page = await context.newPage();
    await page.goto(home);
    await page.getByText("Черновик восстановлен", { exact: true }).waitFor();
    assert.equal(await page.locator("#confluence-status").textContent(), "Данные Confluence не загружены");
    assert.equal(await page.locator("#services tr").count(), 0);
    assert.equal(await page.locator('input[name="proposal-basis"][value="local"]').isDisabled(), true);
    // The old first REST part must not survive clearing or combine with this continuation.
    await upload(page, paginate(full, 5, full.size));
    assert.equal(await page.locator("#services tr").count(), 0);
    assert.match(await page.locator("#confluence-status").textContent(), /Ошибка загрузки JSON/);
    await page.locator("#clear-data").click();
    await confirm(page);
    await page.getByText("Данные Confluence очищены", { exact: true }).waitFor();
    await upload(page, full);
    assert.equal(await page.locator('input[name="proposal-basis"][value="corporate"]').isChecked(), true);
    await standardSelected(page);
    await applyBasis(page, "local");
    assert.equal(await page.locator("#include-sla").isChecked(), false);
    await saved(page);
    const loaded = await record(page);
    await openSources(page);
    const actions = await page.locator(".source-actions button").evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect(); return { text: button.textContent.replace("×", "").trim(), x: box.x, y: box.y, right: box.right };
    }));
    assert.deepEqual(actions.map(({ text }) => text), ["Очистить настройки источников", "Сохранить источники локально"]);
    assert.equal(actions[0].y, actions[1].y);
    assert.ok(actions[0].x < actions[1].x);
    const fields = await page.locator("#sources-panel input").evaluateAll((inputs) => inputs.map(({ value }) => value));
    for (const cancel of [() => page.getByRole("button", { name: "Отмена", exact: true }).click(),
      () => page.keyboard.press("Escape"), () => page.getByRole("button", { name: "Закрыть подтверждение", exact: true }).click()]) {
      await page.locator("#clear-sources").click();
      await cancel();
      assert.deepEqual(await page.locator("#sources-panel input").evaluateAll((inputs) => inputs.map(({ value }) => value)), fields);
      assert.equal(await record(page), loaded);
    }
    if (channel === channels[0] && output) {
      await page.mouse.move(1, 1);
      await page.locator("#sources-dialog").screenshot({ path: join(output, "SSB_SOURCE_CONTROLS.png") });
      await page.locator("#clear-sources").click();
      await page.locator("#basis-dialog").screenshot({ path: join(output, "SSB_CLEAR_SOURCES_CONFIRM.png") });
      await page.keyboard.press("Escape");
    }
    await page.evaluate((key) => {
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (name) {
        if (name === key) throw new DOMException("Synthetic storage failure", "SecurityError");
        return original.call(this, name);
      };
      window.restoreSourceRemoval = () => { Storage.prototype.removeItem = original; };
    }, sourceKey);
    await page.locator("#clear-sources").click();
    await confirm(page);
    await page.locator("#sources-notice.error").waitFor();
    assert.deepEqual(await storage(page), beforeStorage);
    assert.deepEqual(await page.locator("#sources-panel input").evaluateAll((inputs) => inputs.map(({ value }) => value)), fields);
    await page.evaluate(() => window.restoreSourceRemoval());
    await page.locator("#clear-sources").click();
    await confirm(page);
    await page.getByText("Настройки источников очищены", { exact: true }).waitFor();
    assert.equal(await page.locator("#sources-dialog").isVisible(), true);
    assert.equal(await page.locator("#clear-sources").isDisabled(), true);
    assert.deepEqual(await page.locator("#sources-panel input").evaluateAll((inputs) => inputs.map(({ value }) => value)), Array(9).fill(""));
    assert.equal(await record(page), loaded);
    const expected = { ...beforeStorage };
    delete expected[sourceKey];
    assert.deepEqual(await storage(page), expected);
    await closeSources(page);
    await page.reload();
    await page.getByText("Черновик восстановлен", { exact: true }).waitFor();
    assert.deepEqual(await page.locator("#sources-panel input").evaluateAll((inputs) => inputs.map(({ value }) => value)), Array(9).fill(""));
    assert.equal(await page.locator("#services tr").count(), 6);
    await upload(page, full);
    assert.equal(await page.locator("#services tr").count(), 6);
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator("#clear-data").focus();
      await page.keyboard.press("Enter");
      assert.ok(await page.locator("#basis-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().bottom <= innerHeight));
      await page.keyboard.press("Escape");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await openSources(page);
      await page.locator("#source-space").fill("TEMP");
      await page.locator("#clear-sources").click();
      assert.ok(await page.locator("#basis-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().bottom <= innerHeight));
      await page.keyboard.press("Escape");
      await closeSources(page);
    }
    assert.deepEqual(errors, []);
    console.log(channel + ": persisted data clearing, independent source reset, failure handling, default sections and templates OK");
  } finally { await browser.close(); }
}
