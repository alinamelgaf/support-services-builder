import assert from "node:assert/strict";
import { test } from "node:test";
import {
  documentPalette, hexColor, paletteSettings, readLocalPalette, restorePaletteSettings, resolveDocumentPalette, writeLocalPalette,
} from "../src/export-palette.js";

test("keeps the fixed base palette and normalizes missing or malformed draft values", () => {
  const base = documentPalette();
  assert.deepEqual(documentPalette({ mode: "base", main: { background: "#FFFFFF" } }), base);
  assert.equal(hexColor("#aa11bb"), "#AA11BB");
  for (const input of ["aa11bb", "#AB1", "#AABBCCDD", " #00AD21", "#00AD21\n", "#ZZZZZZ", undefined]) assert.equal(hexColor(input), null);
  const custom = documentPalette({ mode: "custom", proposal: { background: "#BAD", textMode: "invalid", textColor: 0 } });
  assert.deepEqual(custom, { ...base, mode: "custom" });
  const colors = resolveDocumentPalette(base);
  assert.equal(colors.main.background, "#234C5E");
  assert.equal(colors.proposal.background, "#00AD21");
  assert.equal(colors.proposal.text, "#FFFFFF");
  assert.ok(colors.proposal.contrast < 4.5);
  assert.equal(colors.selectedFill, "#E0F5E4");
});

test("handles extreme backgrounds and honors explicitly selected text colors", () => {
  for (const background of ["#000000", "#FFFFFF", "#FFFF00", "#FF0000", "#757575"]) {
    const main = { background, textMode: "auto" };
    const proposal = { background, textMode: "custom", textColor: background };
    const colors = resolveDocumentPalette({ mode: "custom", main, proposal });
    assert.ok(["#000000", "#FFFFFF"].includes(colors.main.text));
    assert.ok(colors.main.contrast >= 4.5);
    assert.equal(colors.proposal.text, background);
    assert.equal(colors.proposal.contrast, 1);
    assert.ok(Number.parseInt(colors.selectedFill.slice(1, 3), 16) >= 224);
    assert.ok(colors.band.startsWith("#"));
    if (background === "#FFFFFF") {
      assert.notEqual(colors.titleText, background);
      assert.equal(colors.selectedFill, "#EEEEEE");
    }
  }
});

test("stores independent palette mode and custom settings in the existing record and verifies writes", () => {
  const values = new Map([["other-settings", "preserved"]]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: values.set.bind(values), removeItem: values.delete.bind(values) };
  const custom = documentPalette({ mode: "custom", main: { background: "#11CC88", textMode: "auto" } });
  assert.equal(readLocalPalette(storage), null);
  const own = paletteSettings(custom);
  writeLocalPalette(storage, own);
  assert.deepEqual(readLocalPalette(storage), own);
  const base = { ...own, mode: "base" };
  writeLocalPalette(storage, base);
  assert.deepEqual(readLocalPalette(storage).custom, own.custom);
  assert.deepEqual(documentPalette(readLocalPalette(storage)), documentPalette());
  assert.deepEqual(documentPalette({ ...readLocalPalette(storage), mode: "custom" }), custom);
  assert.throws(() => writeLocalPalette({ ...storage, setItem() {} }, own));
  assert.deepEqual(readLocalPalette(storage), base);
  assert.equal(values.get("other-settings"), "preserved");
  assert.equal(values.size, 2);
});

test("migrates old fixed and draft palettes without losing distinct custom colors", () => {
  const local = documentPalette({ mode: "custom", main: { background: "#112233", textMode: "auto", textColor: "#445566" } });
  const draft = documentPalette({ mode: "custom", proposal: { background: "#774499", textMode: "custom", textColor: "#FFEEDD" } });
  const migrated = restorePaletteSettings(local, draft);
  assert.deepEqual(documentPalette(migrated), draft);
  assert.deepEqual(migrated.legacyFixed, { main: local.main, proposal: local.proposal });
  const base = restorePaletteSettings(local, documentPalette());
  assert.equal(base.mode, "base");
  assert.deepEqual(documentPalette({ ...base, mode: "custom" }), local);
  assert.deepEqual(documentPalette(restorePaletteSettings(local)), local);
  assert.deepEqual(documentPalette(restorePaletteSettings(null, draft)), draft);
});

test("restores the latest palette after a failed local write and protects new preferences from stale drafts", () => {
  const local = { ...paletteSettings(), updatedAt: 20 };
  const draft = { ...paletteSettings({ mode: "custom", main: { background: "#112233" } }), updatedAt: 30 };
  assert.deepEqual(restorePaletteSettings(local, draft), draft);
  assert.deepEqual(restorePaletteSettings({ ...local, updatedAt: 40 }, draft), { ...local, updatedAt: 40 });
  assert.deepEqual(restorePaletteSettings(local, documentPalette({ mode: "custom" })), local);
});
