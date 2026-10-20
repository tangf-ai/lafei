import type { AIProvider, AISettings, ChatSource, Note, Priority } from "../types";
import { noteTitle, stripMarkdown } from "./util";

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIProviderPreset {
  label: string;
  hint: string;
  baseUrl: string;
  model: string;
  models: string[];
}

export const AI_PRESETS: Record<AIProvider, AIProviderPreset> = {
  deepseek: {
    label: "DeepSeek",
    hint: "国内直连，性价比高",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  openai: {
    label: "OpenAI",
    hint: "GPT 系列模型",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  },
  custom: {
    label: "自定义 / 本地",
    hint: "任何 OpenAI 兼容接口",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    models: [],
  },
};

export const DEFAULT_AI: AISettings = {
  provider: "deepseek",
  baseUrl: AI_PRESETS.deepseek.baseUrl,
  apiKey: "",
  model: AI_PRESETS.deepseek.model,
};

export class AIError extends Error {
  code: string;
  constructor(message: string, code = "unknown") {
    super(message);
    this.name = "AIError";
    this.code = code;
  }
}

export function isLocalEndpoint(baseUrl: string) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.\d+\.\d+\.\d+/.test(baseUrl);
}

export function isAIConfigured(ai: AISettings) {
  if (!ai.baseUrl.trim() || !ai.model.trim()) return false;
  return Boolean(ai.apiKey.trim()) || isLocalEndpoint(ai.baseUrl);
}

export function resolveEndpoint(baseUrl: string) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return "";
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function assertConfigured(settings: AISettings) {
  if (!isAIConfigured(settings)) {
    throw new AIError("还没有配置 AI。填入 API Key 后，Lafei 的 AI 就可以工作了。", "not_configured");
  }
}

function friendlyHTTPError(status: number, detail: string) {
  const extra = detail ? `（${detail.slice(0, 160)}）` : "";
  if (status === 401 || status === 403) return new AIError(`API Key 似乎无效，或没有访问该模型的权限。${extra}`, "auth");
  if (status === 402) return new AIError(`账户余额不足，请到服务商后台充值后再试。${extra}`, "billing");
  if (status === 404) return new AIError(`找不到接口或模型，请检查 Base URL 和模型名称。${extra}`, "not_found");
  if (status === 429) return new AIError("请求太频繁或额度用完了，稍等一会儿再试。", "rate_limit");
  if (status >= 500) return new AIError(`AI 服务暂时不可用，请稍后重试。${extra}`, "server");
  return new AIError(`AI 请求失败（${status}）${extra}`, "http");
}

async function requestError(response: Response): Promise<AIError> {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      detail = data?.error?.message || data?.message || text;
    } catch {
      detail = text;
    }
  } catch {
    // ignore
  }
  return friendlyHTTPError(response.status, String(detail || ""));
}

interface StreamOptions {
  settings: AISettings;
  messages: AIMessage[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  onDelta: (delta: string) => void;
}

export async function streamChat({
  settings,
  messages,
  signal,
  temperature = 0.7,
  maxTokens = 1600,
  onDelta,
}: StreamOptions): Promise<string> {
  assertConfigured(settings);
  const endpoint = resolveEndpoint(settings.baseUrl);
  if (!endpoint) throw new AIError("请填写 AI 接口地址。", "not_configured");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: settings.model.trim(),
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new AIError(
      "连接不上 AI 服务。请检查网络、Base URL，以及该服务是否允许浏览器跨域访问。",
      "network",
    );
  }

  if (!response.ok) throw await requestError(response);
  if (!response.body) throw new AIError("AI 服务没有返回内容。", "empty");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      if (parsed?.error) {
        throw new AIError(parsed.error.message || "AI 返回了一个错误。", "server");
      }
      const delta =
        parsed?.choices?.[0]?.delta?.content ??
        parsed?.choices?.[0]?.message?.content ??
        "";
      if (typeof delta === "string" && delta) {
        full += delta;
        onDelta(delta);
      }
    } catch (error) {
      if (error instanceof AIError) throw error;
      // Ignore malformed keep-alive/partial chunks.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    if (buffer) handleLine(buffer);
  } finally {
    reader.releaseLock();
  }

  if (!full.trim()) throw new AIError("AI 没有返回文字，请换一个模型或稍后再试。", "empty");
  return full;
}

