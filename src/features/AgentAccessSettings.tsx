import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { useUI, toast } from "../store/ui";
import { isTauri } from "../lib/util";
import { agentBackend, type AgentSnapshotStatus } from "../lib/agentBackend";
import { clearAgentSnapshot, flushAgentSnapshot, setAgentAccess } from "../lib/agentExport";
import { ConfirmDialog } from "../components/ConfirmDialog";

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
  const [status, setStatus] = useState<AgentSnapshotStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState("");

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
            <p>让 Codex、Pi 等智能体读取笔记和任务的只读快照。这个功能只在桌面版可用。</p>
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
              把笔记和任务导出为只读快照，供 Codex、Pi 等智能体通过 MCP 读取。不会导出 AI
              对话、API Key 或删除记录。
            </p>
          </div>
          <span className={enabled ? "status-badge is-ok" : "status-badge"}>
            <span className="status-dot" />
            {enabled ? "已开启" : "已关闭"}
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
          <span>快照是只读的，放在本机应用数据目录；只有本机进程能读取，不会上传到网络。</span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="清除智能体快照？"
        description="只会删除导出的快照文件，不会影响笔记和任务。如果智能体正在使用，请先关闭它。"
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void clearSnapshot()}
      />
    </div>
  );
}
