import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  FileJson,
  FileText,
  Info,
  Layers,
  Leaf,
  Loader2,
  LockKeyhole,
  Monitor,
  Moon,
  Palette,
  ShieldCheck,
  Sparkles,
  Sun,
  SunMedium,
  Trash2,
  Upload,
  Waves,
  X,
} from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { AI_PRESETS, AIError, isAIConfigured, testAIConnection } from "../lib/ai";
import { useUI, toast } from "../store/ui";
import { cn } from "../lib/util";
import type { AIProvider, BackupData, NoteMode, ThemeMode } from "../types";
import { tagsOf } from "../lib/tags";
import { db } from "../db";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { openExternal } from "../lib/external";
import { isTauri } from "../lib/util";
import { FolderStorageSettings } from "../features/FolderStorageSettings";
import { AgentAccessSettings } from "../features/AgentAccessSettings";
import { FONT_SCALES } from "../lib/fontScale";
import { LogseqImport } from "../features/LogseqImport";
import { mirrorAllToFolder } from "../lib/folderSync";

type SettingsTab = "ai" | "appearance" | "data" | "agent" | "about";

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Cpu; caption: string }> = [
  { id: "ai", label: "AI 模型", icon: Cpu, caption: "接入你的模型" },
  { id: "appearance", label: "外观与写作", icon: Palette, caption: "调整阅读与编辑" },
  { id: "data", label: "数据与备份", icon: Database, caption: "随时带走你的内容" },
  { id: "agent", label: "智能体访问", icon: Bot, caption: "让 Codex / Pi 读取" },
  { id: "about", label: "关于 Lafei", icon: Info, caption: "版本与快捷键" },
];

const PROVIDERS: Array<{ id: AIProvider; label: string; note: string }> = [
  { id: "deepseek", label: "DeepSeek", note: "国内直连" },
  { id: "openai", label: "OpenAI", note: "GPT 系列" },
  { id: "custom", label: "自定义 / 本地", note: "OpenAI 兼容" },
];

const THEMES: Array<{ id: ThemeMode; label: string; icon: typeof Sun; caption: string }> = [
  { id: "light", label: "浅色", icon: Sun, caption: "温暖的纸感" },
  { id: "dark", label: "深色", icon: Moon, caption: "夜晚的墨色" },
  { id: "system", label: "跟随系统", icon: Monitor, caption: "随环境切换" },
  { id: "sunny", label: "晴日", icon: SunMedium, caption: "明亮有活力" },
  { id: "mint", label: "薄荷", icon: Leaf, caption: "柔和护眼" },
  { id: "sea", label: "海盐", icon: Waves, caption: "清透放松" },
];

const EDITOR_MODES: Array<{ id: NoteMode; label: string; caption: string }> = [
  { id: "live", label: "即时预览", caption: "输入即渲染，悬停看源码" },
  { id: "source", label: "纯源码", caption: "只看见正在写的字" },
  { id: "split", label: "分栏", caption: "左边写，右边看" },
  { id: "read", label: "阅读", caption: "沉浸阅读渲染结果" },
];

