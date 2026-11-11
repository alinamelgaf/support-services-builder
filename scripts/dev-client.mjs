const revision = document.querySelector('meta[name="ssb-dev-revision"]')?.content;
const panel = document.querySelector("#ssb-dev-live");
const message = document.querySelector("#ssb-dev-message");
const details = document.querySelector("#ssb-dev-error");
const refresh = document.querySelector("#ssb-dev-refresh");
let pendingRevision = "";
let checking = false;

function show(text, error = "") {
  message.textContent = text;
  details.textContent = error;
  details.hidden = !error;
  panel.hidden = !text;
}

async function poll() {
  if (checking) return;
  checking = true;
  try {
    const response = await fetch("/__ssb_dev_status", { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("Local server unavailable");
    const build = await response.json();
    if (!revision && build.phase === "ready") return location.reload();
    const available = build.phase === "ready" && build.revision !== revision;
    refresh.hidden = !available;
    if (build.phase === "error") show("Ошибка тестовой сборки. Исправьте причину и дождитесь пересборки.", build.error);
    else if (build.phase === "building") show("Тестовая версия пересобирается…");
    else if (available && build.revision !== pendingRevision) show("Новая тестовая сборка готова.");
    else if (!available) show("");
    pendingRevision = available ? build.revision : "";
  } catch {
    refresh.hidden = true;
    pendingRevision = "";
    show("Тестовый сервер недоступен. Запустите Start SSB Test.cmd.");
  } finally {
    checking = false;
  }
}

refresh.addEventListener("click", () => {
  refresh.disabled = true;
  const timeout = setTimeout(() => finish("Приложение ещё не готово к обновлению."), 5000);
  function finish(reason) {
    clearTimeout(timeout);
    if (!refresh.disabled) return;
    if (!reason) return location.reload();
    refresh.disabled = false;
    show(reason);
  }
  window.dispatchEvent(new CustomEvent("ssb-dev-refresh", { detail: finish }));
});

void poll();
setInterval(poll, 1000);
