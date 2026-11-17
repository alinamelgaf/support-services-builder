import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { chromium } from "playwright";
import { referenceFixture } from "./fixtures.mjs";

const home = process.env.SSB_DEV_URL ?? "http://127.0.0.1:4173/";
const output = process.env.SSB_SAMPLE_OUTPUT;
const channels = (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",");
const sample = { name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(referenceFixture())) };
const storageKey = "ssb-dev:ssb:document-palette:v1";
const saved = (page) => page.getByText("Черновик сохранён на этом устройстве.", { exact: true }).waitFor();
const hex = (page, name) => page.getByRole("textbox", { name: `${name} — HEX`, exact: true });
const mode = (page, key, value) => page.locator(`input[name="palette-text-${key}"][value="${value}"]`);
const custom = (page) => page.locator('[name="palette-mode"][value="custom"]');
const storedPalette = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);

async function paletteSuccess(page, title, detail) {
  const notice = page.locator("#palette-success");
  await notice.waitFor();
  assert.equal(await notice.locator("strong").textContent(), title);
  assert.equal(await notice.locator("p").textContent(), detail);
  assert.equal(await notice.locator('[aria-hidden="true"]').textContent(), "✓");
  assert.equal(await page.locator("#palette-dialog").isVisible(), true);
  assert.equal(await page.locator("#palette-notice").isVisible(), false);
}

async function toggleStorageFailure(page, method, enabled) {
  await page.evaluate(({ method, enabled, key }) => {
    if (!enabled) {
      window.restorePaletteStorageMethod();
      return;
    }
    const original = Storage.prototype[method];
    Storage.prototype[method] = function (name, ...args) {
      if (this === localStorage && name === key) throw new DOMException("Test storage failure", "QuotaExceededError");
      return original.call(this, name, ...args);
    };
    window.restorePaletteStorageMethod = () => {
      Storage.prototype[method] = original;
      delete window.restorePaletteStorageMethod;
    };
  }, { method, enabled, key: storageKey });
}

