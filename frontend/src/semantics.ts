import { DateTime } from "luxon";
import type { Plan } from "./api";

export const priorities = [4, 3, 2, 1].map((value) => ({
  value,
  label: ["低", "普通", "高", "紧急"][value - 1],
}));

export function priorityLabel(value: number) {
  return ["低", "普通", "高", "紧急"][value - 1] ?? "普通";
}

export function staleInfo(plan: Plan) {
  if (!plan.stale) return null;
  const expired =
    plan.status === "draft" &&
    DateTime.fromISO(plan.start_at) < DateTime.now();
  return expired
    ? {
        short: "时间已过",
        detail: "计划开始时间已过，不能再采用；请按当前时间重新生成。",
      }
    : {
        short: "依据已变化",
        detail: "任务、课表或规则已变化；请重新生成计划并确认采用。",
      };
}
