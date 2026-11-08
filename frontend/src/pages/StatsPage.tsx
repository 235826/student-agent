import { Alert, Empty, Select, Spin, Statistic } from "antd";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CompletionStats } from "../api";

export default function StatsPage() {
  const [days, setDays] = useState(14);
  const stats = useQuery({
    queryKey: ["tasks", "stats", days],
    queryFn: () => api<CompletionStats>(`/stats/completion?days=${days}`),
  });
  if (stats.isPending) return <Spin />;
  if (stats.error)
    return <Alert type="error" message={stats.error.message} />;
  const data = stats.data!;
  const max = Math.max(1, ...data.days.map((day) => day.count));
  return (
    <>
      <header>
        <div>
          <h1>完成统计</h1>
          <p className="muted">最近 {days} 天的任务完成情况。</p>
        </div>
        <Select
          aria-label="统计范围"
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: "最近 7 天" },
            { value: 14, label: "最近 14 天" },
            { value: 30, label: "最近 30 天" },
          ]}
          style={{ width: 128 }}
        />
      </header>
      <div className="stats-summary">
        <div className="stat-block">
          <Statistic title="今天完成" value={data.today} />
        </div>
        <div className="stat-block">
          <Statistic title="本周完成" value={data.week} />
        </div>
        <div className="stat-block">
          <Statistic title="本月完成" value={data.month} />
        </div>
      </div>
      <section className="section toolbar">
        <h3>最近 {days} 天</h3>
        <div className="stats-bars">
          {data.days.map((day) => (
            <div
              className="stats-bar"
              key={day.date}
              title={`${day.date}：${day.count} 项`}
            >
              <span className="stats-bar-count">{day.count || ""}</span>
              <div className="stats-bar-track">
                <div
                  className="stats-bar-fill"
                  style={{ height: `${(day.count / max) * 100}%` }}
                />
              </div>
              <span className="stats-bar-label">{day.date.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="section toolbar">
        <h3>估时与实耗</h3>
        <div className="stats-minutes">
          <Statistic title="预计用时（分钟）" value={data.estimate_minutes} />
          <Statistic title="实际用时（分钟）" value={data.actual_minutes} />
        </div>
      </section>
      {data.days.every((day) => day.count === 0) && (
        <Empty description="最近还没有完成记录" />
      )}
    </>
  );
}
