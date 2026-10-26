/**
 * 笔记大纲：从 Markdown 原文提取 ATX 标题。
 *
 * 这里只做「文本层面」的识别，行号与 react-markdown 解析出的
 * heading node.position.start.line 严格一致（1 基），这样阅读模式才能用
 * `md-h-<line>` 精确跳转，即时预览也能用 line 定位编辑器行。
 */

export interface OutlineItem {
  level: number;
  text: string;
  line: number;
  index: number;
}

/** 最多 3 个空格缩进 + 1~6 个 # + 至少一个空白。 */
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
/** 围栏代码块（``` / ~~~），允许 0~3 个空格缩进与 info string。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 去掉标题里的 Markdown 记号，保留可读文字。
 * 规则：闭合 #、图片/链接/wiki、行内代码、粗斜/删除线、HTML 标签。
 */
function cleanHeadingText(raw: string): string {
  let text = raw.trim();
  // ATX 闭合序列：`## 标题 ##` → `标题`（整行只有 # 时标题为空）
  text = text.replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();

  // 行内代码先占位，避免代码里的 **、<div> 等被后续规则误删
  const codes: string[] = [];
  text = text.replace(/`([^`]*)`/g, (_match, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // 自动链接 <https://…> 保留文字，不当作 HTML 标签
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, "$1");
  // 图片先于链接处理，避免把 ![](src) 变成 `!alt`
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, label?: string) => (label ?? target).trim(),
  );
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // 还原行内代码文字
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? "");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 提取大纲。跳过围栏代码块内部（含 info string 的开围栏行也算围栏行），
 * `line` 为 1 基行号，`index` 为 0 基大纲序号。
 */
export function extractOutline(content: string): OutlineItem[] {
  const outline: OutlineItem[] = [];
  if (!content) return outline;

  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  let fence: { marker: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);

    if (fence) {
      // 收尾围栏必须同字符、长度不小于开头，且后面不能再有 info string
      const closes =
        fenceMatch !== null &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === "";
      if (closes) fence = null;
      continue;
    }

    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (!headingMatch) continue;

    const text = cleanHeadingText(headingMatch[2]);
    if (!text) continue;

    outline.push({
      level: headingMatch[1].length,
      text,
      line: i + 1,
      index: outline.length,
    });
  }

  return outline;
}
