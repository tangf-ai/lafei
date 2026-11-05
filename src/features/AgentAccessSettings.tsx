import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Check,
  ChevronRight,
  Copy,
  FileText,
  ListTodo,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { useUI, toast } from "../store/ui";
import { isTauri, updatedLabel } from "../lib/util";
import { agentBackend, type AgentSnapshotStatus } from "../lib/agentBackend";
import { clearAgentSnapshot, flushAgentSnapshot, setAgentAccess } from "../lib/agentExport";
import {
  AGENT_WRITE_EVENT,
  loadAgentWriteLog,
  processAgentInboxOnce,
  setAgentWriteEnabled,
  type AgentWriteLogItem,
} from "../lib/agentWrite";
import { ConfirmDialog } from "../components/ConfirmDialog";

/** 首次开启写入前需要用户确认一次，确认结果只存在本机 */
const WRITE_CONFIRM_KEY = "lafei:agent-write:confirmed";

function hasConfirmedWrite() {
  try {
    return localStorage.getItem(WRITE_CONFIRM_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberWriteConfirmed() {
  try {
    localStorage.setItem(WRITE_CONFIRM_KEY, "1");
  } catch {
    // 隐私模式下存不进去，下次开启会再确认一次
  }
}

function codexConfig(mcpPath: string, dir: string) {
  return `[mcp_servers.lafei]
command = ${JSON.stringify(mcpPath)}
args = ["--data-dir", ${JSON.stringify(dir)}]`;
}

function jsonConfig(mcpPath: string, dir: string) {
  return JSON.stringify(
    {
      mcpServers: {
        lafei: {
          command: mcpPath,
          args: ["--data-dir", dir],
        },
      },
    },
    null,
    2,
  );
}

export function AgentAccessSettings() {
  const enabled = useUI((state) => state.agentAccessEnabled);
  const writeEnabled = useUI((state) => state.agentWriteEnabled);
  const openNote = useUI((state) => state.openNote);
  const setView = useUI((state) => state.setView);
  const setTaskFilter = useUI((state) => state.setTaskFilter);
  const setTaskDetailId = useUI((state) => state.setTaskDetailId);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const [status, setStatus] = useState<AgentSnapshotStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [copied, setCopied] = useState("");
  const [writeLog, setWriteLog] = useState<AgentWriteLogItem[]>(() => loadAgentWriteLog());

  const refresh = async () => {
    if (!isTauri) return;
    try {
      setStatus(await agentBackend.status());
    } catch {
      // 状态读取失败不打断设置页，导出按钮仍会给出具体错误
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // 队列处理完一批会派发事件：刷新队列数量和「由智能体创建」列表
  useEffect(() => {
    const onWrites = () => {
      setWriteLog(loadAgentWriteLog());
      void refresh();
    };
    window.addEventListener(AGENT_WRITE_EVENT, onWrites);
    return () => window.removeEventListener(AGENT_WRITE_EVENT, onWrites);
  }, []);

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1600);
      toast("已复制", "success");
    } catch {
      toast("复制失败，请手动选择文本", "error");
    }
  };

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setAgentAccess(!enabled);
      await refresh();
      toast(enabled ? "已停止更新智能体快照" : "已开启智能体访问", "success");
    } catch {
      toast("导出智能体快照失败，请检查磁盘权限", "error");
    } finally {
      setBusy(false);
    }
  };

  const applyWriteToggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await setAgentWriteEnabled(next);
      await refresh();
      toast(next ? "已开启智能体写入" : "已关闭智能体写入", "success");
    } catch {
      toast("切换智能体写入失败，请检查磁盘权限", "error");
    } finally {
      setBusy(false);
    }
  };

  const toggleWrite = () => {
    if (busy || !enabled) return;
    if (writeEnabled) {
      void applyWriteToggle(false);
      return;
    }
    if (!hasConfirmedWrite()) {
      setConfirmWrite(true);
      return;
    }
    void applyWriteToggle(true);
  };

  const checkNow = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await processAgentInboxOnce();
      await refresh();
      toast("已检查外部智能体队列", "success");
    } catch {
      toast("检查队列失败，请稍后重试", "error");
    } finally {
      setChecking(false);
    }
  };

  const exportNow = async () => {
    if (busy || !enabled) return;
    setBusy(true);
    try {
      await flushAgentSnapshot();
      await refresh();
      toast("智能体快照已更新", "success");
    } catch {
      toast("导出失败，请稍后重试", "error");
    } finally {
      setBusy(false);
    }
  };

  const clearSnapshot = async () => {
    setConfirmClear(false);
    setBusy(true);
    try {
      await clearAgentSnapshot();
      await refresh();
      toast("智能体快照已清除");
    } catch {
      toast("清除失败，请稍后重试", "error");
    } finally {
      setBusy(false);
    }
  };

  /** 点开活动列表：笔记直接打开，任务切到任务页并弹详情 */
  const openWriteLogItem = (item: AgentWriteLogItem) => {
    if (item.status !== "applied" || !item.entityId) return;
    if (item.kind === "note") {
      openNote(item.entityId);
    } else {
      setView("tasks");
      setTaskFilter("all");
      setTaskDetailId(item.entityId);
    }
    setSettingsOpen(false);
  };

  const recentWrites = useMemo(() => writeLog.slice(0, 5), [writeLog]);

  const config = useMemo(() => {
    const dir = status?.dir ?? "~/Library/Application Support/app.lafei.desktop/agent";
    const mcp = status?.mcpPath ?? "/Applications/Lafei.app/Contents/MacOS/lafei-mcp";
    return { codex: codexConfig(mcp, dir), json: jsonConfig(mcp, dir) };
  }, [status?.dir, status?.mcpPath]);

  if (!isTauri) {
    return (
      <div className="settings-block agent-access-block">
        <div className="settings-block-head">
          <div>
            <h3>智能体访问（MCP）</h3>
            <p>让 Codex、Pi 等智能体读取笔记和任务，开启写入后还可以新建。这个功能只在桌面版可用。</p>
          </div>
          <span className="status-badge">桌面版</span>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-access-shell">
      <div className="settings-block agent-access-block">
        <div className="settings-block-head">
          <div>
            <h3>智能体访问（MCP）</h3>
            <p>
              把笔记和任务导出为智能体快照，供 Codex、Pi 等通过 MCP 读取；开启写入后还能新建笔记和任务。
              不会导出 AI 对话、API Key 或删除记录。
            </p>
          </div>
          <span className={enabled ? "status-badge is-ok" : "status-badge"}>
            <span className="status-dot" />
            {enabled ? (writeEnabled ? "读取 + 写入" : "已开启") : "已关闭"}
          </span>
        </div>

        <div className="settings-row agent-access-toggle-row">
          <div>
            <h3>允许外部智能体读取</h3>
            <p>开启后，笔记或任务变化约 1 秒内更新快照；关闭后停止更新，但保留已导出文件。</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={enabled ? "关闭智能体访问" : "开启智能体访问"}
            className={enabled ? "agent-switch is-on" : "agent-switch"}
            onClick={() => void toggle()}
            disabled={busy}
          >
            <span />
          </button>
        </div>

        <div className="settings-row agent-access-toggle-row agent-write-toggle-row">
          <div>
            <h3>允许外部智能体新建笔记和任务</h3>
            <p>
              写入通过本机 agent/inbox 队列异步生效，每次创建都会给出提示，可以撤销。
              {enabled ? "" : "需要先打开上面的读取开关；关闭读取时写入会一起关闭。"}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={writeEnabled}
            aria-label={writeEnabled ? "关闭智能体写入" : "开启智能体写入"}
            className={writeEnabled ? "agent-switch is-on" : "agent-switch"}
            onClick={toggleWrite}
            disabled={busy || !enabled}
          >
            <span />
          </button>
        </div>

        {writeEnabled && (
          <div className="agent-write-queue">
            <div className="agent-write-queue-copy">
              <span className="agent-mini-label">待处理请求</span>
              <strong>{status ? status.pendingRequests : "—"}</strong>
              <span>条在队列里等待处理</span>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => void checkNow()}
              disabled={checking || busy}
            >
              {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              立即检查
            </button>
          </div>
        )}

        <div className="agent-write-log">
          <div className="agent-write-log-head">
            <h4>
              <Activity size={13} /> 由智能体创建
            </h4>
            {recentWrites.length > 0 && <span className="agent-mini-label">最近 {recentWrites.length} 条</span>}
          </div>
          {recentWrites.length === 0 ? (
            <p className="agent-write-empty">还没有由智能体创建的内容。</p>
          ) : (
            <ul className="agent-write-list">
              {recentWrites.map((item) => {
                const applied = item.status === "applied" && Boolean(item.entityId);
                const kindLabel = item.kind === "note" ? "笔记" : "任务";
                const title = item.title || (applied ? `${kindLabel}（无标题）` : "未通过的写入请求");
                return (
                  <li key={item.id}>
                    {applied ? (
                      <button
                        type="button"
                        className="agent-write-item"
                        onClick={() => openWriteLogItem(item)}
                      >
                        <span className="agent-write-icon">
                          {item.kind === "note" ? <FileText size={13} /> : <ListTodo size={13} />}
                        </span>
                        <span className="agent-write-copy">
                          <strong>{title}</strong>
                          <span>
                            {kindLabel} · {updatedLabel(item.at)}
                          </span>
                        </span>
                        <ChevronRight size={13} className="agent-write-chevron" />
                      </button>
                    ) : (
                      <div className="agent-write-item is-rejected">
                        <span className="agent-write-icon is-rejected">
                          {item.kind === "note" ? <FileText size={13} /> : <ListTodo size={13} />}
                        </span>
                        <span className="agent-write-copy">
                          <strong>{title}</strong>
                          <span>
                            {item.error ?? "请求未通过校验"} · {updatedLabel(item.at)}
                          </span>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {enabled && (
          <>
            <div className="agent-path-box">
              <div>
                <span className="agent-mini-label">快照目录</span>
                <code>{status?.dir ?? "正在读取…"}</code>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-outline"
                onClick={() => status && void copy("dir", status.dir)}
                disabled={!status}
              >
                {copied === "dir" ? <Check size={13} /> : <Copy size={13} />}
                {copied === "dir" ? "已复制" : "复制路径"}
              </button>
            </div>

            <div className="agent-export-row">
              <span>
                {status?.modifiedAt
                  ? `上次导出：${new Date(status.modifiedAt).toLocaleString("zh-CN")}`
                  : "尚未导出"}
                {status ? ` · ${status.notes} 篇笔记 · ${status.tasks} 个任务` : ""}
              </span>
              <div className="agent-export-actions">
                <button type="button" className="btn btn-sm btn-outline" onClick={() => void exportNow()} disabled={busy}>
                  {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                  立即导出
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmClear(true)} disabled={busy}>
                  <Trash2 size={13} /> 清除快照
                </button>
              </div>
            </div>
          </>
        )}

        <div className="agent-config-block">
          <div className="agent-config-head">
            <div>
              <h3>
                <Terminal size={14} /> MCP 配置
              </h3>
              <p>
                {status?.mcpExists
                  ? "把下面的配置复制到 Codex 或 Pi 的 MCP 设置里即可。"
                  : "当前没有找到 lafei-mcp 可执行文件；重新构建桌面版后它会随应用一起打包。"}
              </p>
            </div>
            <span className={status?.mcpExists ? "agent-mini-badge is-ready" : "agent-mini-badge"}>
              {status?.mcpExists ? "服务已就绪" : "服务未就绪"}
            </span>
          </div>
          <pre className="agent-config-code">{config.codex}</pre>
          <div className="agent-config-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void copy("codex", config.codex)}>
              {copied === "codex" ? <Check size={13} /> : <Copy size={13} />}
              {copied === "codex" ? "已复制" : "复制 Codex 配置"}
            </button>
            <button type="button" className="btn btn-sm btn-outline" onClick={() => void copy("json", config.json)}>
              {copied === "json" ? <Check size={13} /> : <Copy size={13} />}
              {copied === "json" ? "已复制" : "复制 JSON 配置"}
            </button>
          </div>
        </div>

        <div className="agent-security-note">
          <ShieldCheck size={14} />
          <span>
            快照和写入队列都放在本机应用数据目录，只有本机进程能访问，不会上传网络。写入请求由 Lafei
            校验后才会落库，智能体无法直接修改数据库。
          </span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="清除智能体快照？"
        description="只会删除导出的快照文件，不会影响笔记和任务。如果智能体正在使用，请先关闭它。"
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void clearSnapshot()}
      />

      <ConfirmDialog
        open={confirmWrite}
        title="允许外部智能体新建内容？"
        description="开启后，MCP 客户端可以通过本机 agent/inbox 队列新建笔记和任务；每次创建都会给出提示，可以撤销。写入只在本机进行，不会上传网络。"
        confirmLabel="开启写入"
        onClose={() => setConfirmWrite(false)}
        onConfirm={() => {
          rememberWriteConfirmed();
          void applyWriteToggle(true);
        }}
      />
    </div>
  );
}
