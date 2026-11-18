import { applyBasis } from "./basis-helper.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { paginate, referenceFixture, REFERENCE_SOURCES } from "./fixtures.mjs";

const home = process.env.SSB_DEV_URL ?? "http://127.0.0.1:4173/";
const channels = (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",");
const output = process.env.SSB_SAMPLE_OUTPUT;
const status = (page) => page.locator("#confluence-status");
const sources = (page) => page.locator("#sources-dialog");
const waitSaved = (page) => page.getByText("Черновик сохранён на этом устройстве.", { exact: true }).waitFor({ state: "attached" });
const count = (page) => page.locator("#services tr").count();

async function upload(page, value, raw = false) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#upload").click()]);
  await chooser.setFiles({ name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(raw ? value : JSON.stringify(value)) });
  await page.waitForFunction(() => !document.querySelector("#catalog-file").disabled && !document.querySelector("#catalog-file").files.length);
  await waitSaved(page);
  assert.equal(await sources(page).isVisible(), false);
}

async function openSources(page) {
  await page.locator("#open-sources").click();
  await sources(page).waitFor();
}

if (output) await mkdir(output, { recursive: true });
for (const channel of channels) {
  const browser = await chromium.launch({ channel });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const external = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    context.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(home)) external.push(request.url());
    });
    const page = await context.newPage();
    await page.goto(home);
    await page.waitForFunction(() => !document.querySelector("#upload").disabled);
    assert.equal(await status(page).textContent(), "Данные Confluence не загружены");
    assert.equal(await page.locator(".catalog-panel, #catalog-heading").count(), 0);
    assert.equal(await page.locator("main > .panel").first().getAttribute("aria-labelledby"), "proposal-heading");
    assert.deepEqual((await page.locator(".proposal-heading button").allTextContents()).map((text) => text.trim()), ["Источники Confluence", "Загрузить JSON"]);
    assert.deepEqual(await page.locator(".button-primary").evaluateAll((buttons) => buttons.map((button) => button.textContent)),
      ["Загрузить JSON", "Скачать Excel", "Скачать Word"]);
    const normalStyles = await page.locator("button.button:not(.button-primary):not(.button-danger):enabled, a.button:not([hidden])").evaluateAll((buttons) =>
      buttons.map((button) => [getComputedStyle(button).backgroundColor, getComputedStyle(button).color]));
    assert.ok(normalStyles.every(([background, color]) => background === "rgb(255, 255, 255)" && color === "rgb(37, 76, 119)"));

    await upload(page, "broken JSON", true);
    assert.match(await status(page).textContent(), /^Ошибка загрузки JSON/);
    assert.equal(await count(page), 0);
    await openSources(page);
    assert.match(await page.locator("#catalog-notice").textContent(), /JSON в UTF-8/);
    assert.equal(await page.locator("#sources-panel").getAttribute("open"), null);
    await page.locator("#source-space").fill("UNSAVED");
    await page.locator("#close-sources").click();
    await openSources(page);
    assert.equal(await page.locator("#source-space").inputValue(), "UNSAVED");
    await page.keyboard.press("Escape");
    assert.equal(await sources(page).isVisible(), false);
    assert.equal(await page.locator("#open-sources").evaluate((button) => button === document.activeElement), true);

    const full = referenceFixture();
    await upload(page, full);
    assert.equal(await status(page).textContent(), "Данные Confluence загружены: 6 из 6 услуг");
    assert.equal(await status(page).getAttribute("class"), "confluence-status success");
    assert.equal(await count(page), 6);
    await openSources(page);
    assert.equal(await sources(page).locator("details:not(#issues), summary:not(#issues-summary), #catalog-summary, #catalog-completeness").count(), 0);
    for (const key of ["intro", "sla", "severity", "assumptions", "glossary"]) assert.equal(await page.locator("#include-" + key).isEnabled(), true);
    assert.equal(await page.locator("#source-space").inputValue(), "UNSAVED");
    await page.locator("#source-space").fill(REFERENCE_SOURCES.space);
    await page.locator("#source-base").fill(REFERENCE_SOURCES.base);
    for (const [key, label] of Object.entries(REFERENCE_SOURCES.labels)) await page.locator("#label-" + key).fill(label);
    await page.locator("#save-sources").click();
    await page.getByText("Источники сохранены в этом браузере.", { exact: true }).waitFor();
    assert.equal(await page.locator("#source-link").isVisible(), true);
    const url = new URL(await page.locator("#source-link").getAttribute("href"));
    assert.equal(url.searchParams.get("limit"), "50");
    await page.locator("#close-sources").click();


    await page.locator('#variants input[value="Extended"]').check();
    await waitSaved(page);
    if (channel === channels[0] && output) {
      await page.mouse.move(2, 2);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(output, "SSB_TOP.png"), animations: "disabled" });
      await openSources(page);
      await sources(page).evaluate((dialog) => dialog.scrollTop = 0);
      await sources(page).screenshot({ path: join(output, "SSB_SOURCES.png"), animations: "disabled" });
      await page.locator("#close-sources").click();
    }
    const buttonBoxes = await page.locator(".proposal-heading button").evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right };
    }));
    assert.equal(new Set(buttonBoxes.map(({ y }) => y)).size, 1);
    const heading = await page.locator("#proposal-heading").boundingBox();
    assert.ok(buttonBoxes[0].x > heading.x + heading.width);

    await upload(page, "broken again", true);
    assert.match(await status(page).textContent(), /Ошибка загрузки JSON.*Сохранены ранее загруженные данные: 6 из 6 услуг/);
    assert.equal(await count(page), 6);
    await page.reload();
    await page.getByText("Черновик восстановлен").waitFor();
    assert.match(await status(page).textContent(), /Ошибка загрузки JSON.*6 из 6 услуг/);
    await openSources(page);
    assert.equal(await page.locator("#source-space").inputValue(), REFERENCE_SOURCES.space);
    assert.match(await page.locator("#catalog-notice").textContent(), /JSON в UTF-8/);
    await page.locator("#close-sources").click();

    await upload(page, paginate(full, 0, 5));
    assert.match(await status(page).textContent(), /Ошибка загрузки JSON.*6 из 6 услуг/);
    assert.equal(await count(page), 6);
    await openSources(page);
    assert.match(await page.locator("#catalog-notice").textContent(), /Неполная выгрузка REST/);
    assert.equal(await page.locator("#reset-batch").isVisible(), true);
    await page.locator("#close-sources").click();
    await upload(page, paginate(full, 5, full.size));
    assert.equal(await status(page).getAttribute("class"), "confluence-status success");

    const warning = structuredClone(full);
    warning.results.push(structuredClone(warning.results[0]));
    warning.size = warning.totalSize = warning.results.length;
    await upload(page, warning);
    assert.equal(await status(page).getAttribute("class"), "confluence-status warning");
    assert.match(await status(page).textContent(), /Есть предупреждения/);
    await openSources(page);
    await page.locator("#issues summary").click();
    assert.match(await page.locator("#issue-list").textContent(), /Повтор страницы пропущен/);
    await page.locator("#close-sources").click();

    await upload(page, referenceFixture({ alterSla: (rows) => rows.slice(1) }));
    assert.equal(await status(page).getAttribute("class"), "confluence-status error");
    assert.match(await status(page).textContent(), /Есть ошибки импорта/);
    assert.equal(await page.locator("#include-sla").isDisabled(), true);
    await openSources(page);
    assert.match(await page.locator("#issue-list").textContent(), /Отсутствует сочетание/);
    await page.locator("#close-sources").click();

    const partial = structuredClone(full);
    partial.results[0].body.storage.value = partial.results[0].body.storage.value.replace("Описание услуги", "Неизвестное поле");
    await upload(page, partial);
    assert.equal(await count(page), 5);
    assert.match(await status(page).textContent(), /Загружено 5 из 6 услуг.*Есть ошибки импорта/);

    const optional = referenceFixture({ alterSla: () => null });
    optional.results.at(-1).body.storage.value = "<p></p>";
    optional.results.push({ id: "900", title: "Учебная матрица", body: { storage: { value: "<p>Пока не реализовано</p>" } } });
    optional.size = optional.totalSize = optional.results.length;
    await upload(page, optional);
    assert.equal(await status(page).getAttribute("class"), "confluence-status success");
    assert.equal(await page.locator("#include-glossary").isDisabled(), true);
    await upload(page, full);
    await page.reload();
    await page.getByText("Черновик восстановлен").waitFor();
    assert.equal(await status(page).textContent(), "Данные Confluence загружены: 6 из 6 услуг");
    await openSources(page);
    assert.equal(await page.locator("#issues").isVisible(), false);
    assert.equal(await page.locator("#catalog-notice").isVisible(), false);
    await page.locator("#close-sources").click();

    await applyBasis(page,"corporate");
    await waitSaved(page);
    assert.equal(await count(page), 6);
    assert.equal(await status(page).getAttribute("class"), "confluence-status success");
    assert.equal(await page.locator("#source-space").inputValue(), REFERENCE_SOURCES.space);

    for (const format of ["word", "excel"]) {
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-format="${format}"]`).click()]);
      assert.equal(await download.failure(), null);
    }
    for (const width of [320, 375, 620, 768, 950, 1050, 1280, 1440]) {
      await page.setViewportSize({ width, height: 760 });
      await page.locator("#open-sources").focus();
      await page.keyboard.press("Enter");
      await sources(page).waitFor();
      assert.equal(await sources(page).evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().bottom <= innerHeight), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#open-sources").evaluate((button) => button === document.activeElement && button.matches(":focus-visible")), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(`${channel}: Confluence dialog, compact status, import diagnostics, settings, drafts and exports OK`);
  } finally {
    await browser.close();
  }
}
