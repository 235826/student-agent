import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Empty, Space, Spin } from "antd";
import { DateTime } from "luxon";
import { api, type Plan, type Event, type Task, type Profile } from "../api";
import { displayTime } from "../time";

export default function TodayPage({ profile }: { profile: Profile }) {
  const plan = useQuery({
    queryKey: ["plans", "current"],
    queryFn: () => api<Plan | null>("/plans/current"),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const tasks = useQuery({
    queryKey: ["tasks", false],
    queryFn: () => api<Task[]>("/tasks"),
  });
  const now = DateTime.now().setZone(profile.timezone);
  const day = now.startOf("day");
  const tomorrow = day.plus({ days: 1 });
  const agenda = [
    ...(events.data ?? [])
      .filter((e) => !e.is_skipped)
      .map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start_at,
        end: e.end_at,
        to: `/events/${e.id}`,
        kind: "固定事件",
      })),
    ...(plan.data?.blocks ?? []).map((b) => ({
      id: `${b.task_id}-${b.start_at}`,
      title: b.title,
      start: b.start_at,
      end: b.end_at,
      to: `/tasks/${b.task_id}`,
      kind: "计划任务",
    })),
  ]
    .filter(
      (a) =>
        DateTime.fromISO(a.start) < tomorrow && DateTime.fromISO(a.end) > day,
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  const next = agenda.find(
    (a) => a.kind === "计划任务" && DateTime.fromISO(a.end) > now,
  );
  const due = (tasks.data ?? [])
    .filter(
      (t) =>
        !["done", "cancelled"].includes(t.status) &&
        t.deadline_at &&
        DateTime.fromISO(t.deadline_at) < now.plus({ days: 3 }),
    )
    .sort((a, b) => a.deadline_at!.localeCompare(b.deadline_at!));
  const error = plan.error ?? events.error ?? tasks.error;
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">TODAY</div>
          <h1>今日工作台</h1>
          <p className="muted">
            {now.toFormat("yyyy-MM-dd")} · {profile.timezone}
          </p>
        </div>
        <Space wrap>
          <Link to="/tasks?new=1">新建任务</Link>
          <Link to="/calendar?new=1">新建事件</Link>
          <Link to="/calendar">查看本周</Link>
        </Space>
      </header>
      {error && <Alert type="error" message={error.message} />}
      {plan.data?.stale && (
        <Alert
          type="warning"
          message="当前计划依据已变化；原计划保留，重新生成后需确认采用。"
          action={<Link to="/plans">重新生成</Link>}
        />
      )}
      {plan.isPending || events.isPending || tasks.isPending ? (
        <Spin />
      ) : (
        <>
          <Card className="toolbar" title="下一项任务">
            {next ? (
              <Link to={next.to}>
                {next.title} · {displayTime(next.start, profile.timezone)}
              </Link>
            ) : (
              <p>
                今天没有待执行的计划任务。<Link to="/plans">生成计划草稿</Link>
              </p>
            )}
          </Card>
          <Card className="toolbar" title="当天议程">
            {agenda.length ? (
              agenda.map((a) => (
                <p key={a.id}>
                  <span>
                    {displayTime(a.start, profile.timezone)} · {a.kind} ·{" "}
                  </span>
                  <Link to={a.to}>{a.title}</Link>
                </p>
              ))
            ) : (
              <Empty description="今天没有固定安排或计划块" />
            )}
          </Card>
          <Card title="逾期与三天内到期">
            {due.length ? (
              due.map((t) => (
                <p key={t.id}>
                  <Link to={`/tasks/${t.id}`}>{t.title}</Link> ·{" "}
                  {DateTime.fromISO(t.deadline_at!) < now
                    ? "已逾期"
                    : "即将到期"}{" "}
                  · {displayTime(t.deadline_at, profile.timezone)}
                </p>
              ))
            ) : (
              <Empty description="暂无临近截止的任务" />
            )}
          </Card>
        </>
      )}
    </>
  );
}
