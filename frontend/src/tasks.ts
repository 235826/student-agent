import { DateTime } from "luxon";
import type { Task, TaskInput } from "./api";
import { toInstant } from "./time";

export type QuickDeadline = {
  key: string;
  label: string;
  deadline_at: string | null;
  deadline_all_day: boolean;
};

export function toTaskInput(
  task: Task,
  status: Task["status"] = task.status,
): TaskInput {
  return {
    title: task.title,
    description: task.description,
    links: task.links,
    status,
    priority: task.priority,
    deadline_at: task.deadline_at,
    deadline_all_day: task.deadline_all_day,
    estimate_minutes: task.estimate_minutes,
    task_type: task.task_type,
    recurrence: task.recurrence,
    flagged: task.flagged,
    list_id: task.list_id,
    tags: task.tags,
    parent_id: task.parent_id,
    predecessor_ids: task.predecessor_ids,
    parallel_policy: task.parallel_policy,
    confirm_impact: false,
  };
}

export function quickDeadlineOptions(now: DateTime): QuickDeadline[] {
  const endOfDay = (value: DateTime) => value.endOf("day").toISO()!;
  const weekend = now.plus({ days: (7 - now.weekday + 7) % 7 });
  const nextMonday = now.plus({ days: (8 - now.weekday) % 7 || 7 });
  return [
    {
      key: "today",
      label: "今天",
      deadline_at: endOfDay(now),
      deadline_all_day: true,
    },
    {
      key: "tomorrow",
      label: "明天",
      deadline_at: endOfDay(now.plus({ days: 1 })),
      deadline_all_day: true,
    },
    {
      key: "weekend",
      label: "本周末",
      deadline_at: endOfDay(weekend),
      deadline_all_day: true,
    },
    {
      key: "next_week",
      label: "下周一",
      deadline_at: endOfDay(nextMonday),
      deadline_all_day: true,
    },
    {
      key: "clear",
      label: "清除截止",
      deadline_at: null,
      deadline_all_day: false,
    },
  ];
}

export function deadlineInstant(value: string, allDay: boolean, zone: string) {
  if (!value) return null;
  if (!allDay) return toInstant(value, zone);
  const deadline = DateTime.fromISO(value, { zone });
  if (!deadline.isValid) throw new Error("请选择有效的截止日期");
  return deadline.endOf("day").toISO();
}

export function recurrenceLabel(value: string | null | undefined) {
  if (value === "daily") return "每天";
  if (value === "weekly") return "每周";
  if (value === "monthly") return "每月";
  return "";
}

export function deadlineLabel(
  value: string | null | undefined,
  allDay: boolean,
  zone: string,
) {
  if (!value) return "未设置";
  const deadline = DateTime.fromISO(value).setZone(zone);
  return allDay ? deadline.toFormat("M月d日") : deadline.toFormat("MM-dd HH:mm");
}
