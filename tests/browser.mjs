import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import JSZip from "jszip";
import { fixture, IDS, paginate, SOURCES } from "./fixtures.mjs";

const version = JSON.parse(await readFile("package.json", "utf8")).version;
const scope = "/support-services-builder/";
const types = {
  "index.html": "text/html; charset=utf-8", "app.js": "text/javascript", "app.css": "text/css",
  "sw.js": "text/javascript", "manifest.webmanifest": "application/manifest+json", "icon-192.png": "image/png", "icon-512.png": "image/png",
  "user-guide.html": "text/html; charset=utf-8",
};
const assets = Object.fromEntries(await Promise.all(Object.keys(types).map(async (name) => [name, await readFile(`dist/${name}`)])));
const updatedVersion = "99.0.0";
const nextIndex = Buffer.from(assets["index.html"].toString()
  .replace(`Версия ${version}`, `Версия ${updatedVersion}`)
  .replace(`<h2>${version} —`, `<h2>${updatedVersion} —`));
const digest = (buffer) => "sha256-" + createHash("sha256").update(buffer).digest("base64");
const nextWorker = assets["sw.js"].toString().replace(`VERSION = "${version}-`, `VERSION = "${updatedVersion}-`).replace(digest(assets["index.html"]), digest(nextIndex));
const brokenWorker = nextWorker + "\n// Test response with an inconsistent asset.\n";
assert.notEqual(nextWorker, assets["sw.js"].toString());

