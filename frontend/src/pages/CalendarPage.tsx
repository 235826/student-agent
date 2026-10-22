import { useQuery } from "@tanstack/react-query";
import { Alert, Card } from "antd";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import luxonPlugin from "@fullcalendar/luxon3";
import zhLocale from "@fullcalendar/core/locales/zh-cn";
import { api, type Plan, type Event, type Profile } from "../api";
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
export default function CalendarPage({ profile }: { profile: Profile }) {
  const plan = useQuery({
    queryKey: ["plans", "current"],
    queryFn: () => api<Plan | null>("/plans/current"),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">YOUR WEEK</div>
          <h1>留出时间，专注当下</h1>
          <p className="muted">
            查看固定安排，从容开始本周。当前时区：{profile.timezone}
          </p>
        </div>
      </header>
      <Alert
        type="info"
        message={
          plan.data?.stale
            ? "当前计划的依据已变化，请到学习计划页重新生成并确认。"
            : "展示固定事件与已采用的任务工作块；可到学习计划页生成草稿。"
        }
      />
      {events.error && <Alert type="error" message={errorText(events.error)} />}
      <Card className="calendar">
        <FullCalendar
          plugins={[timeGridPlugin, listPlugin, luxonPlugin]}
          locale={zhLocale}
          timeZone={profile.timezone}
          initialView={window.innerWidth < 700 ? "listWeek" : "timeGridWeek"}
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "timeGridWeek,listWeek",
          }}
          height="auto"
          allDaySlot={false}
          slotMinTime="00:00:00"
          slotMaxTime="24:00:00"
          events={[
            ...(events.data?.map((e) => ({
              id: e.id,
              title: e.title + (e.is_skipped ? "（本次不参加）" : ""),
              start: e.start_at,
              end: e.end_at,
              color: e.is_skipped ? "#a6a6a6" : "#37735c",
            })) ?? []),
            ...(plan.data?.blocks.map((b) => ({
              id: `${b.task_id}-${b.start_at}`,
              title: b.title,
              start: b.start_at,
              end: b.end_at,
              color: "#3873ac",
            })) ?? []),
          ]}
        />
      </Card>
    </>
  );
}
