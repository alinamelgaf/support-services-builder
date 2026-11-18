import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { referenceFixture, REFERENCE_SOURCES } from "./fixtures.mjs";

const capture = process.env.SSB_GUIDE_CAPTURE === "1";
const version = JSON.parse(await readFile("package.json", "utf8")).version;
for (const path of ["README.md", "docs/USER_GUIDE.md", "docs/INSTALL.md", "docs/CONFLUENCE_IMPORT.md"]) {
  const markdown = await readFile(path, "utf8");
  for (const [, link] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|mailto:|#)/.test(link)) continue;
    await access(resolve(dirname(path), decodeURIComponent(link.split("#")[0])));
  }
}
const types = { "index.html": "text/html", "app.js": "text/javascript", "app.css": "text/css", "sw.js": "text/javascript",
  "manifest.webmanifest": "application/manifest+json", "user-guide.html": "text/html", "icon-192.png": "image/png", "icon-512.png": "image/png" };
const files = Object.fromEntries(await Promise.all(Object.keys(types).map(async (name) => [name, await readFile("dist/" + name)])));
const server = createServer((req, res) => {
  const name = new URL(req.url, "http://127.0.0.1").pathname.slice(1) || "index.html";
  if (!Object.hasOwn(files, name)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[name], "Cache-Control": "no-store" }).end(files[name]);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const home = "http://127.0.0.1:" + server.address().port + "/";
try {
  for (const [index, channel] of (process.env.SSB_BROWSER_CHANNELS ?? "chromium").split(",").entries()) {
    const browser = await chromium.launch({ channel });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const errors = [];
      context.on("weberror", (error) => errors.push(error.error().message));
      await page.goto(home);
      await page.waitForFunction(() => !document.querySelector("#upload").disabled);
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      assert.equal(await page.locator("#version").textContent(), "Версия " + version);
      assert.equal(await page.locator(".dev-badge, #pwa-preview").count(), 0);
      if (capture && index === 0) {
        await page.screenshot({ path: "docs/assets/guide-install.png" });
      }
      const [guide] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "Помощь", exact: true }).click()]);
      await guide.getByRole("heading", { name: "Руководство пользователя Support Services Builder", exact: true }).waitFor();
      assert.equal(guide.url(), home + "user-guide.html");
      assert.match(await guide.locator("main").textContent(), new RegExp("Версия " + version.replaceAll(".", "\\.")));
      assert.equal(await guide.locator("h2").count(), 10);
      assert.equal(await guide.locator("img").count(), 4);
      for (const image of await guide.locator("img").all()) {
        assert.ok(await image.evaluate(async (el) => { await el.decode(); return el.naturalWidth > 0 && el.naturalHeight > 0; }));
      }
      const links = await guide.locator("a").evaluateAll((anchors) => anchors.map((el) => ({ href: el.getAttribute("href"), url: el.href })));
      for (const link of links) {
        if (link.url.startsWith(home)) {
          const target = new URL(link.url);
          if (target.hash && target.pathname.endsWith("user-guide.html")) assert.equal(await guide.locator("[id]").evaluateAll((els, id) => els.some((el) => el.id === id), decodeURIComponent(target.hash.slice(1))), true);
          else assert.equal((await context.request.get(link.url)).status(), 200);
        }
      }
      await context.setOffline(true);
      await guide.reload();
      await guide.getByRole("heading", { name: "Руководство пользователя Support Services Builder", exact: true }).waitFor();
      await context.setOffline(false);
      await guide.getByRole("link", { name: "К приложению", exact: true }).click();
      await guide.waitForURL(home + "index.html");
      await guide.close();
      if (capture && index === 0) {
        await page.locator("#catalog-file").setInputFiles({ name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(referenceFixture())) });
        await page.waitForFunction(() => document.querySelectorAll("#services tr").length === 6);
        await page.locator('input[name="proposal-variant"][value="Extended"]').check();
        await page.locator('[name="sla-mode"][value="all"]').check();
        await page.locator('[name="sla-format"][value="comparison"]').check();
        await page.locator("#save-template").click();
        await page.getByText("Черновик сохранён на этом устройстве.", { exact: true }).waitFor({ state: "attached" });
        await page.mouse.move(1, 1);
        await page.locator(".comparison").screenshot({ path: "docs/assets/guide-proposal.png" });
        await page.locator("#open-sources").click();
        await page.locator("#source-base").fill(REFERENCE_SOURCES.base);
        await page.locator("#source-space").fill(REFERENCE_SOURCES.space);
        for (const [key, value] of Object.entries(REFERENCE_SOURCES.labels)) await page.locator("#label-" + key).fill(value);
        await page.locator("#save-sources").click();
        await page.locator("#sources-notice").waitFor({ state: "hidden", timeout: 8000 });
        await page.mouse.move(1, 1);
        await page.locator("#sources-dialog").screenshot({ path: "docs/assets/guide-sources.png" });
        await page.keyboard.press("Escape");
        await page.locator("#open-palette").click();
        await page.locator('[name="palette-mode"][value="custom"]').check();
        await page.locator('[name="palette-text-proposal"][value="auto"]').check();
        await page.mouse.move(1, 1);
        await page.locator("#palette-dialog").screenshot({ path: "docs/assets/guide-palette.png" });
      }
      assert.deepEqual(errors, []);
      console.log(channel + ": Help, versioned guide, ten sections, four images, local links, return to app and offline access OK");
    } finally { await browser.close(); }
  }
} finally { await new Promise((resolve) => server.close(resolve)); }
