/**
 * 即时预览里的链接行为：⌘/Ctrl + 点击打开链接。
 *
 * 普通单击仍然只是把光标放进链接文字里（编辑时更常见），
 * 和 Typora 一样用修饰键区分「打开」与「编辑」。
 */
import { syntaxTree } from "@codemirror/language";
import type { Extension, EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { EditorView } from "@codemirror/view";
import { openExternal } from "../../lib/external";

const WIKI_PATTERN = /\[\[([^\]\n]+?)(?:\|([^\]\n]+))?\]\]/g;

/** 光标/点击位置是否落在某个 `[[wiki 链接]]` 上，返回目标笔记标题 */
export function wikiLinkAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos);
  WIKI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_PATTERN.exec(line.text))) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) return match[1].trim();
  }
  return null;
}

/** 光标/点击位置上的 Markdown 链接地址 */
function urlAt(state: EditorState, pos: number): string | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (node) {
    if (node.name === "URL") return state.sliceDoc(node.from, node.to);
    if (node.name === "Link" || node.name === "Autolink") {
      const url = node.getChildren("URL")[0];
      if (url) return state.sliceDoc(url.from, url.to);
    }
    node = node.parent;
  }
  return null;
}

/**
 * @param getWiki 读取打开 wiki 链接的回调（React 侧随时变化，用函数取最新值）
 */
export function linkClickHandler(
  getWiki: () => ((title: string) => void) | undefined,
): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const element = event.target instanceof Element ? event.target : null;
      if (!element || !element.closest(".cm-md-link, .cm-md-wikilink, .cm-md-url")) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const wiki = wikiLinkAt(view.state, pos);
      if (wiki) {
        event.preventDefault();
        getWiki()?.(wiki);
        return true;
      }
      const url = urlAt(view.state, pos);
      if (url) {
        event.preventDefault();
        void openExternal(url);
        return true;
      }
      return false;
    },
  });
}
