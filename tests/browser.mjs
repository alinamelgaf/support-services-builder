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
const baseline = process.env.SSB_UPGRADE_FROM_DIST;
const headful = process.env.SSB_HEADFUL === "1";
const types = {
  "index.html": "text/html; charset=utf-8", "app.js": "text/javascript", "app.css": "text/css",
  "sw.js": "text/javascript", "manifest.webmanifest": "application/manifest+json", "icon-192.png": "image/png", "icon-512.png": "image/png",
  "user-guide.html": "text/html; charset=utf-8",
};
const readAssets = async (directory) => Object.fromEntries(await Promise.all(
  Object.keys(types).map(async (name) => [name, await readFile(join(directory, name))]),
));
const assets = await readAssets("dist");
const initialAssets = baseline ? await readAssets(baseline) : assets;
const initialVersion = /id="version">Версия (\d+\.\d+\.\d+)</.exec(initialAssets["index.html"].toString())?.[1];
assert.ok(initialVersion);
if (baseline) assert.notEqual(initialVersion, version);
const updatedVersion = baseline ? version : "99.0.0";
const nextIndex = Buffer.from(assets["index.html"].toString()
  .replace(`Версия ${version}`, `Версия ${updatedVersion}`)
  .replace(`<h2>${version} —`, `<h2>${updatedVersion} —`));
const digest = (buffer) => "sha256-" + createHash("sha256").update(buffer).digest("base64");
const nextWorker = baseline ? assets["sw.js"].toString() : assets["sw.js"].toString()
  .replace(`VERSION = "${version}-`, `VERSION = "${updatedVersion}-`).replace(digest(assets["index.html"]), digest(nextIndex));
const brokenWorker = nextWorker + "\n// Test response with an inconsistent asset.\n";
assert.notEqual(nextWorker, initialAssets["sw.js"].toString());

