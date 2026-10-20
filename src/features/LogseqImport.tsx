import { useState } from "react";
import { CheckCircle2, ChevronRight, FolderSearch, ListTodo, Loader2, RefreshCw } from "lucide-react";
import type { LogseqScan } from "../types";
import { folderBackend } from "../lib/folderBackend";
import { importLogseqTasks, scanLogseqGraph } from "../lib/logseqImport";
import { useUI, toast } from "../store/ui";
import { isTauri } from "../lib/util";

interface ImportResult {
  added: number;
  skipped: number;
}

export function LogseqImport() {
  const folderRoot = useUI((state) => state.folderRoot);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<LogseqScan | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");

  if (!isTauri) {
    return (
      <div className="settings-block logseq-import-block">
        <div className="settings-block-head">
          <div>
            <h3>从 Logseq 导入</h3>
            <p>读取 Logseq graph 里的未完成任务。由于需要访问本地文件夹，这个功能目前只在桌面版可用。</p>
          </div>
        </div>
      </div>
    );
  }

  const chooseGraph = async () => {
    setError("");
    setResult(null);
    let selected: string | null = null;
    try {
      selected = await folderBackend.pickFolder();
    } catch {
      setError("无法打开文件夹选择器，请稍后再试。");
      return;
    }
    if (!selected) return;

    setScanning(true);
    setScan(null);
    try {
      const next = await scanLogseqGraph(selected);
      setScan(next);
    } catch (nextError) {
      setError(
        typeof nextError === "string"
          ? nextError
          : "读取 Logseq graph 失败，请确认选择的是 graph 根目录。",
      );
    } finally {
      setScanning(false);
    }
  };

  const importTasks = async () => {
    if (!scan || importing) return;
    setImporting(true);
    setError("");
    try {
      const summary = await importLogseqTasks(scan);
      setResult(summary);
      setScan(null);
      toast(
        summary.added
          ? `已从 Logseq 导入 ${summary.added} 个任务`
          : "没有新增任务，重复项已跳过",
        "success",
      );
    } catch {
      setError("导入失败，可能是本地数据库暂时不可用，请重试。");
    } finally {
      setImporting(false);
    }
  };

  const dueCount = scan?.tasks.filter((task) => task.dueDate).length ?? 0;

  return (
    <div className="settings-block logseq-import-block">
      <div className="settings-block-head">
        <div>
          <h3>从 Logseq 导入</h3>
          <p>
            选择 Logseq graph 根目录，把未完成任务导入 Lafei。只读取 pages/ 与 journals/，不会修改
            Logseq，也不会覆盖现有数据。
          </p>
        </div>
        {scan && (
          <span className="logseq-count-pill">
            <ListTodo size={12} /> {scan.openCount} 个待办
          </span>
        )}
      </div>

      {!scan && !result && (
        <button type="button" className="data-action" onClick={() => void chooseGraph()} disabled={scanning}>
          <span className="data-action-icon">
            {scanning ? <Loader2 size={18} className="spin" /> : <FolderSearch size={18} />}
          </span>
          <span>
            <strong>{scanning ? "正在扫描 graph…" : "选择 Logseq graph 文件夹"}</strong>
            <em>通常包含 pages/、journals/ 和 logseq/ 目录</em>
          </span>
          <ChevronRight size={15} />
        </button>
      )}

      {error && <p className="logseq-error">{error}</p>}

      {scan && (
        <div className="logseq-preview">
          <div className="logseq-preview-head">
            <div>
              <strong>{scan.graphName}</strong>
              <span>
                {scan.scannedFiles} 个页面文件 · 已跳过 {scan.completedCount} 个完成任务
              </span>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => void chooseGraph()}
              disabled={scanning}
            >
              <RefreshCw size={12} /> 重新选择
            </button>
          </div>

          <div className="logseq-preview-stats">
            <span>
              <strong>{scan.openCount}</strong> 个未完成任务
            </span>
            <span>
              <strong>{dueCount}</strong> 个带截止日期
            </span>
          </div>

          {scan.tasks.length ? (
            <>
              <div className="logseq-task-preview">
                {scan.tasks.slice(0, 4).map((task) => (
                  <div className="logseq-task-line" key={task.id}>
                    <span className={`priority-dot priority-${task.priority}`} />
                    <span>{task.title}</span>
                    {task.dueDate && <em>截止 {task.dueDate}</em>}
                  </div>
                ))}
                {scan.tasks.length > 4 && (
                  <span className="logseq-more">还有 {scan.tasks.length - 4} 个任务…</span>
                )}
              </div>
              <div className="logseq-import-actions">
                <span>重复导入时会按来源和标题自动跳过。</span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void importTasks()}
                  disabled={importing}
                >
                  {importing ? <Loader2 size={13} className="spin" /> : <ListTodo size={13} />}
                  {importing ? "正在导入…" : `导入 ${scan.openCount} 个任务`}
                </button>
              </div>
            </>
          ) : (
            <p className="logseq-empty">这个 graph 里没有找到未完成任务。</p>
          )}
        </div>
      )}

      {result && (
        <div className="logseq-done">
          <CheckCircle2 size={20} />
          <div>
            <strong>导入完成</strong>
            <p>
              新增 {result.added} 个任务
              {result.skipped ? `，跳过 ${result.skipped} 个重复项` : ""}。
            </p>
          </div>
          <button type="button" className="btn btn-sm btn-outline" onClick={() => void chooseGraph()}>
            再导入一次
          </button>
        </div>
      )}

      {folderRoot && (
        <p className="logseq-hint">
          已连接文件夹存储：新任务会随本机数据库一起同步到你的存储目录。
        </p>
      )}
    </div>
  );
}
