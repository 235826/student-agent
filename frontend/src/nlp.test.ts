import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { parseQuickAdd } from "./nlp";

const zone = "Asia/Shanghai";
const lists = [
  { id: "life", name: "生活" },
  { id: "course", name: "课程" },
];

describe("自然语言快速添加", () => {
  const now = DateTime.fromISO("2026-11-01T10:00:00", { zone });

  it("解析日期、时间、标签、优先级和预计用时", () => {
    const parsed = parseQuickAdd(
      "明天下午3点交高数作业 #数学 !高 预计30分钟",
      now,
      zone,
      lists,
    );
    expect(parsed.title).toBe("交高数作业");
    expect(parsed.deadline_at).toBe("2026-11-02T15:00:00.000+08:00");
    expect(parsed.deadline_all_day).toBe(false);
    expect(parsed.priority).toBe(3);
    expect(parsed.tags).toEqual(["数学"]);
    expect(parsed.estimate_minutes).toBe(30);
    expect(parsed.list_id).toBeNull();
  });

  it("解析周几、中文时间和清单", () => {
    const parsed = parseQuickAdd(
      "周五晚上8点半看电影 @生活",
      now,
      zone,
      lists,
    );
    expect(parsed.title).toBe("看电影");
    expect(parsed.deadline_at).toBe("2026-11-06T20:30:00.000+08:00");
    expect(parsed.list_id).toBe("life");
  });

  it("只有日期时按全天处理", () => {
    const parsed = parseQuickAdd("今天交作业", now, zone, lists);
    expect(parsed.title).toBe("交作业");
    expect(parsed.deadline_all_day).toBe(true);
    expect(parsed.deadline_at).toBe("2026-11-01T23:59:59.999+08:00");
  });

  it("只有时间且已过时顺延到明天", () => {
    const later = DateTime.fromISO("2026-11-01T16:00:00", { zone });
    const parsed = parseQuickAdd("下午3点写作业", later, zone, lists);
    expect(parsed.deadline_at).toBe("2026-11-02T15:00:00.000+08:00");
    expect(parsed.title).toBe("写作业");
  });

  it("周几的时间已过时顺延到下一周", () => {
    const monday = DateTime.fromISO("2026-11-02T16:00:00", { zone });
    const parsed = parseQuickAdd("周一15:00开会", monday, zone, lists);
    expect(parsed.deadline_at).toBe("2026-11-09T15:00:00.000+08:00");
    expect(parsed.title).toBe("开会");
  });

  it("保留没有元数据的普通标题", () => {
    const parsed = parseQuickAdd("买牛奶", now, zone, lists);
    expect(parsed.title).toBe("买牛奶");
    expect(parsed.deadline_at).toBeNull();
    expect(parsed.tags).toEqual([]);
    expect(parsed.chips).toEqual([]);
  });

  it("只有元数据时提示补充标题", () => {
    const parsed = parseQuickAdd("明天 #数学", now, zone, lists);
    expect(parsed.title).toBe("");
    expect(parsed.warnings).toEqual(["请补充任务标题"]);
  });
});
