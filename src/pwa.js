export function enablePwa({ saveDraft, hasPendingImport, isBusy }) {
  if (!document.querySelector('link[rel="manifest"]') || !isSecureContext || !navigator.serviceWorker) return;
  const $ = (selector) => document.querySelector(selector);
  const update = $("#update");
  const install = $("#install");
  const notice = $("#pwa-notice");
  const tell = (text) => { notice.textContent = text; notice.hidden = !text; };
  const serviceWorker = navigator.serviceWorker;
  const version = $("#version").textContent.trim();
  let registration;
  let installing;
  let approved = false;
  let reloadReady = false;
  let checking = false;
  let installFailed = false;
  let timeout;
  $("#pwa-actions").hidden = false;
  update.disabled = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installing = event;
    install.hidden = false;
  });
  window.addEventListener("appinstalled", () => { install.hidden = true; installing = null; });
  install.addEventListener("click", async () => {
    const prompt = installing;
    installing = null;
    install.hidden = true;
    try { await prompt?.prompt(); }
    catch { tell("Для установки используйте меню приложений браузера."); }
  });

  function available() {
    if (!registration.waiting) return false;
    update.textContent = "Установить обновление";
    tell("Новая версия готова. Откройте её, когда закончите работу с предложением.");
    return true;
  }

  async function reloadSaved() {
    if (!isBusy() && await saveDraft() && !isBusy()) {
      location.reload();
    } else {
      update.textContent = "Перезапустить приложение";
      tell("Перезапуск отложен. Дождитесь окончания операции и сохранения правок.");
    }
  }

  serviceWorker.addEventListener("controllerchange", () => {
    if (!approved) return;
    approved = false;
    clearTimeout(timeout);
    reloadReady = true;
    void reloadSaved();
  });
  serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((worker) => {
    registration = worker;
    update.disabled = false;
    const watchInstall = () => {
      const next = worker.installing;
      next?.addEventListener("statechange", () => {
        if (next.state === "installed") available();
        if (next.state === "redundant" && !worker.waiting) {
          installFailed = true;
          tell("Обновление не подготовлено. Можно продолжить работу в текущей версии.");
        }
      });
    };
    worker.addEventListener("updatefound", watchInstall);
    watchInstall();
    available();
  }).catch(() => tell("Офлайн-установка недоступна. Можно продолжить работу в открытой вкладке."));

  update.addEventListener("click", async () => {
    if (!registration || approved || checking || isBusy()) return;
    if (reloadReady) {
      if (window.confirm("Перезапустить приложение после сохранения черновика?")) await reloadSaved();
      return;
    }
    const waiting = registration.waiting;
    if (waiting) {
      const imported = hasPendingImport() ? " Незавершённую загрузку страниц JSON потребуется повторить." : "";
      if (!window.confirm(`Установить обновление после сохранения черновика? Настройки и сохранённое предложение откроются после перезапуска.${imported}`)) return;
      approved = true;
      if (!await saveDraft() || isBusy()) {
        approved = false;
        tell("Обновление отложено. Сначала сохраните черновик и настройки, затем повторите попытку.");
        return;
      }
      waiting.postMessage({ type: "SSB_ACTIVATE" });
      timeout = setTimeout(() => {
        approved = false;
        tell("Не удалось подтвердить обновление в этой вкладке. Можно продолжить работу.");
      }, 8000);
      return;
    }
    await checkForUpdate(true);
  });

  async function checkForUpdate(manual = false) {
    if (!registration || checking || approved || reloadReady || available()) return;
    checking = true;
    installFailed = false;
    update.disabled = true;
    try {
      await registration.update();
      if (!available() && manual && !installFailed) tell(registration.installing ? "Обновление загружается…" : `${version}. Новая версия не найдена.`);
    } catch {
      if (manual) tell("Не удалось проверить обновления. Проверьте подключение к интернету.");
    } finally {
      checking = false;
      update.disabled = false;
    }
  }

  window.addEventListener("online", () => void checkForUpdate());
  setInterval(() => { if (navigator.onLine) void checkForUpdate(); }, 15 * 60_000);
}
