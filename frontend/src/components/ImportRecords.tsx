import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Collapse, Empty, Select, Spin } from "antd";
import { DateTime } from "luxon";
import { api, type ImportJob } from "../api";
export const importLabels: Record<string, string> = {
  queued: "等待解析",
  running: "正在解析",
  succeeded: "待校对",
  failed: "解析失败",
  cancelled: "已取消解析",
  published: "已创建",
};
export default function ImportRecords({
  timezone,
  pendingOnly = false,
}: {
  timezone: string;
  pendingOnly?: boolean;
}) {
  const [filter, setFilter] = useState("all");
  const list = useQuery({
    queryKey: ["imports"],
    queryFn: () => api<ImportJob[]>("/imports"),
    refetchInterval: 5000,
  });
  const items = (list.data ?? []).filter(
    (j) =>
      !j.source.deleted_at &&
      (!pendingOnly || !j.published_revision) &&
      (filter === "all" ||
        (j.published_revision ? "published" : j.status) === filter),
  );
  const groups = new Map<string, ImportJob[]>();
  for (const item of items) {
    const key =
      DateTime.fromISO(item.created_at)
        .setZone(timezone)
        .toFormat("yyyy-MM-dd") +
      " · " +
      importLabels[item.published_revision ? "published" : item.status];
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return (
    <>
      <Select
        className="activity-select"
        aria-label="筛选导入状态"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "全部状态" },
          ...Object.entries(importLabels)
            .filter(([key]) => !pendingOnly || key !== "published")
            .map(([value, label]) => ({ value, label })),
        ]}
      />
      {list.error ? (
        <Alert type="error" message={list.error.message} />
      ) : list.isPending ? (
        <Spin />
      ) : !items.length ? (
        <Empty description="没有符合条件的导入记录" />
      ) : (
        <Collapse
          defaultActiveKey={[...groups.keys()][0]}
          items={[...groups].map(([key, jobs]) => ({
            key,
            label: `${key}（${jobs.length} 批）`,
            children: jobs.map((job) => (
              <p key={job.id}>
                <Link to={`/inbox/imports/${job.id}`}>
                  {job.source.kind === "image"
                    ? "课表图片"
                    : job.source.text.slice(0, 60) || "文本材料"}{" "}
                  ·{" "}
                  {DateTime.fromISO(job.created_at)
                    .setZone(timezone)
                    .toFormat("HH:mm")}
                </Link>
              </p>
            )),
          }))}
        />
      )}
    </>
  );
}
