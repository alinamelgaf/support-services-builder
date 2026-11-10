import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");
const write = (path, content) => writeFile(join(root, path), content, "utf8");
const integrity = (source) => "sha256-" + createHash("sha256").update(source).digest("base64");
const { version } = JSON.parse(await read("package.json"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a release version in package.json");
const [page, stylesheet] = await Promise.all([read("src/page.html"), read("src/app.css")]);
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/app.js"],
  bundle: true, format: "iife", platform: "browser", target: ["chrome109", "edge109"],
  minify: true, legalComments: "inline", write: false, charset: "utf8",
});
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = stylesheet.replace(/\r\n?/g, "\n").replace(/<\/style/gi, "<\\/style");
const policy = (scriptSource, styleSource, pwa) =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSource}; style-src ${styleSource}; connect-src 'none'; base-uri 'none'; form-action 'none'${pwa ? "; manifest-src 'self'; img-src 'self'; worker-src 'self'" : ""}">`;

function html(csp, styleTag, scriptTag, manifest = "") {
  return page.replace("<!-- CSP -->", () => csp)
    .replace("<!-- STYLE -->", () => styleTag)
    .replace("<!-- SCRIPT -->", () => scriptTag)
    .replace("<!-- MANIFEST -->", () => manifest)
    .replace("<!-- VERSION -->", () => version);
}

await Promise.all([mkdir(join(root, "dist"), { recursive: true }), mkdir(join(root, "standalone"), { recursive: true })]);
const manifest = '<link rel="manifest" href="./manifest.webmanifest"><link rel="icon" href="./icon-192.png"><meta name="theme-color" content="#123150">';
const assets = {
  "index.html": html(policy("'self'", "'self'", true), '<link rel="stylesheet" href="./app.css">', '<script src="./app.js"></script>', manifest),
  "app.js": script, "app.css": css,
  "manifest.webmanifest": (await read("pwa/manifest.webmanifest")).replace(/\r\n?/g, "\n"),
  "icon-192.png": await readFile(join(root, "pwa/icon-192.png")),
  "icon-512.png": await readFile(join(root, "pwa/icon-512.png")),
};
const hashes = Object.fromEntries(Object.entries(assets).map(([name, content]) => [name, integrity(content)]));
const sw = (await read("pwa/sw.js")).replace(/\r\n?/g, "\n");
const digest = createHash("sha256").update(sw).update(JSON.stringify(hashes)).digest("hex").slice(0, 20);
const worker = sw.replace("@@VERSION@@", `${version}-${digest}`).replace("@@ASSETS@@", JSON.stringify(hashes));
await Promise.all([
  ...Object.entries(assets).map(([name, content]) => writeFile(join(root, "dist", name), content)),
  write("dist/sw.js", worker),
  write("dist/.nojekyll", ""),
  write("standalone/index.html", html(policy(`'${integrity(script)}'`, `'${integrity(css)}'`), `<style>${css}</style>`, `<script>${script}</script>`)),
]);

const notices = new Map();
const visited = new Set();

async function collectLicenses(directory) {
  const real = await realpath(directory);
  if (visited.has(real)) return;
  visited.add(real);
  const entries = await readdir(real, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["@esbuild", "esbuild", "fsevents", "playwright", "playwright-core"].includes(entry.name) ||
        (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const path = join(real, entry.name);
    if (entry.name.startsWith("@")) {
      await collectLicenses(path);
      continue;
    }
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    const key = `${manifest.name}@${manifest.version}`;
    const files = (await readdir(path)).filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
    const content = await Promise.all(files.map((file) => readFile(join(path, file), "utf8")));
    notices.set(key, `${key} · ${manifest.license ?? ""}\n${content.join("\n")}`);
    if ((await readdir(path)).includes("node_modules")) await collectLicenses(join(path, "node_modules"));
  }
}

await collectLicenses(join(root, "node_modules"));
const virtualStore = join(root, "node_modules", ".pnpm");
const virtualEntries = await readdir(virtualStore, { withFileTypes: true }).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
for (const entry of virtualEntries) {
  if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
  await collectLicenses(join(virtualStore, entry.name, "node_modules"));
}
const licenseText = [...notices].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  .map(([, notice]) => notice).join("\n\n-----\n\n").replace(/\r\n?/g, "\n");
await Promise.all([write("dist/THIRD_PARTY_NOTICES.txt", licenseText), write("standalone/THIRD_PARTY_NOTICES.txt", licenseText)]);
console.log(`Built Support Services Builder ${version} in dist/ and standalone/`);
