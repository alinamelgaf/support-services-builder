import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { SOURCES, fixture } from "./fixtures.mjs";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
const types = {
  "index.html": "text/html; charset=utf-8", "app.css": "text/css", "app.js": "text/javascript",
  "icon-192.png": "image/png", "icon-512.png": "image/png", "sw.js": "text/javascript",
  "manifest.webmanifest": "application/manifest+json", "user-guide.html": "text/html; charset=utf-8",
};
let folder = "dist";
const server = createServer(async (request, response) => {
  const testPath = request.url.startsWith("/test/");
  const path = testPath ? request.url.slice("/test".length) : request.url;
  const name = path === "/" ? "index.html" : path.slice(1);
  if (request.method !== "GET" || !Object.hasOwn(types, name)) return response.writeHead(404).end();
  try {
    const body = await readFile((testPath ? "dist-dev" : folder) + "/" + name);
    response.writeHead(200, { "Content-Type": types[name], "Cache-Control": "no-store" }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const home = "http://127.0.0.1:" + server.address().port + "/";
const labels = { ...SOURCES.labels };
const catalog = { name: "demo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture({ unknown: false }))) };
const storageKeys = {
  sources: "ssb:confluence-sources:v1",
  defaults: "support-services-builder-defaults:v2",
  legacy: "support-services-builder-defaults:v1",
};
const parameter = (page) => page.getByRole("textbox", { name: "Параметр TS-1 в Standard", exact: true });

async function save(page, space, value) {
  await page.locator("#sources-panel summary").click();
  assert.ok(await page.getByRole("textbox", { name: "Вводные тексты", exact: true }).isVisible());
  await page.locator("#source-base").fill(SOURCES.base);
  await page.locator("#source-space").fill(space);
  for (const [key, label] of Object.entries(labels)) await page.locator("#label-" + key).fill(label);
  await page.locator("#save-sources").click();
  await page.locator("#catalog-file").setInputFiles(catalog);
  await parameter(page).fill(value);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#save-defaults").click();
  await page.locator("#client").fill(value);
  await page.getByText("Черновик сохранён на этом устройстве.").waitFor();
}

async function restore(page, space, value) {
  await page.getByText("Черновик восстановлен на этом устройстве.").waitFor();
  assert.equal(await page.locator("#source-space").inputValue(), space);
  assert.equal(await page.locator("#client").inputValue(), value);
  assert.equal(await parameter(page).inputValue(), value);
}

async function verifyActionLayout(page) {
  const actions = page.locator("#pwa-actions");
  const controls = [actions.getByRole("link", { name: "Помощь" }), actions.locator("#show-release-notes"), actions.locator("#update")];
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const row = await actions.boundingBox();
    const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
    for (const [i, box] of boxes.entries()) {
      assert.ok(box && box.x >= row.x && box.x + box.width <= row.x + row.width + 1);
      for (const other of boxes.slice(0, i)) {
        assert.ok(box.x >= other.x + other.width || box.y >= other.y + other.height);
      }
    }
    const [help, news, update] = boxes;
    assert.ok(Math.abs(update.x + update.width - row.x - row.width) < 1);
    if (width === 1280) {
      assert.equal(help.y, news.y);
      assert.equal(news.y, update.y);
      const intro = await page.locator(".intro").boundingBox();
      const notice = await page.locator("#pwa-notice").boundingBox();
      const bottom = notice ? notice.y + notice.height : row.y + row.height;
      assert.ok(intro.y + intro.height - bottom <= 17);
    } else {
      assert.ok(help.y < update.y);
    }
  }
}

async function verifyHelpAndNews(page) {
  const [guide] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: "Помощь" }).click()]);
  await guide.getByRole("heading", { name: "Руководство пользователя Support Services Builder" }).waitFor();
  await guide.close();
  await page.getByRole("button", { name: "Что нового" }).click();
  assert.ok(await page.locator("#release-notes").isVisible());
  await page.locator("#close-release-notes").click();
}

async function verifyPreview(page) {
  const result = page.locator("#pwa-preview-result");
  const update = page.locator("#update");
  const notice = page.locator("#pwa-notice");
  assert.equal(await result.isVisible(), false);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  await update.click();
  assert.equal(await update.isDisabled(), true);
  assert.match(await notice.textContent(), /^Имитация PWA\. Проверяем обновления/);
  await notice.getByText("Имитация PWA. Новая версия не найдена.", { exact: true }).waitFor();
  await result.selectOption("available");
  await update.click();
  await notice.getByText(/Имитация PWA\. Новая версия готова/).waitFor();
  assert.equal(await update.textContent(), "Установить обновление");
  await update.click();
  assert.match(await notice.textContent(), /^Имитация PWA\. Установка обновлений в тестовом сценарии недоступна/);
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
  await result.selectOption("error");
  await update.click();
  await notice.getByText(/Имитация PWA\. Не удалось проверить обновления/).waitFor();
  assert.equal(await update.textContent(), "Проверить обновления");
}

