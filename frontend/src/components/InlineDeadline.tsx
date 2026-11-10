import { useEffect, useRef, useState } from "react";
import { Button, Checkbox } from "antd";
import { DateTime } from "luxon";
import type { Task } from "../api";
import { deadlineInstant, deadlineLabel, quickDeadlineOptions } from "../tasks";

export default function InlineDeadline({
  task,
  timezone,
  onChange,
  compact = false,
}: {
  task: Task;
  timezone: string;
  onChange: (deadline_at: string | null, deadline_all_day: boolean) => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("18:00");
  const [allDay, setAllDay] = useState(false);
  const dateInput = useRef<HTMLInputElement>(null);
  const now = DateTime.now().setZone(timezone);
  const overdue =
    !!task.deadline_at && DateTime.fromISO(task.deadline_at) < now;
  const presets = quickDeadlineOptions(now);

  useEffect(() => {
    if (editing) dateInput.current?.focus();
  }, [editing]);

  const open = () => {
    if (task.deadline_at) {
      const local = DateTime.fromISO(task.deadline_at).setZone(timezone);
      setDate(local.toFormat("yyyy-MM-dd"));
      setTime(local.toFormat("HH:mm"));
    } else {
      setDate("");
      setTime("18:00");
    }
    setAllDay(task.deadline_all_day);
    setEditing(true);
  };

  const save = () => {
    if (!date) {
      onChange(null, false);
      setEditing(false);
      return;
    }
    const value = deadlineInstant(
      allDay ? date : `${date}T${time}`,
      allDay,
      timezone,
    );
    onChange(value, allDay);
    setEditing(false);
  };

  if (editing) {
    return (
      <div
        className="inline-deadline-editor"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditing(false);
          if (event.key === "Enter") save();
        }}
      >
        <input
          ref={dateInput}
          type="date"
          aria-label="截止日期"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        {!allDay && (
          <input
            type="time"
            aria-label="截止时间"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        )}
        <Checkbox
          checked={allDay}
          onChange={(event) => setAllDay(event.target.checked)}
        >
          全天
        </Checkbox>
        <div className="inline-deadline-presets">
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className="text-action"
              onClick={() => {
                onChange(preset.deadline_at, preset.deadline_all_day);
                setEditing(false);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <Button type="primary" size="small" onClick={save}>
          保存
        </Button>
        <button
          type="button"
          className="text-action"
          onClick={() => setEditing(false)}
        >
          取消
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`${overdue ? "text-action row-deadline danger-text" : "text-action row-deadline"}${compact && (!task.deadline_at || task.deadline_all_day) ? " task-date-in-group" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      aria-label={`修改截止时间：${deadlineLabel(task.deadline_at, task.deadline_all_day, timezone)}`}
    >
      {compact && task.deadline_at && !task.deadline_all_day
        ? DateTime.fromISO(task.deadline_at).setZone(timezone).toFormat("HH:mm")
        : task.deadline_at
          ? `${overdue ? "已逾期 · " : ""}${deadlineLabel(
              task.deadline_at,
              task.deadline_all_day,
              timezone,
            )}`
          : "＋ 截止"}
    </button>
  );
}