export function SettingsView() {
  const open = useUI((state) => state.settingsOpen);
  const setOpen = useUI((state) => state.setSettingsOpen);
  const ai = useUI((state) => state.ai);
  const patchAI = useUI((state) => state.patchAI);
  const theme = useUI((state) => state.theme);
  const setTheme = useUI((state) => state.setTheme);
  const fontScale = useUI((state) => state.fontScale);
  const setFontScale = useUI((state) => state.setFontScale);
  const noteMode = useUI((state) => state.noteMode);
  const setNoteMode = useUI((state) => state.setNoteMode);
  const closeNote = useUI((state) => state.closeNote);
  const setView = useUI((state) => state.setView);
  const folderRoot = useUI((state) => state.folderRoot);
  const activeFolderRoot = isTauri ? folderRoot : null;

  const [tab, setTab] = useState<SettingsTab>("ai");
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [confirm, setConfirm] = useState<"import" | "clear" | null>(null);
  const [pendingImport, setPendingImport] = useState<BackupData | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const notesCount = useLiveQuery(() => db.notes.count(), [], 0);
  const tasksCount = useLiveQuery(() => db.tasks.count(), [], 0);
  const chatsCount = useLiveQuery(() => db.chats.count(), [], 0);

  useEffect(() => {
    if (!open) return;
    if (!isAIConfigured(ai)) setTab("ai");
  }, [open]);

  useEffect(() => {
    setTestState("idle");
    setTestMessage("");
  }, [ai.provider, ai.baseUrl, ai.model, ai.apiKey]);

  if (!open) return null;

  const currentTab = TABS.find((item) => item.id === tab)!;
  const configured = isAIConfigured(ai);

  const chooseProvider = (provider: AIProvider) => {
    const preset = AI_PRESETS[provider];
    patchAI({ provider, baseUrl: preset.baseUrl, model: preset.model });
  };

  const testConnection = async () => {
    if (!configured || testState === "testing") return;
    setTestState("testing");
    setTestMessage("正在连接模型…");
    try {
      const reply = await testAIConnection(ai);
      setTestState("success");
      setTestMessage(`连接成功，模型回复：${reply || "OK"}`);
    } catch (error) {
      setTestState("error");
      setTestMessage(error instanceof AIError ? error.message : "连接失败，请检查接口地址与 Key。");
    }
  };

  const exportBackup = async () => {
    const data: BackupData = {
      app: "lafei",
      version: 1,
      exportedAt: new Date().toISOString(),
      notes: await db.notes.toArray(),
      tasks: await db.tasks.toArray(),
      chats: await db.chats.toArray(),
      messages: await db.messages.toArray(),
      tombstones: await db.tombstones.toArray(),
    };
    try {
      const saved = await downloadFile(
        JSON.stringify(data, null, 2),
        `lafei-backup-${new Date().toISOString().slice(0, 10)}.json`,
        "application/json",
      );
      if (saved) toast("备份已导出", "success");
    } catch {
      toast("备份导出失败，请检查磁盘权限后重试", "error");
    }
  };

  const exportMarkdown = async () => {
    const notes = await db.notes.toArray();
    const tasks = await db.tasks.toArray();
    const parts: string[] = [
      `# Lafei 导出\n\n> 导出于 ${new Date().toLocaleString("zh-CN")}\n`,
      "## 笔记\n",
    ];
    for (const note of notes.sort((a, b) => a.createdAt - b.createdAt)) {
      parts.push(`### ${note.title.trim() || "无标题笔记"}`);
      if (note.tags.length) parts.push(note.tags.map((tag) => `#${tag}`).join(" "));
      parts.push(`\n${note.content.trim() || "（空白）"}\n`);
      parts.push(`*创建于 ${new Date(note.createdAt).toLocaleDateString("zh-CN")}*\n\n---\n`);
    }
    parts.push("## 任务\n");
    for (const task of tasks) {
      const done = task.done ? "x" : " ";
      const due = task.dueDate ? ` · 截止 ${task.dueDate}` : "";
      const taskTags = tagsOf(task);
      const tags = taskTags.length ? ` · ${taskTags.map((tag) => `#${tag}`).join(" ")}` : "";
      parts.push(`- [${done}] ${task.title}${due}${tags}`);
    }
    try {
      const saved = await downloadFile(
        parts.join("\n"),
        `lafei-notes-${new Date().toISOString().slice(0, 10)}.md`,
        "text/markdown",
      );
      if (saved) toast("Markdown 副本已导出", "success");
    } catch {
      toast("导出失败，请检查磁盘权限后重试", "error");
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as BackupData;
      if (
        !parsed ||
        parsed.app !== "lafei" ||
        !Array.isArray(parsed.notes) ||
        !Array.isArray(parsed.tasks)
      ) {
        throw new Error("invalid");
      }
      const normalizeTags = <T extends { tags?: unknown }>(items: T[]): T[] =>
        items.map((item) => ({
          ...item,
          tags: Array.isArray(item.tags)
            ? item.tags.filter((tag): tag is string => typeof tag === "string")
            : [],
        }));
      const data: BackupData = {
        ...parsed,
        notes: normalizeTags(parsed.notes),
        tasks: normalizeTags(parsed.tasks),
        chats: Array.isArray(parsed.chats) ? parsed.chats : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
      };
      setPendingImport(data);
      setConfirm("import");
    } catch {
      toast("无法识别这个备份文件，请选择 Lafei 导出的 JSON", "error");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const runImport = async () => {
    if (!pendingImport) return;
    setImporting(true);
    try {
      await db.transaction("rw", db.notes, db.tasks, db.chats, db.messages, db.tombstones, async () => {
        await db.notes.clear();
        await db.tasks.clear();
        await db.chats.clear();
        await db.messages.clear();
        await db.tombstones.clear();
        await db.notes.bulkAdd(pendingImport.notes);
        await db.tasks.bulkAdd(pendingImport.tasks);
        await db.chats.bulkAdd(pendingImport.chats);
        await db.messages.bulkAdd(pendingImport.messages);
        if (pendingImport.tombstones?.length) await db.tombstones.bulkAdd(pendingImport.tombstones);
      });
      localStorage.setItem("lafei:seeded:v1", "1");
      if (activeFolderRoot) {
        try {
          await mirrorAllToFolder();
        } catch {
          toast("本地数据已恢复，但文件夹同步失败；重新打开后可在设置中重试", "error");
        }
      }
      toast("数据已恢复，即将重新载入…", "success");
      window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      setImporting(false);
      toast("导入失败，原有数据未被替换", "error");
    } finally {
      setPendingImport(null);
    }
  };

  const clearAll = async () => {
    await db.transaction("rw", db.notes, db.tasks, db.chats, db.messages, db.tombstones, async () => {
      await db.notes.clear();
      await db.tasks.clear();
      await db.chats.clear();
      await db.messages.clear();
      await db.tombstones.clear();
    });
    localStorage.setItem("lafei:seeded:v1", "1");
    if (activeFolderRoot) {
      try {
        await mirrorAllToFolder();
      } catch {
        toast("本机数据已清空，但文件夹清理失败，请手动检查同步目录", "error");
      }
    }
    closeNote();
    setView("today");
    setOpen(false);
    toast("所有数据已清空");
  };

  return (
    <>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        headless
        size="xl"
        className="settings-modal"
        focusOnOpen={false}
      >
        <div className="settings-shell">
          <aside className="settings-nav">
            <div className="settings-brand">
              <div className="brand-mark">
                <span>l</span>
              </div>
              <div>
                <strong>设置</strong>
                <span>lafei · v0.12</span>
              </div>
            </div>
            <div className="settings-nav-items">
              {TABS.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={cn("settings-nav-item", tab === item.id && "active")}
                    onClick={() => setTab(item.id)}
                  >
                    <Icon size={16} />
                    <span>{item.label}</span>
                    <ChevronRight size={13} className="settings-nav-arrow" />
                  </button>
                );
              })}
            </div>
            <div className="settings-nav-foot">
              <div className="settings-local">
                <ShieldCheck size={14} />
                <div>
                  <strong>本地优先</strong>
                  <span>默认不把内容传到云端</span>
                </div>
              </div>
            </div>
          </aside>

          <div className="settings-main">
            <header className="settings-head">
              <div>
                <span className="eyebrow">{currentTab.caption}</span>
                <h2 className="display">{currentTab.label}</h2>
              </div>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="关闭设置">
                <X size={19} />
              </button>
            </header>

            <div className="settings-content">
              {tab === "ai" && (
                <div className="settings-section">
                  <div className="settings-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>模型服务</h3>
                        <p>选择服务商，或接入任何兼容 OpenAI 协议的接口。</p>
                      </div>
                      <span className={cn("status-badge", configured ? "is-ok" : "is-off")}>
                        <span className="status-dot" />
                        {configured ? "已配置" : "待配置"}
                      </span>
                    </div>
                    <div className="provider-grid">
                      {PROVIDERS.map((provider) => (
                        <button
                          key={provider.id}
                          type="button"
                          className={cn("provider-card", ai.provider === provider.id && "active")}
                          onClick={() => chooseProvider(provider.id)}
                        >
                          <span className="provider-icon">
                            {provider.id === "deepseek" ? (
                              <Sparkles size={16} />
                            ) : provider.id === "openai" ? (
                              <Bot size={16} />
                            ) : (
                              <Cpu size={16} />
                            )}
                          </span>
                          <strong>{provider.label}</strong>
                          <span>{provider.note}</span>
                          {ai.provider === provider.id && (
                            <span className="provider-check">
                              <Check size={11} />
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="settings-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>连接信息</h3>
                        <p>这些信息只保存在当前设备，不会经过 Lafei 的服务器。</p>
                      </div>
                    </div>

                    <div className="form-field">
                      <div className="form-label-row">
                        <label className="field-label" htmlFor="api-key">
                          API Key
                        </label>
                        <button
                          type="button"
                          className="form-link"
                          onClick={() => {
                            const url =
                              ai.provider === "deepseek"
                                ? "https://platform.deepseek.com/api_keys"
                                : ai.provider === "openai"
                                  ? "https://platform.openai.com/api-keys"
                                  : "";
                            if (url) void openExternal(url);
                          }}
                          disabled={ai.provider === "custom"}
                        >
                          {ai.provider === "deepseek"
                            ? "获取 DeepSeek Key ↗"
                            : ai.provider === "openai"
                              ? "获取 OpenAI Key ↗"
                              : "本地模型可留空"}
                        </button>
                      </div>
                      <div className="password-field">
                        <LockKeyhole size={15} />
                        <input
                          id="api-key"
                          className="input"
                          type={showKey ? "text" : "password"}
                          value={ai.apiKey}
                          onChange={(event) => patchAI({ apiKey: event.target.value })}
                          placeholder={ai.provider === "custom" ? "本地服务可留空" : "sk-…"}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="password-toggle"
                          onClick={() => setShowKey((value) => !value)}
                          aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                        >
                          {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                    </div>

                    <div className="form-row">
                      <div className="form-field">
                        <label className="field-label" htmlFor="base-url">
                          Base URL
                        </label>
                        <input
                          id="base-url"
                          className="input"
                          value={ai.baseUrl}
                          onChange={(event) => patchAI({ baseUrl: event.target.value })}
                          placeholder="https://api.deepseek.com/v1"
                          spellCheck={false}
                        />
                        <p className="hint">
                          一般以 /v1 结尾，会自动补全 /chat/completions。桌面版使用原生网络，局域网 HTTP
                          接口也可以直接连接。
                        </p>
                      </div>
                      <div className="form-field">
                        <label className="field-label" htmlFor="model">
                          模型
                        </label>
                        <input
                          id="model"
                          className="input"
                          value={ai.model}
                          onChange={(event) => patchAI({ model: event.target.value })}
                          placeholder="deepseek-chat"
                          spellCheck={false}
                          list="model-suggestions"
                        />
                        <datalist id="model-suggestions">
                          {AI_PRESETS[ai.provider].models.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                        <p className="hint">
                          {ai.provider === "custom"
                            ? "填入本地服务加载的模型名称，例如 qwen2.5:7b。"
                            : "选择服务商提供的模型 ID。"}
                        </p>
                      </div>
                    </div>

                    <div className="settings-test-row">
                      <button
                        type="button"
                        className="btn btn-outline"
                        onClick={() => void testConnection()}
                        disabled={!configured || testState === "testing"}
                      >
                        {testState === "testing" ? (
                          <>
                            <Loader2 size={14} className="spin" /> 正在连接
                          </>
                        ) : (
                          <>
                            <Sparkles size={14} /> 测试连接
                          </>
                        )}
                      </button>
                      {testState !== "idle" && (
                        <span
                          className={cn(
                            "test-result",
                            testState === "success" && "is-success",
                            testState === "error" && "is-error",
                          )}
                        >
                          {testState === "success" ? <Check size={13} /> : testState === "error" ? <AlertTriangle size={13} /> : null}
                          {testMessage}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="settings-note">
                    <ShieldCheck size={16} />
                    <div>
                      <strong>你的 Key 是如何被使用的？</strong>
                      <p>
                        Key 存放在本机应用存储中，仅用于从当前设备直接调用你选择的服务商。桌面版通过系统原生 HTTP
                        通道发送请求，不受浏览器 CORS 限制；网页 / PWA 版仍要求接口允许跨域。AI
                        请求不会经过任何 Lafei 中转服务器。若使用本地模型（如 LM Studio、Ollama），Key 可以留空。
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {tab === "appearance" && (
                <div className="settings-section">
                  <div className="settings-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>主题</h3>
                        <p>选择一种让你愿意多写一会儿的光线。</p>
                      </div>
                    </div>
                    <div className="theme-grid">
                      {THEMES.map((item) => {
                        const Icon = item.icon;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={cn("theme-card", theme === item.id && "active")}
                            onClick={() => setTheme(item.id)}
                          >
                            <span className={cn("theme-preview", `preview-${item.id}`)}>
                              <span className="theme-preview-side" />
                              <span className="theme-preview-main">
                                <span />
                                <span />
                                <span />
                              </span>
                            </span>
                            <span className="theme-card-foot">
                              <Icon size={14} />
                              <strong>{item.label}</strong>
                              <em>{item.caption}</em>
                              {theme === item.id && <Check size={13} className="theme-check" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="settings-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>界面字号</h3>
                        <p>整体放大文字和控件；选择后立即生效。</p>
                      </div>
                    </div>
                    <div className="font-scale-grid" role="group" aria-label="界面字号">
                      {FONT_SCALES.map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          className={cn("font-scale-card", fontScale === item.value && "active")}
                          onClick={() => setFontScale(item.value)}
                          aria-pressed={fontScale === item.value}
                          aria-label={`${item.label}字号 ${item.caption}`}
                        >
                          <span className="font-scale-sample" style={{ fontSize: `${item.sample}px` }}>
                            Aa
                          </span>
                          <span className="font-scale-label">
                            <strong>{item.label}</strong>
                            <em>{item.caption}</em>
                          </span>
                          {fontScale === item.value && <Check size={12} className="font-scale-check" />}
                        </button>
                      ))}
                    </div>
                    <p className="font-scale-hint">
                      设置保存在本机，只影响显示大小，不改变笔记内容。
                    </p>
                  </div>

                  <div className="settings-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>打开笔记时的默认视图</h3>
                        <p>随时可以在编辑器右上角切换。</p>
                      </div>
                    </div>
                    <div className="editor-mode-grid">
                      {EDITOR_MODES.map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          className={cn("editor-mode-card", noteMode === mode.id && "active")}
                          onClick={() => setNoteMode(mode.id)}
                        >
                          <span className="editor-mode-art">
                            {mode.id === "split" ? (
                              <>
                                <span className="art-half" />
                                <span className="art-half art-half-preview" />
                              </>
                            ) : mode.id === "read" ? (
                              <span className="art-lines art-lines-read">
                                <span />
                                <span />
                                <span />
                              </span>
                            ) : mode.id === "live" ? (
                              <span className="art-lines art-lines-live">
                                <span />
                                <span />
                                <span />
                              </span>
                            ) : (
                              <span className="art-lines">
                                <span />
                                <span />
                                <span />
                              </span>
                            )}
                          </span>
                          <span>
                            <strong>{mode.label}</strong>
                            <em>{mode.caption}</em>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="settings-block settings-block-compact">
                    <div className="settings-row">
                      <div>
                        <h3>编辑器自动保存</h3>
                        <p>每次停笔约半秒后自动写入本地数据库。</p>
                      </div>
                      <span className="settings-fixed-on">
                        <Check size={13} /> 已开启
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {tab === "data" && (
                <div className="settings-section">
                  <div className="data-stats">
                    <div className="data-stat">
                      <Layers size={16} />
                      <strong>{notesCount}</strong>
                      <span>篇笔记</span>
                    </div>
                    <div className="data-stat">
                      <Check size={16} />
                      <strong>{tasksCount}</strong>
                      <span>个任务</span>
                    </div>
                    <div className="data-stat">
                      <FileText size={16} />
                      <strong>{chatsCount}</strong>
                      <span>段对话</span>
                    </div>
                  </div>

                  <FolderStorageSettings />

                  <LogseqImport />

                  <div className="settings-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>备份与迁移</h3>
                        <p>把全部内容导出为一个文件，或从备份恢复。建议定期备份。</p>
                      </div>
                    </div>
                    <div className="data-actions">
                      <button type="button" className="data-action" onClick={() => void exportBackup()}>
                        <span className="data-action-icon">
                          <FileJson size={18} />
                        </span>
                        <span>
                          <strong>导出完整备份</strong>
                          <em>包含笔记、任务与 AI 对话（JSON）</em>
                        </span>
                        <Download size={15} />
                      </button>
                      <button type="button" className="data-action" onClick={() => void exportMarkdown()}>
                        <span className="data-action-icon">
                          <FileText size={18} />
                        </span>
                        <span>
                          <strong>导出可读副本</strong>
                          <em>所有笔记与任务，Markdown 格式</em>
                        </span>
                        <Download size={15} />
                      </button>
                      <button type="button" className="data-action" onClick={() => fileRef.current?.click()}>
                        <span className="data-action-icon">
                          <Upload size={18} />
                        </span>
                        <span>
                          <strong>从备份恢复</strong>
                          <em>会替换当前设备上的全部数据</em>
                        </span>
                        <ChevronRight size={15} />
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="application/json,.json"
                        hidden
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void handleImportFile(file);
                        }}
                      />
                    </div>
                  </div>

                  <div className="settings-block cross-device-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>在手机与电脑上使用</h3>
                        <p>Lafei 的界面会自适应手机屏幕，也可以安装到主屏幕，像原生 App 一样打开。</p>
                      </div>
                    </div>
                    <div className="cross-device-tips">
                      <div>
                        <span className="cross-device-num">01</span>
                        <strong>安装到桌面</strong>
                        <p>桌面版直接运行原生窗口；手机用 Safari / Chrome 打开后「添加到主屏幕」。</p>
                      </div>
                      <div>
                        <span className="cross-device-num">02</span>
                        <strong>iCloud 文件夹同步</strong>
                        <p>在桌面版把数据文件夹放进 iCloud Drive，另一台 Mac 打开后会自动合并。</p>
                      </div>
                      <div>
                        <span className="cross-device-num">03</span>
                        <strong>手机路径</strong>
                        <p>手机 PWA 暂不能直接访问 iCloud 目录；先用备份迁移，原生 iOS 版后续支持。</p>
                      </div>
                    </div>
                  </div>

                  <div className="settings-block danger-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>清空所有数据</h3>
                        <p>删除本机上的全部笔记、任务和对话。操作无法撤销。</p>
                      </div>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirm("clear")}>
                        <Trash2 size={13} /> 清空
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {tab === "agent" && (
                <div className="settings-section">
                  <AgentAccessSettings />
                </div>
              )}

              {tab === "about" && (
                <div className="settings-section">
                  <div className="about-hero">
                    <div className="about-mark">
                      <span>l</span>
                      <i />
                    </div>
                    <div>
                      <span className="eyebrow">Lafei · 拉斐 · v0.12.0</span>
                      <h3 className="display">把知识收好，把行动理清。</h3>
                      <p>Lafei（拉斐）是一个本地优先的笔记与任务应用，AI 是内置的，不是后装的外挂。</p>
                    </div>
                  </div>

                  <div className="settings-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>关于这个版本</h3>
                        <p>文件夹存储已经可用：把数据目录放进 iCloud Drive，就能在多台 Mac 之间免费同步。</p>
                      </div>
                    </div>
                    <div className="about-facts">
                      <div>
                        <span>桌面</span>
                        <strong>Tauri 2 · macOS / Windows</strong>
                      </div>
                      <div>
                        <span>手机</span>
                        <strong>响应式 PWA · iOS / Android</strong>
                      </div>
                      <div>
                        <span>数据</span>
                        <strong>IndexedDB · 完全本地</strong>
                      </div>
                      <div>
                        <span>AI</span>
                        <strong>OpenAI 兼容接口 · 自带 Key</strong>
                      </div>
                    </div>
                  </div>

                  <div className="settings-block">
                    <div className="settings-block-head">
                      <div>
                        <h3>快捷键</h3>
                        <p>让手不必离开键盘。</p>
                      </div>
                    </div>
                    <div className="shortcut-list">
                      {[
                        ["打开命令面板 / 搜索", "⌘ K"],
                        ["新建笔记", "⌘ N"],
                        ["保存笔记", "⌘ S"],
                        ["在笔记中查找", "⌘ F"],
                        ["加粗 / 斜体", "⌘ B / ⌘ I"],
                        ["打开设置", "⌘ ,"],
                      ].map(([label, keys]) => (
                        <div className="shortcut-row" key={label}>
                          <span>{label}</span>
                          <span className="shortcut-keys">
                            {keys.split(" / ").map((key) => (
                              <kbd className="kbd" key={key}>
                                {key}
                              </kbd>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="settings-note">
                    <ShieldCheck size={16} />
                    <div>
                      <strong>你的内容属于你</strong>
                      <p>
                        Lafei 不要求注册账号，也不会把你的笔记上传到自己的服务器。所有内容保存在当前设备，可随时通过 JSON
                        备份带走。
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm === "import"}
        title="用备份替换当前数据？"
        description={
          pendingImport
            ? `备份包含 ${pendingImport.notes.length} 篇笔记、${pendingImport.tasks.length} 个任务。当前设备上的全部内容将被替换，建议先导出当前备份。${activeFolderRoot ? "已连接的文件夹也会被覆盖为这份备份。" : ""}`
            : ""
        }
        confirmLabel={importing ? "正在导入…" : "替换并恢复"}
        onClose={() => {
          setConfirm(null);
          setPendingImport(null);
        }}
        onConfirm={() => void runImport()}
      />

      <ConfirmDialog
        open={confirm === "clear"}
        title="清空所有数据？"
        description={`笔记、任务和 AI 对话都会被永久删除，且无法恢复。${activeFolderRoot ? "已连接文件夹中的 Lafei 数据也会被清空。" : ""}请确认你已经备份了重要内容。`}
        confirmLabel="确认清空"
        onClose={() => setConfirm(null)}
        onConfirm={() => void clearAll()}
      />
    </>
  );
}

async function downloadFile(content: string, filename: string, type: string) {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await invoke<string | null>("save_text_file", {
      filename,
      contents: content,
      kind: type.includes("json") ? "json" : "md",
    });
    return Boolean(path);
  }

  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}
