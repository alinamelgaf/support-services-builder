import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fixture } from "../tests/fixtures.mjs";
import { SAMPLE, STATIC_FILES, STANDALONE_FILES } from "./ship-files.mjs";

const root = process.cwd();
const realRoot = await realpath(root);
const known = new Set([".gitignore", ".gitattributes", "README.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "build.mjs", SAMPLE]);
const safePath = /^(?:src\/[\w.-]+\.(?:js|css|html)|pwa\/(?:sw\.js|manifest\.webmanifest|icon-(?:192|512)\.png)|config\/presets\.json|(?:tests|scripts)\/[\w.-]+\.mjs|docs\/[\w.-]+\.md|\.github\/workflows\/[\w.-]+\.yml)$/;
const suspicious = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----\s+[A-Za-z0-9+/]{24}/],
  ["token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{12,})\b/],
  ["credentialed URL", /https?:\/\/[^\s"'/:]+:[^\s"'@/]+@[a-z\d.-]+/i],
  ["hardcoded credential", /(?:password|client_secret|access_token|api[_-]?key)\s*[=:]\s*["'][A-Za-z0-9+/_.-]{20,}["']/i],
];
const xmlHosts = new Set(["schemas.openxmlformats.org", "www.w3.org"]);
const binaryNames = /(?:^|\/)icon-(?:192|512)\.png$/;
const fixtureText = JSON.stringify(fixture({ unknown: false, adversarial: false }));
const isContained = (parent, child) => {
  const difference = relative(parent, child);
  return difference === "" || (!isAbsolute(difference) && !/^\.\.(?:[\\/]|$)/.test(difference));
};

let deny = [];
if (process.env.SSB_PRIVATE_DENYLIST) {
  const list = await realpath(resolve(process.env.SSB_PRIVATE_DENYLIST));
  if (isContained(realRoot, list)) throw new Error("Keep the private denylist outside the repository.");
  deny = (await readFile(list, "utf8")).split(/\r?\n/).map((line) => line.trim().normalize("NFKC").toLowerCase()).filter(Boolean);
}
if (process.argv.includes("--private-required") && !deny.length) throw new Error("A nonempty private denylist is required for this check.");

async function scan(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024 || !isContained(realRoot, await realpath(path))) {
    throw new Error(`Invalid public file: ${path}`);
  }
  const raw = await readFile(path);
  if (binaryNames.test(path) && !raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`Invalid PNG: ${path}`);
  const text = raw.toString("utf8");
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const phrase of deny) if (normalized.includes(phrase)) throw new Error(`Private denylist match in ${path}`);
  for (const [reason, pattern] of suspicious) if (pattern.test(text)) throw new Error(`${reason} match in ${path}`);
  if (/^(?:src|config|pwa|tests|examples)\//.test(path)) {
    for (const [url] of text.matchAll(/https?:\/\/[a-z\d][a-z\d.-]*/gi)) {
      const host = new URL(url).hostname;
      if (!(host.endsWith(".invalid") || host === "127.0.0.1" || xmlHosts.has(host))) throw new Error(`Unexpected host literal in ${path}`);
    }
  }
  if (path === SAMPLE && JSON.stringify(JSON.parse(text)) !== fixtureText) throw new Error("Public demo does not match the synthetic fixture.");
}

const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
if (!paths.length) throw new Error("Stage the public files before running the repository scan.");
for (const path of paths) {
  if (!(known.has(path) || safePath.test(path))) throw new Error(`Unexpected tracked path: ${path}`);
  await scan(path);
}
if (process.argv.includes("--built")) {
  for (const [folder, allowed] of [["dist", STATIC_FILES], ["standalone", STANDALONE_FILES]]) {
    const files = await readdir(folder);
    if (files.length !== allowed.length || files.some((name) => !allowed.includes(name))) throw new Error(`Unexpected or missing files in ${folder}`);
    for (const name of allowed) await scan(`${folder}/${name}`);
    const html = await readFile(`${folder}/index.html`, "utf8");
    if (!html.includes("connect-src 'none'")) throw new Error(`Missing network restriction in ${folder}`);
  }
}
console.log(`Public scan passed (${paths.length} tracked files${deny.length ? ", private denylist applied" : ""}).`);
