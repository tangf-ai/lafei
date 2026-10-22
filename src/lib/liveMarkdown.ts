/**
 * 即时预览编辑器的「块」工具。
 *
 * 把整篇 Markdown 按「空行」切成块，供逐块渲染、逐块就地编辑使用。
 * 围栏代码块（``` / ~~~）内部的空行不算分块边界；其余位置空行（含只有空白字符的行）都算。
 * 这里只做纯文本计算，不访问 DOM。
 *
 * 约定：
 * - 每个块只包含自己的内容，不含与相邻块之间的空行；
 * - block.raw === content.slice(block.start, block.end)（块内部换行、缩进原样保留）；
 * - 偏移量只对「切出这些块的那份 content」有效，内容一旦变化必须重新切分。
 */

export interface MarkdownBlock {
  /** 这一块的原始 Markdown（不含块与块之间的空行） */
  raw: string;
  /** raw 在整篇 content 中的起止偏移，raw === content.slice(start, end) */
  start: number;
  end: number;
}

interface SourceLine {
  /** 行首在 content 中的偏移 */
  start: number;
  /** 行尾（不含换行符）在 content 中的偏移 */
  end: number;
  /** 行文本（不含换行符） */
  text: string;
}

/** 开头围栏：最多 3 个前导空格，3 个以上 ` 或 ~，后面允许带 info string（[^\n] 兼容 CRLF 的 \r） */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[^\n]*$/;
/** 结尾围栏：最多 3 个前导空格，与开头相同的字符，长度不小于开头，行尾只允许空白（兼容 CRLF 的 \r） */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/;

/**
 * 手动扫描每一行并记录精确偏移。
 * 不能用 content.split("\n")：那样拿不到每行在原文中的位置。
 */
function scanLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = 0;
  while (cursor <= content.length) {
    const breakAt = content.indexOf("\n", cursor);
    const end = breakAt === -1 ? content.length : breakAt;
    lines.push({ start: cursor, end, text: content.slice(cursor, end) });
    if (breakAt === -1) break;
    cursor = breakAt + 1;
  }
  return lines;
}

/** 空行：空字符串或只含空白字符 */
function isBlankLine(text: string): boolean {
  return text.trim() === "";
}

/** 判断一行是否是围栏代码块的开头，返回围栏字符与长度 */
function matchFenceOpen(text: string): { char: string; length: number } | null {
  const match = FENCE_OPEN.exec(text);
  if (!match) return null;
  return { char: match[1][0], length: match[1].length };
}

/** 判断一行能否关闭当前围栏代码块：同字符、长度不小于开头 */
function isFenceClose(text: string, char: string, length: number): boolean {
  const match = FENCE_CLOSE.exec(text);
  if (!match) return false;
  return match[1][0] === char && match[1].length >= length;
}

/**
 * 把整篇 Markdown 切成块。
 * - 空白内容一律返回 []；
 * - 围栏代码块（含其中的空行）整体算一个块；
 * - 每块 raw 不含两侧空行，内部内容（缩进、空行、代码）原样保留。
 */
export function splitMarkdownBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  /** 当前块起点；null 表示当前在块之间的空行里 */
  let blockStart: number | null = null;
  /** 当前块最后一个非空行（或代码块内任意行）的行尾偏移 */
  let blockEnd = 0;
  /** 正在围栏代码块内时的围栏信息 */
  let fence: { char: string; length: number } | null = null;

  for (const line of scanLines(content)) {
    if (fence) {
      // 代码块内部：空行也属于这一块，只有匹配的结尾围栏才结束
      blockEnd = line.end;
      if (isFenceClose(line.text, fence.char, fence.length)) fence = null;
      continue;
    }

    if (isBlankLine(line.text)) {
      // 块之间的空行：结束当前块（块尾取最后一个非空行，不包含空行）
      if (blockStart !== null) {
        blocks.push({ raw: content.slice(blockStart, blockEnd), start: blockStart, end: blockEnd });
        blockStart = null;
      }
      continue;
    }

    if (blockStart === null) blockStart = line.start;
    blockEnd = line.end;

    const open = matchFenceOpen(line.text);
    if (open) fence = open;
  }

  if (blockStart !== null) {
    blocks.push({ raw: content.slice(blockStart, blockEnd), start: blockStart, end: blockEnd });
  }
  return blocks;
}

/**
 * 用新的 raw 替换某个块，返回整篇新内容。
 *
 * 注意：block 的偏移只对切出它的那份 content 有效（start / end 是绝对值）。
 * 内容替换后必须重新 splitMarkdownBlocks 才能继续拿到有效偏移。
 */
export function replaceMarkdownBlock(content: string, block: MarkdownBlock, raw: string): string {
  return content.slice(0, block.start) + raw + content.slice(block.end);
}
