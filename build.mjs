import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import MarkdownIt from "markdown-it";
import { readRelease } from "./scripts/release-notes.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");
const write = (path, content) => writeFile(join(root, path), content, "utf8");
const integrity = (source) => "sha256-" + createHash("sha256").update(source).digest("base64");
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--dev")) throw new Error("Usage: node build.mjs [--dev]");
const dev = args[0] === "--dev";
const dist = dev ? "dist-dev" : "dist";
const standalone = dev ? "standalone-dev" : "standalone";
const project = JSON.parse(await read("package.json"));
const { version } = project;
const displayVersion = version + (dev ? "-dev" : "");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a release version in package.json");
const [page, stylesheet, release, guideSource, guideCss] = await Promise.all([
  read("src/page.html"), read("src/app.css"), readRelease(), read("docs/USER_GUIDE.md"), read("src/guide.css"),
]);
const markdown = new MarkdownIt({ html: false });
const guideImages = new Map(await Promise.all(["install", "sources", "proposal"].map(async (name) => {
  const path = `assets/guide-${name}.png`;
  const image = await readFile(join(root, "docs", path));
  return [path, `data:image/png;base64,${image.toString("base64")}`];
})));
const renderImage = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const path = token.attrGet("src");
  if (!guideImages.has(path)) throw new Error("Unexpected guide image: " + path);
  token.attrSet("src", guideImages.get(path));
  return renderImage(tokens, index, options, env, renderer);
};
const guideStyle = guideCss.replace(/\r\n?/g, "\n");
const guide = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src '${integrity(guideStyle)}'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Руководство пользователя Support Services Builder</title><style>${guideStyle}</style></head>
<body><main><nav><a href="./index.html">К приложению</a></nav>
${markdown.render(guideSource)}
</main></body></html>\n`;
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/app.js"],
  bundle: true, format: "iife", platform: "browser", target: ["chrome109", "edge109"],
  minify: true, legalComments: "inline", write: false, charset: "utf8",
  define: { __SSB_STORAGE_PREFIX__: JSON.stringify(dev ? "ssb-dev:" : "") },
  alias: { exceljs: "exceljs/dist/exceljs.js" },
  plugins: [{
    name: "exceljs-uuid-buffer-check",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]exceljs[\\/]dist[\\/]exceljs\.js$/ }, async ({ path }) => {
        const contents = await readFile(path, "utf8");
        // ExcelJS embeds uuid in its browser distribution. The lockfile override only affects Node.js.
        const declaration = "function generateUUID(value, namespace, buf, offset) {";
        if (contents.split(declaration).length !== 2) throw new Error("Review the bundled ExcelJS UUID implementation before building.");
        const guard = "if (buf && ((offset || 0) < 0 || (offset || 0) + 16 > buf.length)) " +
          'throw new RangeError("UUID byte range is out of buffer bounds");';
        return { contents: contents.replace(declaration, () => declaration + "\n    " + guard), loader: "js" };
      });
    },
  }],
});
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = (stylesheet + (dev ? "\n" + await read("src/dev.css") : ""))
  .replace(/\r\n?/g, "\n").replace(/<\/style/gi, "<\\/style");
const policy = (scriptSource, styleSource, external) =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSource}; style-src ${styleSource}; connect-src 'none'; base-uri 'none'; form-action 'none'; img-src ${external ? "'self'" : "data:"}${dev ? "; worker-src 'none'" : external ? "; manifest-src 'self'; worker-src 'self'" : ""}">`;

function html(csp, styleTag, scriptTag, appIcon, manifest = "") {
  return page.replace(/\r\n?/g, "\n").replace("<!-- CSP -->", () => csp)
    .replace("<!-- STYLE -->", () => styleTag)
    .replace("<!-- SCRIPT -->", () => scriptTag)
    .replace("<!-- MANIFEST -->", () => manifest)
    .replace("<!-- APP_ICON -->", () => appIcon)
    .replace("<!-- APP_TITLE -->", () => dev ? "SSB — Тестовая версия" : "Support Services Builder")
    .replace("<!-- DEV_BADGE -->", () => dev ? '\n      <span class="dev-badge">ТЕСТОВАЯ</span>' : "")
    .replace("<!-- DEV_NOTICE -->", () => dev ? '\n    <p class="dev-notice">Локальная тестовая сборка. Настройки и черновики хранятся отдельно.</p>' : "")
    .replace("<!-- RELEASE_NOTES -->", () => markdown.render(release.markdown.replace(`## ${version} —`, `## ${displayVersion} —`)))
    .replace("<!-- VERSION -->", () => displayVersion);
}

