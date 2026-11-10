import { linkGroups } from "./rich-text.js";

export function renderRich(blocks, editing = false) {
  const result = document.createDocumentFragment();
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      const paragraph = document.createElement("p");
      for (const { href, runs } of linkGroups(block.runs)) {
        const target = href ? document.createElement("a") : paragraph;
        if (href) {
          target.href = href;
          if (!editing) {
            target.target = "_blank";
            target.rel = "noopener noreferrer";
          }
          paragraph.append(target);
        }
        for (const run of runs) {
          let part = document.createDocumentFragment();
          run.text.split("\n").forEach((text, index) => {
            if (index) part.append(document.createElement("br"));
            if (text) part.append(text);
          });
          for (const [enabled, tag] of [
            [run.bold, "strong"], [run.italics, "em"], [run.underline, "u"],
            [run.strike, "s"], [run.monospace, "code"],
          ]) {
            if (!enabled) continue;
            const wrapper = document.createElement(tag);
            wrapper.append(part);
            part = wrapper;
          }
          if (run.color) {
            const wrapper = document.createElement("span");
            wrapper.style.color = "#" + run.color;
            wrapper.append(part);
            part = wrapper;
          }
          target.append(part);
        }
      }
      if (editing && !paragraph.hasChildNodes()) paragraph.append(document.createElement("br"));
      result.append(paragraph);
    } else {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered) list.start = block.start;
      for (const item of block.items) {
        const entry = document.createElement("li");
        if (block.ordered && item.value !== undefined) entry.value = item.value;
        entry.append(renderRich(item.blocks, editing));
        list.append(entry);
      }
      result.append(list);
    }
  }
  return result;
}
