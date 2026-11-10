export function enablePwa({ hasDraft, hasImport, isBusy }) {
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

  serviceWorker.addEventListener("controllerchange", () => {
    if (!approved) return;
    approved = false;
    clearTimeout(timeout);
    location.reload();
  });
  serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((worker) => {
    registration = worker;
    update.disabled = false;
    const watchInstall = () => {
      const next = worker.installing;
      next?.addEventListener("statechange", () => {
        if (next.state === "installed") available();
        if (next.state === "redundant" && !worker.waiting) tell("Обновление не подготовлено. Можно продолжить работу в текущей версии.");
      });
    };
    worker.addEventListener("updatefound", watchInstall);
    watchInstall();
    available();
  }).catch(() => tell("Офлайн-установка недоступна. Можно продолжить работу в открытой вкладке."));

  update.addEventListener("click", async () => {
    if (!registration || approved || isBusy()) return;
    const waiting = registration.waiting;
    if (waiting) {
      const draft = hasDraft() ? " Несохранённые изменения предложения будут потеряны." : "";
      const imported = hasImport() ? " JSON из Confluence потребуется загрузить заново." : "";
      if (!window.confirm(`Открыть обновлённую версию? Сохранённые локальные настройки останутся в браузере.${draft}${imported}`)) return;
      approved = true;
      waiting.postMessage({ type: "SSB_ACTIVATE" });
      timeout = setTimeout(() => {
        approved = false;
        tell("Не удалось подтвердить обновление в этой вкладке. Можно продолжить работу.");
      }, 8000);
      return;
    }
    update.disabled = true;
    try {
      await registration.update();
      if (!available()) tell(registration.installing ? "Обновление загружается…" : `${version}. Новая версия не найдена.`);
    } catch {
      tell("Не удалось проверить обновления. Проверьте подключение к интернету.");
    } finally {
      update.disabled = false;
    }
  });
}
