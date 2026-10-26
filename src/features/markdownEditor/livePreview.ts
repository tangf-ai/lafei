/**
 * 即时预览（Typora 式）装饰层。
 *
 * 思路：正文仍然是纯 Markdown 文本（CodeMirror 的文档），只在渲染层做装饰：
 * - 光标/选区所在的「当前行」显示 Markdown 源码标记，但文字仍按排版样式显示；
 * - 其余行把语法标记隐藏掉，换成排版结果：标题字号、粗体、斜体、删除线、行内代码、
 *   链接、[[wiki 链接]]、图片、分隔线、列表圆点、待办复选框、引用竖线、代码块底色。
 *
 * 关键约束：替换型装饰（隐藏标记、图片、复选框）只加在「非当前行」上，避免和光标
 * 落在同一个 range 里。当前行只加样式与 marker 标记，因此可以直接点击任意位置落光标，
 * 中文输入法也走浏览器原生行为，不需要重排 DOM。
 *
 * 行内排版只处理 GFM 常见语法；表格目前保留源码（只做样式提示），在阅读模式里渲染。
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

/** 一块装饰的收集数组，最后统一排序 */
type Deco = Range<Decoration>[];

const HIDE = Decoration.replace({});

const MARK = {
  strong: Decoration.mark({ class: "cm-md-strong" }),
  em: Decoration.mark({ class: "cm-md-em" }),
  strike: Decoration.mark({ class: "cm-md-strike" }),
  inlineCode: Decoration.mark({ class: "cm-md-inline-code" }),
  link: Decoration.mark({ class: "cm-md-link" }),
  wiki: Decoration.mark({ class: "cm-md-wikilink" }),
  url: Decoration.mark({ class: "cm-md-url" }),
  marker: Decoration.mark({ class: "cm-md-marker" }),
  image: Decoration.mark({ class: "cm-md-image-source" }),
};

