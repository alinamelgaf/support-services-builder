const BLOCKS = new Set(["p", "div", "section", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6"]);
const IGNORED = new Set(["script", "style", "iframe", "object", "embed", "template", "ac:parameter", "ac:placeholder"]);
const CONTAINERS = new Set([
  "span", "font", "li", "td", "th", "tbody", "thead", "tfoot", "colgroup", "col",
  "ac:rich-text-body", "ac:plain-text-body", "ac:rich-text-link-body", "ac:plain-text-link-body",
]);
const MARKS = {
  b: { bold: true }, strong: { bold: true }, i: { italics: true }, em: { italics: true },
  u: { underline: true }, s: { strike: true }, strike: { strike: true }, del: { strike: true },
  code: { monospace: true },
};

export function pageUrl(id, base) {
  return base ? `${base}/pages/viewpage.action?pageId=${encodeURIComponent(id)}` : "";
}

export function safeUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, base);
    if (["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    // Текст ссылки можно показать и без адреса.
  }
  return "";
}

function linkTarget(node, source, base, warn) {
  if (node.name === "a") {
    const raw = node.attribs.href;
    const href = safeUrl(raw, source);
    if (raw && !href) warn("Пропущен неподдерживаемый адрес ссылки.");
    return { href, label: href };
  }
  const target = node.children.find((child) => child.name?.startsWith("ri:"));
  const anchor = node.attribs["ac:anchor"];
  let href = "";
  let label = "";
  if (target?.name === "ri:page") {
    label = target.attribs["ri:content-title"] ?? "";
    const pageId = target.attribs["ri:content-id"] ?? "";
    const space = target.attribs["ri:space-key"];
    if (/^\d+$/.test(pageId)) href = pageUrl(pageId, base);
    else if (base && label && space) href = `${base}/display/${encodeURIComponent(space)}/${encodeURIComponent(label).replaceAll("%20", "+")}`;
  } else if (target?.name === "ri:url") {
    label = target.attribs["ri:value"] ?? "";
    href = safeUrl(label, source);
    if (!href) warn("Пропущен неподдерживаемый адрес ссылки.");
  } else if (target) {
    label = target.attribs["ri:filename"] ?? "";
    warn("Ссылка на вложение сохранена как текст.");
  }
  if (anchor && (href || !target)) href = safeUrl(`#${encodeURIComponent(anchor)}`, href || source);
  return { href, label: label || anchor || href };
}

function styled(node, marks) {
  const next = { ...marks, ...(Object.hasOwn(MARKS, node.name) ? MARKS[node.name] : {}) };
  for (const declaration of (node.attribs.style ?? "").split(";")) {
    const [property, value] = declaration.toLowerCase().split(":").map((part) => part.trim());
    if (property === "font-weight" && /^(bold|[6-9]00)$/.test(value)) next.bold = true;
    if (property === "font-style" && value === "italic") next.italics = true;
    if (["text-decoration", "text-decoration-line"].includes(property)) {
      if (/\bunderline\b/.test(value)) next.underline = true;
      if (/\bline-through\b/.test(value)) next.strike = true;
    }
    if (property === "color" && /^#[0-9a-f]{6}$/.test(value)) next.color = value.slice(1).toUpperCase();
  }
  return next;
}

export function readRich(nodes, { source, base, warn = () => {}, preserveEmptyLines = false } = {}) {
  const blocks = [];
  let runs = [];

  function append(value, marks, preserve = false) {
    let text = preserve || preserveEmptyLines ? value.replace(/\r\n?/g, "\n") : value.replace(/[ \t\n\r\f]+/g, " ");
    if (!preserve && !preserveEmptyLines && (!runs.length || /[ \n]$/.test(runs.at(-1).text))) text = text.replace(/^ +/, "");
    if (text) runs.push({ ...marks, text });
  }

  function flush(force = false, preserve = false) {
    if (!preserve && !preserveEmptyLines) {
      while (runs.length) {
        runs.at(-1).text = runs.at(-1).text.replace(/ +$/, "");
        if (runs.at(-1).text) break;
        runs.pop();
      }
    }
    if (runs.length || force) blocks.push({ kind: "paragraph", runs });
    runs = [];
  }

  function visit(node, marks = {}, preserve = false) {
    if (node.type === "text") {
      append(node.data, marks, preserve);
      return;
    }
    const tag = node.name ?? "";
    const children = node.children ?? [];
    if (IGNORED.has(tag) || tag.startsWith("ri:")) return;
    if (tag === "br") {
      append("\n", marks, true);
    } else if (tag === "ul" || tag === "ol") {
      flush();
      const start = /^-?\d{1,8}$/.test(node.attribs.start) ? Number(node.attribs.start) : 1;
      const items = children.filter((child) => child.name === "li").map((child) => ({
        value: /^-?\d{1,8}$/.test(child.attribs.value) ? Number(child.attribs.value) : undefined,
        blocks: readRich(child.children, { source, base, warn, preserveEmptyLines }),
      }));
      if (items.length) blocks.push({ kind: "list", ordered: tag === "ol", start, items });
    } else if (BLOCKS.has(tag) || tag === "tr") {
      flush();
      const start = blocks.length;
      const keepSpaces = preserve || tag === "pre";
      const placeholder = preserveEmptyLines && children.length === 1 && children[0].name === "br";
      if (!placeholder) for (const child of children) visit(child, styled(node, marks), keepSpaces);
      flush((tag === "p" || preserveEmptyLines) && blocks.length === start, keepSpaces);
    } else if (tag === "a" || tag === "ac:link") {
      const { href, label } = linkTarget(node, source, base, warn);
      const linkMarks = href ? { ...marks, href } : marks;
      const before = runs.length;
      const beforeBlocks = blocks.length;
      for (const child of children) visit(child, linkMarks, preserve);
      if (before === runs.length && beforeBlocks === blocks.length && label) append(label, linkMarks, preserve);
    } else if (tag === "img" || tag === "ac:image") {
      warn("Изображение сохранено как текст при наличии подписи.");
      const alt = node.attribs.alt || node.attribs["ac:alt"] || node.attribs["ac:title"];
      if (alt) append(alt, marks, preserve);
    } else {
      if (tag === "table") {
        warn("Вложенная таблица в описании представлена текстом.");
      } else if (tag === "ac:structured-macro" || tag === "ac:macro") {
        warn(`Макрос «${node.attribs["ac:name"] || tag}» представлен доступным текстом.`);
      } else if (tag && !CONTAINERS.has(tag) && !Object.hasOwn(MARKS, tag)) {
        warn(`Элемент «${tag}» представлен доступным текстом.`);
      }
      if ((tag === "td" || tag === "th") && runs.length) append(" | ", marks, true);
      const next = tag ? styled(node, marks) : marks;
      for (const child of children) visit(child, next, preserve);
    }
  }

  for (const node of nodes) visit(node);
  flush();
  return blocks;
}

export function* linkGroups(runs) {
  let group;
  for (const run of runs) {
    if (!group || group.href !== run.href) {
      if (group) yield group;
      group = { href: run.href, runs: [] };
    }
    group.runs.push(run);
  }
  if (group) yield group;
}

function* richLines(blocks, indent, addresses) {
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      const line = [{ text: indent }];
      for (const { href, runs } of linkGroups(block.runs)) {
        line.push(...runs);
        if (addresses && href && runs.map((run) => run.text).join("").trim() !== href) line.push({ text: ` (${href})` });
      }
      yield line;
    } else {
      let number = block.start;
      for (const item of block.items) {
        number = item.value ?? number;
        const marker = { text: indent + (block.ordered ? `${number}. ` : "• ") };
        const lines = [...richLines(item.blocks, indent + "  ", addresses)];
        const startsWithParagraph = item.blocks[0]?.kind === "paragraph";
        yield startsWithParagraph ? [marker, ...lines[0].slice(1)] : [marker];
        yield* lines.slice(startsWithParagraph ? 1 : 0);
        number += 1;
      }
    }
  }
}