const tlsFolder = process.env.SSB_TEST_TLS_DIR;
const tls = tlsFolder && { key: await readFile(join(tlsFolder, "key.pem")), cert: await readFile(join(tlsFolder, "cert.pem")) };
const pin = tls && createHash("sha256").update(new X509Certificate(tls.cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
const protocol = tls ? "https" : "http";
let served = "initial";
const handler = (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (request.method !== "GET" || !Object.hasOwn(assets, file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": types[file], "Cache-Control": "no-store" });
  if (served === "broken" && file === "sw.js") response.end(brokenWorker);
  else if (served !== "updated") response.end(initialAssets[file]);
  else if (baseline) response.end(assets[file]);
  else response.end(file === "sw.js" ? nextWorker : file === "index.html" ? nextIndex : assets[file]);
};
const server = tls ? httpsServer(tls, handler) : httpServer(handler);
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `${protocol}://127.0.0.1:${server.address().port}`;
const home = origin + "/";
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

async function checkManifest(session) {
  const { url, manifest } = await session.send("Page.getAppManifest");
  assert.equal(url, home + "manifest.webmanifest");
  assert.match(manifest.display, /^(?:kStandalone|standalone)$/);
  assert.equal(manifest.startUrl, home);
  assert.equal(manifest.scope, home);
  const { appId } = await session.send("Page.getAppId");
  assert.equal(appId, home);
}

async function openPwaWindow(context, session, expectedVersion) {
  const [app] = await Promise.all([
    context.waitForEvent("page", { timeout: 10000 }),
    session.send("PWA.launch", { manifestId: home }),
  ]);
  await app.getByText(`Версия ${expectedVersion}`, { exact: true }).waitFor();
  assert.equal(app.url(), home);
  assert.ok(await app.evaluate(() => matchMedia("(display-mode: standalone)").matches));
  return app;
}

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
    assert.equal(await page.locator("#update").isVisible(), false);
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
    assert.equal(await page.locator("#intro-text, #intro-word, #intro-excel, [contenteditable]").count(), 0);
    assert.equal(await page.locator("#include-intro").isChecked(), true);
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
    assert.equal(await page.locator("#include-intro").isChecked(), true);
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
  const launch = () => chromium.launchPersistentContext(profile, { channel, headless: !headful,
    args: pin ? ["--ignore-certificate-errors-spki-list=" + pin] : [] });
  const canLaunch = channel === "chrome" || (channel === "msedge" && headful);
  let context = await launch();
  const requests = [];
  const errors = [];
  context.on("request", (request) => { if (/^https?:/.test(request.url())) requests.push(request); });
  context.on("weberror", (error) => errors.push(error.error().message));
  let page = context.pages()[0] ?? await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  let installed = false;
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
    await checkManifest(session);
    const { installabilityErrors } = await session.send("Page.getInstallabilityErrors");
    assert.deepEqual(installabilityErrors, []);
    if (process.env.SSB_NATIVE_INSTALL === "1") {
      await session.send("PWA.install", { manifestId: home });
      installed = true;
      await session.send("PWA.getOsAppState", { manifestId: home });
      if (canLaunch) {
        // DevTools installation does not use the browser's normal installation dialog.
        await session.send("PWA.changeAppUserSettings", { manifestId: home, displayMode: "standalone" });
        const app = await openPwaWindow(context, session, initialVersion);
        await page.close();
        page = app;
      }
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
    const legacyIntroEditor = await page.locator("#intro-text").count() === 1;
    if (legacyIntroEditor) await page.locator("#intro-text").fill("Локальный вводный текст старой версии");
    else await page.locator("#include-intro").uncheck();
    await page.locator("#client").fill("Учебный клиент");
    await page.locator("#title").fill("Учебное предложение");
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
    assert.equal(await page.locator("#version").textContent(), `Версия ${initialVersion}`);

    await context.setOffline(true);
    served = "updated";
    await context.setOffline(false);
    await page.getByRole("button", { name: "Установить обновление" }).waitFor();
    await dialog(page, "#update", /после сохранения черновика/, false);
    assert.equal(await standardParam(page).inputValue(), "Черновик перед обновлением");
    assert.equal(await page.locator("#version").textContent(), `Версия ${initialVersion}`);
    await dialog(page, "#update", /сохранённое предложение откроются/);
    await page.getByText(`Версия ${updatedVersion}`, { exact: true }).waitFor();
    await page.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    assert.equal(await standardParam(page).inputValue(), "Черновик перед обновлением");
    assert.equal(await page.getByRole("radio", { name: /^Extended/ }).isChecked(), true);
    assert.equal(await page.locator("#include-intro").isChecked(), legacyIntroEditor);
    assert.equal(await page.locator("#client").inputValue(), "Учебный клиент");
    assert.equal(await page.locator("#title").inputValue(), "Учебное предложение");
    assert.equal(await page.getByRole("checkbox", { name: "Включить в документ TS-1.A", exact: true }).isChecked(), false);
    assert.match(await page.locator("#source-link").getAttribute("href"), /^https:\/\/wiki\.example\.invalid\//);
    if (legacyIntroEditor) {
      assert.equal(await page.locator("#intro-text").count(), 0);
      const word = await exportFile(page, "word", "word/document.xml");
      assert.match(word, /Пример Extended/);
      assert.doesNotMatch(word, /Локальный вводный текст старой версии/);
    }
    await page.getByRole("button", { name: "Что нового" }).click();
    await page.locator("#release-notes").getByRole("heading", { name: new RegExp(updatedVersion) }).waitFor();
    await page.locator("#close-release-notes").click();
    assert.deepEqual(errors, []);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => new URL(request.url()).origin === origin && request.method() === "GET" && !request.postData()));
    const updatedSession = await context.newCDPSession(page);
    await checkManifest(updatedSession);
    if (installed) await updatedSession.send("PWA.getOsAppState", { manifestId: home });
    await context.close();
    context = await launch();
    await context.setOffline(true);
    const tab = context.pages()[0] ?? await context.newPage();
    const restartSession = await context.newCDPSession(tab);
    if (installed) await restartSession.send("PWA.getOsAppState", { manifestId: home });
    const reopened = installed && canLaunch ? await openPwaWindow(context, restartSession, updatedVersion) : tab;
    if (reopened === tab) await reopened.goto(home);
    await checkManifest(await context.newCDPSession(reopened));
    await checkAppIcon(reopened);
    assert.equal(await reopened.locator("#version").textContent(), `Версия ${updatedVersion}`);
    await reopened.getByText("Черновик восстановлен на этом устройстве.").waitFor();
    assert.equal(await standardParam(reopened).inputValue(), "Черновик перед обновлением");
    const [guide] = await Promise.all([context.waitForEvent("page"), reopened.getByRole("link", { name: "Помощь" }).click()]);
    await guide.getByRole("heading", { name: /Руководство пользователя/ }).waitFor();
    await dialog(reopened, "#reset", /Восстановить локальные настройки/);
    assert.equal(await standardParam(reopened).inputValue(), "9 часов в сохранённом профиле");
    if (installed) console.log(`${channel}: PWA identity and installation survived the update and browser restart${canLaunch ? "; standalone relaunch verified" : ""}`);
  } finally {
    try {
      if (installed) {
        await context.setOffline(false);
        const cleanup = await context.newCDPSession(context.pages()[0] ?? await context.newPage());
        await cleanup.send("PWA.uninstall", { manifestId: home });
        await assert.rejects(cleanup.send("PWA.getOsAppState", { manifestId: home }), /Unknown web-app manifest id|not installed/i);
      }
    } finally {
      await context.close();
    }
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
      console.log(`${channel} ${browser.version()} (${protocol}): standalone, installability, offline, update ${initialVersion} → ${updatedVersion}, persistence, request isolation — OK`);
    } finally { await browser.close(); }
  }
} finally { await new Promise((done) => server.close(done)); }
