import { useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  Cloud,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { useUI, toast } from "../store/ui";
import { useFolderSync } from "../store/folderSync";
import { revealInFolder } from "../lib/external";
import {
  disableFolderStorage,
  enableFolderCandidate,
  isFolderStorageAvailable,
  selectFolderCandidate,
  syncFolderNow,
  type FolderCandidate,
} from "../lib/folderSync";
import { Modal } from "../components/Modal";
import { cn } from "../lib/util";

function timeLabel(timestamp: number | null) {
  if (!timestamp) return "等待首次同步";
  const date = new Date(timestamp);
  const isToday = date.toDateString() === new Date().toDateString();
  return isToday
    ? `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function FolderStorageSettings() {
  const root = useUI((state) => state.folderRoot);
  const phase = useFolderSync((state) => state.phase);
  const lastSyncedAt = useFolderSync((state) => state.lastSyncedAt);
  const error = useFolderSync((state) => state.error);
  const lastMessage = useFolderSync((state) => state.lastMessage);
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<FolderCandidate | null>(null);
  const available = isFolderStorageAvailable();
  const syncing = phase === "syncing" || busy;
  const activeRoot = available ? root : null;

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await selectFolderCandidate();
      if (!next) return;
      if (next.hasRemoteData) {
        setCandidate(next);
        return;
      }
      const result = await enableFolderCandidate(next, "merge");
      toast(
        `已连接文件夹 · 写入 ${result.summary.uploaded} 项，读取 ${result.summary.downloaded} 项`,
        "success",
      );
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "无法启用文件夹存储", "error");
    } finally {
      setBusy(false);
    }
  };

  const resolveCandidate = async (mode: "merge" | "folder") => {
    const next = candidate;
    if (!next || busy) return;
    setCandidate(null);
    setBusy(true);
    try {
      const result = await enableFolderCandidate(next, mode);
      toast(
        mode === "folder"
          ? `已用文件夹内容替换本机 · ${result.summary.downloaded} 项`
          : `已合并两边 · 写入 ${result.summary.uploaded} 项，读取 ${result.summary.downloaded} 项`,
        "success",
      );
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "启用文件夹失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    if (syncing) return;
    setBusy(true);
    try {
      const summary = await syncFolderNow();
      toast(
        summary.uploaded || summary.downloaded || summary.removed
          ? `同步完成 · 上传 ${summary.uploaded} · 读取 ${summary.downloaded} · 删除 ${summary.removed}`
          : "文件夹已是最新",
        "success",
      );
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "同步失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    disableFolderStorage();
    toast("已断开文件夹存储，文件夹中的数据不会被删除");
  };

  return (
    <div className="settings-block folder-storage-block">
      <div className="settings-block-head">
        <div>
          <h3>
            文件夹存储
            <span className="folder-icloud-badge">
              <Cloud size={10} /> iCloud 友好
            </span>
          </h3>
          <p>把每条笔记、任务和对话写成普通文件。放进 iCloud Drive，就让 iCloud 免费替你同步。</p>
        </div>
        <span className={cn("status-badge", activeRoot ? "is-ok" : "is-off")}>
          <span className="status-dot" />
          {activeRoot ? (phase === "error" ? "同步异常" : syncing ? "同步中" : "已连接") : "未启用"}
        </span>
      </div>

      {!available ? (
        <div className="folder-desktop-only">
          <FolderOpen size={18} />
          <div>
            <strong>目录存储需要桌面版</strong>
            <p>
              手机浏览器无法直接访问 iCloud Drive 文件夹。请先在 Mac 桌面版启用；iPhone
              端可通过备份迁移，原生 iCloud 读取会在后续版本支持。
            </p>
          </div>
        </div>
      ) : !activeRoot ? (
        <>
          <div className="folder-empty">
            <div className="folder-empty-art">
              <FolderOpen size={24} />
              <span className="folder-empty-dot" />
            </div>
            <div className="folder-empty-copy">
              <strong>选一个文件夹，让数据看得见</strong>
              <p>
                建议在 iCloud Drive 里新建 Lafei 文件夹，或直接选择 iCloud Drive；Lafei
                会自动创建专用目录，并写入 Markdown 笔记与 JSON 数据。
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => void enable()} disabled={busy}>
              {busy ? <Loader2 size={15} className="spin" /> : <FolderOpen size={15} />}
              {busy ? "正在准备…" : "选择文件夹"}
            </button>
          </div>
          <p className="folder-hint">
            目录中的数据是完整可迁移的。启用后，每次编辑会自动落盘；应用重新打开时会与文件夹双向合并。
          </p>
        </>
      ) : (
        <>
          <div className="folder-connected">
            <div className="folder-path-row">
              <span className="folder-path-icon">
                <FolderOpen size={18} />
              </span>
              <div className="folder-path-text">
                <strong>{folderName(activeRoot)}</strong>
                <span title={activeRoot}>{activeRoot}</span>
              </div>
            </div>
            <div className="folder-sync-line">
              <span className={cn("folder-live-dot", syncing && "is-syncing", phase === "error" && "is-error")} />
              <span>
                {syncing ? "正在与文件夹同步…" : phase === "error" ? "最近一次同步失败" : lastMessage || "自动同步已开启"}
              </span>
              <span className="folder-sync-time">{timeLabel(lastSyncedAt)}</span>
            </div>
            {error && (
              <div className="folder-error">
                <AlertCircle size={14} />
                <span>{error}</span>
                <button type="button" onClick={() => void syncNow()}>
                  重试
                </button>
              </div>
            )}
          </div>

          <div className="folder-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void syncNow()} disabled={syncing}>
              <RefreshCw size={13} className={syncing ? "spin" : ""} />
              {syncing ? "同步中…" : "立即同步"}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void revealInFolder(activeRoot)}>
              <FolderOpen size={13} /> 在文件管理器中显示
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost folder-disconnect"
              onClick={disconnect}
              disabled={syncing}
            >
              <Unplug size={13} /> 断开
            </button>
          </div>

          <div className="folder-safety">
            <ShieldCheck size={14} />
            <span>
              双向合并，按更新时间保留较新版本。删除会写入 tombstone，避免在另一台设备上“复活”。
            </span>
          </div>

          <details className="folder-structure">
            <summary>
              查看目录结构 <ChevronDown size={12} />
            </summary>
            <pre>{`${folderName(activeRoot)}/
├── manifest.json      同步信息
├── tombstones.json    删除记录
├── notes/             每篇笔记（Markdown）
├── tasks/             每个任务（JSON）
└── chats/             AI 对话（JSON）`}</pre>
            <p>请优先在应用内编辑。iCloud 若生成冲突副本，Lafei 会读取更新时间较新的版本。</p>
          </details>

          <p className="folder-mobile-note">
            手机 PWA 不能直接读取这个目录；在 iPhone 上目前用备份迁移。后续原生 iOS 版可以直接使用同一 iCloud 文件夹。
          </p>
        </>
      )}

      <Modal
        open={Boolean(candidate)}
        onClose={() => setCandidate(null)}
        title="文件夹里已经有数据"
        subtitle="这个文件夹已经是一个 Lafei 数据目录。选择如何处理两边的内容。"
        size="sm"
      >
        {candidate && (
          <div className="folder-merge-body">
            <div className="folder-merge-meta">
              <span>{folderName(candidate.root)}</span>
              <span>
                {candidate.remoteDevice ? `${candidate.remoteDevice} · ` : ""}
                {candidate.remoteUpdatedAt ? timeLabel(candidate.remoteUpdatedAt) : "未知时间"}
              </span>
            </div>
            <div className="folder-merge-counts">
              <div>
                <strong>{candidate.counts.notes}</strong>
                <span>篇笔记</span>
              </div>
              <div>
                <strong>{candidate.counts.tasks}</strong>
                <span>个任务</span>
              </div>
              <div>
                <strong>{candidate.counts.chats}</strong>
                <span>段对话</span>
              </div>
            </div>
            <div className="folder-merge-actions">
              <button type="button" className="btn btn-primary" onClick={() => void resolveCandidate("merge")}>
                合并两边（推荐）
              </button>
              <button type="button" className="btn btn-outline" onClick={() => void resolveCandidate("folder")}>
                以文件夹为准
              </button>
            </div>
            <p className="folder-merge-hint">
              「合并」保留本机和文件夹的全部内容，按更新时间去重；「以文件夹为准」会用目录内容替换本机当前数据，适合在新设备上接入已有目录。
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