interface CompleteOptions {
  settings: AISettings;
  messages: AIMessage[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export async function completeChat({
  settings,
  messages,
  signal,
  temperature = 0.4,
  maxTokens = 1600,
}: CompleteOptions): Promise<string> {
  assertConfigured(settings);
  const endpoint = resolveEndpoint(settings.baseUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: settings.model.trim(),
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new AIError(
      "连接不上 AI 服务。请检查网络、Base URL，以及该服务是否允许浏览器跨域访问。",
      "network",
    );
  }

  if (!response.ok) throw await requestError(response);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AIError("AI 返回了无法解析的内容。", "parse");
  }
  const content = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new AIError("AI 没有返回文字，请换一个模型或稍后再试。", "empty");
  return content;
}

export async function testAIConnection(settings: AISettings): Promise<string> {
  const reply = await completeChat({
    settings,
    messages: [
      { role: "system", content: "你是一个连接测试助手。" },
      { role: "user", content: "请只回复：连接成功" },
    ],
    maxTokens: 20,
    temperature: 0,
  });
  return reply.trim().slice(0, 40);
}

const BASE_PERSONA = `你是 Lafei 的内置 AI，一位安静、可靠、有见识的中文思考伙伴。
你的任务是帮助用户整理知识、想清楚问题、推进下一步。
要求：
- 直接、具体、自然，不说客套话，不堆砌空洞的列表。
- 当信息不足时，明确说出你的假设或追问一个最关键的问题。
- 如果提供了用户笔记，只基于笔记内容作答；引用时用 [[笔记标题]] 标注来源，不要编造笔记中不存在的内容。
- 使用简体中文。除非用户要求，避免过度使用加粗和标题。`;

export function notePrompt(note: Note) {
  return `笔记标题：${noteTitle(note.title)}
标签：${note.tags.length ? note.tags.join("、") : "无"}
正文：
"""
${note.content.slice(0, 12000)}
"""`;
}

export const NOTE_ACTIONS = [
  {
    id: "summarize",
    label: "总结这篇",
    icon: "sparkles",
    prompt: `请总结下面这篇笔记。先用一句话说清核心，再给出 3 个要点；如果笔记里有明确的下一步，最后用一句话点出来。不要重复原文，不要写“这篇笔记讲了”。\n\n${"{{note}}"}`,
  },
  {
    id: "extract",
    label: "提取待办",
    icon: "listChecks",
    prompt: "",
  },
  {
    id: "continue",
    label: "接着写",
    icon: "penLine",
    prompt: `请顺着下面这篇笔记的思路继续写 150—250 字。延续原有语气，推进一个具体的想法，不要重复已有内容，不要加标题，不要解释你在做什么。只输出续写的正文。\n\n${"{{note}}"}`,
  },
  {
    id: "title",
    label: "起个标题",
    icon: "heading",
    prompt: `根据下面的笔记内容，给出 5 个简洁、有吸引力的中文标题。每个标题不超过 16 个字，一行一个，不要编号，不要解释。\n\n${"{{note}}"}`,
  },
] as const;

export type NoteActionId = (typeof NOTE_ACTIONS)[number]["id"];

export function buildNoteActionPrompt(action: NoteActionId, note: Note) {
  const item = NOTE_ACTIONS.find((a) => a.id === action);
  return item && "prompt" in item ? item.prompt.replace("{{note}}", notePrompt(note)) : "";
}

export const EXTRACT_PROMPT = `从用户的笔记中提取明确的、可执行的待办事项。只提取笔记中真实存在或明显隐含的下一步，不要凭空发明。

只返回一个 JSON 数组，不要包含 Markdown 代码块或任何解释。每个对象字段：
- "title": 简洁的行动描述，不超过 30 个字，以动词开头
- "dueDate": YYYY-MM-DD，或 null（笔记里没有明确日期时）
- "priority": "high" | "medium" | "low"

如果没有可执行的待办，返回 []。今天是 ${new Date().toLocaleDateString("zh-CN")}。`;

export interface ExtractedTask {
  title: string;
  dueDate: string | null;
  priority: Priority;
}

export function parseExtractedTasks(raw: string): ExtractedTask[] {
  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): ExtractedTask | null => {
        if (!item || typeof item.title !== "string" || !item.title.trim()) return null;
        const priority: Priority = ["high", "medium", "low"].includes(item.priority) ? item.priority : "medium";
        const due = typeof item.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) ? item.dueDate : null;
        return { title: item.title.trim().slice(0, 80), dueDate: due, priority };
      })
      .filter((item): item is ExtractedTask => Boolean(item))
      .slice(0, 12);
  } catch {
    return [];
  }
}

