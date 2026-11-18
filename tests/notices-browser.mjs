import assert from "node:assert/strict";
import { chromium } from "playwright";
import { referenceFixture } from "./fixtures.mjs";

const home = process.env.SSB_DEV_URL ?? "http://127.0.0.1:4173/";
for (const channel of (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",")) {
  const browser = await chromium.launch({ channel });
  try {
    const page = await browser.newPage();
    await page.goto(home);
    await page.waitForFunction(() => !document.querySelector("#upload").disabled);
    assert.equal(await page.locator(".intro-copy p").textContent(), "Сравните три варианта поддержки и подготовьте предложение.");
    assert.equal(await page.locator("#comparison-help").textContent(), "Выберите услуги для документа и настройте параметры вариантов.");
    await page.locator("#catalog-file").setInputFiles({ name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(referenceFixture())) });
    await page.getByText("Черновик сохранён на этом устройстве.", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await page.locator("#draft-notice").isVisible(), false);
    await page.locator("#open-sources").click();
    assert.equal(await page.locator("#sources-panel input:visible").count(), 9);
    await page.locator("#save-sources").click();
    await page.getByText("Источники сохранены в этом браузере.", { exact: true }).waitFor();
    await page.locator("#sources-notice").waitFor({ state: "hidden", timeout: 8000 });
    await page.locator("#save-sources").click();
    await page.locator("#source-base").fill("invalid source");
    await page.locator("#save-sources").click();
    await page.locator("#sources-notice.error").waitFor();
    await page.locator("#close-sources").click();
    await page.locator("#open-palette").click();
    await page.locator('[name="palette-mode"][value="custom"]').check();
    await page.getByRole("textbox", { name: "Основной цвет — HEX", exact: true }).fill("#334455");
    assert.equal(await page.locator("#palette-success").count(), 0);
    assert.equal(await page.locator("#palette-notice").isVisible(), false);
    await page.keyboard.press("Escape");
    await page.locator("#open-sources").click();
    assert.equal(await page.locator("#sources-notice.error").isVisible(), true);
    console.log(channel + ": quiet autosave, temporary confirmations and persistent errors OK");
  } finally { await browser.close(); }
}