const tlsFolder = process.env.SSB_TEST_TLS_DIR;
const tls = tlsFolder && { key: await readFile(join(tlsFolder, "key.pem")), cert: await readFile(join(tlsFolder, "cert.pem")) };
const pin = tls && createHash("sha256").update(new X509Certificate(tls.cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
const protocol = tls ? "https" : "http";
let served = "initial";
const handler = (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = pathname === scope ? "index.html" : pathname.startsWith(scope) ? pathname.slice(scope.length) : "";
  if (request.method !== "GET" || !Object.hasOwn(assets, file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": types[file], "Cache-Control": "no-store" });
  const worker = served === "broken" ? brokenWorker : nextWorker;
  response.end(served !== "initial" && file === "sw.js" ? worker : served === "updated" && file === "index.html" ? nextIndex : assets[file]);
};
const server = tls ? httpsServer(tls, handler) : httpServer(handler);
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `${protocol}://127.0.0.1:${server.address().port}`;
const home = origin + scope;
const localFile = pathToFileURL(resolve("standalone/index.html")).href;

async function checkAppIcon(page) {
  const icon = page.locator(".topbar .app-icon");
  const source = page.url() === localFile
    ? `data:image/png;base64,${assets["icon-192.png"].toString("base64")}`
    : "./icon-192.png";
  assert.equal(await icon.getAttribute("src"), source);
  const naturalSize = await icon.evaluate(async (image) => {
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  });
  assert.deepEqual(naturalSize, [192, 192]);
}

async function configure(page) {
  await page.getByText("Настройки источников Confluence", { exact: true }).click();
  await page.locator("#source-base").fill(SOURCES.base);
  await page.locator("#source-space").fill(SOURCES.space);
  for (const [key, label] of Object.entries(SOURCES.labels)) await page.locator(`#label-${key}`).fill(label);
  await page.locator("#save-sources").click();
  const href = await page.locator("#source-link").getAttribute("href");
  assert.match(href, /^https:\/\/wiki\.example\.invalid\/confluence\/rest\/api\/content\/search\?/);
  assert.equal(new URL(href).searchParams.get("limit"), "50");
}

async function upload(page, ...pages) {
  await page.locator("#catalog-file").setInputFiles(pages.map((data, index) => ({
    name: `demo-${index}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)),
  })));
}

const sorted = (page) => page.locator("#services .service-id").allTextContents();
const standardParam = (page) => page.getByRole("textbox", { name: "Параметр TS-1 в Standard", exact: true });
const selected = (page, code) => page.getByRole("radio", { name: new RegExp(`^${code}`) }).check();

async function dialog(page, button, expected, accept = true) {
  const decision = page.waitForEvent("dialog").then(async (prompt) => {
    const message = prompt.message();
    if (accept) await prompt.accept();
    else await prompt.dismiss();
    assert.match(message, expected);
  });
  await Promise.all([decision, page.locator(button).click()]);
}

async function exportFile(page, format, internalPath) {
  const [file] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-format=${format}]`).click()]);
  const zip = await JSZip.loadAsync(await readFile(await file.path()));
  return zip.file(internalPath).async("string");
}

async function checkStandalone(browser) {
  const context = await browser.newContext();
  const requests = [];
  const errors = [];
  context.on("request", (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(localFile);
    await checkAppIcon(page);
    assert.equal(await page.locator("#pwa-actions").isVisible(), false);
    await configure(page);
    const data = fixture();
    await upload(page, paginate(data, 0, 4));
    await page.getByText(/Неполная выгрузка REST/).waitFor();
    assert.equal(await page.locator('[data-format="excel"]').isDisabled(), true);
    await upload(page, paginate(data, 4, data.size));
    await page.getByText("Услуг загружено 6 из", { exact: false }).waitFor();
    assert.deepEqual(await sorted(page), IDS);
    assert.equal(await standardParam(page).inputValue(), "12 часов");
    await page.getByRole("button", { name: "Описание и условия TS-1", exact: true }).click();
    await page.locator("#detail-description ul").waitFor();
    await page.locator("#close-dialog").click();
    await selected(page, "Extended");
    assert.equal(await page.locator("#intro-text em, #intro-text i").first().textContent(), "Пример Extended");
    assert.equal(await page.locator("#intro-word").isChecked(), true);
    assert.equal(await page.locator("#intro-excel").isChecked(), false);
    await page.locator("#intro-excel").check();
    await standardParam(page).fill("7 часов локально");
    await page.getByRole("checkbox", { name: "Включить в документ TS-1.A", exact: true }).uncheck();
    await dialog(page, "#save-defaults", /сохранённые настройки будут заменены/i);
    await page.getByText(/Настройки по умолчанию сохранены/).waitFor();
    await standardParam(page).fill("8 часов в черновике");
    await upload(page, fixture({ parameter: "18 часов", extra: true }));
    await page.getByText(/Сохранены текущие правки предложения/).waitFor();
    assert.equal(await standardParam(page).inputValue(), "8 часов в черновике");
    assert.equal(await page.getByRole("textbox", { name: "Параметр TS-3.B в Extended", exact: true }).inputValue(), "6 часов");
    await dialog(page, "#apply-standard", /правки.*будут сброшены/, false);
    assert.equal(await standardParam(page).inputValue(), "8 часов в черновике");
    await dialog(page, "#apply-standard", /сохранённые настройки менеджера останутся/i);
    assert.equal(await standardParam(page).inputValue(), "18 часов");
    await dialog(page, "#reset", /Восстановить локальные настройки/);
    assert.equal(await standardParam(page).inputValue(), "7 часов локально");
    assert.equal(await page.locator("#intro-excel").isChecked(), true);
    const excel = await exportFile(page, "excel", "xl/sharedStrings.xml");
    const word = await exportFile(page, "word", "word/document.xml");
    assert.match(excel, /Пример Extended/);
    assert.match(word, /Пример Extended/);
    assert.doesNotMatch(excel + word, /TS-1\.A|wiki\.example\.invalid/);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
  } finally { await context.close(); }
}

async function checkHosted(channel) {
  served = "initial";
  const folder = resolve(process.env.SSB_QA_DIR ?? tmpdir());
  await mkdir(folder, { recursive: true });
  const base = await realpath(folder);
  const profile = await mkdtemp(join(base, "pwa-"));
  const launch = () => chromium.launchPersistentContext(profile, { channel, headless: true,
    args: pin ? ["--ignore-certificate-errors-spki-list=" + pin] : [] });
  let context = await launch();
  const requests = [];
  const errors = [];
  context.on("request", (request) => { if (/^https?:/.test(request.url())) requests.push(request); });
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  try {
    await page.goto(home);
    try { await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 }); }
    catch (error) {
      const notice = await page.locator("#pwa-notice").textContent();
      const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((reg) =>
        [reg.installing?.state, reg.waiting?.state, reg.active?.state]));
      const cacheError = await page.evaluate(async () => {
        try {
          const cache = await caches.open("ssb-qa-probe");
          await cache.put(location.href, new Response("QA"));
          await caches.delete("ssb-qa-probe");
          return "";
        } catch (error) { return String(error); }
      });
      throw new Error(JSON.stringify({ notice, registrations, cacheError, consoleErrors, errors, requests: requests.map((request) => request.url()) }), { cause: error });
    }
    const session = await context.newCDPSession(page);
    const { manifest } = await session.send("Page.getAppManifest");
    assert.match(manifest.display, /^(?:kStandalone|standalone)$/);
    assert.equal(manifest.startUrl, home);
    const { installabilityErrors } = await session.send("Page.getInstallabilityErrors");
    assert.deepEqual(installabilityErrors, []);
    const { appId } = await session.send("Page.getAppId");
    assert.equal(appId, home);
    if (process.env.SSB_NATIVE_INSTALL === "1") {
      let installed = false;
      try {
        await session.send("PWA.install", { manifestId: home });
        installed = true;
        await session.send("PWA.getOsAppState", { manifestId: home });
        if (channel === "chrome") {
          const [app] = await Promise.all([
            context.waitForEvent("page", { timeout: 10000 }),
            session.send("PWA.launch", { manifestId: home }),
          ]);
          await app.getByRole("heading", { name: /Конструктор услуг/ }).waitFor();
          assert.equal(app.url(), home);
          await app.close();
        }
      } finally {
        if (installed) await session.send("PWA.uninstall", { manifestId: home });
      }
      await assert.rejects(session.send("PWA.getOsAppState", { manifestId: home }), /Unknown web-app manifest id|not installed/i);
      console.log(`${channel}: PWA install${channel === "chrome" ? ", launch" : ""} and uninstall verified through the browser protocol`);
    }
    await configure(page);
    await upload(page, fixture());
    await standardParam(page).fill("9 часов в сохранённом профиле");
    await dialog(page, "#save-defaults", /сохранённые настройки будут заменены/i);
    await page.getByText("Черновик сохранён на этом устройстве.").waitFor();
    await context.setOffline(true);
    await page.reload();
    await page.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    assert.equal(await standardParam(page).inputValue(), "9 часов в сохранённом профиле");
    await upload(page, { ...fixture({ catalogCount: 26, unknown: false, adversarial: false }), limit: 50 });
    await page.getByText("Услуг загружено 26 из 26", { exact: false }).waitFor();
    assert.equal(await standardParam(page).inputValue(), "9 часов в сохранённом профиле");
    assert.match(await exportFile(page, "word", "word/document.xml"), /Учебный список/);
    await context.setOffline(false);
    const stale = await context.newPage();
    await stale.goto(home);
    await stale.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    await standardParam(page).fill("Черновик перед обновлением");
    await selected(page, "Extended");
    await page.locator("#intro-text").fill("Учебный вводный текст перед обновлением");
    await page.locator("#client").fill("Учебный клиент");
    await page.getByRole("checkbox", { name: "Включить в документ TS-1.A", exact: true }).uncheck();
    await page.getByText("Черновик сохранён на этом устройстве.").waitFor();
    await stale.locator("#client").fill("Учебная правка из другой вкладки");
    await stale.getByText(/Черновик изменён в другой вкладке/).waitFor();
    await stale.close({ runBeforeUnload: false });

    served = "broken";
    await page.locator("#update").click();
    await page.getByText(/Обновление не подготовлено/).waitFor();
    await page.waitForFunction(() => !document.querySelector("#update").disabled);
    assert.equal(await standardParam(page).inputValue(), "Черновик перед обновлением");
    assert.equal(await page.locator("#version").textContent(), `Версия ${version}`);

    await context.setOffline(true);
    served = "updated";
    await context.setOffline(false);
    await page.getByRole("button", { name: "Установить обновление" }).waitFor();
    await dialog(page, "#update", /после сохранения черновика/, false);
    assert.equal(await standardParam(page).inputValue(), "Черновик перед обновлением");
    assert.equal(await page.locator("#version").textContent(), `Версия ${version}`);
    await dialog(page, "#update", /сохранённое предложение откроются/);
    await page.getByText(`Версия ${updatedVersion}`, { exact: true }).waitFor();
    await page.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    assert.equal(await standardParam(page).inputValue(), "Черновик перед обновлением");
    assert.equal(await page.getByRole("radio", { name: /^Extended/ }).isChecked(), true);
    assert.equal(await page.locator("#intro-text").textContent(), "Учебный вводный текст перед обновлением");
    assert.equal(await page.locator("#client").inputValue(), "Учебный клиент");
    assert.equal(await page.getByRole("checkbox", { name: "Включить в документ TS-1.A", exact: true }).isChecked(), false);
    assert.match(await page.locator("#source-link").getAttribute("href"), /^https:\/\/wiki\.example\.invalid\//);
    await page.getByRole("button", { name: "Что нового" }).click();
    await page.locator("#release-notes").getByRole("heading", { name: new RegExp(updatedVersion) }).waitFor();
    await page.locator("#close-release-notes").click();
    assert.deepEqual(errors, []);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => new URL(request.url()).origin === origin && request.method() === "GET" && !request.postData()));
    await context.close();
    context = await launch();
    await context.setOffline(true);
    const reopened = context.pages()[0] ?? await context.newPage();
    await reopened.goto(home);
    await checkAppIcon(reopened);
    assert.equal(await reopened.locator("#version").textContent(), `Версия ${updatedVersion}`);
    await reopened.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    assert.equal(await standardParam(reopened).inputValue(), "Черновик перед обновлением");
    const [guide] = await Promise.all([context.waitForEvent("page"), reopened.getByRole("link", { name: "Помощь" }).click()]);
    await guide.getByRole("heading", { name: /Руководство пользователя/ }).waitFor();
    await dialog(reopened, "#reset", /Восстановить локальные настройки/);
    assert.equal(await standardParam(reopened).inputValue(), "9 часов в сохранённом профиле");
  } finally {
    await context.close();
    const target = await realpath(profile);
    if (target === profile && dirname(target) === base) await rm(target, { recursive: true, maxRetries: 3 });
  }
}

try {
  for (const channel of (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",")) {
    const browser = await chromium.launch({ channel, headless: true });
    try {
      await checkStandalone(browser);
      await checkHosted(channel);
      console.log(`${channel} ${browser.version()} (${protocol}): standalone, installability, offline, update, persistence, request isolation — OK`);
    } finally { await browser.close(); }
  }
} finally { await new Promise((done) => server.close(done)); }
