import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlignCenterVertical,
  ArrowLeft,
  Bold,
  Check,
  CheckCheck,
  ChevronRight,
  Code2,
  Columns2,
  Eye,
  Focus,
  Heading2,
  Italic,
  Link2,
  List,
  ListTodo,
  ListTree,
  Loader2,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Pin,
  Plus,
  Quote,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { db, deleteNoteCascade, updateNote } from "../db";
import {
  CONTENT_WIDTH_DEFAULT,
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  useUI,
  toast,
} from "../store/ui";
import { useIsMobile } from "../lib/hooks";
import {
  charCount,
  cn,
  noteBacklinks,
  noteTitle,
  updatedLabel,
} from "../lib/util";
import type { Note } from "../types";
import { Markdown } from "../lib/markdown";
import type { FormatSpec } from "../lib/markdownFormat";
import { MarkdownEditor, type CursorInfo, type MarkdownEditorHandle } from "../features/markdownEditor/MarkdownEditor";
import { MarkdownReader } from "../features/MarkdownReader";
import { NoteOutline } from "../features/NoteOutline";
import { extractOutline, type OutlineItem } from "../lib/outline";
import { openWikiLink } from "../lib/wikiLink";
import "./noteEditor.css";
import { ContentWidthHandle, SplitDivider } from "../features/EditorResize";
import { NoteAIPanel } from "../features/NoteAIPanel";
import { ConfirmDialog } from "../components/ConfirmDialog";

type Draft = Pick<Note, "title" | "content" | "tags">;

interface FormatButton extends FormatSpec {
  icon: typeof Bold;
}

const FORMAT_BUTTONS: FormatButton[] = [
  { id: "bold", icon: Bold, label: "加粗", before: "**", after: "**", placeholder: "加粗文字" },
  { id: "italic", icon: Italic, label: "斜体", before: "*", after: "*", placeholder: "斜体文字" },
  { id: "heading", icon: Heading2, label: "标题", prefix: "## " },
  { id: "list", icon: List, label: "列表", prefix: "- " },
  { id: "todo", icon: ListTodo, label: "待办列表", prefix: "- [ ] " },
  { id: "quote", icon: Quote, label: "引用", prefix: "> " },
  { id: "code", icon: Code2, label: "代码", before: "`", after: "`", placeholder: "代码" },
];

const MODE_LABEL = {
  live: "即时预览",
  source: "源码模式",
  split: "分栏预览",
  read: "阅读模式",
} as const;

const MODE_HINT = {
  live: "光标处露出源码 · 其余即时排版 · ⌘/ 切源码",
  source: "Markdown 源码模式 · ⌘/ 切回即时预览",
  split: "拖动中间分隔线调整左右宽度",
  read: "纯阅读模式 · 大纲可跳转",
} as const;

