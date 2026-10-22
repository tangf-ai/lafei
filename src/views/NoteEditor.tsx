import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  Bold,
  Check,
  CheckCheck,
  ChevronRight,
  Code2,
  Columns2,
  Eye,
  Heading2,
  Italic,
  Link2,
  List,
  ListTodo,
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
import {
  applyFormatSpec,
  applyLinkSpec,
  type FormatSpec,
} from "../lib/markdownFormat";
import { LiveMarkdownEditor, MarkdownBlocks, type LiveEditorHandle } from "../features/LiveMarkdownEditor";
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
  source: "源码编辑",
  split: "分栏预览",
  read: "阅读模式",
} as const;

const MODE_HINT = {
  live: "输入即渲染 · 悬停看源码 · 点击编辑",
  source: "Markdown 源码模式",
  split: "拖动中间分隔线调整左右宽度",
  read: "悬停任意段落查看 Markdown 源码",
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
  const isMobile = useIsMobile();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const liveRef = useRef<LiveEditorHandle>(null);
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

  const replaceSelection = (next: string, selectStart?: number, selectEnd?: number) => {
    patchDraft({ content: next });
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      if (typeof selectStart === "number") {
        textarea.setSelectionRange(selectStart, selectEnd ?? selectStart);
      }
    });
  };

  /** 源码模式：在整篇文本的当前选区上执行格式操作 */
  const applyFormatInSource = (format: FormatSpec) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const result = applyFormatSpec(draft.content, textarea.selectionStart, textarea.selectionEnd, format);
    replaceSelection(result.text, result.start, result.end);
  };

  const addLinkInSource = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const result = applyLinkSpec(draft.content, textarea.selectionStart, textarea.selectionEnd);
    replaceSelection(result.text, result.start, result.end);
  };

  /** 工具栏与 AI 面板统一入口：即时预览模式交给块级编辑器处理 */
  const applyFormatFromToolbar = (format: FormatSpec) => {
    if (noteMode === "live") {
      liveRef.current?.applyFormat(format);
      return;
    }
    applyFormatInSource(format);
  };

  const addLinkFromToolbar = () => {
    if (noteMode === "live") {
      liveRef.current?.addLink();
      return;
    }
    addLinkInSource();
  };

  const insertAtCursor = (text: string) => {
    if (noteMode === "live") {
      liveRef.current?.insertAtCursor(text);
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      patchDraft({ content: `${draft.content.trimEnd()}\n\n${text}` });
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = draft.content.slice(0, start) + text + draft.content.slice(end);
    replaceSelection(next, start + text.length, start + text.length);
  };

  const currentSelection = () => {
    if (noteMode === "live") return liveRef.current?.getSelection() ?? "";
    const textarea = textareaRef.current;
    if (!textarea) return "";
    return draft.content.slice(textarea.selectionStart, textarea.selectionEnd);
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

  return (
    <>
      <section className={cn("editor-shell", aiPanelOpen && "ai-open")}>
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
                  title="即时预览：输入 Markdown 自动渲染，点击段落编辑"
                  onClick={() => setNoteMode("live")}
                >
                  <WandSparkles size={14} />
                </button>
                <button
                  type="button"
                  className={cn("segment", noteMode === "source" && "active")}
                  title="源码模式：直接编辑 Markdown"
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
            {noteMode === "live" && (
              <div className="editor-live">
                <LiveMarkdownEditor
                  ref={liveRef}
                  content={draft.content}
                  onChange={(next) => patchDraft({ content: next })}
                  placeholder={
                    "从这里开始写。\n\n直接输入 Markdown：# 标题、**加粗**、- 列表、- [ ] 待办、> 引用，以及 [[双向链接]]。"
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

            {(noteMode === "source" || noteMode === "split") && (
              <div className="editor-write">
                <textarea
                  ref={textareaRef}
                  className="editor-textarea"
                  value={draft.content}
                  onChange={(event) => patchDraft({ content: event.target.value })}
                  placeholder={
                    "从这里开始写。\n\n支持 Markdown：# 标题、**加粗**、- 列表、- [ ] 待办、> 引用，以及 [[双向链接]]。"
                  }
                  spellCheck={false}
                  onKeyDown={(event) => {
                    if (event.key === "Tab") {
                      event.preventDefault();
                      insertAtCursor("  ");
                    }
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                      event.preventDefault();
                      void saveNow();
                    }
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
                      event.preventDefault();
                      applyFormatInSource(FORMAT_BUTTONS[0]);
                    }
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
                      event.preventDefault();
                      applyFormatInSource(FORMAT_BUTTONS[1]);
                    }
                  }}
                />
                {noteMode === "source" && !isMobile && (
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
                    <MarkdownBlocks content={draft.content} />
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
          </div>

          <footer className="editor-statusbar">
            <span className="editor-status-mode">{MODE_LABEL[noteMode]}</span>
            <span className="editor-status-spacer" />
            <span>{charCount(draft.content)} 字</span>
            <span className="editor-status-dot" />
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
