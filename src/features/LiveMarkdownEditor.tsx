/**
 * LiveMarkdownEditor —— 即时预览编辑器（笔记「编辑」模式的内核）。
 *
 * 整篇 Markdown 按空行切成块（见 lib/liveMarkdown.ts），平时每块用共享的 <Markdown> 渲染成
 * 排版好的样子；点某一块就在原地换成 textarea 编辑这一块，每次按键把整篇新内容回传给父组件
 * （父组件负责 500ms 自动保存、字数统计）。鼠标悬停在渲染结果上时浮层显示该块的 Markdown 源码；
 * 悬停在链接 / 待办勾选框上则不显示，保证它们可以正常点（peek 需要 Lead 的 CSS 设
 * pointer-events: none，否则会挡住下面的链接）。
 *
 * 编辑期间的关键点：块列表与整篇内容在进入编辑那一刻「冻结」。这样键入空行、粘贴多段文字都不会
 * 让块下标 / 偏移在编辑途中失效；全文一律用 replaceMarkdownBlock(frozenContent, block, value) 计算。
 */
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";
import { Markdown } from "../lib/markdown";
import { applyFormatSpec, applyLinkSpec } from "../lib/markdownFormat";
import type { FormatSpec } from "../lib/markdownFormat";
import { replaceMarkdownBlock, splitMarkdownBlocks } from "../lib/liveMarkdown";
import type { MarkdownBlock } from "../lib/liveMarkdown";
import { cn } from "../lib/util";

export interface LiveMarkdownEditorProps {
  content: string;
  /** 每次编辑都应回传整篇新内容；父组件负责 500ms 自动保存 */
  onChange: (next: string) => void;
  placeholder?: string;
}

export interface LiveEditorHandle {
  focus: () => void;
  applyFormat: (format: FormatSpec) => void;
  addLink: () => void;
  insertAtCursor: (text: string) => void;
  getSelection: () => string;
}

/** 命中这些元素时不显示源码浮层、也不进入编辑，保证链接 / 勾选框可正常点击 */
const INTERACTIVE_SELECTOR = "a, button, input, summary, label, textarea";
/** 焦点落在这类控件上（父组件的工具栏等）时，先提交内容但保留编辑态，方便随后的格式化作用于当前块 */
const CONTROL_SELECTOR = "button, [role='button'], summary";

const BOLD_FORMAT: FormatSpec = { id: "bold", label: "加粗", before: "**", after: "**", placeholder: "加粗文字" };
const ITALIC_FORMAT: FormatSpec = { id: "italic", label: "斜体", before: "*", after: "*", placeholder: "斜体文字" };

/** 编辑态：进入编辑那一刻冻结块列表和整篇内容，避免编辑途中偏移失效 */
interface EditState {
  /** 冻结块列表中的下标 */
  index: number;
  /** 正在编辑的块（start / end 基于 frozenContent） */
  block: MarkdownBlock;
  /** 进入编辑那一刻的整篇内容 */
  frozenContent: string;
  /** 进入编辑那一刻的块列表（编辑期间不重算） */
  frozenBlocks: MarkdownBlock[];
  /** textarea 当前值，每次按键更新 */
  value: string;
  /** 是否是用「继续写 / 空状态」新建出来的空块（它本身不在原文档里） */
  isNew: boolean;
}

/** 打开块之后要执行的命令式动作（延迟到 textarea 挂载后执行） */
type PendingCommand = { kind: "format"; format: FormatSpec } | { kind: "link" };

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

/** 鼠标事件落在当前块哪里：命中交互元素返回 null（隐藏源码浮层），否则返回块起点 */
function hoveredBlockStart(event: ReactMouseEvent<HTMLDivElement>): number | null {
  if (isInteractiveTarget(event.target)) return null;
  return Number(event.currentTarget.dataset.start);
}

/** 悬停源码浮层的显示延时：停留一会儿才显示，鼠标掠过时不闪 */
const PEEK_DELAY = 120;

/**
 * 悬停源码浮层的状态机：
 * - 在普通内容上停留 PEEK_DELAY 才显示；
 * - 移到链接 / 勾选框等交互元素、或鼠标离开，立即隐藏（计时器一并取消）。
 */
