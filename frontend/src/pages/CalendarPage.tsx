import { useEffect, useRef } from "react";
import type { DateSelectArg } from "@fullcalendar/core";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "antd";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import listPlugin from "@fullcalendar/list";
import luxonPlugin from "@fullcalendar/luxon3";
import zhLocale from "@fullcalendar/core/locales/zh-cn";
import { DateTime } from "luxon";
import { api, type Plan, type Event, type Profile } from "../api";
import { withFrom } from "../navigation";
import { eventTypeColor, eventTypeLabel, staleInfo } from "../semantics";
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
const calendarViews = ["dayGridMonth", "timeGridWeek", "listWeek"] as const;
export default function CalendarPage({
  profile,
  week,
  view,
  onDatesChange,
  onSelect,
}: {
  profile: Profile;
  week?: string;
  view?: string;
  onDatesChange?: (day: string, view: string) => void;
  onSelect?: (start: Date, end: Date) => void;
}) {
  const navigate = useNavigate();
  const calendar = useRef<FullCalendar | null>(null);
  const initialView =
    view && (calendarViews as readonly string[]).includes(view)
      ? view
      : window.innerWidth < 700
        ? "listWeek"
        : "timeGridWeek";
  const calendarUrl = week
    ? `/calendar?week=${encodeURIComponent(week)}&view=${initialView}`
    : `/calendar?view=${initialView}`;
  const plan = useQuery({
    queryKey: ["plans", "current"],
    queryFn: () => api<Plan | null>("/plans/current"),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const stale = plan.data ? staleInfo(plan.data) : null;
  useEffect(() => {
    if (!week) return;
    const api = calendar.current?.getApi();
    if (!api) return;
    if (
      view &&
      (calendarViews as readonly string[]).includes(view) &&
      api.view.type !== view
    ) {
      api.changeView(view, week);
      return;
    }
    const current = DateTime.fromJSDate(api.view.currentStart)
      .setZone(profile.timezone)
      .toISODate();
    if (current !== week) api.gotoDate(week);
  }, [week, view, profile.timezone]);
  const selectDay = (date: Date) => {
    const start = DateTime.fromJSDate(date)
      .setZone(profile.timezone)
      .startOf("day")
      .set({ hour: 9 });
    onSelect?.(start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
  };
  return (
    <>
      {(events.error || plan.error) && (
        <Alert type="error" message={errorText(events.error ?? plan.error)} />
      )}
      {stale && (
        <Alert
          type="warning"
          message={`${stale.detail} 日历中的灰色计划块仅作历史展示。`}
          action={<Link to="/plans">查看计划</Link>}
        />
      )}
      <div className="calendar">
        <FullCalendar
          ref={calendar}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, luxonPlugin]}
          locale={zhLocale}
          timeZone={profile.timezone}
          initialDate={week}
          initialView={initialView}
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,timeGridWeek,listWeek",
          }}
          buttonText={{ month: "月", week: "周", list: "列表" }}
          views={{ dayGridMonth: { dayMaxEvents: 3, eventDisplay: "block" } }}
          moreLinkText={(count) => `还有 ${count} 项`}
          dayCellContent={(info) =>
            info.view.type === "dayGridMonth" && onSelect ? (
              <button
                className="calendar-day-add"
                type="button"
                aria-label={`在${DateTime.fromJSDate(info.date).setZone(profile.timezone).toISODate()}新建事件`}
                onClick={() => selectDay(info.date)}
              >
                {info.dayNumberText}
              </button>
            ) : (
              info.dayNumberText
            )
          }
          height="auto"
          selectable={!!onSelect}
          select={(info: DateSelectArg) =>
            info.allDay
              ? selectDay(info.start)
              : onSelect?.(info.start, info.end)
          }
          datesSet={(info) => {
            onDatesChange?.(
              DateTime.fromJSDate(info.view.currentStart)
                .setZone(profile.timezone)
                .toISODate()!,
              info.view.type,
            );
          }}
          eventClick={(info) => navigate(info.event.extendedProps.to)}
          eventContent={(arg) => (
            <div
              className="fc-event-body"
              title={`${arg.event.title} · ${arg.event.extendedProps.typeLabel}${arg.event.extendedProps.note ? ` · ${arg.event.extendedProps.note}` : ""}`}
            >
              {arg.timeText && (
                <div className="fc-event-time">{arg.timeText}</div>
              )}
              <div className="fc-event-title">{arg.event.title}</div>
              <div className="fc-event-type">
                {arg.event.extendedProps.typeLabel}
              </div>
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
              to: withFrom(
                week
                  ? `/calendar/events/${e.id}?week=${encodeURIComponent(week)}`
                  : `/calendar/events/${e.id}`,
                calendarUrl,
              ),
              title: e.title + (e.is_skipped ? "（本次不参加）" : ""),
              start: e.start_at,
              end: e.end_at,
              note: e.note,
              typeLabel: eventTypeLabel(e),
              color: e.is_skipped ? "#a6a6a6" : eventTypeColor(e),
            })) ?? []),
            ...(plan.data?.blocks.map((b) => ({
              id: `${b.task_id}-${b.start_at}`,
              to: withFrom(`/tasks/${b.task_id}`, calendarUrl),
              title: b.title,
              start: b.start_at,
              end: b.end_at,
              note: "",
              typeLabel: "计划块",
              color: plan.data?.stale ? "#9ca3af" : "#3873ac",
            })) ?? []),
          ]}
        />
      </div>
    </>
  );
}
