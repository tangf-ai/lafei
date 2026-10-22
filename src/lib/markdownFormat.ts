/**
 * Markdown 格式操作的纯函数：编辑器（源码 / 即时预览）共用。
 *
 * 传入整段文本和选区，返回新文本与新选区，不碰 DOM。
 */

export interface FormatSpec {
  id: string;
  label: string;
  /** 成对包裹，例如 **加粗** */
  before?: string;
  /** 在行首插入，例如 "## " */
  prefix?: string;
  after?: string;
  placeholder?: string;
}

export interface FormatResult {
  text: string;
  start: number;
  end: number;
}

export function applyFormatSpec(
  value: string,
  start: number,
  end: number,
  format: FormatSpec,
): FormatResult {
  const selected = value.slice(start, end);

  if (format.prefix) {
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const next = `${value.slice(0, lineStart)}${format.prefix}${value.slice(lineStart)}`;
    return {
      text: next,
      start: start + format.prefix.length,
      end: end + format.prefix.length,
    };
  }

  const before = format.before ?? "";
  const after = format.after ?? "";
  const body = selected || format.placeholder || "";
  const next = `${value.slice(0, start)}${before}${body}${after}${value.slice(end)}`;
  const bodyStart = start + before.length;
  return {
    text: next,
    // 有选中：光标落到包裹语法的后面；没选中：选中占位文字，方便直接替换
    start: selected ? bodyStart + body.length + after.length : bodyStart,
    end: selected ? bodyStart + body.length + after.length : bodyStart + body.length,
  };
}

export function applyLinkSpec(value: string, start: number, end: number): FormatResult {
  const selected = value.slice(start, end) || "链接文字";
  const insertion = `[${selected}](https://)`;
  const next = value.slice(0, start) + insertion + value.slice(end);
  return {
    text: next,
    // 选中 https:// 这段，直接输入网址即可
    start: start + selected.length + 3,
    end: start + selected.length + 11,
  };
}