function useHoverPeek() {
  const [hoveredStart, setHoveredStart] = useState<number | null>(null);
  const timerRef = useRef(0);
  const pendingRef = useRef<number | null>(null);

  const clear = () => {
    pendingRef.current = null;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = 0;
  };
  useEffect(() => clear, []); // 卸载时清掉未触发的计时器

  const onMouseOver = (event: ReactMouseEvent<HTMLDivElement>) => {
    const start = hoveredBlockStart(event);
    if (start === null) {
      clear();
      setHoveredStart((current) => (current === null ? current : null));
      return;
    }
    if (start === hoveredStart || start === pendingRef.current) return; // 已在显示 / 计时中
    pendingRef.current = start;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      pendingRef.current = null;
      setHoveredStart(start);
    }, PEEK_DELAY);
  };

  const onMouseLeave = () => {
    clear();
    setHoveredStart((current) => (current === null ? current : null));
  };

  /** 立即隐藏（进入编辑、切换块时同步清掉计时的悬停） */
  const hidePeek = () => {
    clear();
    setHoveredStart((current) => (current === null ? current : null));
  };

  return { hoveredStart, hidePeek, onMouseOver, onMouseLeave };
}

/** 移除一个空块：合并两侧空行（不留 3 个以上连续换行），并清掉文末空白 */
function removeBlockFromContent(content: string, block: MarkdownBlock): string {
  const before = content.slice(0, block.start).replace(/\n+$/, "");
  const after = content.slice(block.end).replace(/^\n+/, "");
  if (!before) return after;
  if (!after) return before.trimEnd();
  return `${before}\n\n${after}`;
}

/** 单块 Markdown 渲染：按 raw 做 memo，悬停 / 切编辑态只重渲染外层 div，不重新解析其它块 */
const BlockBody = memo(function BlockBody({ raw }: { raw: string }) {
  return <Markdown content={raw} />;
});

/** 悬停时显示的源码浮层。CSS 必须给它 pointer-events: none，否则会挡住下面的链接和勾选框 */
function SourcePeek({ raw }: { raw: string }) {
  return (
    <div className="lp-source-peek" aria-hidden="true">
      <span className="lp-source-tag">Markdown 源码</span>
      <pre className="lp-source-code">{raw}</pre>
    </div>
  );
}

