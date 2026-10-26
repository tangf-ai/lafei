/**
 * 即时预览里的表格：光标不在表格里时，把 GFM 表格渲染成真正的表格；
 * 光标进入表格（或选中表格）时立刻回到 Markdown 源码，像 Typora / Obsidian 一样。
 *
 * 块级替换只能由 StateField 提供（ViewPlugin 不允许块级装饰），
 * 所以这里单独做一个只处理表格的字段。笔记通常不大，整篇扫描成本可以接受；
 * 超长文档（> 30 万字符）直接不渲染表格，避免每次选择变化都全篇遍历。
 */
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";

const MAX_TABLE_PREVIEW_DOC = 300_000;

interface ParsedTable {
  header: string[];
  aligns: Array<"left" | "center" | "right">;
  rows: string[][];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseTable(source: string): ParsedTable | null {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return null;
  const header = splitRow(lines[0]);
  const delimiter = splitRow(lines[1]);
  if (!header.length || header.length !== delimiter.length) return null;
  const aligns = delimiter.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center" as const;
    if (right) return "right" as const;
    return "left" as const;
  });
  const rows = lines.slice(2).map(splitRow);
  return { header, aligns, rows };
}

const INLINE_PATTERN =
  /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|`[^`]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\))/g;

/** 把一行表格单元格里的常见行内 Markdown 渲染成 DOM（纯文本插入，避免 XSS） */
function renderInline(container: HTMLElement, text: string) {
  let lastIndex = 0;
  INLINE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_PATTERN.exec(text))) {
    if (match.index > lastIndex) container.append(text.slice(lastIndex, match.index));
    const token = match[0];
    let el: HTMLElement | null = null;
    if (token.startsWith("**") || token.startsWith("__")) {
      el = document.createElement("strong");
      el.textContent = token.slice(2, -2);
    } else if (token.startsWith("~~")) {
      el = document.createElement("del");
      el.textContent = token.slice(2, -2);
    } else if (token.startsWith("`")) {
      el = document.createElement("code");
      el.textContent = token.slice(1, -1);
    } else if (token.startsWith("[[")) {
      el = document.createElement("span");
      el.className = "cm-md-table-wikilink";
      const inner = token.slice(2, -2);
      const pipe = inner.indexOf("|");
      el.textContent = pipe >= 0 ? inner.slice(pipe + 1) : inner;
    } else if (token.startsWith("[")) {
      el = document.createElement("span");
      el.className = "cm-md-table-link";
      const close = token.indexOf("](");
      el.textContent = close > 0 ? token.slice(1, close) : token.slice(1, -1);
    } else {
      // 单个 * 或 _ 强调
      el = document.createElement("em");
      el.textContent = token.slice(1, -1);
    }
    if (el) container.append(el);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) container.append(text.slice(lastIndex));
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly anchor: number,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.anchor === this.anchor;
  }

  toDOM(view: EditorView): HTMLElement {
    const parsed = parseTable(this.source);
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-widget";
    wrapper.setAttribute("role", "table");
    wrapper.title = "点击编辑表格源码";
    if (!parsed) {
      wrapper.textContent = this.source;
      return wrapper;
    }
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    parsed.header.forEach((cell, index) => {
      const th = document.createElement("th");
      th.style.textAlign = parsed.aligns[index];
      renderInline(th, cell);
      headRow.append(th);
    });
    thead.append(headRow);
    table.append(thead);
    const tbody = document.createElement("tbody");
    parsed.rows.forEach((row) => {
      const tr = document.createElement("tr");
      parsed.header.forEach((_, index) => {
        const td = document.createElement("td");
        td.style.textAlign = parsed.aligns[index];
        renderInline(td, row[index] ?? "");
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(tbody);
    wrapper.append(table);
    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: this.anchor },
        effects: EditorView.scrollIntoView(this.anchor, { y: "nearest" }),
      });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function decorSelectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function buildTableDecorations(state: EditorState): DecorationSet {
  if (state.doc.length > MAX_TABLE_PREVIEW_DOC) return Decoration.none;
  const decorations: Array<Range<Decoration>> = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.name !== "Table") return undefined;
      const from = node.from;
      const to = node.to;
      if (decorSelectionTouches(state, from, to)) return false;
      const firstLine = state.doc.lineAt(from);
      const lastLine = state.doc.lineAt(to);
      const source = state.sliceDoc(firstLine.from, lastLine.to);
      decorations.push(
        Decoration.replace({
          widget: new TableWidget(source, firstLine.from),
          block: true,
        }).range(firstLine.from, lastLine.to),
      );
      return false;
    },
  });
  return Decoration.set(decorations, true);
}

const tablePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildTableDecorations(state),
  update: (value, transaction) => {
    if (transaction.docChanged || transaction.selection) return buildTableDecorations(transaction.state);
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 表格预览扩展：只在即时预览模式里装 */
export function tablePreview() {
  return tablePreviewField;
}
