import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { fixture } from "./fixtures.mjs";

const home = process.env.SSB_DEV_URL ?? "http://127.0.0.1:4173/";
const channels = (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",");
const output = process.env.SSB_SAMPLE_OUTPUT;
const saved = (page) => page.getByText("Черновик сохранён на этом устройстве.", { exact: true }).waitFor({ state: "attached" });
const boxes = (elements) => elements.map((el) => {
  const { x, y, right, bottom, width, height } = el.getBoundingClientRect();
  return { x, y, right, bottom, width, height };
});
if (output) await mkdir(output, { recursive: true });

for (const channel of channels) {
  const browser = await chromium.launch({ channel });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(home);
    await page.waitForFunction(() => !document.querySelector("#upload").disabled);
    await page.locator("#catalog-file").setInputFiles({ name: "synthetic-26.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture({ catalogCount: 26, unknown: false, adversarial: false }))) });
    await page.waitForFunction(() => document.querySelectorAll("#services tr").length === 26);
    await saved(page);
    assert.deepEqual(await page.locator(".proposal-heading button").allTextContents(), ["Источники Confluence", "Загрузить JSON"]);
    const wrap = page.locator(".table-wrap");
    const rowHeight = await page.locator("#services tr").first().evaluate((el) => el.getBoundingClientRect().height);
    const measurements = [];
    for (const [width, height] of [[1440, 1000], [1440, 700], [1440, 1200], [375, 700], [320, 640], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await wrap.evaluate((el) => { el.scrollTop = 0; el.scrollLeft = 0; el.scrollIntoView({ block: "start" }); });
      const dimensions = await wrap.evaluate((el) => ({ height: el.getBoundingClientRect().height, client: el.clientHeight, scroll: el.scrollHeight }));
      assert.ok(Math.abs(dimensions.height - height * .78) <= 2, JSON.stringify({ width, height, dimensions }));
      assert.ok(dimensions.scroll > dimensions.client);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const before = await page.locator("#columns th").evaluateAll(boxes);
      await wrap.evaluate((el) => { el.scrollTop = 800; });
      await page.waitForFunction(() => document.querySelector(".table-wrap").scrollTop >= 800);
      const after = await page.locator("#columns th").evaluateAll(boxes);
      for (let i = 0; i < before.length; i++) assert.ok(Math.abs(before[i].y - after[i].y) < 2, "Sticky column header moved");
      assert.ok(await page.locator("#columns th").evaluateAll((headers) => headers.every((el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)")));
      if (width < 1020) {
        await wrap.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
        assert.ok(await wrap.evaluate((el) => el.scrollLeft > 0));
        const last = await page.locator("#columns th").last().boundingBox();
        const viewport = await wrap.boundingBox();
        assert.ok(last.x >= viewport.x && last.x + last.width <= viewport.x + viewport.width + 2);
      }
      await wrap.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      assert.ok(await wrap.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1));
      measurements.push({ width, height, tableHeight: dimensions.height });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await wrap.evaluate((el) => { el.scrollTop = 0; el.scrollLeft = 0; });
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const pageEnd = await page.evaluate(() => scrollY);
    await wrap.hover();
    await page.mouse.wheel(0, -300);
    await page.waitForFunction((end) => scrollY < end, pageEnd);
    assert.equal(await wrap.evaluate((el) => el.scrollTop), 0, "Scrolling at the table boundary must reach the page");
    assert.equal(await page.locator("#services tr").first().evaluate((el) => el.getBoundingClientRect().height), rowHeight);
    // At the same row sizes, the taller workspace reveals at least one more complete service row.
    const visibleRows = async () => wrap.evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      return [...el.querySelectorAll("tbody tr")].filter((row) => {
        const box = row.getBoundingClientRect(); return box.bottom <= bounds.bottom && box.top >= bounds.top;
      }).length;
    });
    const more = await visibleRows();
    await wrap.evaluate((el) => { el.style.maxHeight = "68vh"; });
    const previous = await visibleRows();
    await wrap.evaluate((el) => { el.style.removeProperty("max-height"); });
    assert.ok(more > previous, `Rows: ${previous} -> ${more}`);
    const parameter = page.getByRole("textbox", { name: "Параметр TS-1 в Standard", exact: true });
    await parameter.fill("17 часов — учебный параметр");
    const row = page.locator("#services tr").filter({ has: page.locator(".service-id", { hasText: /^TS-1$/ }) });
    const documentCheckbox = row.locator(".document-setting input");
    await documentCheckbox.uncheck();
    await documentCheckbox.check();
    const packageCheckbox = row.locator(".setting input").first();
    await packageCheckbox.uncheck();
    await packageCheckbox.check();
    assert.equal(await parameter.inputValue(), "17 часов — учебный параметр");
    await row.getByRole("button", { name: "Описание и условия" }).click();
    await page.locator("#service-dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.locator('input[name="proposal-variant"][value="Extended"]').check();
    assert.equal(await page.locator("#columns th.selected strong").textContent(), "Extended");
    assert.equal(await page.locator("#columns th.selected .proposal-marker").textContent(), "Предложение");
    await saved(page);
    await page.reload();
    await page.getByText("Черновик восстановлен", { exact: true }).waitFor();
    assert.equal(await parameter.inputValue(), "17 часов — учебный параметр");
    assert.equal(await page.locator('input[name="proposal-variant"][value="Extended"]').isChecked(), true);
    await wrap.evaluate((el) => { el.scrollTop = 0; el.scrollLeft = 0; el.scrollIntoView({ block: "start" }); });
    if (channel === channels[0] && output) {
      await page.mouse.move(1, 1);
      await page.locator(".comparison").screenshot({ path: join(output, "SSB_TABLE_WORKSPACE.png") });
    }
    await page.locator("#open-sources").click();
    await page.locator("#source-space").fill("DEMO");
    const controls = await page.locator(".source-actions button").evaluateAll(boxes);
    assert.ok(controls[0].x < controls[1].x && controls[1].right < controls[2].right);
    assert.ok(controls.every((box) => box.y === controls[0].y));
    const footer = await page.locator(".source-actions").boundingBox();
    assert.ok(Math.abs(controls[0].x - footer.x) < 2);
    assert.ok(Math.abs(controls[2].right - footer.x - footer.width) < 2);
    for (const id of ["clear-data", "clear-sources"]) {
      const styles = await page.locator("#" + id).evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
      assert.deepEqual(styles, { color: "rgb(134, 47, 42)", background: "rgb(255, 255, 255)" });
    }
    if (channel === channels[0] && output) {
      await page.mouse.move(1, 1);
      await page.locator("#sources-dialog").screenshot({ path: join(output, "SSB_SOURCE_FOOTER.png") });
    }
    for (const width of [320, 375, 768, 1040]) {
      await page.setViewportSize({ width, height: 640 });
      assert.ok(await page.locator("#sources-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().bottom <= innerHeight));
      for (const button of await page.locator(".source-actions button").all()) {
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 640);
      }
    }
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    console.log(channel + ": responsive workspace, sticky headers, edits and drafts, footer layout OK; rows " + previous + " -> " + more + "; " + JSON.stringify(measurements));
  } finally { await browser.close(); }
}
