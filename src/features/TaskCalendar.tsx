import { useMemo, useState } from "react";
import {
  addDays,
  addMonths,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { zhCN } from "date-fns/locale";
import { CalendarDays, ChevronLeft, ChevronRight, ListTodo } from "lucide-react";
import type { Note, Task } from "../types";
import { cn, dayKey, isOverdue, noteTitle } from "../lib/util";
import { TaskRow } from "../components/TaskRow";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;

interface TaskCalendarProps {
  tasks: Task[];
  notes: Note[];
  onShowList: () => void;
}

export function TaskCalendar({ tasks, notes, onShowList }: TaskCalendarProps) {
  const now = new Date();
  const [cursor, setCursor] = useState(() => startOfMonth(now));
  const [selectedKey, setSelectedKey] = useState(() => dayKey(now));

  const noteMap = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.done || !task.dueDate) continue;
      const list = map.get(task.dueDate) ?? [];
      list.push(task);
      map.set(task.dueDate, list);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] ||
          a.createdAt - b.createdAt,
      );
    }
    return map;
  }, [tasks]);

  const monthPrefix = format(cursor, "yyyy-MM");
  const monthTasks = tasks.filter((task) => !task.done && task.dueDate?.startsWith(monthPrefix));
  const unscheduled = tasks.filter((task) => !task.done && !task.dueDate);
  const selectedDate = new Date(`${selectedKey}T12:00:00`);
  const selectedTasks = tasksByDay.get(selectedKey) ?? [];

  const gridStart = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));

  const chooseMonth = (next: Date) => {
    setCursor(startOfMonth(next));
    setSelectedKey(isSameMonth(next, now) ? dayKey(now) : dayKey(startOfMonth(next)));
  };

  const selectDay = (day: Date) => {
    setSelectedKey(dayKey(day));
    if (!isSameMonth(day, cursor)) setCursor(startOfMonth(day));
  };

  return (
    <section className="task-calendar" aria-label="任务日历">
      <header className="calendar-head">
        <div className="calendar-heading">
          <span className="eyebrow">Calendar</span>
          <h2 className="display">{format(cursor, "yyyy年M月", { locale: zhCN })}</h2>
          <p>
            本月 {monthTasks.length} 个截止任务 · 点击日期查看安排
          </p>
        </div>
        <div className="calendar-controls">
          <button
            type="button"
            className="icon-btn"
            onClick={() => chooseMonth(subMonths(cursor, 1))}
            aria-label="上个月"
          >
            <ChevronLeft size={17} />
          </button>
          <button type="button" className="btn btn-sm btn-outline" onClick={() => chooseMonth(now)}>
            <CalendarDays size={13} /> 今天
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => chooseMonth(addMonths(cursor, 1))}
            aria-label="下个月"
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </header>

      <div className="calendar-weekdays" aria-hidden="true">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="calendar-grid">
        {days.map((day) => {
          const key = dayKey(day);
          const dayTasks = tasksByDay.get(key) ?? [];
          const outside = !isSameMonth(day, cursor);
          const today = key === dayKey(now);
          const selected = key === selectedKey;
          const past = dayTasks.length > 0 && isOverdue(key);
          return (
            <button
              type="button"
              key={key}
              className={cn(
                "calendar-day",
                outside && "is-outside",
                today && "is-today",
                selected && "is-selected",
                past && "is-past",
              )}
              onClick={() => selectDay(day)}
              aria-label={`${format(day, "M月d日")}，${dayTasks.length} 个任务`}
            >
              <span className="calendar-day-top">
                <span className="calendar-day-number">{format(day, "d")}</span>
                {dayTasks.length > 0 && <span className="calendar-day-count">{dayTasks.length}</span>}
              </span>
              {dayTasks.length > 0 && (
                <span className="calendar-day-tasks">
                  {dayTasks.slice(0, 2).map((task) => (
                    <span className="calendar-chip" key={task.id}>
                      <i className={cn("calendar-priority", `priority-${task.priority}`)} />
                      <em>{noteTitle(task.title)}</em>
                    </span>
                  ))}
                  {dayTasks.length > 2 && <span className="calendar-more">+{dayTasks.length - 2}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="calendar-detail">
        <div className="calendar-detail-head">
          <div>
            <span className="eyebrow">Selected day</span>
            <h3 className="display">
              {format(selectedDate, "M月d日 · EEEE", { locale: zhCN })}
            </h3>
          </div>
          <span className="calendar-detail-count">
            {selectedTasks.length ? `${selectedTasks.length} 件` : "空"}
          </span>
        </div>

        {selectedTasks.length > 0 ? (
          <div className="calendar-detail-list">
            {selectedTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                note={task.noteId ? noteMap.get(task.noteId) : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="calendar-detail-empty">
            <span>这一天没有到期的任务。</span>
            <span>可以在上方快速添加任务，或选择其他日期。</span>
          </div>
        )}

        <div className="calendar-foot">
          <span>
            <ListTodo size={13} />
            {unscheduled.length > 0 ? `另有 ${unscheduled.length} 个任务没有截止日期` : "所有未完成任务都有截止日期"}
          </span>
          <button type="button" onClick={onShowList}>
            切换到列表
          </button>
        </div>
      </div>
    </section>
  );
}
