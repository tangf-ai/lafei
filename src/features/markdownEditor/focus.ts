/**
 * 写作辅助：聚焦模式（只保留当前段落清晰）与打字机模式（光标始终停在视线中央）。
 *
 * 两个都是独立的 CodeMirror 扩展，用 Compartment 在运行时开关，不影响正文内容。
 */
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

const DIM_LINE = Decoration.line({ class: "cm-md-dim" });

/** 一段连续内容的块级节点名：聚焦模式保留光标所在的那一块 */
const BLOCK_NAMES = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "ListItem",
  "Task",
  "Blockquote",
  "FencedCode",
  "Table",
  "HorizontalRule",
]);

/** 光标所在的块范围（找不到时退回到当前行） */
function currentBlock(view: EditorView): { from: number; to: number } {
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(head, 1);
  while (node) {
    if (BLOCK_NAMES.has(node.name)) return { from: node.from, to: node.to };
    node = node.parent;
  }
  return { from: line.from, to: line.to };
}

function buildDim(view: EditorView): DecorationSet {
  const { state } = view;
  const block = currentBlock(view);
  const decorations = [];
  for (const range of view.visibleRanges) {
    let line = state.doc.lineAt(range.from);
    while (line.from <= range.to) {
      if (line.to < block.from || line.from > block.to) {
        decorations.push(DIM_LINE.range(line.from));
      }
      if (line.to >= state.doc.length) break;
      line = state.doc.lineAt(line.to + 1);
    }
  }
  return Decoration.set(decorations, true);
}

/** 聚焦模式：除当前块以外的行变淡 */
export function focusMode(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDim(view);
      }

      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged || update.viewportChanged || update.focusChanged) {
          this.decorations = buildDim(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/**
 * 打字机模式：光标移动时把光标所在位置滚到编辑器竖直方向的中间。
 * 只在「光标/内容变化」时调整，用户主动滚动时不会强拉回来。
 */
export function typewriterMode(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.selectionSet && !update.docChanged) return;
    if (update.view.composing) return;
    const head = update.state.selection.main.head;
    const coords = update.view.coordsAtPos(head);
    if (!coords) return;
    const scroller = update.view.scrollDOM;
    const rect = scroller.getBoundingClientRect();
    const target = rect.top + rect.height * 0.42;
    const delta = coords.top - target;
    if (Math.abs(delta) > 8) scroller.scrollTop += delta;
  });
}
