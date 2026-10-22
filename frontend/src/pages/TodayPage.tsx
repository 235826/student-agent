import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Empty, Space, Spin } from "antd";
import { DateTime } from "luxon";
import { api, type Plan, type Event, type Task, type Profile } from "../api";
import { displayTime } from "../time";
import { withFrom } from "../navigation";
import { eventTypeLabel, staleInfo } from "../semantics";

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
        to: `/calendar/events/${e.id}`,
        kind: eventTypeLabel(e),
        stale: false,
      })),
    ...(plan.data?.blocks ?? []).map((b) => ({
      id: `${b.task_id}-${b.start_at}`,
      title: b.title,
      start: b.start_at,
      end: b.end_at,
      to: `/tasks/${b.task_id}`,
      kind: "计划块",
      stale: !!plan.data?.stale,
    })),
  ]
    .filter(
      (a) =>
        DateTime.fromISO(a.start) < tomorrow && DateTime.fromISO(a.end) > day,
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  const next = agenda.find(
    (a) => !a.stale && DateTime.fromISO(a.end) > now,
  );
  const stale = plan.data ? staleInfo(plan.data) : null;
  const due = (tasks.data ?? [])
    .filter(
      (t) =>
        !["done", "cancelled"].includes(t.status) &&
        t.deadline_at &&
        DateTime.fromISO(t.deadline_at) < now.plus({ days: 3 }),
    )
    .sort((a, b) => a.deadline_at!.localeCompare(b.deadline_at!));
  const nextDue = due[0];
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
          <Link to="/tasks/new?from=/">新建任务</Link>
          <Link
            to={`/calendar/events/new?date=${now.toFormat(
              "yyyy-MM-dd",
            )}&from=/`}
          >
            新建事件
          </Link>
          <Link to="/calendar">查看本周</Link>
        </Space>
      </header>
      {error && <Alert type="error" message={error.message} />}
      {stale && (
        <Alert
          type="warning"
          message={stale.detail}
          action={<Link to="/plans/new?from=/">重新生成</Link>}
        />
      )}
      {plan.isPending || events.isPending || tasks.isPending ? (
        <Spin />
      ) : (
        <>
          <Card className="toolbar" title="接下来">
            {next ? (
              <Link to={withFrom(next.to, "/")}>
                {next.title} · {next.kind} ·{" "}
                {displayTime(next.start, profile.timezone)}
              </Link>
            ) : nextDue ? (
              <Link to={withFrom(`/tasks/${nextDue.id}`, "/")}>
                {nextDue.title} ·{" "}
                {DateTime.fromISO(nextDue.deadline_at!) < now
                  ? "已逾期"
                  : "最近截止"}{" "}
                · {displayTime(nextDue.deadline_at, profile.timezone)}
              </Link>
            ) : (
              <p>
                今天没有更多安排。
                {!plan.data && (
                  <>
                    {" "}
                    <Link to="/plans/new?from=/">生成计划草稿</Link>
                  </>
                )}
              </p>
            )}
          </Card>
          <Card className="toolbar" title="当天议程">
            {agenda.length ? (
              agenda.map((a) => (
                <p key={a.id}>
                  <span>
                    {displayTime(a.start, profile.timezone)} · {a.kind}
                    {a.stale ? "（旧计划）" : ""} ·{" "}
                  </span>
                  <Link to={withFrom(a.to, "/")}>{a.title}</Link>
                </p>
              ))
            ) : (
              <Empty description="今天没有事件或计划块" />
            )}
          </Card>
          <Card title="逾期与 72 小时内到期">
            {due.length ? (
              due.map((t) => (
                <p key={t.id}>
                  <Link to={withFrom(`/tasks/${t.id}`, "/")}>{t.title}</Link> ·{" "}
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
