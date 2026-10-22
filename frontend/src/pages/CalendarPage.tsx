import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card } from "antd";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import luxonPlugin from "@fullcalendar/luxon3";
import zhLocale from "@fullcalendar/core/locales/zh-cn";
import { api, type Plan, type Event, type Profile } from "../api";
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
export default function CalendarPage({
  profile,
  onWeekChange,
}: {
  profile: Profile;
  onWeekChange?: (day: string) => void;
}) {
  const navigate = useNavigate();
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
      {(events.error || plan.error) && (
        <Alert type="error" message={errorText(events.error ?? plan.error)} />
      )}
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
          datesSet={(info) => onWeekChange?.(info.startStr.slice(0, 10))}
          eventClick={(info) => navigate(info.event.extendedProps.to)}
          allDaySlot={false}
          slotMinTime="00:00:00"
          slotMaxTime="24:00:00"
          events={[
            ...(events.data?.map((e) => ({
              id: e.id,
              to: `/events/${e.id}`,
              title: e.title + (e.is_skipped ? "（本次不参加）" : ""),
              start: e.start_at,
              end: e.end_at,
              color: e.is_skipped ? "#a6a6a6" : "#37735c",
            })) ?? []),
            ...(plan.data?.blocks.map((b) => ({
              id: `${b.task_id}-${b.start_at}`,
              to: `/tasks/${b.task_id}`,
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
