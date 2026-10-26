import { Markdown } from "../lib/markdown";
import "./markdownReader.css";

/**
 * 阅读模式：把笔记正文按「像 Typora 一样干净」的排版渲染出来。
 * 标题会带上 id="md-h-<行号>"，与 lib/outline.ts 的 OutlineItem.line 一一对应。
 */
export function MarkdownReader({ content, className }: { content: string; className?: string }) {
  return (
    <div className={"md-reader " + (className ?? "")}>
      <Markdown content={content} reading />
    </div>
  );
}
