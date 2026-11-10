import { readIntroductionHtml } from "./introductions.js";
import { renderRich } from "./rich-dom.js";
import { safeUrl } from "./rich-text.js";

const HISTORY_LIMIT = 100;
const commands = new Set(["bold", "italic", "underline"]);
const listCommands = new Set(["insertUnorderedList", "insertOrderedList"]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createIntroEditor({ editor, toolbar, label, excel, word, feedback, onChange }) {
  let drafts = {};
  let selected;
  let savedRange;
  let editingList = false;
  const histories = new Map();
  const undo = toolbar.querySelector('[data-command="undo"]');
  const redo = toolbar.querySelector('[data-command="redo"]');

  function buttons() {
    const { index, entries } = histories.get(selected);
    undo.disabled = index === 0;
    redo.disabled = index === entries.length - 1;
  }

  function show(code) {
    selected = code;
    savedRange = undefined;
    editor.replaceChildren(renderRich(drafts[code].blocks, true));
    excel.checked = drafts[code].excel;
    word.checked = drafts[code].word;
    label.textContent = code;
    feedback.textContent = "";
    buttons();
  }

  function load(introductions, code) {
    drafts = { ...introductions };
    histories.clear();
    for (const [key, { blocks }] of Object.entries(drafts)) histories.set(key, { entries: [blocks], index: 0 });
    show(code);
  }

  function sync() {
    let blocks;
    try {
      blocks = readIntroductionHtml(editor.innerHTML);
    } catch {
      show(selected);
      feedback.textContent = "Правка отклонена. Текст слишком вложен или содержит недопустимые символы.";
      return;
    }
    const current = drafts[selected];
    if (same(blocks, current.blocks)) return;
    const history = histories.get(selected);
    history.entries = [...history.entries.slice(0, history.index + 1), blocks].slice(-HISTORY_LIMIT);
    history.index = history.entries.length - 1;
    drafts[selected] = { ...current, blocks };
    feedback.textContent = "";
    buttons();
    onChange();
  }

  function focusEditor(range) {
    const selection = document.getSelection();
    const live = selection.rangeCount && selection.getRangeAt(0);
    const target = range ?? (live && editor.contains(live.commonAncestorContainer) ? live.cloneRange() : savedRange);
    editor.focus();
    if (target && editor.contains(target.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(target);
    } else if (!selection.rangeCount || !editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      selection.selectAllChildren(editor);
      selection.collapseToEnd();
    }
    return selection;
  }

  function travel(delta) {
    const history = histories.get(selected);
    const index = history.index + delta;
    if (index < 0 || index >= history.entries.length) return;
    history.index = index;
    drafts[selected] = { ...drafts[selected], blocks: history.entries[index] };
    show(selected);
    focusEditor();
    onChange();
  }

  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) savedRange = range.cloneRange();
  });
  toolbar.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });
  toolbar.addEventListener("click", (event) => {
    const command = event.target.closest("button")?.dataset.command;
    if (!command) return;
    if (command === "undo" || command === "redo") {
      travel(command === "undo" ? -1 : 1);
      return;
    }
    const selection = focusEditor();
    if (command === "createLink") {
      if (selection.isCollapsed) {
        feedback.textContent = "Выделите текст, который станет ссылкой.";
        return;
      }
      const range = selection.getRangeAt(0).cloneRange();
      const value = window.prompt("Адрес ссылки");
      if (value === null) return;
      const href = safeUrl(value);
      if (!href) {
        feedback.textContent = "Введите полный адрес https://, http:// или mailto:.";
        return;
      }
      focusEditor(range);
      document.execCommand(command, false, href);
    } else if (listCommands.has(command)) {
      editingList = true;
      try {
        document.execCommand(command, false);
        // Chromium может вложить список в P. Разбор такого HTML добавляет
        // пустые абзацы вокруг списка, поэтому убираем только внешнюю обёртку.
        const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
        const wrappers = editor.querySelectorAll("p:has(> ul, > ol)");
        for (const wrapper of wrappers) wrapper.replaceWith(...wrapper.childNodes);
        if (wrappers.length && editor.contains(anchorNode) && editor.contains(focusNode)) {
          selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
        }
      } finally {
        editingList = false;
      }
    } else if (commands.has(command)) {
      document.execCommand(command, false);
    }
    sync();
  });
  editor.addEventListener("input", (event) => { if (!event.isComposing && !editingList) sync(); });
  editor.addEventListener("compositionend", sync);
  editor.addEventListener("paste", (event) => {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
    sync();
  });
  editor.addEventListener("drop", (event) => event.preventDefault());
  editor.addEventListener("click", (event) => { if (event.target.closest("a")) event.preventDefault(); });
  editor.addEventListener("beforeinput", (event) => {
    if (["insertFromDrop", "insertFromPaste", "insertFromPasteAsQuotation"].includes(event.inputType)) event.preventDefault();
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      travel(event.inputType === "historyUndo" ? -1 : 1);
    }
  });
  editor.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !["z", "y"].includes(key)) return;
    event.preventDefault();
    travel(key === "y" || event.shiftKey ? 1 : -1);
  });
  function setFormats() {
    drafts[selected] = { ...drafts[selected], excel: excel.checked, word: word.checked };
    onChange();
  }
  excel.addEventListener("change", setFormats);
  word.addEventListener("change", setFormats);

  return { load, show, get values() { return drafts; }, differs: (defaults) => !same(drafts, defaults) };
}