export const LiveMarkdownEditor = forwardRef<LiveEditorHandle, LiveMarkdownEditorProps>(
  function LiveMarkdownEditor(
    { content, onChange, placeholder = "输入 Markdown，松手就会变成排版好的样子…" },
    ref,
  ) {
    const [editing, setEditing] = useState<EditState | null>(null);
    const { hoveredStart, hidePeek, onMouseOver, onMouseLeave } = useHoverPeek();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    /** 事件回调里读取最新编辑态（渲染时同步镜像，避免闭包读到旧值） */
    const editingRef = useRef<EditState | null>(null);
    editingRef.current = editing;
    /** 最后一次通过 onChange 发出的内容，用来识别父组件回传的「回声」 */
    const lastEmittedRef = useRef("");
    /** 刚打开的块需要聚焦并把光标放到块尾 */
    const pendingFocusRef = useRef(false);
    /** 打开块之后再执行的命令（工具栏格式化 / 插入链接） */
    const pendingCommandRef = useRef<PendingCommand | null>(null);
    /** 编辑 A 时点了 B：记下 B 的冻结起点，提交后按长度变化重新定位 */
    const pendingOpenRef = useRef<{ start: number } | null>(null);
    /** 跨块切换时延迟一帧再挂载新 textarea，避开浏览器 mousedown 的焦点处理 */
    const openFrameRef = useRef(0);

    const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
    /** 编辑期间用冻结的块列表，保证块下标与偏移稳定 */
    const visibleBlocks = editing ? editing.frozenBlocks : blocks;

    const emit = (next: string) => {
      lastEmittedRef.current = next;
      onChange(next);
    };

    /**
     * 计算提交结果（不 emit）：块里有内容就替换；块被清空 / 新建块没写字就整块移除。
     * changed 用「提交前后整篇内容是否相同」判断，空块移除、改回原样都不会重复 emit。
     */
    const resolveCommit = (current: EditState): { nextContent: string; changed: boolean } => {
      const nextContent = current.value.trim()
        ? replaceMarkdownBlock(current.frozenContent, current.block, current.value)
        : removeBlockFromContent(current.frozenContent, current.block);
      return { nextContent, changed: nextContent !== current.frozenContent };
    };

    /** 被点击块在提交后的起点：源块之后的块整体平移（平移量 = 提交前后长度差） */
    const mapTargetStart = (current: EditState, nextContent: string, frozenStart: number): number =>
      frozenStart <= current.block.start
        ? frozenStart
        : nextContent.length - (current.frozenContent.length - frozenStart);

    /** 统一进入编辑态：清掉待打开记录，聚焦到块尾 */
    const beginEdit = (state: EditState) => {
      pendingOpenRef.current = null;
      pendingFocusRef.current = true;
      hidePeek();
      setEditing(state);
    };

    const openBlock = (list: MarkdownBlock[], index: number, baseContent: string) => {
      const block = list[index];
      if (!block) return;
      beginEdit({
        index,
        block,
        frozenContent: baseContent,
        frozenBlocks: list,
        value: block.raw,
        isNew: false,
      });
    };

    /** 取消「下一帧打开某块」的调度 */
    const cancelScheduledOpen = () => {
      if (!openFrameRef.current) return;
      window.cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = 0;
    };

    /** 打开最后一块；空文档则造一个空块从偏移 0 开始写 */
    const openLastBlock = () => {
      cancelScheduledOpen();
      if (blocks.length > 0) {
        openBlock(blocks, blocks.length - 1, content);
        return;
      }
      // 纯空白内容按空文档处理：否则从空白处开始写会被前面的空格顶成缩进 / 代码块
      const baseContent = content.trim() ? content : "";
      if (baseContent !== content) emit(baseContent);
      beginEdit({
        index: 0,
        block: { raw: "", start: baseContent.length, end: baseContent.length },
        frozenContent: baseContent,
        frozenBlocks: [{ raw: "", start: baseContent.length, end: baseContent.length }],
        value: "",
        isNew: true,
      });
    };

    /** 下一帧再打开目标块：此时浏览器已处理完 mousedown 的焦点切换，避免抢焦点失败 */
    const scheduleOpenAt = (baseContent: string, targetStart: number) => {
      cancelScheduledOpen();
      openFrameRef.current = window.requestAnimationFrame(() => {
        openFrameRef.current = 0;
        if (editingRef.current) return; // 期间已经打开了别的块
        const list = splitMarkdownBlocks(baseContent);
        const index = list.findIndex((item) => item.start === targetStart);
        if (index >= 0) openBlock(list, index, baseContent);
      });
    };

    /** 提交当前编辑（有变化才 emit 一次），关闭编辑态，返回提交后的整篇内容 */
    const commitAndClose = (current: EditState): string => {
      const { nextContent, changed } = resolveCommit(current);
      setEditing(null);
      hidePeek();
      if (changed) emit(nextContent);
      return nextContent;
    };

    /** 对当前 textarea 选区做一次纯文本变换，回传新内容，并在下一帧恢复选区 */
    const applyToSelection = (
      transform: (value: string, start: number, end: number) => { text: string; start: number; end: number },
    ) => {
      const current = editingRef.current;
      const el = textareaRef.current;
      if (!current || !el) return;
      const result = transform(current.value, el.selectionStart, el.selectionEnd);
      setEditing({ ...current, value: result.text });
      emit(replaceMarkdownBlock(current.frozenContent, current.block, result.text));
      window.requestAnimationFrame(() => {
        if (!el.isConnected) return;
        el.focus();
        el.setSelectionRange(result.start, result.end);
      });
    };

    const applyFormatInTextarea = (format: FormatSpec) => {
      applyToSelection((value, start, end) => applyFormatSpec(value, start, end, format));
    };
    const applyLinkInTextarea = () => {
      applyToSelection(applyLinkSpec);
    };
    const insertTextInTextarea = (text: string) => {
      applyToSelection((value, start, end) => ({
        text: value.slice(0, start) + text + value.slice(end),
        start: start + text.length,
        end: start + text.length,
      }));
    };

    /** 「＋ 继续写」：先提交当前块，再在文末新起一个空段落并进入编辑 */
    const startNewBlock = () => {
      const current = editingRef.current;
      cancelScheduledOpen();
      const base = current ? resolveCommit(current).nextContent : content;
      const trimmed = base.trimEnd();
      const nextContent = trimmed ? `${trimmed}\n\n` : "";
      const nextBlocks = splitMarkdownBlocks(nextContent);
      const synthetic: MarkdownBlock = { raw: "", start: nextContent.length, end: nextContent.length };
      if (nextContent !== content) emit(nextContent);
      beginEdit({
        index: nextBlocks.length,
        block: synthetic,
        frozenContent: nextContent,
        frozenBlocks: [...nextBlocks, synthetic],
        value: "",
        isNew: true,
      });
    };

    // ---- 事件处理 ----

    const handleEditorChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
      const current = editingRef.current;
      if (!current) return;
      const value = event.target.value;
      setEditing({ ...current, value });
      // 每次按键都回传整篇内容：父组件的字数统计 / 自动保存 / 预览保持实时
      emit(replaceMarkdownBlock(current.frozenContent, current.block, value));
    };

    const handleBlur = (event: ReactFocusEvent<HTMLTextAreaElement>) => {
      const current = editingRef.current;
      if (!current) return;
      const pending = pendingOpenRef.current;
      pendingOpenRef.current = null;
      const { nextContent, changed } = resolveCommit(current);
      const related = event.relatedTarget;
      const toControl =
        !pending &&
        related instanceof Element &&
        related.closest(".lp-doc") === null &&
        related.closest(CONTROL_SELECTOR) !== null;
      if (toControl) {
        // 焦点交给了父组件的工具栏按钮：内容先提交，但保留编辑态，
        // 随后 applyFormat / addLink 才能作用在当前块和选区上
        if (changed) emit(nextContent);
        return;
      }
      setEditing(null);
      hidePeek();
      if (changed) emit(nextContent);
      if (pending) {
        // 点了另一块：提交后按长度变化重新定位它，等焦点处理完再挂载 textarea
        scheduleOpenAt(nextContent, mapTargetStart(current, nextContent, pending.start));
      }
    };

    const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const current = editingRef.current;
      if (!current) return;
      if (event.key === "Escape") {
        // Esc：放弃本次编辑，恢复进入编辑前的整篇内容
        event.preventDefault();
        const restore = current.isNew ? current.frozenContent.trimEnd() : current.frozenContent;
        pendingOpenRef.current = null;
        pendingCommandRef.current = null;
        setEditing(null);
        hidePeek();
        if (restore !== content) emit(restore);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        insertTextInTextarea("  ");
        return;
      }
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        applyFormatInTextarea(BOLD_FORMAT);
      } else if (key === "i") {
        event.preventDefault();
        applyFormatInTextarea(ITALIC_FORMAT);
      } else if (key === "s") {
        // 自动保存由父组件负责，这里只吞掉浏览器默认的「保存网页」
        event.preventDefault();
      }
      // 不拦截 Cmd/Ctrl+Enter
    };

    const handleBlockClick = (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isInteractiveTarget(event.target)) return;
      if (editingRef.current) {
        pendingOpenRef.current = null; // 跨块切换已由 pointerdown + blur 处理，清掉可能残留的记录
        return;
      }
      if (openFrameRef.current) return; // 正在等下一帧切换到别的块
      const start = Number(event.currentTarget.dataset.start);
      const index = blocks.findIndex((item) => item.start === start);
      if (index >= 0) openBlock(blocks, index, content);
    };

    const handleBlockPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isInteractiveTarget(event.target)) return;
      const current = editingRef.current;
      if (!current) return; // 非编辑态交给 click 打开
      const start = Number(event.currentTarget.dataset.start);
      if (start === current.block.start) return; // 点在正在编辑的块上

      if (document.activeElement === textareaRef.current) {
        // textarea 还有焦点：浏览器紧接着会触发 blur，由 blur 流程提交后再打开
        pendingOpenRef.current = { start };
        return;
      }
      // 编辑器当前没有焦点（例如焦点停在工具栏按钮上）：直接提交并安排打开
      const nextContent = commitAndClose(current);
      scheduleOpenAt(nextContent, mapTargetStart(current, nextContent, start));
    };

    /** 点编辑区空白处（不在任何块上）：提交并退出编辑 */
    const handleDocPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".lp-block") || target.closest(INTERACTIVE_SELECTOR)) return;
      const current = editingRef.current;
      if (current) commitAndClose(current);
    };

    // ---- 副作用 ----

    useLayoutEffect(() => {
      const el = textareaRef.current;
      if (!editing || !el) return;
      // 自动增高：先归零再读 scrollHeight，删行后高度才能收回来
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
      if (!pendingFocusRef.current) return;
      pendingFocusRef.current = false;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      const command = pendingCommandRef.current;
      pendingCommandRef.current = null;
      if (!command) return;
      if (command.kind === "format") applyFormatInTextarea(command.format);
      else applyLinkInTextarea();
    }, [editing]);

    // 编辑期间忽略外部 content 变化（块列表已冻结）；但如果外部内容既不是自己刚发出的、
    // 也不是打开编辑时的那份（例如切换了笔记），说明这次编辑已失效，直接放弃，避免把旧内容写进新文档。
    useEffect(() => {
      const current = editingRef.current;
      if (!current) return;
      if (content === lastEmittedRef.current || content === current.frozenContent) return;
      pendingOpenRef.current = null;
      pendingCommandRef.current = null;
      setEditing(null);
    }, [content]);

    useEffect(() => () => cancelScheduledOpen(), []); // 卸载时取消尚未执行的「下一帧打开」

    useImperativeHandle(ref, () => ({
      focus() {
        if (editingRef.current) textareaRef.current?.focus();
        else openLastBlock();
      },
      applyFormat(format) {
        if (editingRef.current) {
          applyFormatInTextarea(format);
          return;
        }
        // 未在编辑：先打开最后一块，等 textarea 挂载后再把格式应用到块尾
        pendingCommandRef.current = { kind: "format", format };
        openLastBlock();
      },
      addLink() {
        if (editingRef.current) {
          applyLinkInTextarea();
          return;
        }
        pendingCommandRef.current = { kind: "link" };
        openLastBlock();
      },
      insertAtCursor(text) {
        if (editingRef.current) {
          insertTextInTextarea(text);
          return;
        }
        // 非编辑态：作为新段落追加到文末
        const piece = text.trim();
        if (!piece) return;
        const base = content.trimEnd();
        const next = base ? `${base}\n\n${piece}` : piece;
        if (next !== content) emit(next);
      },
      getSelection() {
        const el = textareaRef.current;
        if (!editingRef.current || !el) return "";
        return el.value.slice(el.selectionStart, el.selectionEnd);
      },
    }));

    return (
      <div className="lp-doc" onPointerDown={handleDocPointerDown}>
        <div className="lp-canvas">
          {visibleBlocks.map((block, index) => {
            const isEditing = editing !== null && editing.index === index;
            const showPeek =
              !isEditing && hoveredStart === block.start && block.raw.trim().length > 0;
            return (
              <div
                key={`${index}-${block.start}`}
                className={cn("lp-block", isEditing && "is-editing")}
                data-start={block.start}
                onMouseOver={onMouseOver}
                onMouseLeave={onMouseLeave}
                onPointerDown={handleBlockPointerDown}
                onClick={handleBlockClick}
              >
                {isEditing ? (
                  <textarea
                    ref={textareaRef}
                    className="lp-block-editor"
                    value={editing.value}
                    placeholder={placeholder}
                    spellCheck={false}
                    rows={1}
                    aria-label="编辑这一段"
                    onChange={handleEditorChange}
                    onBlur={handleBlur}
                    onKeyDown={handleEditorKeyDown}
                  />
                ) : (
                  <BlockBody raw={block.raw} />
                )}
                {showPeek ? <SourcePeek raw={block.raw} /> : null}
              </div>
            );
          })}

          {visibleBlocks.length === 0 ? (
            <div className="lp-empty">
              <p>这一页还是空白。直接输入 Markdown，松手就会变成排版好的样子。</p>
              <button type="button" className="lp-empty-start" onClick={openLastBlock}>
                开始写第一段
              </button>
            </div>
          ) : null}

          <button type="button" className="lp-add-block" onClick={startNewBlock}>
            ＋ 继续写
          </button>
        </div>
      </div>
    );
  },
);

/** 只读渲染：阅读模式用，同样支持悬停显示源码；空内容不渲染（空状态由调用方负责） */
export function MarkdownBlocks({ content }: { content: string }): ReactElement {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
  const { hoveredStart, onMouseOver, onMouseLeave } = useHoverPeek();

  if (!content.trim()) return <></>;

  return (
    <div className="lp-canvas lp-canvas-readonly">
      {blocks.map((block) => {
        const showPeek = hoveredStart === block.start && block.raw.trim().length > 0;
        return (
          <div
            key={`${block.start}-${block.end}`}
            className="lp-block"
            data-start={block.start}
            onMouseOver={onMouseOver}
            onMouseLeave={onMouseLeave}
          >
            <BlockBody raw={block.raw} />
            {showPeek ? <SourcePeek raw={block.raw} /> : null}
          </div>
        );
      })}
    </div>
  );
}