export function flattenRich(blocks, addresses = false) {
  const output = [];
  for (const line of richLines(blocks, "", addresses)) {
    if (output.length) output.push({ text: "\n" });
    output.push(...line);
  }
  return output.filter(({ text }) => text);
}

export function plainText(blocks) {
  return flattenRich(blocks).map(({ text }) => text).join("");
}

export function withoutSourceLinks(blocks, bases) {
  const origins = new Set(bases.filter(Boolean).map((base) => new URL(base).origin));
  const isSource = (href) => {
    if (!href) return false;
    const url = new URL(href);
    return origins.has(url.origin) || /\/(?:pages\/viewpage\.action|display\/|spaces\/[^/]+\/pages\/|rest\/api\/content(?:\/|$))/i.test(url.pathname);
  };
  function clean(items) {
    return items.map((block) => block.kind === "list"
      ? { ...block, items: block.items.map((item) => ({ ...item, blocks: clean(item.blocks) })) }
      : { ...block, runs: [...linkGroups(block.runs)].flatMap(({ href, runs }) => {
        if (!isSource(href)) return runs;
        if (runs.map(({ text }) => text).join("").trim() === href) return [{ text: "Confluence" }];
        return runs.map(({ href: _href, ...run }) => run);
      }) });
  }
  return clean(blocks);
}
