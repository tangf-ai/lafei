import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Plus } from "lucide-react";
import type { Quadrant, Task } from "../types";
import { TaskRow } from "../components/TaskRow";
import { updateTask } from "../db";
import { cn, dueLabel, isOverdue, remainingLabel } from "../lib/util";
import { tagsOf } from "../lib/tags";
import { useUI } from "../store/ui";
import { dayKeyOffset } from "../lib/date";
import { QUADRANTS, groupTasksByQuadrant, quadrantMeta, quadrantOf } from "../lib/quadrant";
import "./taskMatrix.css";

interface TaskMatrixProps {
  /** 需要出现在矩阵里的任务（未完成、已按筛选条件过滤） */
  tasks: Task[];
  /** 新建任务时默认归到这个象限 */
  onAddToQuadrant: (quadrant: Quadrant) => void;
  /** 矩阵模式的新建入口（浮层快捷新建） */
  onNewTask: () => void;
}

const PRIORITY_WEIGHT: Record<Task["priority"], number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABEL: Record<Task["priority"], string> = {
  high: "高优先",
  medium: "中优先",
  low: "低优先",
};

/** 每个象限里一行任务的高度 */
const ROW_HEIGHT = 32;
/** 单格最多铺多少行，再多就收口成「还有 N 件」 */
const MAX_VISIBLE_ROWS = 8;
/** 板的固定高度：板头 46 + 轴 24 + 底部留白 14 */
const BOARD_CHROME = 84;
/** 每格固定高度：格头 46 + 任务区的上下内边距 12 */
const CELL_CHROME = 58;

interface RowHover {
  task: Task;
  x: number;
  y: number;
}

function sortByPriority(tasks: Task[]) {
  return [...tasks].sort((a, b) => {
    const priority = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (priority !== 0) return priority;
    const aDue = a.dueDate ?? "9999-12-31";
    const bDue = b.dueDate ?? "9999-12-31";
    return aDue.localeCompare(bDue) || b.updatedAt - a.updatedAt;
  });
}

function tipMeta(task: Task) {
  const parts: string[] = [];
  parts.push(task.dueDate ? dueLabel(task.dueDate).label : "待安排");
  if (task.dueDate) {
    const remaining = remainingLabel(task.dueDate);
    if (remaining.days !== null && remaining.days > 0) parts.push(remaining.label);
  }
  parts.push(PRIORITY_LABEL[task.priority]);
  const tags = tagsOf(task);
  if (tags.length > 0) parts.push(tags.map((tag) => `#${tag}`).join(" "));
  return parts.join(" · ");
}

/**
 * 任务四象限：纵轴「重要 ↑」、横轴「紧急 →」，所以 Q1 重要紧急在右上角。
 * 每格用通栏任务行铺开（一行一件），窗口矮时矩阵按内容长高、整页滚动；
 * 格头「查看全部」下钻看该象限的全部任务。
 */
