import ReactMarkdown, { type Components } from "react-markdown";
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

export function Markdown({ content, className = "" }: { content: string; className?: string }) {
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
