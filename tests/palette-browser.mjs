import { applyBasis, saveTemplate } from "./basis-helper.mjs";
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
const saved = (page) => page.getByText("Черновик сохранён на этом устройстве.", { exact: true }).waitFor({ state: "attached" });
const hex = (page, name) => page.getByRole("textbox", { name: `${name} — HEX`, exact: true });
const mode = (page, key, value) => page.locator(`input[name="palette-text-${key}"][value="${value}"]`);
const custom = (page) => page.locator('[name="palette-mode"][value="custom"]');
const storedPalette = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);

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

async function open(page) {
  await page.locator("#open-palette").click();
  await page.getByRole("dialog", { name: "Палитра документа" }).waitFor();
}

async function upload(page) {
  await page.locator("#catalog-file").setInputFiles(sample);
  await page.waitForFunction(() => document.querySelectorAll("#services tr").length === 6);
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

if (output) await mkdir(output, { recursive: true });
for (const [index, channel] of channels.entries()) {
  const browser = await chromium.launch({ channel });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors = [], external = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    context.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(home)) external.push(request.url());
    });
    let page = await context.newPage();
    await page.goto(home);
    await page.waitForFunction(() => !document.querySelector("#upload").disabled);
    assert.equal(await page.locator(".dev-badge").textContent(), "ТЕСТОВАЯ");
    assert.match(await page.locator("#version").textContent(), /-dev$/);
    assert.equal(await page.getByText("Тестовая версия · Данные хранятся отдельно от рабочей версии", { exact: true }).count(), 0);
    if (index === 0 && output) await page.screenshot({ path: join(output, "SSB_TEST_HEADER.png") });
    await open(page);
    const base = ["234C5E", "FFFFFF", "00AD21", "FFFFFF", "E0F5E4"];
    const own = ["F7DC94", "000000", "683CA0", "FFF0D5", "EDE8F4"];
    await checkPreview(page, ...base);
    assert.equal(await custom(page).isChecked(), false);
    assert.equal(await hex(page, "Основной цвет").isDisabled(), true);
    assert.equal(await page.locator("#save-palette, #reset-palette, #palette-reset-dialog, #palette-success").count(), 0);
    assert.equal(await page.locator("#palette-dialog button").count(), 1);
    assert.equal(await storedPalette(page), null);
    await custom(page).check();
    await page.getByLabel("Основной цвет", { exact: true }).fill("#223344");
    assert.equal(await hex(page, "Основной цвет").inputValue(), "#223344");
    await hex(page, "Основной цвет").fill("#F7DC94");
    await hex(page, "Цвет предложения").fill("#683CA0");
    await mode(page, "main", "custom").check();
    await hex(page, "Основной цвет — цвет текста").fill("#112233");
    await mode(page, "main", "auto").check();
    await mode(page, "proposal", "custom").check();
    await hex(page, "Цвет предложения — цвет текста").fill("#FFF0D5");
    await mode(page, "proposal", "auto").check();
    await mode(page, "proposal", "default").check();
    await mode(page, "proposal", "custom").check();
    assert.equal(await hex(page, "Цвет предложения — цвет текста").inputValue(), "#FFF0D5");
    await checkPreview(page, ...own);
    const ownSettings = (await storedPalette(page)).custom;
    assert.equal(ownSettings.main.textColor, "#112233");
    assert.equal(ownSettings.main.textMode, "auto");
    const valid = await storedPalette(page);
    await hex(page, "Основной цвет").fill("#12");
    assert.equal(await hex(page, "Основной цвет").getAttribute("aria-invalid"), "true");
    assert.deepEqual(await storedPalette(page), valid);
    await checkPreview(page, ...own);
    await page.keyboard.press("Escape");
    await open(page);
    assert.equal(await hex(page, "Основной цвет").inputValue(), "#F7DC94");
    await mode(page, "main", "default").check();
    assert.equal(await page.locator("#palette-warning").isVisible(), true);
    await mode(page, "main", "custom").check();
    assert.equal(await hex(page, "Основной цвет — цвет текста").inputValue(), "#112233");
    await mode(page, "main", "auto").check();
    await page.locator('[name="palette-mode"][value="base"]').check();
    await checkPreview(page, ...base);
    assert.deepEqual((await storedPalette(page)).custom, ownSettings);
    await page.locator("#close-palette").click();
    await saved(page);
    await page.close();
    page = await context.newPage();
    await page.goto(home);
    await page.getByText("Черновик восстановлен").waitFor();
    await open(page);
    await checkPreview(page, ...base);
    await custom(page).check();
    await checkPreview(page, ...own);
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.locator("#palette-dialog").evaluate((el) => el.scrollWidth === el.clientWidth));
      for (const group of await page.locator(".palette-text .palette-choices").all()) {
        assert.equal(new Set(await group.locator("label").evaluateAll((labels) => labels.map((el) => el.getBoundingClientRect().top))).size, 1);
      }
    }
    if (index === 0 && output) {
      await page.mouse.move(1, 1);
      await page.locator("#palette-dialog").screenshot({ path: join(output, "SSB_PALETTE_AUTOSAVE.png") });
    }
    assert.equal(await page.locator("#palette-notice").isVisible(), false);
    await page.keyboard.press("Escape");
    await upload(page);
    await page.locator('#variants input[value="Extended"]').check();
    await page.locator('[name="sla-mode"][value="all"]').check();
    await page.locator('[name="sla-format"][value="comparison"]').check();
    await checkDownloads(page, "autosave", own, index === 0 ? output : null);
    await saveTemplate(page);
    const independent = await storedPalette(page);
    await applyBasis(page, "corporate");
    await applyBasis(page, "local");
    assert.deepEqual(await storedPalette(page), independent);
    await upload(page);
    await open(page);
    await checkPreview(page, ...own);
    await page.locator('[name="palette-mode"][value="base"]').check();
    await page.keyboard.press("Escape");
    await checkDownloads(page, "base", base);
    await open(page);
    await custom(page).check();
    await toggleStorageFailure(page, "setItem", true);
    const beforeFailure = await storedPalette(page);
    await hex(page, "Основной цвет").fill("#223344");
    assert.match(await page.locator("#palette-notice.error").textContent(), /не сохранены локально/);
    assert.deepEqual(await storedPalette(page), beforeFailure);
    await saved(page);
    await toggleStorageFailure(page, "setItem", false);
    await page.keyboard.press("Escape");
    await page.close();
    page = await context.newPage();
    await page.goto(home);
    await page.getByText("Черновик восстановлен").waitFor();
    await open(page);
    assert.equal(await hex(page, "Основной цвет").inputValue(), "#223344");
    assert.equal((await storedPalette(page)).custom.main.background, "#223344");
    assert.equal(await page.locator("#palette-notice").isVisible(), false);
    await page.keyboard.press("Escape");
    // Exercise migrations in the real draft store with two distinct old-format palettes.
    const oldLocal = { mode: "custom", main: { background: "#112233", textMode: "auto", textColor: "#FFFFFF" }, proposal: { background: "#336699", textMode: "default", textColor: "#FFFFFF" } };
    const oldDraft = { mode: "custom", main: { background: "#445566", textMode: "custom", textColor: "#FEDCBA" }, proposal: { background: "#885599", textMode: "auto", textColor: "#AABBCC" } };
    for (const [legacyDraft, expectedMode, expectedColor] of [[oldDraft, "custom", "#445566"], [{ mode: "base" }, "base", "#112233"], [undefined, "custom", "#112233"]]) {
      await page.evaluate(({ key, local, draft }) => new Promise((resolve, reject) => {
        localStorage.setItem(key, JSON.stringify(local));
        const request = indexedDB.open("ssb-dev:support-services-builder-drafts", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("proposals", "readwrite");
          const store = tx.objectStore("proposals");
          const entry = store.get("/");
          entry.onsuccess = () => {
            if (draft) entry.result.proposal.palette = draft;
            else delete entry.result.proposal.palette;
            store.put(entry.result, "/");
          };
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onabort = () => reject(tx.error);
        };
      }), { key: storageKey, local: oldLocal, draft: legacyDraft });
      await page.reload();
      await page.getByText("Черновик восстановлен").waitFor();
      await open(page);
      assert.equal((await storedPalette(page)).mode, expectedMode);
      assert.equal((await storedPalette(page)).custom.main.background, expectedColor);
      if (expectedColor === "#445566") {
        assert.equal((await storedPalette(page)).legacyFixed.main.background, "#112233");
        assert.equal(await hex(page, "Основной цвет — цвет текста").inputValue(), "#FEDCBA");
      }
      await page.keyboard.press("Escape");
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(channel + ": palette autosave, base/custom retention, errors, legacy migration, preview and Word/Excel OK");
  } finally { await browser.close(); }
}
