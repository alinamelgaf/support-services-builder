import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const headings = ["Добавлено", "Изменено", "Исправлено"];
const format = /^## ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) — (\d{4}-\d{2}-\d{2})$/;

export function currentRelease(changelog, version) {
  const entries = changelog.replace(/\r\n?/g, "\n").split(/(?=^## )/m).slice(1);
  const seen = new Set();
  const releases = entries.map((entry) => {
    const [heading, ...lines] = entry.trim().split("\n");
    const match = format.exec(heading);
    if (!match) throw new Error("Invalid release heading: " + heading);
    const [, number, date] = match;
    if (seen.has(number)) throw new Error("Duplicate release: " + number);
    seen.add(number);
    const day = new Date(date);
    if (!Number.isFinite(day.valueOf()) || day.toISOString().slice(0, 10) !== date) throw new Error("Invalid release date: " + date);
    const sections = lines.join("\n").trim().split(/(?=^### )/m);
    if (sections.length !== headings.length || sections.some((section, index) => {
      const [title, ...body] = section.trim().split("\n");
      const content = body.join("\n").trim();
      return title !== "### " + headings[index] || !(content === "—" || /^- \S/m.test(content));
    }) || !sections.some((section) => /^- \S/m.test(section))) throw new Error("Missing release notes: " + number);
    return { version: number, date, markdown: entry.trim() + "\n" };
  });
  if (!releases.length || releases[0].version !== version) throw new Error("Current CHANGELOG version does not match package.json");
  return releases[0];
}

export async function readRelease() {
  const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  return currentRelease(await readFile(new URL("CHANGELOG.md", root), "utf8"), version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = await readRelease();
  if (process.argv[2]) await writeFile(process.argv[2], release.markdown);
  console.log("Validated release " + release.version + " · " + release.date);
}