await Promise.all([dist, standalone].map((folder) => mkdir(join(root, folder), { recursive: true })));
const headLinks = dev ? '<link rel="icon" href="./icon-192.png">'
  : '<link rel="manifest" href="./manifest.webmanifest"><link rel="icon" href="./icon-192.png"><meta name="theme-color" content="#123150">';
const appIcon = await readFile(join(root, "pwa/icon-192.png"));
const assets = {
  "index.html": html(policy("'self'", "'self'", true), '<link rel="stylesheet" href="./app.css">', '<script src="./app.js"></script>', "./icon-192.png", headLinks),
  "app.js": script, "app.css": css,
  ...(!dev ? { "manifest.webmanifest": (await read("pwa/manifest.webmanifest")).replace(/\r\n?/g, "\n") } : {}),
  "icon-192.png": appIcon,
  ...(!dev ? { "icon-512.png": await readFile(join(root, "pwa/icon-512.png")) } : {}),
  "user-guide.html": guide,
};
if (!dev) {
  const hashes = Object.fromEntries(Object.entries(assets).map(([name, content]) => [name, integrity(content)]));
  const sw = (await read("pwa/sw.js")).replace(/\r\n?/g, "\n");
  const digest = createHash("sha256").update(sw).update(JSON.stringify(hashes)).digest("hex").slice(0, 20);
  assets["sw.js"] = sw.replace("@@VERSION@@", `${version}-${digest}`).replace("@@ASSETS@@", JSON.stringify(hashes));
  assets[".nojekyll"] = "";
}
await Promise.all([
  ...Object.entries(assets).map(([name, content]) => writeFile(join(root, dist, name), content)),
  ...[dist, standalone].map((folder) => copyFile(join(root, "LICENSE"), join(root, folder, "LICENSE"))),
  write(join(standalone, "user-guide.html"), guide),
  write(join(standalone, "index.html"), html(policy(`'${integrity(script)}'`, `'${integrity(css)}'`), `<style>${css}</style>`, `<script>${script}</script>`,
    `data:image/png;base64,${appIcon.toString("base64")}`)),
]);

const notices = new Map();
const visited = new Set();

async function packageManifest(name, from) {
  for (const lookup of createRequire(from).resolve.paths(name + "/package.json") ?? []) {
    try { return await realpath(join(lookup, name, "package.json")); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  }
  throw new Error("Could not resolve installed package: " + name);
}

async function collectLicenses(path) {
  if (visited.has(path)) return;
  visited.add(path);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const key = `${manifest.name}@${manifest.version}`;
  const directory = dirname(path);
  const files = (await readdir(directory)).filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name)).sort();
  const content = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
  notices.set(key, `${key} · ${manifest.license ?? ""}\n${content.join("\n")}`);
  for (const name of Object.keys(manifest.dependencies ?? {})) await collectLicenses(await packageManifest(name, path));
}

const manifestPath = join(root, "package.json");
for (const name of Object.keys(project.dependencies)) await collectLicenses(await packageManifest(name, manifestPath));
notices.set("uuid@8.3.2", "uuid@8.3.2 · MIT · embedded in ExcelJS\n" + await read("docs/UUID_8_3_2_LICENSE.md"));
const licenseText = [...notices].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  .map(([, notice]) => notice).join("\n\n-----\n\n").replace(/\r\n?/g, "\n");
await Promise.all([dist, standalone].map((folder) => write(join(folder, "THIRD_PARTY_NOTICES.txt"), licenseText)));
console.log(`Built Support Services Builder ${displayVersion} in ${dist}/ and ${standalone}/`);
