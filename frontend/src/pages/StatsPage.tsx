import { Alert, Card, Empty, Spin, Statistic } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api, type CompletionStats } from "../api";

export default function StatsPage() {
  const stats = useQuery({
    queryKey: ["tasks", "stats", 14],
    queryFn: () => api<CompletionStats>("/stats/completion?days=14"),
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
          <p className="muted">最近 14 天的任务完成情况。</p>
        </div>
      </header>
      <div className="stats-summary">
        <Card>
          <Statistic title="今天完成" value={data.today} />
        </Card>
        <Card>
          <Statistic title="本周完成" value={data.week} />
        </Card>
        <Card>
          <Statistic title="本月完成" value={data.month} />
        </Card>
      </div>
      <Card title="最近 14 天" className="toolbar">
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
      </Card>
      <Card title="估时与实耗" className="toolbar">
        <div className="stats-minutes">
          <Statistic title="预计用时（分钟）" value={data.estimate_minutes} />
          <Statistic title="实际用时（分钟）" value={data.actual_minutes} />
        </div>
      </Card>
      {data.days.every((day) => day.count === 0) && (
        <Empty description="最近还没有完成记录" />
      )}
    </>
  );
}
