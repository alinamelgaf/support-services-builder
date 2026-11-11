import assert from "node:assert/strict";
import { test } from "node:test";
import { currentRelease, readRelease } from "../scripts/release-notes.mjs";
import { createDraftAutosave } from "../src/draft.js";

test("releases require a matching version, valid date and user-facing notes", async () => {
  const release = await readRelease();
  const changes = "# Changelog\n\n" + release.markdown;
  assert.equal(currentRelease(changes, release.version).date, release.date);
  assert.throws(() => currentRelease(changes, "0.0.0"), /does not match/);
  assert.throws(() => currentRelease(changes.replace(release.date, "2026-02-30"), release.version), /Invalid release date/);
  assert.throws(() => currentRelease(changes.replace(/^- .*$/gm, "—"), release.version), /Missing release notes/);
  assert.throws(() => currentRelease(changes + "\n" + release.markdown, release.version), /Duplicate release/);
});

test("draft flush waits for the newest edit and reports write failure", async () => {
  let current = "первое изменение";
  let finishFirst;
  let fail = false;
  const saved = [];
  const statuses = [];
  const store = {
    async save(value) {
      if (!saved.length) await new Promise((resolve) => { finishFirst = resolve; });
      if (fail) throw new Error("Учебная ошибка записи");
      saved.push(value);
    },
  };
  const draft = createDraftAutosave(store, () => current, (...status) => statuses.push(status));
  draft.change();
  current = "второе изменение";
  draft.change();
  assert.equal(draft.unsaved, true);
  finishFirst();
  assert.equal(await draft.flush(), true);
  assert.deepEqual(saved, ["первое изменение", "второе изменение"]);
  fail = true;
  current = "третье изменение";
  draft.change();
  assert.equal(await draft.flush(), false);
  assert.equal(draft.unsaved, true);
  assert.match(statuses.at(-1)[0], /Учебная ошибка записи/);
  fail = false;
  assert.equal(await draft.flush(), true);
  assert.equal(saved.at(-1), "третье изменение");
});
