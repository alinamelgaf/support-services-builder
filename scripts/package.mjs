import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { SAMPLE, STATIC_FILES, STANDALONE_FILES, USER_DOCS } from "./ship-files.mjs";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version");
await mkdir("release", { recursive: true });
const hashes = [];
for (const [name, root, files] of [["pwa", "dist", STATIC_FILES], ["standalone", "standalone", STANDALONE_FILES]]) {
  const zip = new JSZip();
  const inputs = [...files.map((file) => [`${root}/${file}`, file]), ...USER_DOCS.map((file) => [file, file])];
  if (name === "standalone") inputs.push([SAMPLE, SAMPLE]);
  const date = new Date("2020-01-01T00:00:00Z");
  for (const [from, to] of inputs) zip.file(to, await readFile(from), { date, createFolders: false });
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" });
  const check = await JSZip.loadAsync(buffer, { checkCRC32: true });
  if (Object.keys(check.files).length !== inputs.length || inputs.some(([, to]) => !check.file(to))) throw new Error("Unexpected ZIP entry");
  const file = `support-services-builder-${version}-${name}.zip`;
  await writeFile(`release/${file}`, buffer);
  hashes.push(`${createHash("sha256").update(buffer).digest("hex")}  ${file}`);
  console.log(`Packaged ${file}`);
}
await writeFile("release/SHA256SUMS.txt", hashes.join("\n") + "\n");
