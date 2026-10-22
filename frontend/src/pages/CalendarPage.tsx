import { useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card } from "antd";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import luxonPlugin from "@fullcalendar/luxon3";
import zhLocale from "@fullcalendar/core/locales/zh-cn";
import { DateTime } from "luxon";
import { api, type Plan, type Event, type Profile } from "../api";
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
export default function CalendarPage({
  profile,
  week,
  onWeekChange,
}: {
  profile: Profile;
  week?: string;
  onWeekChange?: (day: string) => void;
}) {
  const navigate = useNavigate();
  const calendar = useRef<FullCalendar | null>(null);
  const plan = useQuery({
    queryKey: ["plans", "current"],
    queryFn: () => api<Plan | null>("/plans/current"),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  useEffect(() => {
    if (!week) return;
    const view = calendar.current?.getApi();
    if (!view) return;
    const current = DateTime.fromJSDate(view.view.currentStart)
      .setZone(profile.timezone)
      .toISODate();
    if (current !== week) view.gotoDate(week);
  }, [week, profile.timezone]);
  return (
    <>
      {(events.error || plan.error) && (
        <Alert type="error" message={errorText(events.error ?? plan.error)} />
      )}
      {plan.data?.stale && (
        <Alert
          type="warning"
          message="当前计划已过期，灰色工作块仅作历史展示；请重新生成并确认采用。"
          action={<Link to="/plans">查看计划</Link>}
        />
      )}
      <Card className="calendar">
        <FullCalendar
          ref={calendar}
          plugins={[timeGridPlugin, listPlugin, luxonPlugin]}
          locale={zhLocale}
          timeZone={profile.timezone}
          initialDate={week}
          initialView={window.innerWidth < 700 ? "listWeek" : "timeGridWeek"}
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "timeGridWeek,listWeek",
          }}
          height="auto"
          datesSet={(info) => onWeekChange?.(info.startStr.slice(0, 10))}
          eventClick={(info) => navigate(info.event.extendedProps.to)}
          eventContent={(arg) => (
            <div className="fc-event-body">
              {arg.timeText && (
                <div className="fc-event-time">{arg.timeText}</div>
              )}
              <div className="fc-event-title">{arg.event.title}</div>
              {arg.event.extendedProps.note && (
                <div className="fc-event-note">
                  {arg.event.extendedProps.note}
                </div>
              )}
            </div>
          )}
          allDaySlot={false}
          slotMinTime="00:00:00"
          slotMaxTime="24:00:00"
          events={[
            ...(events.data?.map((e) => ({
              id: e.id,
              to: week ? `/events/${e.id}?week=${week}` : `/events/${e.id}`,
              title: e.title + (e.is_skipped ? "（本次不参加）" : ""),
              start: e.start_at,
              end: e.end_at,
              note: e.note,
              color: e.is_skipped ? "#a6a6a6" : "#37735c",
            })) ?? []),
            ...(plan.data?.blocks.map((b) => ({
              id: `${b.task_id}-${b.start_at}`,
              to: `/tasks/${b.task_id}`,
              title: b.title,
              start: b.start_at,
              end: b.end_at,
              note: "",
              color: plan.data?.stale ? "#9ca3af" : "#3873ac",
            })) ?? []),
          ]}
        />
      </Card>
    </>
  );
}