export function TaskMatrix({ tasks, onAddToQuadrant, onNewTask }: TaskMatrixProps) {
  const groups = useMemo(() => groupTasksByQuadrant(tasks), [tasks]);
  const weekDue = useMemo(
    () => tasks.filter((task) => task.dueDate && task.dueDate <= dayKeyOffset(7)).length,
    [tasks],
  );
  const setTaskDetailId = useUI((state) => state.setTaskDetailId);

  const [drillQuadrant, setDrillQuadrant] = useState<Quadrant | null>(null);
  const [hover, setHover] = useState<RowHover | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overQuadrant, setOverQuadrant] = useState<Quadrant | null>(null);

  // 板子随内容长高：行数多的格子决定板的最低高度，窗口矮时整页滚动
  const matrixMinHeight = useMemo(() => {
    const maxRows = Math.max(0, ...QUADRANTS.map((item) => groups[item.id].length));
    const rows = Math.min(MAX_VISIBLE_ROWS, Math.max(1, maxRows));
    // 有收口行时，每个格子要多留出「还有 N 件」那一行的高度
    const moreRow = maxRows > MAX_VISIBLE_ROWS ? 24 : 0;
    // 多给几像素余量，避免亚像素取整把最后一行裁掉
    return BOARD_CHROME + 2 * (CELL_CHROME + rows * ROW_HEIGHT + moreRow) + 6;
  }, [groups]);

  // Esc 返回总览
  useEffect(() => {
    if (!drillQuadrant) return;
    const onKey = (event: KeyboardEvent) => {
      // 快捷新建浮层开着时，Esc 先收浮层（TasksView 里处理），不要同时退出下钻
      if (event.key === "Escape" && !document.querySelector(".task-quick-layer")) setDrillQuadrant(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drillQuadrant]);

  useEffect(() => {
    if (!hover) return;
    const hide = () => setHover(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [hover]);

  const openDrill = (quadrant: Quadrant) => {
    setHover(null);
    setDrillQuadrant(quadrant);
  };

  const closeDrill = () => setDrillQuadrant(null);

  const handleRowEnter = (task: Task, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setHover({ task, x: rect.left + Math.min(rect.width / 2, 220), y: rect.top });
  };

  const handleDragStart = (event: DragEvent<HTMLElement>, task: Task) => {
    event.dataTransfer.setData("text/plain", task.id);
    event.dataTransfer.effectAllowed = "move";
    setHover(null);
    setDraggingId(task.id);
  };

  const clearDrag = () => {
    setDraggingId(null);
    setOverQuadrant(null);
  };

  const renderRow = (task: Task) => {
    const due = dueLabel(task.dueDate);
    const remaining = remainingLabel(task.dueDate);
    const overdue = isOverdue(task.dueDate);
    const tags = tagsOf(task);
    const firstTag = tags[0];

    return (
      <div
        key={task.id}
        className={cn("wb-item", overdue && "is-overdue", draggingId === task.id && "is-dragging")}
        role="button"
        tabIndex={0}
        draggable
        onClick={(event) => {
          event.stopPropagation();
          setTaskDetailId(task.id);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          setTaskDetailId(task.id);
        }}
        onMouseEnter={(event) => handleRowEnter(task, event.currentTarget)}
        onMouseLeave={() => setHover(null)}
        onFocus={(event) => handleRowEnter(task, event.currentTarget)}
        onBlur={() => setHover(null)}
        onDragStart={(event) => handleDragStart(event, task)}
        onDragEnd={clearDrag}
      >
        <i className={cn("wb-pdot", `is-${task.priority}`)} />
        <span className="wb-item-title">{task.title || "未命名任务"}</span>
        <span className="wb-item-meta">
          <span className="wb-item-when">{task.dueDate ? due.label : "待安排"}</span>
          {task.dueDate && remaining.days !== null && remaining.days > 0 && (
            <span>{remaining.label}</span>
          )}
          {firstTag && <span className="wb-item-tag">#{firstTag}</span>}
        </span>
      </div>
    );
  };

  const renderCell = (quadrant: Quadrant, isTop: boolean, isLeft: boolean) => {
    const meta = quadrantMeta(quadrant);
    const cellTasks = sortByPriority(groups[quadrant]);
    const visible = cellTasks.slice(0, MAX_VISIBLE_ROWS);
    const hidden = cellTasks.length - visible.length;
    const isEmpty = cellTasks.length === 0;
    const isOver = overQuadrant === quadrant;

    return (
      <section
        key={quadrant}
        className={cn(
          "wb-quad",
          `wb-quad-${quadrant}`,
          isTop && "is-top",
          isLeft && "is-left",
          isOver && "is-drop",
        )}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, [role='button']")) return;
          openDrill(quadrant);
        }}
        onDragOver={(event) => {
          if (!draggingId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setOverQuadrant((current) => (current === quadrant ? current : quadrant));
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setOverQuadrant((current) => (current === quadrant ? null : current));
        }}
        onDrop={(event) => {
          event.preventDefault();
          const id = event.dataTransfer.getData("text/plain") || draggingId;
          clearDrag();
          if (!id) return;
          const task = tasks.find((item) => item.id === id);
          if (!task || quadrantOf(task) === quadrant) return;
          void updateTask(id, { quadrant });
        }}
      >
        <div className="wb-quad-head">
          <span className="wb-quad-badge">{meta.num}</span>
          <div className="wb-quad-head-text">
            <span className="wb-quad-title">{meta.title}</span>
            <span className="wb-quad-hint">{meta.hint}</span>
          </div>
          {isEmpty ? (
            <button
              type="button"
              className="wb-quad-more"
              onClick={(event) => {
                event.stopPropagation();
                onAddToQuadrant(quadrant);
              }}
            >
              ＋ 添加
            </button>
          ) : (
            <>
              <span className="wb-quad-count">
                {cellTasks.length}
                <span>件</span>
              </span>
              <button
                type="button"
                className="wb-quad-more"
                onClick={(event) => {
                  event.stopPropagation();
                  openDrill(quadrant);
                }}
              >
                查看全部 <b>›</b>
              </button>
            </>
          )}
        </div>

        {isEmpty ? (
          <div className="wb-items-empty">
            <span className="wb-items-zero">0</span>
            <span className="wb-items-empty-text">{meta.empty}</span>
          </div>
        ) : (
          <div className="wb-items-wrap">
            <div className="wb-items">{visible.map(renderRow)}</div>
            {hidden > 0 && (
              <button
                type="button"
                className="wb-items-more"
                onClick={(event) => {
                  event.stopPropagation();
                  openDrill(quadrant);
                }}
              >
                还有 {hidden} 件 ›
              </button>
            )}
          </div>
        )}
      </section>
    );
  };

  const renderDrill = () => {
    if (!drillQuadrant) return null;
    const meta = quadrantMeta(drillQuadrant);
    const cellTasks = sortByPriority(groups[drillQuadrant]);

    return (
      <div className="wb-drill" role="region" aria-label={`${meta.title}的任务`}>
        <div className="wb-drill-head">
          <button type="button" className="wb-drill-back" onClick={closeDrill}>
            <ArrowLeft size={11} /> 四象限
          </button>
          <span className={cn("wb-drill-badge", `is-${drillQuadrant}`)}>{meta.num}</span>
          <span className="wb-drill-title">
            <span>{meta.title}</span>
            <small>{meta.hint}</small>
          </span>
          <span className="wb-drill-count">
            {cellTasks.length}
            <span>件</span>
          </span>
          <div className="wb-drill-switch">
            {QUADRANTS.map((item) => (
              <button
                key={item.id}
                type="button"
                data-q={item.id}
                aria-pressed={item.id === drillQuadrant}
                className={cn(item.id === drillQuadrant && "is-active")}
                onClick={() => setDrillQuadrant(item.id)}
              >
                {item.num} · {groups[item.id].length}
              </button>
            ))}
          </div>
          <button type="button" className="wb-drill-add" onClick={() => onAddToQuadrant(drillQuadrant)}>
            <Plus size={11} /> 添加任务
          </button>
        </div>

        <div className="wb-drill-list">
          {cellTasks.length === 0 && (
            <p className="wb-drill-empty">这个象限还空着。点右上角「添加任务」，或者回到四象限把任务拖进来。</p>
          )}
          {cellTasks.map((task) => (
            <div key={task.id} className="wb-drill-row" data-task-id={task.id}>
              <TaskRow task={task} showNote={false} maxTags={2} />
            </div>
          ))}
          <button type="button" className="wb-drill-add-row" onClick={() => onAddToQuadrant(drillQuadrant)}>
            <Plus size={11} /> 添加任务
          </button>
        </div>

        <div className="wb-drill-foot">点任务打开详情 · Esc 返回四象限</div>
      </div>
    );
  };

  const tipAbove = hover ? hover.y > 170 : true;
  const tipX = hover
    ? Math.min(Math.max(hover.x, 160), (typeof window === "undefined" ? 1600 : window.innerWidth) - 160)
    : 0;

  return (
    <section
      className={cn("wb-matrix", drillQuadrant && "is-drilling")}
      aria-label="任务四象限"
      data-q={drillQuadrant ?? undefined}
      style={{ minHeight: matrixMinHeight }}
    >
      <header className="wb-matrix-head">
        <span className="wb-matrix-title">任务四象限</span>
        <span className="wb-matrix-formula">重要 ↑ × 紧急 →</span>
        <div className="wb-matrix-legend">
          <span>
            <i className="is-high" />高优先
          </span>
          <span>
            <i className="is-medium" />中优先
          </span>
          <span>
            <i className="is-low" />低优先
          </span>
        </div>
        <div className="wb-matrix-meta">
          <span>
            <b>{tasks.length}</b> 件未完成
          </span>
          <span className="wb-matrix-sep" />
          <span>
            本周到期 <b>{weekDue}</b>
          </span>
        </div>
        <button type="button" className="wb-matrix-new" onClick={onNewTask}>
          <Plus size={11} />
          新建任务
        </button>
      </header>

      <div className="wb-plot">
        <span className="wb-axis-corner" aria-hidden="true" />
        <span className="wb-axis-top">不紧急</span>
        <span className="wb-axis-top">
          紧急<span className="ar">→</span>
        </span>
        <span className="wb-axis-left">重要</span>
        {renderCell("q2", true, true)}
        {renderCell("q1", true, false)}
        <span className="wb-axis-left">不重要</span>
        {renderCell("q4", false, true)}
        {renderCell("q3", false, false)}
      </div>

      {renderDrill()}

      {hover &&
        createPortal(
          <div
            className={cn("wb-dot-tip", tipAbove ? "is-above" : "is-below")}
            style={{ left: tipX, top: tipAbove ? hover.y - 10 : hover.y + 40 }}
          >
            <b>{hover.task.title || "未命名任务"}</b>
            <span>{tipMeta(hover.task)}</span>
          </div>,
          document.body,
        )}
    </section>
  );
}
