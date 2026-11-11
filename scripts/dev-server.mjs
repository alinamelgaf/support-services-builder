import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const host = "127.0.0.1";
const port = 4173;
const home = "http://localhost:4173/";
const marker = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
const statusPath = "/__ssb_dev_status";
const scriptPath = "/__ssb_dev_client.js";
const clientFile = join(root, "scripts/dev-client.mjs");
const initialClient = await readFile(clientFile);
const types = {
  "app.js": "text/javascript; charset=utf-8", "app.css": "text/css; charset=utf-8",
  "icon-192.png": "image/png", "user-guide.html": "text/html; charset=utf-8",
};
let state = { phase: "building", revision: "", error: "" };
let current;
let previous;
let timer;
let requested = false;
let building = false;

const panel = `<section id="ssb-dev-live" class="dev-notice" hidden>
  <p id="ssb-dev-message" role="status"></p>
  <pre id="ssb-dev-error" hidden></pre>
  <button id="ssb-dev-refresh" class="button" type="button" hidden>Загрузить новую сборку</button>
</section>`;
const clientTag = `<script type="module" src="${scriptPath}"></script>`;
const startingPage = `<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'none'; style-src 'unsafe-inline'; base-uri 'none'">
<title>SSB — Тестовая версия</title>
<body style="margin:2rem;font:1rem system-ui;color:#172c43">
<h1>SSB — Тестовая версия</h1><p>Ожидание локальной сборки…</p>${panel}${clientTag}</body></html>`;

function send(response, code, type, body) {
  response.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(body);
}

const server = createServer((request, response) => {
  if (!["localhost:4173", "127.0.0.1:4173"].includes(request.headers.host) || request.method !== "GET") {
    return send(response, 403, "text/plain; charset=utf-8", "Только локальный адрес тестовой среды.");
  }
  const path = URL.parse(request.url, home);
  if (!path) return send(response, 400, "text/plain; charset=utf-8", "Некорректный адрес.");
  const { pathname, searchParams } = path;
  if (pathname === statusPath) return send(response, 200, "application/json", JSON.stringify({ marker, ...state }));
  if (pathname === "/" || pathname === "/index.html") {
    return send(response, state.phase === "ready" ? 200 : 503, types["user-guide.html"],
      state.phase === "ready" ? current.page : startingPage);
  }
  const name = pathname.slice(1);
  const revision = searchParams.get("build");
  const snapshot = revision && revision === previous?.revision ? previous : current;
  if (pathname === scriptPath && (!revision || revision === snapshot?.revision)) {
    return send(response, 200, types["app.js"], snapshot?.client ?? initialClient);
  }
  if (Object.hasOwn(types, name) && snapshot && (!revision || revision === snapshot.revision)) {
    return send(response, 200, types[name], snapshot.files[name]);
  }
  return send(response, 404, "text/plain; charset=utf-8", "Файл не найден.");
});

function compile() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["build.mjs", "--dev"], { cwd: root, windowsHide: true });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      output = (output + chunk).slice(-8000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stripVTControlCharacters(output).trim() || "Код завершения " + code));
    });
  });
}

async function snapshot() {
  const revision = randomUUID();
  const template = await readFile(join(root, "dist-dev/index.html"), "utf8");
  const client = await readFile(clientFile);
  const files = Object.fromEntries(await Promise.all(Object.keys(types).map(async (name) =>
    [name, await readFile(join(root, "dist-dev", name))])));
  const page = template
    .replace("connect-src 'none'", "connect-src 'self'")
    .replace("</head>", `<meta name="ssb-dev-revision" content="${revision}"></head>`)
    .replace('<div class="intro">', panel + '<div class="intro">')
    .replace("</body>", clientTag.replace(scriptPath, scriptPath + "?build=" + revision) + "</body>")
    .replace(/(\.\/(?:app\.js|app\.css|icon-192\.png))"/g, `$1?build=${revision}"`);
  return { revision, page, files, client };
}

async function rebuild() {
  if (building || !requested) return;
  requested = false;
  building = true;
  try {
    await compile();
    const next = await snapshot();
    if (!requested) {
      previous = current;
      current = next;
      state = { phase: "ready", revision: current.revision, error: "" };
      console.log("Тестовая сборка готова. " + home);
    }
  } catch (error) {
    if (!requested) {
      state = { phase: "error", revision: current?.revision ?? "", error: error.message };
      console.error("Ошибка тестовой сборки\n" + error.message);
    }
  } finally {
    building = false;
    if (requested && !timer) void rebuild();
  }
}

function schedule() {
  requested = true;
  state = { phase: "building", revision: current?.revision ?? "", error: "" };
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void rebuild(); }, 250);
}

function monitor(directory, recursive, matches) {
  watch(join(root, directory), { recursive }, (_, name) => {
    if (name === null || matches(name.toString().replaceAll("\\", "/"))) schedule();
  }).on("error", (error) => console.error("Ошибка наблюдения за " + directory + ". Перезапустите сервер. " + error.message));
}

function openBrowser() {
  if (!process.argv.includes("--open") || process.platform !== "win32") return;
  const browser = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"),
    ["url.dll,FileProtocolHandler", home], { detached: true, windowsHide: true, stdio: "ignore" });
  browser.on("error", () => console.log("Откройте в браузере " + home));
  browser.unref();
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log("SSB — Тестовая версия " + home + "\nДля остановки нажмите Ctrl+C.");
  monitor(".", false, (name) => ["build.mjs", "package.json", "LICENSE", "CHANGELOG.md"].includes(name));
  for (const directory of ["src", "config", "pwa"]) monitor(directory, true, () => true);
  monitor("docs", true, (name) => name.startsWith("assets/") || ["USER_GUIDE.md", "UUID_8_3_2_LICENSE.md"].includes(name));
  monitor("scripts", false, (name) => ["release-notes.mjs", "dev-client.mjs"].includes(name));
  schedule();
  openBrowser();
} catch (error) {
  if (error.code !== "EADDRINUSE") throw error;
  let existing;
  try {
    const response = await fetch("http://" + host + ":" + port + statusPath, { signal: AbortSignal.timeout(1200) });
    if (response.ok) existing = await response.json();
  } catch { /* A foreign process may own the port. */ }
  if (existing?.marker === marker) {
    console.log("Тестовый сервер этого проекта уже работает. " + home);
    openBrowser();
  } else {
    console.error("Порт 4173 занят другой программой. Освободите порт и повторите запуск.");
    process.exitCode = 1;
  }
}
