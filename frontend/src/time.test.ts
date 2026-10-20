import { describe, expect, it } from "vitest";
import { toInstant, toLocal, displayTime } from "./time";
describe("时区转换", () => {
  it("改变显示时区不改变真实时间", () => {
    const instant = toInstant("2026-10-21T09:00", "Asia/Shanghai")!;
    expect(toLocal(instant, "UTC")).toBe("2026-10-21T01:00");
    expect(displayTime(instant, "Asia/Shanghai")).toBe("10-21 09:00");
  });
  it("拒绝夏令时不存在和重复时刻", () => {
    expect(() => toInstant("2026-03-08T02:30", "America/New_York")).toThrow();
    expect(() => toInstant("2026-11-01T01:30", "America/New_York")).toThrow();
  });
  it("没有截止时间时保持为空", () => expect(toInstant("", "UTC")).toBeNull());
});