async function verify(channel) {
  folder = "dist";
  const browser = await chromium.launch({ channel });
  try {
    // Serve both builds at exactly the same URL to test storage separation by build mode.
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(home);
    assert.equal(await page.title(), "Support Services Builder");
    assert.equal(await page.locator("#version").textContent(), "Версия " + version);
    assert.equal(await page.locator(".dev-badge").count(), 0);
    await save(page, "PROD", "Рабочее предложение");
    const production = await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), [storageKeys.sources, storageKeys.defaults]);
    assert.ok(production.every(Boolean));
    await page.evaluate(({ legacy, defaults }) => {
      localStorage.setItem(legacy, localStorage.getItem(defaults));
    }, storageKeys);

    folder = "dist-dev";
    await page.reload();
    assert.equal(await page.title(), "SSB — Тестовая версия");
    await page.locator(".topbar").getByText("ТЕСТОВАЯ", { exact: true }).waitFor();
    await page.getByText("Локальная тестовая сборка.", { exact: false }).waitFor();
    assert.equal(await page.locator("#version").textContent(), "Версия " + version + "-dev");
    await page.waitForFunction(() => !document.querySelector("main").inert);
    assert.equal(await page.locator("#client").inputValue(), "");
    assert.equal(await page.locator("#source-space").inputValue(), "");
    assert.equal(await page.locator("#table-wrap").isVisible(), false);
    assert.equal(await page.locator("#reset").isDisabled(), true);
    await save(page, "DEV", "Тестовое предложение");
    const stored = await page.evaluate((keys) => keys.map((key) =>
      [localStorage.getItem(key), localStorage.getItem("ssb-dev:" + key)]), [storageKeys.sources, storageKeys.defaults]);
    assert.deepEqual(stored.map(([value]) => value), production);
    assert.ok(stored.every(([prod, dev]) => dev && dev !== prod));
    await page.reload();
    await restore(page, "DEV", "Тестовое предложение");
    folder = "dist";
    await page.reload();
    await restore(page, "PROD", "Рабочее предложение");
    await context.close();

    folder = "dist-dev";
    const dev = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const narrow = await dev.newPage();
    const workerRequests = [];
    dev.on("request", (request) => {
      if (new URL(request.url()).pathname === "/sw.js") workerRequests.push(request.url());
    });
    await narrow.goto(home);
    assert.equal(await narrow.locator('link[rel="manifest"]').count(), 0);
    assert.equal(await narrow.locator("#install").isVisible(), false);
    assert.equal(await narrow.locator(".dev-badge").isVisible(), true);
    assert.equal(await narrow.locator("#version").isVisible(), true);
    assert.equal(await narrow.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
    await verifyActionLayout(narrow);
    await verifyHelpAndNews(narrow);
    await verifyPreview(narrow);
    assert.deepEqual(workerRequests, []);
    await dev.close();

    folder = "dist";
    const shared = await browser.newContext();
    const productionTab = await shared.newPage();
    await productionTab.goto(home);
    await productionTab.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js"));
    assert.equal(await productionTab.locator("#pwa-preview, #ssb-dev-refresh").count(), 0);
    await verifyActionLayout(productionTab);
    await verifyHelpAndNews(productionTab);
    assert.equal(await productionTab.locator("#update").textContent(), "Проверить обновления");
    await productionTab.locator("#update").click();
    await productionTab.locator("#pwa-notice").getByText(/Новая версия не найдена/).waitFor();
    await save(productionTab, "PROD", "Рабочее предложение");
    const testTab = await shared.newPage();
    await testTab.goto(home + "test/");
    assert.equal(await testTab.title(), "SSB — Тестовая версия");
    await testTab.waitForFunction(() => !document.querySelector("main").inert);
    assert.equal(await testTab.locator("#client").inputValue(), "");
    await save(testTab, "DEV", "Тестовое предложение");
    await testTab.reload();
    await restore(testTab, "DEV", "Тестовое предложение");
    await productionTab.reload();
    await restore(productionTab, "PROD", "Рабочее предложение");
    assert.deepEqual(await testTab.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).map(({ scope }) => scope)), [home]);
    assert.equal(await testTab.evaluate(async () => (await caches.keys()).length), 1);
    await shared.close();
    console.log(channel + ": responsive actions, safe preview, real update check and isolated storage — OK");
  } finally {
    await browser.close();
  }
}

try {
  for (const channel of (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",")) await verify(channel);
} finally {
  await new Promise((done) => server.close(done));
}
