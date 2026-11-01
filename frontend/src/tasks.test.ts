import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  deadlineInstant,
  deadlineLabel,
  quickDeadlineOptions,
} from "./tasks";

describe("任务快捷改期", () => {
  const now = DateTime.fromISO("2026-11-01T10:00:00", {
    zone: "Asia/Shanghai",
  });

  it("按本地时区生成今天、明天、本周末和下周一", () => {
    const options = Object.fromEntries(
      quickDeadlineOptions(now).map((item) => [item.key, item]),
    );
    expect(options.today.deadline_at).toBe("2026-11-01T23:59:59.999+08:00");
    expect(options.tomorrow.deadline_at).toBe("2026-11-02T23:59:59.999+08:00");
    expect(options.weekend.deadline_at).toBe("2026-11-01T23:59:59.999+08:00");
    expect(options.next_week.deadline_at).toBe("2026-11-02T23:59:59.999+08:00");
    expect(options.clear.deadline_at).toBeNull();
  });

  it("全天截止归一到当天结束", () => {
    expect(
      deadlineInstant("2026-11-02T09:00", true, "Asia/Shanghai"),
    ).toBe("2026-11-02T23:59:59.999+08:00");
    expect(
      deadlineInstant("2026-11-02T09:00", false, "Asia/Shanghai"),
    ).toBe("2026-11-02T09:00:00.000+08:00");
    expect(deadlineInstant("", true, "Asia/Shanghai")).toBeNull();
  });

  it("全天截止只展示日期", () => {
    expect(deadlineLabel("2026-11-02T15:59:00Z", true, "Asia/Shanghai")).toBe(
      "11月2日",
    );
    expect(deadlineLabel("2026-11-02T15:59:00Z", false, "Asia/Shanghai")).toBe(
      "11-02 23:59",
    );
  });
});