async function otherDraft(page, seed = false) {
  return page.evaluate((seed) => new Promise((done, reject) => {
    const request = indexedDB.open("ssb-dev:support-services-builder-drafts", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("proposals", seed ? "readwrite" : "readonly");
      const store = tx.objectStore("proposals");
      const entry = store.get(seed ? "/" : "/another-proposal/");
      if (seed) entry.onsuccess = () => {
        entry.result.proposal.title = "Другое предложение";
        store.put(entry.result, "/another-proposal/");
      };
      tx.oncomplete = () => { db.close(); done(entry.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), seed);
}

async function open(page) {
  await page.locator("#open-palette").click();
  await page.getByRole("dialog", { name: "Палитра документа" }).waitFor();
}

async function upload(page) {
  await page.locator("#catalog-file").setInputFiles(sample);
  await page.getByText(/Услуг загружено 6 из 6/).waitFor();
  await saved(page);
}

async function checkPreview(page, main, mainText, proposal, proposalText, selectedFill) {
  const computed = await page.locator("#palette-preview").evaluate((table) => {
    const [first, selected] = table.querySelectorAll("th");
    return [getComputedStyle(first).backgroundColor, getComputedStyle(first).color,
      getComputedStyle(selected).backgroundColor, getComputedStyle(selected).color,
      getComputedStyle(table.querySelector("td:last-child")).backgroundColor];
  });
  const rgb = (color) => `rgb(${color.match(/../g).map((hex) => parseInt(hex, 16)).join(", ")})`;
  assert.deepEqual(computed, [main, mainText, proposal, proposalText, selectedFill].map(rgb));
}

async function checkDownloads(page, name, colors, destination) {
  const [main, mainText, proposal, proposalText, selectedFill] = colors;
  for (const [format, ext] of [["word", "docx"], ["excel", "xlsx"]]) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-format="${format}"]`).click()]);
    const file = await readFile(await download.path());
    if (destination) await download.saveAs(join(destination, `SLA-Extended-${name}.${ext}`));
    if (format === "excel") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(file);
      for (const title of ["Предложение", "Матрица SLA"]) {
        const sheet = workbook.getWorksheet(title);
        const row = title === "Матрица SLA" ? 3 : sheet.getColumn(1).values.indexOf("ID услуги");
        for (const [cell, background, text] of [[sheet.getCell(row, 1), main, mainText],
          [sheet.getCell(row, 4), proposal, proposalText], [sheet.getCell(row - 1, 4), proposal, proposalText]]) {
          assert.equal(cell.fill.fgColor.argb, "FF" + background);
          assert.equal(cell.font.color.argb, "FF" + text);
        }
        assert.equal(sheet.getCell(row + 1, 4).fill.fgColor.argb, "FF" + selectedFill);
      }
    } else {
      const zip = await JSZip.loadAsync(file);
      const xml = await zip.file("word/document.xml").async("string");
      const tables = [...xml.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)].map(([table]) => table);
      for (const table of tables.slice(0, 2)) {
        for (const [fill, text] of [[main, mainText], [proposal, proposalText]]) {
          assert.ok([...table.matchAll(/<w:tc>.*?<\/w:tc>/gs)].some(([cell]) =>
            cell.includes(`w:fill="${fill}"`) && cell.includes(`w:color w:val="${text}"`)));
        }
        assert.ok(table.includes(`w:fill="${selectedFill}"`));
      }
    }
  }
}

async function newProposal(page, confirm) {
  page.once("dialog", (dialog) => confirm ? dialog.accept() : dialog.dismiss());
  await page.locator("#new-proposal").click();
  if (confirm) await saved(page);
}

if (output) await mkdir(output, { recursive: true });
for (const [index, channel] of channels.entries()) {
  const browser = await chromium.launch({ channel });
  try {
    const context = await browser.newContext();
    const errors = [];
    const external = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    context.on("request", (request) => {
      const url = request.url();
      if (/^https?:/.test(url) && !url.startsWith(home)) external.push(url);
    });
    let page = await context.newPage();
    await page.goto(home);
    await upload(page);
    await page.locator('#variants input[value="Extended"]').check();
    for (const key of ["sla", "severity", "assumptions", "glossary"]) await page.locator("#include-" + key).check();
    await page.locator('[name="sla-mode"][value="all"]').check();
    await page.locator('[name="sla-format"][value="comparison"]').check();
    await page.locator("#client").fill("Учебная организация");
    await page.locator("#title").fill("Учебное предложение по техническому сопровождению");
    await open(page);
    const base = ["234C5E", "FFFFFF", "00AD21", "FFFFFF", "E0F5E4"];
    const reset = () => page.locator("#reset-palette");
    const confirmReset = () => page.getByRole("dialog", { name: "Сбросить локальную палитру?" });
    const saveSuccess = () => paletteSuccess(page, "Палитра сохранена локально", "Выбранная палитра будет применяться по умолчанию к новым предложениям.");
    assert.equal(await reset().isDisabled(), true);
    assert.equal(await custom(page).isChecked(), false);
    await checkPreview(page, ...base);
    assert.match(await page.locator("#palette-warning").textContent(), /цвет предложения/);
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 860 });
      assert.ok(await page.locator("#palette-dialog").evaluate((dialog) => dialog.scrollWidth === dialog.clientWidth));
      for (const group of await page.locator(".palette-text .palette-choices").all()) {
        const tops = await group.locator("input").evaluateAll((radios) => radios.map((radio) => radio.offsetTop));
        assert.equal(new Set(tops).size, 1);
      }
    }
    assert.deepEqual(await page.locator(".palette-links a").evaluateAll((links) => links.map((link) => [link.target, link.rel])),
      [["_blank", "noopener noreferrer"], ["_blank", "noopener noreferrer"]]);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#palette-dialog").isVisible(), false);
    assert.equal(await page.locator("#open-palette").evaluate((button) => button === document.activeElement), true);
    await checkDownloads(page, "base", base, index === 0 && output);

    await open(page);
    await page.locator("#save-palette").click();
    await saveSuccess();
    assert.equal((await storedPalette(page)).mode, "base");
    assert.equal(await reset().isEnabled(), true);
    await custom(page).check();
    assert.equal(await page.locator("#palette-success").isVisible(), false);
    assert.equal(await hex(page, "Основной цвет").inputValue(), "#234C5E");
    await page.locator('[name="palette-mode"][value="base"]').check();
    await hex(page, "Основной цвет").fill("#zzzzzz");
    assert.equal(await custom(page).isChecked(), true);
    assert.equal(await hex(page, "Основной цвет").getAttribute("aria-invalid"), "true");
    assert.ok(await page.locator("#save-palette").isDisabled());
    await checkPreview(page, ...base);
    await page.locator('#palette-colors input[type="color"]').first().fill("#f7dc94");
    assert.equal(await hex(page, "Основной цвет").inputValue(), "#F7DC94");
    await hex(page, "Цвет предложения").fill("#683ca0");
    await mode(page, "main", "custom").check();
    await hex(page, "Основной цвет — цвет текста").fill("#F7DC94");
    assert.match(await page.locator("#palette-warning").textContent(), /основной цвет/);
    await mode(page, "main", "default").check();
    await mode(page, "main", "auto").check();
    await mode(page, "proposal", "auto").check();
    await checkPreview(page, "F7DC94", "000000", "683CA0", "FFFFFF", "EDE8F4");
    await mode(page, "proposal", "default").check();
    await mode(page, "proposal", "custom").check();
    await page.getByLabel("Цвет предложения — цвет текста", { exact: true }).fill("#fff0dc");
    const customColors = ["F7DC94", "000000", "683CA0", "FFF0DC", "EDE8F4"];
    await checkPreview(page, ...customColors);
    assert.equal(await page.locator("#palette-warning").isVisible(), false);
    assert.equal((await storedPalette(page)).mode, "base");

    await toggleStorageFailure(page, "setItem", true);
    await page.locator("#save-palette").click();
    assert.equal(await page.locator("#palette-notice.error").textContent(), "Не удалось сохранить палитру локально.");
    assert.equal(await page.locator("#palette-success").isVisible(), false);
    assert.equal((await storedPalette(page)).mode, "base");
    await toggleStorageFailure(page, "setItem", false);
    await page.locator("#save-palette").click();
    await saveSuccess();
    assert.equal((await storedPalette(page)).proposal.textColor, "#FFF0DC");
    await hex(page, "Цвет предложения — цвет текста").fill("#FFFFFF");
    assert.equal(await page.locator("#palette-success").isVisible(), false);
    await page.locator("#save-palette").click();
    await saveSuccess();
    assert.equal((await storedPalette(page)).proposal.textColor, "#FFFFFF");
    await hex(page, "Цвет предложения — цвет текста").fill("#FFF0DC");
    await page.locator("#save-palette").click();
    await saveSuccess();
    await page.locator("#close-palette").click();
    assert.equal(await page.locator("#palette-dialog").isVisible(), false);
    await checkDownloads(page, "custom", customColors, index === 0 && output);
    await saved(page);
    await page.close();
    page = await context.newPage();
    await page.goto(home);
    await page.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    await open(page);
    await checkPreview(page, ...customColors);
    assert.equal(await reset().isEnabled(), true);
    await page.locator("#close-palette").click();
    await upload(page);
    await open(page);
    await checkPreview(page, ...customColors);
    await hex(page, "Основной цвет").fill("#332244");
    await page.locator("#close-palette").click();
    await newProposal(page, false);
    await open(page);
    assert.equal(await hex(page, "Основной цвет").inputValue(), "#332244");
    await page.locator("#close-palette").click();
    await newProposal(page, true);
    assert.equal(await page.locator("#client").inputValue(), "");
    assert.match(await page.locator("#catalog-summary").textContent(), /Услуг загружено 6 из 6/);
    await page.locator('#variants input[value="Extended"]').check();
    await page.locator("#include-sla").check();
    await page.locator('[name="sla-mode"][value="all"]').check();
    await page.locator('[name="sla-format"][value="comparison"]').check();
    await saved(page);
    const previous = await otherDraft(page, true);
    assert.equal(previous.proposal.palette.proposal.background, "#683CA0");
    await page.evaluate(() => localStorage.setItem("ssb-test-unrelated-preference", "preserved"));
    await open(page);
    await checkPreview(page, ...customColors);
    const beforeReset = await storedPalette(page);
    await page.setViewportSize({ width: 320, height: 650 });
    for (const cancel of [
      () => confirmReset().getByRole("button", { name: "Отмена" }).click(),
      () => page.keyboard.press("Escape"),
      () => confirmReset().getByRole("button", { name: "Закрыть подтверждение" }).click(),
    ]) {
      await reset().click();
      await confirmReset().waitFor();
      assert.match(await confirmReset().textContent(), /Текущее предложение также переключится на «Базовая»/);
      assert.equal(await confirmReset().evaluate((dialog) => dialog.scrollWidth === dialog.clientWidth), true);
      assert.equal(await confirmReset().getByRole("button", { name: "Отмена" }).evaluate((button) => document.activeElement === button), true);
      await cancel();
      assert.equal(await confirmReset().isVisible(), false);
      assert.equal(await page.locator("#palette-dialog").isVisible(), true);
      await checkPreview(page, ...customColors);
      assert.deepEqual(await storedPalette(page), beforeReset);
    }
    await page.setViewportSize({ width: 1280, height: 860 });
    await toggleStorageFailure(page, "removeItem", true);
    await reset().click();
    await confirmReset().getByRole("button", { name: "Сбросить", exact: true }).click();
    assert.equal(await page.locator("#palette-notice.error").textContent(), "Не удалось сбросить локальную палитру.");
    assert.equal(await page.locator("#palette-success").isVisible(), false);
    assert.deepEqual(await storedPalette(page), beforeReset);
    await checkPreview(page, ...customColors);
    await toggleStorageFailure(page, "removeItem", false);

    await reset().click();
    await confirmReset().getByRole("button", { name: "Сбросить", exact: true }).click();
    await paletteSuccess(page, "Локальная палитра сброшена", "Применена базовая палитра.");
    assert.equal(await confirmReset().isVisible(), false);
    await checkPreview(page, ...base);
    assert.equal(await custom(page).isChecked(), false);
    assert.equal(await mode(page, "main", "default").isChecked(), true);
    assert.equal(await mode(page, "proposal", "default").isChecked(), true);
    assert.equal(await storedPalette(page), null);
    assert.equal(await reset().isDisabled(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("ssb-test-unrelated-preference")), "preserved");
    await page.locator("#close-palette").click();
    await saved(page);
    assert.deepEqual(await otherDraft(page), previous);
    await checkDownloads(page, "after-reset", base);
    await upload(page);
    await page.reload();
    await page.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    await open(page);
    await checkPreview(page, ...base);
    assert.equal(await reset().isDisabled(), true);
    await page.locator("#close-palette").click();
    await newProposal(page, true);
    await open(page);
    await checkPreview(page, ...base);

    // Remove just the new field from the test profile to reproduce the previous draft format.
    await custom(page).check();
    await hex(page, "Цвет предложения").fill("#121212");
    await page.locator("#save-palette").click();
    await page.locator("#close-palette").click();
    await saved(page);
    await page.evaluate(async () => {
      await new Promise((done, reject) => {
        const request = indexedDB.open("ssb-dev:support-services-builder-drafts", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("proposals", "readwrite");
          const store = tx.objectStore("proposals");
          const entry = store.get("/");
          entry.onsuccess = () => {
            delete entry.result.proposal.palette;
            store.put(entry.result, "/");
          };
          tx.oncomplete = () => { db.close(); done(); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
    });
    await page.reload();
    await page.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    await open(page);
    await checkPreview(page, ...base);
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).proposal.background, storageKey), "#121212");
    assert.equal(await reset().isEnabled(), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(`${channel}: document palette, draft, local settings, Word and Excel OK`);
  } finally {
    await browser.close();
  }
}
