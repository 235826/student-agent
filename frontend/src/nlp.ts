import { DateTime } from "luxon";

export type QuickAddList = { id: string; name: string };

export type QuickAddChip = { key: string; label: string };

export type ParsedQuickAdd = {
  title: string;
  deadline_at: string | null;
  deadline_all_day: boolean;
  priority: number;
  tags: string[];
  estimate_minutes: number | null;
  list_id: string | null;
  chips: QuickAddChip[];
  warnings: string[];
};

type DateSource = "today" | "relative" | "weekday" | "explicit";

const priorityNames: Record<string, number> = {
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  低: 1,
  普通: 2,
  高: 3,
  紧急: 4,
};

const priorityLabels: Record<number, string> = {
  1: "低",
  2: "普通",
  3: "高",
  4: "紧急",
};

const weekdayNumbers: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localDate(zone: string, year: number, month: number, day: number) {
  const value = DateTime.fromObject({ year, month, day }, { zone });
  if (
    !value.isValid ||
    value.year !== year ||
    value.month !== month ||
    value.day !== day
  )
    return null;
  return value.startOf("day");
}

function upcomingWeekday(
  now: DateTime,
  nextWeek: boolean,
  weekday: number,
) {
  const monday = now.startOf("day").minus({ days: now.weekday - 1 });
  if (nextWeek) return monday.plus({ weeks: 1, days: weekday - 1 });
  const candidate = monday.plus({ days: weekday - 1 });
  return candidate < now.startOf("day") ? candidate.plus({ weeks: 1 }) : candidate;
}

function parseDate(text: string, now: DateTime, zone: string) {
  let remaining = text;
  let date: DateTime | null = null;
  let source: DateSource | null = null;

  for (const [pattern, days] of [
    [/(?:大后天)/, 3],
    [/(?:后天)/, 2],
    [/(?:明天|明日)/, 1],
    [/(?:今天|今日)/, 0],
  ] as const) {
    const match = remaining.match(pattern);
    if (!match) continue;
    date = now.startOf("day").plus({ days });
    source = days === 0 ? "today" : "relative";
    remaining = remaining.replace(match[0], " ");
    break;
  }

  if (!date) {
    const nextWeek = remaining.match(/下周([一二三四五六日天])/);
    if (nextWeek) {
      date = upcomingWeekday(now, true, weekdayNumbers[nextWeek[1]]);
      source = "weekday";
      remaining = remaining.replace(nextWeek[0], " ");
    }
  }

  if (!date) {
    const weekday = remaining.match(/(?:周|星期)([一二三四五六日天])/);
    if (weekday) {
      date = upcomingWeekday(now, false, weekdayNumbers[weekday[1]]);
      source = "weekday";
      remaining = remaining.replace(weekday[0], " ");
    }
  }

  if (!date) {
    const full = remaining.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (full) {
      const value = localDate(
        zone,
        Number(full[1]),
        Number(full[2]),
        Number(full[3]),
      );
      if (value) {
        date = value;
        source = "explicit";
        remaining = remaining.replace(full[0], " ");
      }
    }
  }

  if (!date) {
    const chinese = remaining.match(/(\d{1,2})月(\d{1,2})日?/);
    if (chinese) {
      const value = localDate(
        zone,
        now.year,
        Number(chinese[1]),
        Number(chinese[2]),
      );
      if (value) {
        date = value;
        source = "explicit";
        remaining = remaining.replace(chinese[0], " ");
      }
    }
  }

  if (!date) {
    const short = remaining.match(/(\d{1,2})\/(\d{1,2})/);
    if (short) {
      let value = localDate(zone, now.year, Number(short[1]), Number(short[2]));
      if (value && value < now.startOf("day"))
        value = localDate(zone, now.year + 1, Number(short[1]), Number(short[2]));
      if (value) {
        date = value;
        source = "explicit";
        remaining = remaining.replace(short[0], " ");
      }
    }
  }

  return { remaining, date, source };
}

