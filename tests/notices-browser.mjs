import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { referenceFixture } from "./fixtures.mjs";

const home = process.env.SSB_DEV_URL ?? "http://127.0.0.1:4173/";
const output = process.env.SSB_SAMPLE_OUTPUT;
const channels = (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",");
const layer = (page) => page.locator("#defaults-layer").textContent();
const parameter = (page) => page.getByRole("textbox", { name: "Параметр TS-1 в Standard", exact: true });

async function apply(page, selector) {
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(selector).click();
}

if (output) await mkdir(output, { recursive: true });
for (const channel of channels) {
  const browser = await chromium.launch({ channel });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(home);
    await page.waitForFunction(() => !document.querySelector("#upload").disabled);
    assert.equal(await layer(page), "Стандарт Confluence не загружен");
    assert.equal(await page.locator(".intro-copy p").textContent(), "Сравните три варианта поддержки и подготовьте предложение.");
    assert.equal(await page.locator("#comparison-help").textContent(), "Выберите услуги для документа и настройте параметры вариантов.");
    assert.equal(await page.locator(".dev-notice").first().textContent(), "Тестовая версия · Данные хранятся отдельно от рабочей версии");
    await page.locator("#catalog-file").setInputFiles({
      name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(referenceFixture())),
    });
    await page.getByText("Данные Confluence загружены: 6 из 6 услуг", { exact: true }).waitFor();
    assert.equal(await layer(page), "Используется стандарт Confluence");
    await parameter(page).fill("9 часов");
    assert.match(await layer(page), /Используется стандарт Confluence · Есть правки предложения/);
    await apply(page, "#save-defaults");
    await page.locator("#defaults-notice.success").waitFor();
    assert.equal(await layer(page), "Используются локальные настройки менеджера · Локальные отличия: TS-1");
    await apply(page, "#apply-standard");
    assert.equal(await parameter(page).inputValue(), "12 часов");
    assert.equal(await layer(page), "Используется стандарт Confluence · Локальные отличия: TS-1");
    assert.equal(await page.locator("#defaults-notice").textContent(), "Применён стандарт Confluence.");
    await page.locator("#defaults-notice").waitFor({ state: "hidden", timeout: 8000 });
    assert.equal(await page.locator("#defaults-layer").isVisible(), true);
    await page.reload();
    await page.getByText("Черновик восстановлен", { exact: true }).waitFor();
    assert.equal(await page.locator("#defaults-notice").isVisible(), false);
    assert.equal(await layer(page), "Используется стандарт Confluence · Локальные отличия: TS-1");
    await page.locator("#draft-notice").waitFor({ state: "hidden", timeout: 8000 });
    assert.equal(await page.locator("#confluence-status").isVisible(), true);
    await page.locator("#client").fill("Учебная организация");
    await page.getByText("Черновик сохранён на этом устройстве.", { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator("#draft-notice").textContent(), /восстановлен/);
    assert.equal(await page.locator("#conflict-notice").count(), 0);

    await page.locator("#open-sources").click();
    assert.equal(await page.locator("#sources-dialog details:not(#issues), #sources-dialog #catalog-summary, #catalog-completeness").count(), 0);
    assert.equal(await page.locator("#sources-dialog .details-body > p").first().textContent(), "Все поля необязательны. Для загрузки готового JSON их заполнять не нужно.");
    assert.equal(await page.locator("#sources-panel input:visible").count(), 9);
    await page.locator("#save-sources").click();
    await page.getByText("Источники сохранены в этом браузере.", { exact: true }).waitFor();
    await page.locator("#sources-notice").waitFor({ state: "hidden", timeout: 8000 });
    if (channel === channels[0] && output) {
      await page.locator("#sources-dialog").screenshot({ path: join(output, "SSB_SOURCES.png") });
      await page.locator("#close-sources").click();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(output, "SSB_TOP.png") });
      await page.locator(".defaults-tools").screenshot({ path: join(output, "SSB_CONFIGURATION.png") });
      await page.locator("#open-sources").click();
    }
    // A previous success timer must never hide a more recent error in the same area.
    await page.locator("#save-sources").click();
    await page.locator("#source-base").fill("invalid source");
    await page.locator("#save-sources").click();
    await page.locator("#sources-notice.error").waitFor();
    const error = await page.locator("#sources-notice").textContent();
    await page.locator("#close-sources").click();
    await page.locator("#open-palette").click();
    await page.locator("#save-palette").click();
    await page.locator("#palette-success").waitFor();
    await page.waitForTimeout(5500);
    assert.equal(await page.locator("#palette-success").isVisible(), true);
    assert.equal(await page.locator("#draft-notice").isVisible(), false);
    await page.keyboard.press("Escape");
    await page.locator("#open-sources").click();
    assert.equal(await page.locator("#sources-notice.error").isVisible(), true);
    assert.equal(await page.locator("#sources-notice").textContent(), error);
    await page.locator("#source-base").fill("");
    await page.locator("#save-sources").click();
    assert.equal(await page.locator("#sources-notice").getAttribute("class"), "notice success");
    await page.keyboard.press("Escape");
    await apply(page, "#reset");
    assert.equal(await layer(page), "Используются локальные настройки менеджера · Локальные отличия: TS-1");
    assert.equal(await parameter(page).inputValue(), "9 часов");
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 760 });
      await page.locator("#open-sources").click();
      assert.equal(await page.locator("#sources-panel input:visible").count(), 9);
      assert.ok(await page.locator("#sources-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth));
      await page.keyboard.press("Escape");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    console.log(`${channel}: temporary success notices, persistent errors, active configuration and source fields OK`);
  } finally {
    await browser.close();
  }
}
