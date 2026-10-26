/**
 * 编辑器的格式命令（工具栏 / 快捷键共用）。
 *
 * 行内格式复用 lib/markdownFormat.ts 的纯函数，再把结果做一次最小 diff 提交，
 * 这样 CodeMirror 的撤销栈仍然是一次操作为一个步骤，滚动位置也不会被整篇替换打乱。
 * 行级格式（标题 / 列表 / 待办 / 引用）直接按行计算新的行首标记。
 */
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { applyFormatSpec, applyLinkSpec, type FormatSpec } from "../../lib/markdownFormat";

const HEADING_RE = /^(\s*)(#{1,6})\s+/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/;
const TASK_RE = /^(\s*)([-*+]|\d+[.)])\s+\[[ xX]\]\s+/;
const QUOTE_RE = /^(\s*)>\s?/;

/** 两个字符串的最长公共前缀长度 */
function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

/** 两个字符串的最长公共后缀长度 */
function commonSuffix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[a.length - 1 - index] === b[b.length - 1 - index]) index += 1;
  return index;
}

/** 用最小变更把整篇文本变成 result.text，并恢复 result 里的选区 */
function dispatchResult(
  view: EditorView,
  result: { text: string; start: number; end: number },
): boolean {
  const current = view.state.doc.toString();
  const selection = EditorSelection.range(result.start, result.end);
  if (current === result.text) {
    view.dispatch({ selection, scrollIntoView: true });
    return true;
  }
  const prefix = commonPrefix(current, result.text);
  const suffix = commonSuffix(current.slice(prefix), result.text.slice(prefix));
  view.dispatch({
    changes: {
      from: prefix,
      to: current.length - suffix,
      insert: result.text.slice(prefix, result.text.length - suffix),
    },
    selection,
    scrollIntoView: true,
  });
  return true;
}

/** 行内格式：加粗 / 斜体 / 行内代码等 */
export function runInlineFormat(view: EditorView, format: FormatSpec): boolean {
  const range = view.state.selection.main;
  const result = applyFormatSpec(view.state.doc.toString(), range.from, range.to, format);
  return dispatchResult(view, result);
}

/** 插入链接 */
export function insertLink(view: EditorView): boolean {
  const range = view.state.selection.main;
  const result = applyLinkSpec(view.state.doc.toString(), range.from, range.to);
  return dispatchResult(view, result);
}

/** 在光标处插入文本（AI 面板“插入到光标”等场景） */
export function insertText(view: EditorView, text: string): boolean {
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + text.length),
    scrollIntoView: true,
  });
  return true;
}

export function selectedText(view: EditorView): string {
  const { state } = view;
  return state.selection.ranges
    .map((range) => state.sliceDoc(range.from, range.to))
    .filter(Boolean)
    .join("\n");
}

interface LineChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * 对选区覆盖的每一行执行一次变换。
 * 只提交真正变化了的行，选区交给 CodeMirror 自动映射。
 */
function transformLines(view: EditorView, transform: (text: string, indent: string) => string): boolean {
  const { state } = view;
  const changes: LineChange[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) {
      if (seen.has(number)) continue;
      seen.add(number);
      const line = state.doc.line(number);
      const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
      const next = transform(line.text, indent);
      if (next !== line.text) {
        changes.push({ from: line.from, to: line.from + line.text.length, insert: next });
      }
    }
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes, scrollIntoView: true });
  return true;
}

function stripHeading(text: string): string {
  return text.replace(/^(\s*)#{1,6}\s+/, "$1");
}

function stripList(text: string): string {
  return text.replace(LIST_RE, "$1");
}

function stripTask(text: string): string {
  return text.replace(TASK_RE, "$1");
}

/**
 * 设置标题级别；传 0 表示恢复成普通段落。
 * 对已经是同一级别的行再按一次会取消标题（与 Typora / 常见编辑器一致）。
 */
export function setHeading(view: EditorView, level: 0 | 1 | 2 | 3 | 4 | 5 | 6): boolean {
  return transformLines(view, (text, indent) => {
    const current = HEADING_RE.exec(text);
    const base = stripHeading(text);
    const content = base.slice(indent.length);
    if (level === 0) return base;
    if (current && current[2].length === level) return base;
    return `${indent}${"#".repeat(level)} ${content}`;
  });
}

/** 无序 / 有序列表开关（先去掉标题、待办、引用等标记） */
export function toggleList(view: EditorView): boolean {
  return transformLines(view, (text, indent) => {
    if (TASK_RE.test(text) || LIST_RE.test(text)) {
      return stripList(stripTask(stripHeading(text)));
    }
    return `${indent}- ${stripHeading(text).slice(indent.length)}`;
  });
}

/** 待办列表开关：普通段落 → `- [ ] `，待办 → 普通段落 */
export function toggleTask(view: EditorView): boolean {
  return transformLines(view, (text, indent) => {
    if (TASK_RE.test(text)) return stripTask(text);
    if (LIST_RE.test(text)) {
      return text.replace(LIST_RE, `$1$2$3[ ] `);
    }
    return `${indent}- [ ] ${stripHeading(text).slice(indent.length)}`;
  });
}

/** 引用开关 */
export function toggleQuote(view: EditorView): boolean {
  return transformLines(view, (text, indent) => {
    if (QUOTE_RE.test(text)) return text.replace(QUOTE_RE, "$1");
    return `${indent}> ${text.slice(indent.length)}`;
  });
}

/** 行内代码开关（复用包裹逻辑，方便 ⌘⇧K / 工具栏） */
const INLINE_CODE: FormatSpec = { id: "code", label: "行内代码", before: "`", after: "`", placeholder: "代码" };
const BOLD: FormatSpec = { id: "bold", label: "加粗", before: "**", after: "**", placeholder: "加粗文字" };
const ITALIC: FormatSpec = { id: "italic", label: "斜体", before: "*", after: "*", placeholder: "斜体文字" };

export function toggleInlineCode(view: EditorView): boolean {
  return runInlineFormat(view, INLINE_CODE);
}

export function toggleBold(view: EditorView): boolean {
  return runInlineFormat(view, BOLD);
}

export function toggleItalic(view: EditorView): boolean {
  return runInlineFormat(view, ITALIC);
}

/** 工具栏统一的入口：按 FormatSpec.id 分发 */
export function applyToolbarFormat(view: EditorView, format: FormatSpec): boolean {
  switch (format.id) {
    case "heading":
      return setHeading(view, 2);
    case "list":
      return toggleList(view);
    case "todo":
      return toggleTask(view);
    case "quote":
      return toggleQuote(view);
    case "code":
      return toggleInlineCode(view);
    default:
      return runInlineFormat(view, format);
  }
}