function parseTime(text: string) {
  let remaining = text;
  let hour: number | null = null;
  let minute = 0;

  const clock = remaining.match(/(\d{1,2}):(\d{2})/);
  if (clock) {
    hour = Number(clock[1]);
    minute = Number(clock[2]);
    remaining = remaining.replace(clock[0], " ");
  } else {
    const chinese = remaining.match(
      /(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/,
    );
    if (chinese) {
      hour = Number(chinese[2]);
      const period = chinese[1];
      const fraction = chinese[3];
      if (fraction === "半") minute = 30;
      else if (chinese[4]) minute = Number(chinese[4]);
      if (period === "下午" || period === "晚上") {
        if (hour < 12) hour += 12;
      } else if (period === "中午") {
        if (hour < 11) hour += 12;
      } else if (period === "凌晨") {
        if (hour === 12) hour = 0;
      } else if (period === "早上" || period === "上午") {
        if (hour === 12) hour = 0;
      }
      remaining = remaining.replace(chinese[0], " ");
    }
  }

  if (hour === null || hour > 23 || minute > 59)
    return { remaining: text, hour: null, minute: 0 };
  return { remaining, hour, minute };
}

export function parseQuickAdd(
  text: string,
  now: DateTime,
  zone: string,
  lists: QuickAddList[],
): ParsedQuickAdd {
  let remaining = text;

  const tags: string[] = [];
  remaining = remaining.replace(
    /(^|\s)#([^\s#@!，,。;；]+)/g,
    (_match, _lead: string, tag: string) => {
      if (tags.length < 20 && tag.length <= 50 && !tags.includes(tag))
        tags.push(tag);
      return " ";
    },
  );

  let priority = 2;
  const priorityMatch = remaining.match(
    /(?:^|\s)!([1-4]|低|普通|高|紧急)(?=\s|$)/,
  );
  if (priorityMatch) {
    priority = priorityNames[priorityMatch[1]];
    remaining = remaining.replace(priorityMatch[0], " ");
  }

  let estimate: number | null = null;
  const estimateMatch = remaining.match(
    /(?:预计|用时)\s*(\d+(?:\.\d+)?)\s*(分钟|分|小时|h|min)/i,
  );
  if (estimateMatch) {
    const value = Number(estimateMatch[1]);
    const minutes =
      estimateMatch[2] === "小时" || estimateMatch[2].toLowerCase() === "h"
        ? value * 60
        : value;
    if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 100000) {
      estimate = Math.round(minutes);
      remaining = remaining.replace(estimateMatch[0], " ");
    }
  }

  let listId: string | null = null;
  for (const list of [...lists].sort((a, b) => b.name.length - a.name.length)) {
    const pattern = new RegExp(
      `(^|\\s)@${escapeRegExp(list.name)}(?=\\s|$)`,
    );
    if (!pattern.test(remaining)) continue;
    listId = list.id;
    remaining = remaining.replace(pattern, " ");
    break;
  }

  const dateResult = parseDate(remaining, now, zone);
  remaining = dateResult.remaining;
  const timeResult = parseTime(remaining);
  remaining = timeResult.remaining;

  let deadline: DateTime | null = null;
  let allDay = false;
  if (dateResult.date && timeResult.hour !== null) {
    deadline = dateResult.date.set({
      hour: timeResult.hour,
      minute: timeResult.minute,
      second: 0,
      millisecond: 0,
    });
    if (dateResult.source === "weekday" && deadline <= now)
      deadline = deadline.plus({ weeks: 1 });
  } else if (dateResult.date) {
    deadline = dateResult.date.endOf("day");
    allDay = true;
  } else if (timeResult.hour !== null) {
    deadline = now.startOf("day").set({
      hour: timeResult.hour,
      minute: timeResult.minute,
      second: 0,
      millisecond: 0,
    });
    if (deadline <= now) deadline = deadline.plus({ days: 1 });
  }

  const title = remaining.replace(/\s+/g, " ").trim();
  const chips: QuickAddChip[] = [];
  if (deadline) {
    chips.push({
      key: "deadline",
      label: allDay
        ? `截止 ${deadline.toFormat("M月d日")}`
        : `截止 ${deadline.toFormat("M月d日 HH:mm")}`,
    });
  }
  if (priority !== 2)
    chips.push({ key: "priority", label: `优先级 ${priorityLabels[priority]}` });
  for (const tag of tags) chips.push({ key: `tag:${tag}`, label: `#${tag}` });
  if (estimate !== null)
    chips.push({ key: "estimate", label: `预计 ${estimate} 分钟` });
  if (listId) {
    const list = lists.find((item) => item.id === listId);
    if (list) chips.push({ key: "list", label: `清单 ${list.name}` });
  }

  return {
    title,
    deadline_at: deadline?.toISO() ?? null,
    deadline_all_day: deadline ? allDay : false,
    priority,
    tags,
    estimate_minutes: estimate,
    list_id: listId,
    chips,
    warnings: title ? [] : ["请补充任务标题"],
  };
}
