const DATABASE = (typeof __SSB_STORAGE_PREFIX__ === "string" ? __SSB_STORAGE_PREFIX__ : "") + "support-services-builder-drafts";
const STORE = "proposals";
const SCHEMA_VERSION = 1;

export async function openDraftStore(scope) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Хранилище черновиков занято."));
  });
  database.onversionchange = () => database.close();

  let revision;
  return {
    async load() {
      const record = await new Promise((resolve, reject) => {
        const request = database.transaction(STORE).objectStore(STORE).get(scope);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (record && (record.schemaVersion !== SCHEMA_VERSION || !record.proposal ||
          !Number.isSafeInteger(record.revision) || record.revision < 1)) {
        throw new Error("Формат сохранённого черновика несовместим.");
      }
      revision = record?.revision ?? 0;
      return record?.proposal;
    },
    async save(proposal) {
      if (revision === undefined) throw new Error("Сначала восстановите сохранённый черновик.");
      const next = revision + 1;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, "readwrite", { durability: "strict" });
        const store = transaction.objectStore(STORE);
        const request = store.get(scope);
        let conflict = false;
        request.onsuccess = () => {
          if ((request.result?.revision ?? 0) !== revision) {
            conflict = true;
            transaction.abort();
            return;
          }
          store.put({ schemaVersion: SCHEMA_VERSION, revision: next, proposal }, scope);
        };
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(conflict
          ? new Error("Черновик изменён в другой вкладке. Продолжите в ней или откройте актуальный черновик заново.")
          : transaction.error);
      });
      revision = next;
    },
  };
}

export function createDraftAutosave(store, snapshot, status) {
  let dirty = false;
  let writing = null;

  function flush() {
    if (!dirty && !writing) return Promise.resolve(true);
    if (!writing) {
      writing = (async () => {
        while (dirty) {
          dirty = false;
          try {
            await store.save(snapshot());
          } catch (error) {
            dirty = true;
            status("Не удалось сохранить черновик. " + (error?.message || "Проверьте хранилище браузера."), true);
            return false;
          }
        }
        status("Черновик сохранён на этом устройстве.");
        return true;
      })().finally(() => { writing = null; });
    }
    return writing;
  }

  return {
    change() {
      dirty = true;
      status("Сохраняем черновик…");
      void flush();
    },
    flush,
    get unsaved() { return dirty || writing !== null; },
  };
}