export function localChecklistTasks(content: string): ExtractedTask[] {
  return Array.from(content.matchAll(/^\s*[-*]\s+\[ \]\s+(.+)$/gm))
    .map((match) => ({
      title: match[1].replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1").trim().slice(0, 80),
      dueDate: null,
      priority: "medium" as Priority,
    }))
    .filter((task) => task.title)
    .slice(0, 12);
}

interface RetrievedContext {
  context: string;
  sources: ChatSource[];
}

const STOP_BIGRAMS = new Set([
  "我的", "你的", "什么", "怎么", "可以", "帮我", "一下", "这篇", "这个", "那个",
  "如何", "为什", "么样", "一个", "一些", "我们", "你们", "他们", "的话", "就是",
  "还是", "但是", "然后", "现在", "今天", "感觉",
]);

function queryTerms(query: string) {
  const chunks = query
    .toLowerCase()
    .split(/[\s,，。？?！!、；;：:"“”'‘’（）()《》<>【】\[\]]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
  const terms = new Set<string>();
  for (const chunk of chunks) {
    terms.add(chunk);
    const chinese = chunk.match(/[\u3400-\u9fff]+/g) ?? [];
    for (const run of chinese) {
      for (let i = 0; i < run.length - 1; i += 1) {
        const bigram = run.slice(i, i + 2);
        if (!STOP_BIGRAMS.has(bigram)) terms.add(bigram);
      }
    }
    for (const word of chunk.match(/[a-z0-9_-]{3,}/g) ?? []) terms.add(word);
  }
  return [...terms].slice(0, 24);
}

export function retrieveNoteContext(notes: Note[], query: string, limit = 3): RetrievedContext {
  const terms = queryTerms(query);
  if (!terms.length) return { context: "", sources: [] };

  const scored = notes
    .map((note) => {
      const title = note.title.toLowerCase();
      const body = note.content.toLowerCase();
      const tags = note.tags.join(" ").toLowerCase();
      let relevance = 0;
      for (const term of terms) {
        const inTitle = title.split(term).length - 1;
        const inTags = tags.split(term).length - 1;
        const inBody = body.split(term).length - 1;
        relevance += inTitle * 40 + inTags * 18 + Math.min(6, inBody) * 4;
      }
      const freshness = Math.max(0, 3 - (Date.now() - note.updatedAt) / (1000 * 60 * 60 * 24 * 10));
      return { note, relevance, score: relevance + freshness + (note.pinned ? 1 : 0) };
    })
    .filter(({ relevance }) => relevance > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ note }) => note);

  if (!scored.length) return { context: "", sources: [] };

  const context = scored
    .map((note, index) => {
      const body = stripMarkdown(note.content).slice(0, 1500);
      return `[笔记 ${index + 1}] 《${noteTitle(note.title)}》\n标签：${note.tags.join("、") || "无"}\n内容：${body}`;
    })
    .join("\n\n");

  return {
    context,
    sources: scored.map((note) => ({ id: note.id, title: noteTitle(note.title) })),
  };
}

export function buildChatMessages(
  history: AIMessage[],
  question: string,
  context: RetrievedContext | null,
): AIMessage[] {
  const contextBlock =
    context && context.context
      ? `以下是从用户笔记中检索到的相关内容，回答时可以参考。不要透露“检索”这一过程，直接用即可：\n\n${context.context}`
      : "";
  return [
    { role: "system", content: `${BASE_PERSONA}\n\n${contextBlock}` },
    ...history.slice(-16),
    { role: "user", content: question },
  ];
}
