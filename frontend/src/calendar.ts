import type { Event } from "./api";

export type CalendarContent = "all" | "courses" | "hide-courses";

export function calendarContent(value: string | null): CalendarContent {
  return value === "courses" || value === "hide-courses" ? value : "all";
}

export function matchesCalendarContent(
  event: Pick<Event, "kind" | "series_id">,
  content: CalendarContent,
): boolean {
  const course = event.kind === "course" || !!event.series_id;
  return content === "all" || (content === "courses" ? course : !course);
}
