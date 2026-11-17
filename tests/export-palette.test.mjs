import assert from "node:assert/strict";
import { test } from "node:test";
import { documentPalette, hexColor, readLocalPalette, resolveDocumentPalette, writeLocalPalette } from "../src/export-palette.js";

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

test("stores the local palette separately and confirms writes and reset", () => {
  const values = new Map([["other-settings", "preserved"]]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: values.set.bind(values), removeItem: values.delete.bind(values) };
  const custom = documentPalette({ mode: "custom", main: { background: "#11CC88", textMode: "auto" } });
  assert.deepEqual(readLocalPalette(storage), documentPalette());
  writeLocalPalette(storage, custom);
  assert.deepEqual(readLocalPalette(storage), custom);
  assert.throws(() => writeLocalPalette({ ...storage, setItem() {} }, { ...custom, main: { background: "#000000" } }));
  assert.throws(() => writeLocalPalette({ ...storage, removeItem() {} }, documentPalette()));
  writeLocalPalette(storage, documentPalette());
  assert.deepEqual(readLocalPalette(storage), documentPalette());
  assert.deepEqual([...values], [["other-settings", "preserved"]]);
});
