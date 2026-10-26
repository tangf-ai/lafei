/**
 * MarkdownEditor —— 基于 CodeMirror 6 的笔记正文编辑器（0.14 起替换旧的块级 textarea）。
 *
 * - `mode="live"`：Typora 式即时预览。正文仍是纯 Markdown，光标所在行显示源码标记，
 *   其余行直接显示排版结果（见 livePreview.ts）。
 * - `mode="source"`：纯源码模式（等宽字体），给「源码 / 分栏」用。
 *
 * 组件只负责「文本 + 光标 + 命令」，保存、字数、模式切换由 NoteEditor 负责。
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { cn } from "../../lib/util";
import type { FormatSpec } from "../../lib/markdownFormat";
import {
  applyToolbarFormat,
  insertLink,
  insertText,
  selectedText,
  setHeading,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
} from "./commands";
import { focusMode, typewriterMode } from "./focus";
import { linkClickHandler } from "./linkClick";
import { livePreview } from "./livePreview";
import { tablePreview } from "./tablePreview";
import "./editor.css";

export interface CursorInfo {
  /** 1 基行号 */
  line: number;
  /** 1 基列号 */
  column: number;
}

export interface MarkdownEditorHandle {
  focus: () => void;
  applyFormat: (format: FormatSpec) => void;
  addLink: () => void;
  insertAtCursor: (text: string) => void;
  getSelection: () => string;
  /** 跳到指定行（1 基）并把该行滚到视野顶部附近，用于大纲跳转 */
  jumpToLine: (line: number) => void;
  getCursor: () => CursorInfo | null;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  mode: "live" | "source";
  placeholder?: string;
  focusMode?: boolean;
  typewriterMode?: boolean;
  onCursorChange?: (info: CursorInfo) => void;
  /** ⌘/Ctrl + 点击 `[[双向链接]]` 时打开目标笔记 */
  onOpenWiki?: (title: string) => void;
  className?: string;
  ariaLabel?: string;
}

/** 即时预览模式需要装的两层装饰：行内排版 + 表格预览 */
function liveModeExtensions() {
  return [livePreview(), tablePreview()];
}

const FORMAT_KEYS = [
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-k", run: insertLink },
  { key: "Mod-Shift-k", run: toggleInlineCode },
  { key: "Mod-1", run: (view: EditorView) => setHeading(view, 1) },
  { key: "Mod-2", run: (view: EditorView) => setHeading(view, 2) },
  { key: "Mod-3", run: (view: EditorView) => setHeading(view, 3) },
  { key: "Mod-4", run: (view: EditorView) => setHeading(view, 4) },
  { key: "Mod-5", run: (view: EditorView) => setHeading(view, 5) },
  { key: "Mod-6", run: (view: EditorView) => setHeading(view, 6) },
  { key: "Mod-0", run: (view: EditorView) => setHeading(view, 0) },
];

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      value,
      onChange,
      mode,
      placeholder = "从这里开始写。支持 Markdown：标题、加粗、列表、待办、引用、代码、[[双向链接]]。",
      focusMode: focusEnabled = false,
      typewriterMode: typewriterEnabled = false,
      onCursorChange,
      onOpenWiki,
      className,
      ariaLabel = "笔记正文",
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const lastEmittedRef = useRef(value);
    const onChangeRef = useRef(onChange);
    const onCursorRef = useRef(onCursorChange);
    const onOpenWikiRef = useRef(onOpenWiki);
    onChangeRef.current = onChange;
    onCursorRef.current = onCursorChange;
    onOpenWikiRef.current = onOpenWiki;

    const compartmentsRef = useRef<{
      mode: Compartment;
      focus: Compartment;
      typewriter: Compartment;
    } | null>(null);
    if (!compartmentsRef.current) {
      compartmentsRef.current = {
        mode: new Compartment(),
        focus: new Compartment(),
        typewriter: new Compartment(),
      };
    }
    const compartments = compartmentsRef.current;
    /** 只在挂载时读取一次初始属性，之后靠 Compartment 重配置 */
    const initialRef = useRef({ value, mode, focusEnabled, typewriterEnabled, placeholder, ariaLabel });

    useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const initial = initialRef.current;

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const next = update.state.doc.toString();
          lastEmittedRef.current = next;
          onChangeRef.current(next);
        }
        if (update.docChanged || update.selectionSet) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          onCursorRef.current?.({ line: line.number, column: head - line.from + 1 });
        }
      });

      const state = EditorState.create({
        doc: initial.value,
        extensions: [
          history(),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          keymap.of([...FORMAT_KEYS, ...markdownKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage, addKeymap: false }),
          linkClickHandler(() => onOpenWikiRef.current),
          EditorView.contentAttributes.of({
            "aria-label": initial.ariaLabel,
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          }),
          EditorView.editorAttributes.of({ class: "md-editor-cm" }),
          compartments.mode.of(initial.mode === "live" ? liveModeExtensions() : []),
          compartments.focus.of(initial.focusEnabled ? focusMode() : []),
          compartments.typewriter.of(initial.typewriterEnabled ? typewriterMode() : []),
          cmPlaceholder(initial.placeholder),
          updateListener,
        ],
      });

      const view = new EditorView({ state, parent: host });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // 挂载一次即可；mode / 聚焦 / 打字机通过 Compartment 热切换
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 外部内容变化（例如文件夹同步合并了别的设备写的内容）：整篇替换，光标尽量留在原处
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (value === current) {
        lastEmittedRef.current = value;
        return;
      }
      if (value === lastEmittedRef.current) return;
      if (view.composing) return;
      const head = Math.min(view.state.selection.main.head, value.length);
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: { anchor: head },
      });
    }, [value]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.mode.reconfigure(mode === "live" ? liveModeExtensions() : []),
      });
    }, [mode, compartments]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.focus.reconfigure(focusEnabled ? focusMode() : []),
      });
    }, [focusEnabled, compartments]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.typewriter.reconfigure(typewriterEnabled ? typewriterMode() : []),
      });
    }, [typewriterEnabled, compartments]);

    useImperativeHandle(
      ref,
      () => ({
        focus() {
          viewRef.current?.focus();
        },
        applyFormat(format) {
          const view = viewRef.current;
          if (!view) return;
          applyToolbarFormat(view, format);
          // 工具栏按钮会先让编辑器失焦，命令执行完把焦点还回去，方便接着敲字
          view.focus();
        },
        addLink() {
          const view = viewRef.current;
          if (!view) return;
          insertLink(view);
          view.focus();
        },
        insertAtCursor(text) {
          const view = viewRef.current;
          if (view) insertText(view, text);
        },
        getSelection() {
          const view = viewRef.current;
          return view ? selectedText(view) : "";
        },
        jumpToLine(line) {
          const view = viewRef.current;
          if (!view) return;
          const total = view.state.doc.lines;
          const number = Math.min(Math.max(1, Math.round(line)), total);
          const target = view.state.doc.line(number);
          view.dispatch({
            selection: { anchor: target.from },
            effects: EditorView.scrollIntoView(target.from, { y: "start", yMargin: 26 }),
          });
          view.focus();
        },
        getCursor() {
          const view = viewRef.current;
          if (!view) return null;
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head);
          return { line: line.number, column: head - line.from + 1 };
        },
      }),
      [],
    );

    return (
      <div
        ref={hostRef}
        className={cn("md-editor", mode === "source" && "md-editor--source", className)}
        data-mode={mode}
      />
    );
  },
);
