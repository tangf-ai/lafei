import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openExternal } from "./external";
import { useUI, toast } from "../store/ui";
import { createNote, db } from "../db";
import { noteTitle } from "./util";

type MarkdownNode = {
  type?: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

function splitTextNode(node: MarkdownNode, nodes: MarkdownNode[]) {
  if (node.type !== "text" || !node.value || !node.value.includes("[[")) {
    nodes.push(node);
    return;
  }
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(node.value))) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", value: node.value.slice(lastIndex, match.index) });
    }
    const target = match[1].trim();
    const label = (match[2] || match[1]).trim();
    nodes.push({
      type: "link",
      url: `wiki:${encodeURIComponent(target)}`,
      children: [{ type: "text", value: label }],
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < node.value.length) {
    nodes.push({ type: "text", value: node.value.slice(lastIndex) });
  }
}

function transformChildren(children: MarkdownNode[]): MarkdownNode[] {
  const output: MarkdownNode[] = [];
  for (const child of children) {
    if (child.type === "text") {
      splitTextNode(child, output);
      continue;
    }
    if (child.children && child.type !== "code" && child.type !== "inlineCode") {
      child.children = transformChildren(child.children);
    }
    output.push(child);
  }
  return output;
}

function remarkWikiLinks() {
  return (tree: MarkdownNode) => {
    if (tree.children) tree.children = transformChildren(tree.children);
  };
}

/* --------------------------------------------------------------------------
   阅读模式（reading）
   - h1~h6 输出 id="md-h-<1 基行号>"，与 lib/outline.ts 的 line 对齐
   - 代码块包一层带「复制」按钮的容器
   默认 reading=false 时完全不启用，既有调用方渲染结果不变。
   -------------------------------------------------------------------------- */

type HeadingProps = ComponentPropsWithoutRef<"h1"> & ExtraProps;

function readingHeadingId(node: ExtraProps["node"]): string | undefined {
  const line = node?.position?.start?.line;
  return typeof line === "number" ? `md-h-${line}` : undefined;
}

function ReadingH1({ node, children, ...rest }: HeadingProps) {
  return (
    <h1 {...rest} id={readingHeadingId(node)}>
      {children}
    </h1>
  );
}

function ReadingH2({ node, children, ...rest }: HeadingProps) {
  return (
    <h2 {...rest} id={readingHeadingId(node)}>
      {children}
    </h2>
  );
}

function ReadingH3({ node, children, ...rest }: HeadingProps) {
  return (
    <h3 {...rest} id={readingHeadingId(node)}>
      {children}
    </h3>
  );
}

function ReadingH4({ node, children, ...rest }: HeadingProps) {
  return (
    <h4 {...rest} id={readingHeadingId(node)}>
      {children}
    </h4>
  );
}

function ReadingH5({ node, children, ...rest }: HeadingProps) {
  return (
    <h5 {...rest} id={readingHeadingId(node)}>
      {children}
    </h5>
  );
}

function ReadingH6({ node, children, ...rest }: HeadingProps) {
  return (
    <h6 {...rest} id={readingHeadingId(node)}>
      {children}
    </h6>
  );
}

async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 剪贴板 API 被限制时走兜底
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function ReadingCodeBlock({ node, children, ...rest }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  // node 只用于类型契约；纯文本从真实 DOM 读取，天然包含 highlight 后的文字
  void node;
  const preRef = useRef<HTMLPreElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const text = (preRef.current?.textContent ?? "").replace(/\n$/, "");
    if (!text) return;
    void copyPlainText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="md-code-block">
      <pre {...rest} ref={preRef}>
        {children}
      </pre>
      <button
        type="button"
        className="md-code-copy"
        data-copied={copied ? "true" : undefined}
        title={copied ? "已复制" : "复制代码"}
        aria-label="复制代码"
        onClick={handleCopy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

const readingComponents: Pick<Components, "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "pre"> = {
  h1: ReadingH1,
  h2: ReadingH2,
  h3: ReadingH3,
  h4: ReadingH4,
  h5: ReadingH5,
  h6: ReadingH6,
  pre: ReadingCodeBlock,
};

export function Markdown({
  content,
  className = "",
  reading = false,
}: {
  content: string;
  className?: string;
  reading?: boolean;
}) {
  const openNote = useUI((state) => state.openNote);

  const handleWiki = async (target: string) => {
    const notes = await db.notes.toArray();
    const existing = notes.find((note) => note.title.trim().toLowerCase() === target.trim().toLowerCase());
    if (existing) {
      openNote(existing.id);
      return;
    }
    const created = await createNote({ title: target });
    toast(`已创建「${noteTitle(created.title)}」`, "success");
    openNote(created.id);
  };

  const components: Components = {
    a({ href, children, ...props }) {
      if (href?.startsWith("wiki:")) {
        const target = decodeURIComponent(href.slice(5));
        return (
          <button
            type="button"
            className="wiki-link"
            title={`打开或创建「${target}」`}
            onClick={() => void handleWiki(target)}
          >
            {children}
          </button>
        );
      }
      return (
        <a
          href={href}
          {...props}
          onClick={(event) => {
            if (href && /^https?:\/\//.test(href)) {
              event.preventDefault();
              void openExternal(href);
            }
          }}
          target="_blank"
          rel="noreferrer"
        >
          {children}
        </a>
      );
    },
    input({ checked, ...props }) {
      return <input type="checkbox" checked={Boolean(checked)} readOnly {...props} />;
    },
    img({ src, alt }) {
      return <img src={src} alt={alt ?? ""} loading="lazy" />;
    },
    ...(reading ? readingComponents : {}),
  };

  return (
    <div className={`prose ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikiLinks]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
        urlTransform={(url) => {
          if (url.startsWith("wiki:")) return url;
          if (/^(https?:|mailto:|tel:|#|\.{0,2}\/)/i.test(url)) return url;
          return "";
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