const HEADING_LINE = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-md-h${level}` }),
);
const QUOTE_LINE = Decoration.line({ class: "cm-md-quote" });
const BLANK_LINE = Decoration.line({ class: "cm-md-blank" });
const TABLE_LINE = Decoration.line({ class: "cm-md-table" });
const CODE_LINE = Decoration.line({ class: "cm-md-code" });
const CODE_FIRST = Decoration.line({ class: "cm-md-code cm-md-code-first" });
const CODE_LAST = Decoration.line({ class: "cm-md-code cm-md-code-last" });
const CODE_ONLY = Decoration.line({ class: "cm-md-code cm-md-code-first cm-md-code-last" });

/** 待办复选框：点击直接切换 `[ ]` / `[x]`，不移动光标 */
class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-checkbox";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "标记为未完成" : "标记为已完成");
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? "[ ]" : "[x]" },
      });
    });
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** 无序列表的圆点 / 有序列表的序号，替代被隐藏的 `- `、`1. ` */
class ListMarkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly ordered: boolean,
    readonly depth: number,
  ) {
    super();
  }

  eq(other: ListMarkWidget): boolean {
    return (
      other.label === this.label && other.ordered === this.ordered && other.depth === this.depth
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.ordered ? "cm-md-listmark is-ordered" : "cm-md-listmark is-bullet";
    // 无序列表统一显示圆点；有序列表保留原序号
    span.textContent = this.ordered ? this.label : "•";
    if (!this.ordered) span.dataset.depth = String(Math.min(this.depth, 2));
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** 分隔线 */
class RuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-md-rule";
    return rule;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** 图片：非当前行直接把 `![alt](src)` 显示成图片 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    img.title = "点击编辑图片源码";
    // 点击图片：把光标放进图片节点内部，装饰重建后会露出 `![alt](src)` 源码
    img.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = Math.min(this.from + 2, this.to);
      view.dispatch({ selection: { anchor: target } });
      view.focus();
    });
    return img;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** 某个位置往上找最近的块级节点 */
interface BlockContext {
  fence: SyntaxNode | null;
  quote: SyntaxNode | null;
  listItem: SyntaxNode | null;
  heading: SyntaxNode | null;
  table: SyntaxNode | null;
  task: SyntaxNode | null;
}

function blockContext(tree: Tree, pos: number): BlockContext {
  const context: BlockContext = {
    fence: null,
    quote: null,
    listItem: null,
    heading: null,
    table: null,
    task: null,
  };
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    const name = node.name;
    // 只记录「最近」的块级祖先：嵌套列表要拿到最内层 ListItem
    if (name === "FencedCode") context.fence ??= node;
    else if (name === "Blockquote") context.quote ??= node;
    else if (name === "ListItem") context.listItem ??= node;
    else if (name === "Table") context.table ??= node;
    else if (name === "Task") context.task ??= node;
    else if (/^(ATXHeading|SetextHeading)[1-6]$/.test(name)) context.heading ??= node;
    node = node.parent;
  }
  return context;
}

/** 当前行是否包含光标（选区碰到的行都算当前行） */
function activeLineNumbers(state: EditorState, focused: boolean): Set<number> {
  const lines = new Set<number>();
  // 编辑器没有焦点时全部按排版结果显示（像 Typora 离开编辑器那样），
  // 点进去之后只有光标所在行露出源码。
  if (!focused) return lines;
  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number;
    const end = state.doc.lineAt(range.to).number;
    for (let number = start; number <= end; number += 1) lines.add(number);
  }
  return lines;
}

/**
 * 光标 / 选区是否落在这个行内范围「内部」。
 * 与块级标记的「整行」判定不同：行内标记只在光标进入该片段时露出，
 * 这样才能像 Typora 一样，光标在普通文字里时 **加粗** 仍然保持渲染。
 */
function selectionInRange(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (range.from > from && range.from < to) return true;
    } else if (range.to > from && range.from < to) {
      return true;
    }
  }
  return false;
}

/** 把一段标记隐藏（非当前行）或显示为弱化的源码标记（当前行） */
function marker(deco: Deco, active: boolean, from: number, to: number) {
  if (to <= from) return;
  deco.push(active ? MARK.marker.range(from, to) : HIDE.range(from, to));
}

/** 缩进宽度（空格 / tab 都算一个缩进层级） */
function indentLength(text: string): number {
  const match = /^[ \t]*/.exec(text);
  return match ? match[0].length : 0;
}

/** 文本节点里跳过连续空格，用来连带隐藏 `> ` 后面的空格 */
function skipSpaces(state: EditorState, from: number): number {
  let end = from;
  const max = state.doc.length;
  while (end < max) {
    const ch = state.sliceDoc(end, end + 1);
    if (ch !== " " && ch !== "\t") break;
    end += 1;
  }
  return end;
}

function decorateCodeLine(
  state: EditorState,
  tree: Tree,
  line: { from: number; to: number; number: number; text: string },
  fence: SyntaxNode,
  active: boolean,
  deco: Deco,
) {
  const firstLine = state.doc.lineAt(fence.from).number;
  const lastLine = state.doc.lineAt(fence.to).number;
  if (firstLine === lastLine) deco.push(CODE_ONLY.range(line.from));
  else if (line.number === firstLine) deco.push(CODE_FIRST.range(line.from));
  else if (line.number === lastLine) deco.push(CODE_LAST.range(line.from));
  else deco.push(CODE_LINE.range(line.from));

  if (line.number !== firstLine && line.number !== lastLine) return;

  // 围栏行：非当前行整行隐藏（留下有底色的空行当内边距），当前行只弱化标记
  const indent = indentLength(line.text);
  if (!active) {
    if (line.to > line.from + indent) {
      deco.push(HIDE.range(line.from + indent, line.to));
    }
    return;
  }
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (node.name === "CodeMark" || node.name === "CodeInfo") {
        marker(deco, true, node.from, node.to);
      }
      return undefined;
    },
  });
}

function decorateHeading(
  line: { from: number; to: number; text: string },
  heading: SyntaxNode,
  active: boolean,
  deco: Deco,
) {
  const level = Number(heading.name.replace(/[^0-9]/g, "")) || 1;
  const isAtx = heading.name.startsWith("ATX");
  const indent = indentLength(line.text);

  if (isAtx) {
    const prefix = /^(#{1,6})[ \t]+/.exec(line.text.slice(indent));
    if (prefix) {
      const from = line.from + indent;
      const to = from + prefix[0].length;
      deco.push(HEADING_LINE[Math.min(level, 6) - 1].range(line.from));
      marker(deco, active, from, to);
    } else {
      deco.push(HEADING_LINE[Math.min(level, 6) - 1].range(line.from));
    }
    // ATX 标题结尾可能有一串 #，非当前行一并隐藏
    for (const mark of heading.getChildren("HeaderMark")) {
      if (mark.from >= line.from + indent + 1) marker(deco, active, mark.from, mark.to);
    }
    return;
  }

  // Setext 标题：标题文字行 + 下划线行。下划线行整行隐藏（当前行则弱化）
  const underline = /^[ \t]*(=+|-+)[ \t]*$/.test(line.text);
  if (underline) {
    marker(deco, active, line.from + indent, line.to);
    return;
  }
  deco.push(HEADING_LINE[Math.min(level, 6) - 1].range(line.from));
}

function decorateListItem(
  state: EditorState,
  line: { from: number; to: number; text: string },
  listItem: SyntaxNode,
  active: boolean,
  deco: Deco,
) {
  const indent = indentLength(line.text);
  const listMark = listItem.getChildren("ListMark").find(
    (node) => node.from >= line.from && node.to <= line.to,
  );
  if (!listMark) return;

  const task = listItem.getChildren("Task")[0];
  const taskMarker = task?.getChildren("TaskMarker")[0];
  const hasTaskOnLine = taskMarker && taskMarker.from >= line.from && taskMarker.to <= line.to;

  if (hasTaskOnLine && taskMarker) {
    const checked = /\[[xX]\]/.test(state.sliceDoc(taskMarker.from, taskMarker.to));
    if (active) {
      marker(deco, true, line.from + indent, taskMarker.to);
      return;
    }
    deco.push(
      Decoration.replace({
        widget: new CheckboxWidget(checked, taskMarker.from, taskMarker.to),
      }).range(line.from + indent, taskMarker.to),
    );
    return;
  }

  const ordered = listItem.parent?.name === "OrderedList";
  let depth = 0;
  let parent = listItem.parent;
  while (parent) {
    if (parent.name === "ListItem") depth += 1;
    parent = parent.parent;
  }
  const markText = state.sliceDoc(listMark.from, listMark.to);
  if (active) {
    marker(deco, true, listMark.from, listMark.to);
    return;
  }
  deco.push(
    Decoration.replace({
      widget: new ListMarkWidget(markText, ordered, depth),
    }).range(listMark.from, listMark.to),
  );
}

/** 把行内的强调、代码、链接、图片等处理掉 */
function decorateInline(
  state: EditorState,
  tree: Tree,
  line: { from: number; to: number },
  active: boolean,
  deco: Deco,
) {
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      const name = node.name;
      switch (name) {
        case "StrongEmphasis": {
          deco.push(MARK.strong.range(node.from, node.to));
          const inside = selectionInRange(state, node.from, node.to);
          for (const mark of node.node.getChildren("EmphasisMark")) {
            marker(deco, inside, mark.from, mark.to);
          }
          return undefined;
        }
        case "Emphasis": {
          deco.push(MARK.em.range(node.from, node.to));
          const inside = selectionInRange(state, node.from, node.to);
          for (const mark of node.node.getChildren("EmphasisMark")) {
            marker(deco, inside, mark.from, mark.to);
          }
          return undefined;
        }
        case "Strikethrough": {
          deco.push(MARK.strike.range(node.from, node.to));
          const inside = selectionInRange(state, node.from, node.to);
          for (const mark of node.node.getChildren("StrikethroughMark")) {
            marker(deco, inside, mark.from, mark.to);
          }
          return undefined;
        }
        case "InlineCode": {
          deco.push(MARK.inlineCode.range(node.from, node.to));
          // InlineCode 的反引号数量可能不止一个：逐个隐藏 CodeMark
          const inside = selectionInRange(state, node.from, node.to);
          for (const mark of node.node.getChildren("CodeMark")) {
            marker(deco, inside, mark.from, mark.to);
          }
          return undefined;
        }
        case "Link": {
          const marks = node.node.getChildren("LinkMark");
          const textFrom = marks[0] ? marks[0].to : node.from;
          const close = marks[1];
          const textTo = close ? close.from : node.to;
          if (textTo > textFrom) deco.push(MARK.link.range(textFrom, textTo));
          const inside = selectionInRange(state, node.from, node.to);
          if (inside) {
            for (const mark of marks) marker(deco, true, mark.from, mark.to);
            for (const url of node.node.getChildren("URL")) marker(deco, true, url.from, url.to);
          } else {
            for (const mark of marks) deco.push(HIDE.range(mark.from, mark.to));
            for (const url of node.node.getChildren("URL")) deco.push(HIDE.range(url.from, url.to));
          }
          return false;
        }
        case "Image": {
          const src = node.node.getChildren("URL")[0];
          if (!src) return undefined;
          if (selectionInRange(state, node.from, node.to)) {
            deco.push(MARK.image.range(node.from, node.to));
            for (const mark of node.node.getChildren("LinkMark")) marker(deco, true, mark.from, mark.to);
            marker(deco, true, src.from, src.to);
            return false;
          }
          const imageMarks = node.node.getChildren("LinkMark");
          const altFrom = imageMarks[0] ? imageMarks[0].to : node.from + 2;
          const altTo = imageMarks[1] ? imageMarks[1].from : src.from;
          const alt = state.sliceDoc(altFrom, altTo);
          deco.push(
            Decoration.replace({
              widget: new ImageWidget(state.sliceDoc(src.from, src.to), alt, node.from, node.to),
            }).range(node.from, node.to),
          );
          return false;
        }
        case "Autolink": {
          const url = node.node.getChildren("URL")[0];
          if (!url) return undefined;
          if (selectionInRange(state, node.from, node.to)) {
            marker(deco, true, node.from, node.to);
          } else {
            deco.push(HIDE.range(node.from, url.from));
            deco.push(HIDE.range(url.to, node.to));
            deco.push(MARK.link.range(url.from, url.to));
          }
          return false;
        }
        case "QuoteMark": {
          marker(deco, active, node.from, skipSpaces(state, node.to));
          return undefined;
        }
        default:
          return undefined;
      }
    },
  });
}

/** 判断某个位置是否在代码 / URL 等不该处理 wiki 链接的地方 */
function inCodeLike(tree: Tree, pos: number): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    const name = node.name;
    if (
      name === "InlineCode" ||
      name === "FencedCode" ||
      name === "CodeText" ||
      name === "CodeBlock" ||
      name === "URL" ||
      name === "Image"
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

const WIKI_PATTERN = /\[\[([^\]\n]+?)(?:\|([^\]\n]+))?\]\]/g;

/** `[[笔记]]` / `[[笔记|别名]]`：非当前行隐藏方括号，当前行弱化方括号 */
function decorateWikiLinks(
  tree: Tree,
  line: { from: number; text: string },
  state: EditorState,
  deco: Deco,
) {
  if (!line.text.includes("[[")) return;
  WIKI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_PATTERN.exec(line.text))) {
    const start = line.from + match.index;
    const end = start + match[0].length;
    if (inCodeLike(tree, start + 1)) continue;
    // `[[目标]]` 的显示文字从 +2 开始；`[[目标|别名]]` 的别名从 `[[` + 目标 + `|` 之后开始
    const labelFrom = match[2] ? start + 2 + match[1].length + 1 : start + 2;
    const labelTo = end - 2;
    if (labelTo > labelFrom) deco.push(MARK.wiki.range(labelFrom, labelTo));
    const inside = selectionInRange(state, start, end);
    marker(deco, inside, start, labelFrom);
    marker(deco, inside, labelTo, end);
  }
}

function decorateLine(
  state: EditorState,
  tree: Tree,
  line: { from: number; to: number; number: number; text: string },
  active: boolean,
  deco: Deco,
) {
  const indent = indentLength(line.text);
  const context = blockContext(tree, line.from + indent);

  if (context.fence) {
    decorateCodeLine(state, tree, line, context.fence, active, deco);
    return;
  }

  if (line.text.trim() === "") {
    deco.push(BLANK_LINE.range(line.from));
    return;
  }

  if (context.table) deco.push(TABLE_LINE.range(line.from));

  if (context.heading) {
    decorateHeading(line, context.heading, active, deco);
  } else if (context.listItem) {
    decorateListItem(state, line, context.listItem, active, deco);
  }

  if (context.quote) {
    deco.push(QUOTE_LINE.range(line.from));
  }

  // 分隔线：非当前行整行换成一条细线
  const hr = tree.resolveInner(line.from + indent, 1);
  if (hr.name === "HorizontalRule" && hr.from >= line.from && hr.to <= line.to) {
    if (active) marker(deco, true, line.from + indent, line.to);
    else deco.push(Decoration.replace({ widget: new RuleWidget() }).range(line.from + indent, line.to));
    return;
  }

  decorateInline(state, tree, line, active, deco);
  decorateWikiLinks(tree, line, state, deco);
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const tree = syntaxTree(state);
  const activeLines = activeLineNumbers(state, view.hasFocus);
  const deco: Deco = [];

  for (const range of view.visibleRanges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(Math.max(range.from, range.to)).number;
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number);
      decorateLine(state, tree, line, activeLines.has(number), deco);
    }
  }

  return Decoration.set(deco, true);
}

/** 即时预览插件：文档、选区、视口变化时重建可见区域的装饰 */
export function livePreview() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}