export function NoteEditor({ noteId }: { noteId: string }) {
  const note = useLiveQuery(() => db.notes.get(noteId), [noteId]);
  const allNotes = useLiveQuery(() => db.notes.toArray(), [], []);
  const closeNote = useUI((state) => state.closeNote);
  const openNote = useUI((state) => state.openNote);
  const noteMode = useUI((state) => state.noteMode);
  const setNoteMode = useUI((state) => state.setNoteMode);
  const aiPanelOpen = useUI((state) => state.aiPanelOpen);
  const setAIPanelOpen = useUI((state) => state.setAIPanelOpen);
  const notesListCollapsed = useUI((state) => state.notesListCollapsed);
  const setNotesListCollapsed = useUI((state) => state.setNotesListCollapsed);
  const contentWidth = useUI((state) => state.contentWidth);
  const setContentWidth = useUI((state) => state.setContentWidth);
  const splitRatio = useUI((state) => state.splitRatio);
  const setSplitRatio = useUI((state) => state.setSplitRatio);
  const outlineOpen = useUI((state) => state.outlineOpen);
  const setOutlineOpen = useUI((state) => state.setOutlineOpen);
  const focusMode = useUI((state) => state.focusMode);
  const setFocusMode = useUI((state) => state.setFocusMode);
  const typewriterMode = useUI((state) => state.typewriterMode);
  const setTypewriterMode = useUI((state) => state.setTypewriterMode);
  const isMobile = useIsMobile();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [readActiveHeading, setReadActiveHeading] = useState<number | null>(null);

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const dirtyRef = useRef(false);
  const deletedRef = useRef(false);
  const loadedRef = useRef(false);
  const latestRef = useRef<Draft | null>(null);
  const lastSeenUpdateRef = useRef(0);

  useEffect(() => {
    if (note && !loadedRef.current) {
      loadedRef.current = true;
      lastSeenUpdateRef.current = note.updatedAt;
      setDraft({ title: note.title, content: note.content, tags: note.tags });
    }
  }, [note]);

  useEffect(() => {
    if (!note || !loadedRef.current) return;
    if (note.updatedAt <= lastSeenUpdateRef.current) return;
    lastSeenUpdateRef.current = note.updatedAt;
    if (dirtyRef.current) return;
    const current = latestRef.current;
    if (!current) return;
    const same =
      current.title === note.title &&
      current.content === note.content &&
      current.tags.join("\u0001") === note.tags.join("\u0001");
    if (same) return;
    setDraft({ title: note.title, content: note.content, tags: note.tags });
    toast("已合并文件夹中的笔记更新", "success");
  }, [note?.updatedAt]);

  latestRef.current = draft;

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [draft?.title]);

  useEffect(() => {
    if (!isMobile && note && !note.title && !note.content) {
      window.setTimeout(() => titleRef.current?.focus(), 120);
    }
  }, [isMobile, note?.id]);

  useEffect(() => {
    if (!draft || !loadedRef.current || !dirtyRef.current) return;
    setSaveStatus("saving");
    const timer = window.setTimeout(async () => {
      if (deletedRef.current) return;
      await updateNote(noteId, { title: draft.title, content: draft.content, tags: draft.tags });
      dirtyRef.current = false;
      setSaveStatus("saved");
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft?.title, draft?.content, draft?.tags.join("\u0001"), noteId]);

  useEffect(() => {
    return () => {
      const latest = latestRef.current;
      if (latest && dirtyRef.current && !deletedRef.current) {
        void updateNote(noteId, { title: latest.title, content: latest.content, tags: latest.tags });
      }
    };
  }, [noteId]);

  const backlinks = useMemo(
    () => (draft?.title ? noteBacklinks(allNotes, draft.title) : []),
    [allNotes, draft?.title],
  );

  /** 大纲：跟正文同步刷新；当前项按光标所在行推断（阅读模式由滚动位置推断） */
  const outline = useMemo(() => extractOutline(draft?.content ?? ""), [draft?.content]);
  const activeHeadingIndex = useMemo(() => {
    if (!cursor) return null;
    let active: number | null = null;
    for (const item of outline) {
      if (item.line <= cursor.line) active = item.index;
      else break;
    }
    return active;
  }, [outline, cursor]);

  /** 阅读模式的大纲高亮：按滚动位置找出「当前读到哪个标题」 */
  useEffect(() => {
    if (noteMode !== "read" || !outlineOpen) {
      setReadActiveHeading(null);
      return;
    }
    const scroller = document.querySelector<HTMLElement>(".editor-read .editor-preview");
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top + 90;
      let active: number | null = null;
      for (const item of outline) {
        const heading = document.getElementById(`md-h-${item.line}`);
        if (!heading) continue;
        if (heading.getBoundingClientRect().top <= top) active = item.index;
        else break;
      }
      setReadActiveHeading((current) => (current === active ? current : active));
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const timer = window.setTimeout(update, 100);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [noteMode, outlineOpen, outline, draft?.content]);

  if (!note || !draft) {
    return (
      <section className="editor-shell">
        <div className="editor-loading">
          <Loader2 size={18} className="spin" /> 正在打开笔记…
        </div>
      </section>
    );
  }

  const patchDraft = (patch: Partial<Draft>) => {
    dirtyRef.current = true;
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const saveNow = async () => {
    if (!draft) return;
    await updateNote(noteId, { title: draft.title, content: draft.content, tags: draft.tags });
    dirtyRef.current = false;
    setSaveStatus("saved");
  };

  const togglePin = async () => {
    dirtyRef.current = true;
    const next = !note.pinned;
    await updateNote(noteId, { pinned: next });
    toast(next ? "已置顶" : "已取消置顶");
  };

  const deleteNote = async () => {
    deletedRef.current = true;
    await deleteNoteCascade(noteId);
    closeNote();
    toast("笔记已删除");
  };

  const addTag = () => {
    const value = tagInput.trim().replace(/^#/, "").replace(/\s+/g, "-");
    if (!value) {
      setAddingTag(false);
      setTagInput("");
      return;
    }
    if (!draft.tags.includes(value)) {
      patchDraft({ tags: [...draft.tags, value].slice(0, 12) });
    }
    setTagInput("");
    setAddingTag(false);
  };

  const removeTag = (tag: string) => {
    patchDraft({ tags: draft.tags.filter((item) => item !== tag) });
  };

  /** 工具栏统一入口：所有编辑模式都交给 CodeMirror 编辑器处理 */
  const applyFormatFromToolbar = (format: FormatSpec) => {
    editorRef.current?.applyFormat(format);
  };

  const addLinkFromToolbar = () => {
    editorRef.current?.addLink();
  };

  const currentSelection = () => editorRef.current?.getSelection() ?? "";

  const jumpToOutline = (item: OutlineItem) => {
    if (noteMode === "read") {
      const heading = document.getElementById(`md-h-${item.line}`);
      const scroller = document.querySelector<HTMLElement>(".editor-read .editor-preview");
      if (!heading) return;
      if (!scroller) {
        heading.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const top =
        heading.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        18;
      scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      return;
    }
    editorRef.current?.jumpToLine(item.line);
  };

  const appendToNote = (text: string) => {
    const base = draft.content.trimEnd();
    const next = base ? `${base}\n\n${text.trim()}\n` : `${text.trim()}\n`;
    patchDraft({ content: next });
    toast("已追加到笔记", "success");
    if (noteMode === "read") setNoteMode("live");
  };

  const applyAITitle = (title: string) => {
    patchDraft({ title: title.slice(0, 80) });
  };

  const setTitleAndSave = (title: string) => {
    patchDraft({ title });
  };

  const copyWikiLink = async () => {
    await navigator.clipboard.writeText(`[[${draft.title || "无标题笔记"}]]`);
    setCopiedLink(true);
    toast("已复制双向链接", "success");
    window.setTimeout(() => setCopiedLink(false), 1600);
  };

  const openLinkedNote = (id: string) => openNote(id);

  /** Typora 同款：⌘/ 在即时预览与源码之间切换；⌘S 立即保存 */
  const handleEditorShortcuts = (event: ReactKeyboardEvent<HTMLElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "/") {
      event.preventDefault();
      setNoteMode(noteMode === "live" ? "source" : "live");
    } else if (key === "s") {
      event.preventDefault();
      void saveNow();
    }
  };

  return (
    <>
      <section
        className={cn("editor-shell", aiPanelOpen && "ai-open")}
        onKeyDownCapture={handleEditorShortcuts}
      >
        <div className="editor-main">
          <header className="editor-topbar">
            <div className="editor-topbar-left">
              <button type="button" className="icon-btn editor-back" onClick={closeNote} aria-label="返回笔记列表">
                <ArrowLeft size={18} />
              </button>
              {!isMobile && (
                <button
                  type="button"
                  className="icon-btn notes-list-toggle"
                  onClick={() => setNotesListCollapsed(!notesListCollapsed)}
                  title={notesListCollapsed ? "展开笔记列表" : "收起笔记列表"}
                  aria-label={notesListCollapsed ? "展开笔记列表" : "收起笔记列表"}
                  aria-pressed={notesListCollapsed}
                >
                  {notesListCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
                </button>
              )}
              <span className="editor-crumb">
                <NotebookPen size={13} /> 笔记 <ChevronRight size={12} /> {noteTitle(draft.title)}
              </span>
              <span className={cn("editor-save-state", saveStatus === "saving" && "is-saving")}>
                {saveStatus === "saving" ? (
                  <>
                    <Loader2 size={12} className="spin" /> 保存中
                  </>
                ) : (
                  <>
                    <Check size={13} /> 已保存
                  </>
                )}
              </span>
            </div>
            <div className="editor-topbar-actions">
              {!isMobile && noteMode !== "split" && (
                <button
                  type="button"
                  className={cn("icon-btn", outlineOpen && "is-active")}
                  title={outlineOpen ? "隐藏大纲" : "显示大纲"}
                  aria-label={outlineOpen ? "隐藏大纲" : "显示大纲"}
                  aria-pressed={outlineOpen}
                  onClick={() => setOutlineOpen(!outlineOpen)}
                >
                  <ListTree size={16} />
                </button>
              )}
              <button
                type="button"
                className={cn("icon-btn", note.pinned && "is-active")}
                title={note.pinned ? "取消置顶" : "置顶"}
                onClick={() => void togglePin()}
              >
                <Pin size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="复制双向链接"
                onClick={() => void copyWikiLink()}
              >
                {copiedLink ? <CheckCheck size={16} /> : <Link2 size={16} />}
              </button>
              <button
                type="button"
                className="icon-btn"
                title="删除笔记"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={16} />
              </button>
              <button
                type="button"
                className={cn("editor-ai-button", aiPanelOpen && "is-active")}
                onClick={() => setAIPanelOpen(!aiPanelOpen)}
              >
                <Sparkles size={15} />
                <span>AI</span>
              </button>
            </div>
          </header>

          <div className="editor-title-block">
            <div className="wb-doc-mode">
              <div className="segmented editor-mode-switch" role="group" aria-label="编辑模式">
                <button
                  type="button"
                  className={cn("segment", noteMode === "live" && "active")}
                  title="即时预览：像 Typora 一样直接写，光标处露出源码，其余内容即时排版（⌘/ 切源码）"
                  onClick={() => setNoteMode("live")}
                >
                  <WandSparkles size={14} />
                </button>
                <button
                  type="button"
                  className={cn("segment", noteMode === "source" && "active")}
                  title="源码模式：直接编辑 Markdown（⌘/ 切回即时预览）"
                  onClick={() => setNoteMode("source")}
                >
                  <PenLine size={14} />
                </button>
                <button
                  type="button"
                  className={cn("segment mode-split-btn", noteMode === "split" && "active")}
                  title="分栏预览：左边写，右边看"
                  onClick={() => setNoteMode("split")}
                >
                  <Columns2 size={14} />
                </button>
                <button
                  type="button"
                  className={cn("segment", noteMode === "read" && "active")}
                  title="阅读模式"
                  onClick={() => setNoteMode("read")}
                >
                  <Eye size={14} />
                </button>
              </div>
            </div>
            <textarea
              ref={titleRef}
              className="editor-title-input"
              value={draft.title}
              rows={1}
              placeholder="无标题"
              spellCheck={false}
              onChange={(event) => setTitleAndSave(event.target.value)}
              aria-label="笔记标题"
            />
            <div className="editor-meta">
              <span className="editor-meta-time">{updatedLabel(note.updatedAt)}</span>
              <span className="editor-meta-sep">·</span>
              <span>{charCount(draft.content)} 字</span>
              <span className="editor-meta-sep">·</span>
              <span className="editor-meta-save">
                {saveStatus === "saving" ? "正在保存…" : "所有更改已保存"}
              </span>
              <div className="editor-tags">
                {draft.tags.map((tag) => (
                  <span className="editor-tag" key={tag}>
                    #{tag}
                    <button type="button" onClick={() => removeTag(tag)} aria-label={`移除标签 ${tag}`}>
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {addingTag ? (
                  <input
                    ref={tagRef}
                    className="editor-tag-input"
                    value={tagInput}
                    autoFocus
                    placeholder="标签名"
                    onChange={(event) => setTagInput(event.target.value)}
                    onBlur={addTag}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addTag();
                      } else if (event.key === "Escape") {
                        setAddingTag(false);
                        setTagInput("");
                      }
                    }}
                  />
                ) : (
                  <button type="button" className="editor-tag-add" onClick={() => setAddingTag(true)}>
                    <Plus size={11} /> 标签
                  </button>
                )}
              </div>
              {backlinks.length > 0 && (
                <details className="backlinks">
                  <summary>
                    <Link2 size={12} /> {backlinks.length} 个反向链接
                  </summary>
                  <div className="backlinks-pop">
                    <span className="backlinks-label">提到这篇笔记的页面</span>
                    {backlinks.map((item) => (
                      <button key={item.id} type="button" onClick={() => openLinkedNote(item.id)}>
                        <span>{noteTitle(item.title)}</span>
                        <ChevronRight size={12} />
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </div>

          {noteMode !== "read" && (
            <div className={cn("editor-toolbar", noteMode === "split" && "is-split")}>
              <div className="editor-toolbar-scroll">
                {FORMAT_BUTTONS.map((format) => {
                  const Icon = format.icon;
                  return (
                    <button
                      key={format.id}
                      type="button"
                      className="editor-tool"
                      title={format.label}
                      onClick={() => applyFormatFromToolbar(format)}
                    >
                      <Icon size={16} />
                    </button>
                  );
                })}
                <button type="button" className="editor-tool" title="插入链接" onClick={addLinkFromToolbar}>
                  <Link2 size={16} />
                </button>
                <span className="editor-toolbar-divider" />
                <button
                  type="button"
                  className="editor-tool editor-tool-ai"
                  title="让 AI 帮你写"
                  onClick={() => setAIPanelOpen(!aiPanelOpen)}
                >
                  <Sparkles size={15} />
                  <span>AI</span>
                </button>
              </div>
            </div>
          )}

          <div
            className={cn("editor-body", `mode-${noteMode}`)}
            style={
              {
                "--doc-width": `${contentWidth}px`,
                "--split-left": `${Math.round(splitRatio * 1000) / 10}%`,
              } as CSSProperties
            }
          >
            {noteMode !== "read" && noteMode !== "split" && (
              <div className={cn(noteMode === "live" ? "editor-live" : "editor-write", "editor-pane")}>
                <MarkdownEditor
                  ref={editorRef}
                  value={draft.content}
                  onChange={(next) => patchDraft({ content: next })}
                  mode={noteMode === "live" ? "live" : "source"}
                  focusMode={focusMode}
                  typewriterMode={typewriterMode}
                  onCursorChange={setCursor}
                  onOpenWiki={(title) => void openWikiLink(title)}
                  placeholder={
                    noteMode === "live"
                      ? "直接开始写。光标处会露出 Markdown 源码，其余内容即时排版；⌘/ 切换源码模式。"
                      : "直接编辑 Markdown 源码；⌘/ 切回即时预览。"
                  }
                />
                {!isMobile && (
                  <ContentWidthHandle
                    value={contentWidth}
                    min={CONTENT_WIDTH_MIN}
                    max={CONTENT_WIDTH_MAX}
                    defaultValue={CONTENT_WIDTH_DEFAULT}
                    onChange={setContentWidth}
                  />
                )}
              </div>
            )}

            {noteMode === "split" && (
              <>
                <div className="editor-write editor-pane">
                  <MarkdownEditor
                    ref={editorRef}
                    value={draft.content}
                    onChange={(next) => patchDraft({ content: next })}
                    mode="source"
                    className="md-editor--split"
                    onCursorChange={setCursor}
                    placeholder="左边写 Markdown，右边实时预览。"
                  />
                </div>
                {!isMobile && (
                  <SplitDivider
                    value={splitRatio}
                    min={SPLIT_RATIO_MIN}
                    max={SPLIT_RATIO_MAX}
                    defaultValue={SPLIT_RATIO_DEFAULT}
                    onChange={setSplitRatio}
                  />
                )}
                <div className="editor-preview">
                  {draft.content.trim() ? (
                    <Markdown content={draft.content} />
                  ) : (
                    <div className="editor-preview-empty">
                      <PenLine size={20} />
                      <p>这一页还是空白。</p>
                      <span>切回编辑，写下第一句。</span>
                    </div>
                  )}
                </div>
              </>
            )}

            {noteMode === "read" && (
              <div className="editor-read">
                <div className="editor-preview">
                  {draft.content.trim() ? (
                    <MarkdownReader content={draft.content} />
                  ) : (
                    <div className="editor-preview-empty">
                      <PenLine size={20} />
                      <p>这一页还是空白。</p>
                      <span>切回编辑，写下第一句。</span>
                    </div>
                  )}
                </div>
                {!isMobile && (
                  <ContentWidthHandle
                    value={contentWidth}
                    min={CONTENT_WIDTH_MIN}
                    max={CONTENT_WIDTH_MAX}
                    defaultValue={CONTENT_WIDTH_DEFAULT}
                    onChange={setContentWidth}
                  />
                )}
              </div>
            )}

            {outlineOpen && !isMobile && noteMode !== "split" && (
              <aside className="editor-outline" aria-label="笔记大纲">
                <NoteOutline
                  content={draft.content}
                  onJump={jumpToOutline}
                  activeIndex={noteMode === "read" ? readActiveHeading : activeHeadingIndex}
                />
              </aside>
            )}
          </div>

          <footer className="editor-statusbar">
            <span className="editor-status-mode">{MODE_LABEL[noteMode]}</span>
            {!isMobile && noteMode !== "read" && (
              <>
                <span className="editor-status-dot" />
                <span className="editor-status-cursor">
                  第 {cursor?.line ?? 1} 行 · 第 {cursor?.column ?? 1} 列
                </span>
              </>
            )}
            <span className="editor-status-spacer" />
            <span>{charCount(draft.content)} 字</span>
            <span className="editor-status-dot" />
            {!isMobile && noteMode !== "read" && (
              <span className="editor-status-toggles">
                <button
                  type="button"
                  className={cn("editor-status-toggle", focusMode && "is-active")}
                  title="聚焦模式：只突出当前段落，其余内容变淡"
                  aria-label="聚焦模式"
                  aria-pressed={focusMode}
                  onClick={() => setFocusMode(!focusMode)}
                >
                  <Focus size={12} />
                </button>
                <button
                  type="button"
                  className={cn("editor-status-toggle", typewriterMode && "is-active")}
                  title="打字机模式：光标始终停在视线中央"
                  aria-label="打字机模式"
                  aria-pressed={typewriterMode}
                  onClick={() => setTypewriterMode(!typewriterMode)}
                >
                  <AlignCenterVertical size={12} />
                </button>
              </span>
            )}
            <span className="editor-status-hint">
              {isMobile ? "自动保存" : MODE_HINT[noteMode]}
            </span>
          </footer>
        </div>

        {aiPanelOpen && (
          <NoteAIPanel
            note={{ ...note, title: draft.title, content: draft.content, tags: draft.tags }}
            onClose={() => setAIPanelOpen(false)}
            onAppend={appendToNote}
            onSetTitle={applyAITitle}
            getSelection={currentSelection}
          />
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title="删除这篇笔记？"
        description="这篇笔记会被永久删除，无法恢复。关联的任务会保留，但会解除与笔记的链接。"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void deleteNote()}
      />


    </>
  );
}
