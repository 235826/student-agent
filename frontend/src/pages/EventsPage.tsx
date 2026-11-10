import CalendarPage from "./CalendarPage";
import { DateTime } from "luxon";
import {
  Link,
  useParams,
  useSearchParams,
  useNavigate,
  useLocation,
} from "react-router-dom";
import SourceButton from "../components/SourceButton";
import InlineConfirm from "../components/InlineConfirm";
import ActivityFeedbackPanel from "../components/ActivityFeedbackPanel";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { api, ApiError } from "../api";
import type {
  Course,
  Event,
  EventInput,
  EventType,
  Profile,
  SeriesInput,
  Series,
} from "../api";
import { displayTime, toInstant, toLocal } from "../time";
import { backTarget, withFrom } from "../navigation";
import { eventTypeColor, eventTypeLabel } from "../semantics";
const policyOptions = [
  { value: "inherit", label: "沿用课程设置 / 默认禁止" },
  { value: "none", label: "本次禁止并行" },
  { value: "allow_selected", label: "本次接受已允许的组合" },
];
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
type Write = { path: string; method?: string; body?: unknown };
export default function EventsPage({ profile }: { profile: Profile }) {
  const { id } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const isNewEvent = location.pathname === "/calendar/events/new";
  const isNewSeries = location.pathname === "/calendar/series/new";
  const viewParam = params.get("view");
  const fallbackWeek = DateTime.now()
    .setZone(profile.timezone)
    .startOf(viewParam === "dayGridMonth" ? "month" : "week")
    .toISODate()!;
  const weekParam = params.get("week");
  const week =
    weekParam &&
    /^\d{4}-\d{2}-\d{2}$/.test(weekParam) &&
    DateTime.fromISO(weekParam, { zone: profile.timezone }).isValid
      ? weekParam
      : fallbackWeek;
  const calendarView =
    viewParam === "dayGridMonth" ||
    viewParam === "timeGridWeek" ||
    viewParam === "listWeek"
      ? viewParam
      : undefined;
  const calendarUrl = `${
    weekParam ? `/calendar?week=${encodeURIComponent(week)}` : "/calendar"
  }${calendarView ? `${weekParam ? "&" : "?"}view=${calendarView}` : ""}`;
  const here = `${location.pathname}${location.search}${location.hash}`;
  const from = params.get("from");
  const back = backTarget(from, {
    to: calendarUrl,
    label: "返回日历",
  });
  const setCalendarDates = (day: string, value: string) => {
    if (!["dayGridMonth", "timeGridWeek", "listWeek"].includes(value)) return;
    if ((day === weekParam || (!weekParam && day === week)) && value === viewParam)
      return;
    const next = new URLSearchParams(params);
    if (weekParam || day !== week) next.set("week", day);
    next.set("view", value);
    setParams(next, { replace: true });
  };
  const client = useQueryClient();
  const { message } = App.useApp();
  const [editing, setEditing] = useState<Event | null | undefined>(
    isNewEvent || params.has("new") ? null : undefined,
  );
  const [seriesOpen, setSeriesOpen] = useState(isNewSeries);
  const [courseOpen, setCourseOpen] = useState(false);
  const [courseTarget, setCourseTarget] = useState<"event" | "series" | null>(
    null,
  );
  const [typeOpen, setTypeOpen] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [form] = Form.useForm();
  const [seriesForm] = Form.useForm();
  const [courseForm] = Form.useForm();
  const [typeForm] = Form.useForm();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const seriesKey = useRef("");
  useEffect(() => {
    if (editing === undefined && !seriesOpen && !courseOpen && !typeOpen) return;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [editing, seriesOpen, courseOpen, typeOpen]);
  const kind = Form.useWatch("kind", form);
  const eventTypeId = Form.useWatch("event_type_id", form);
  const openNewEvent = (start?: string, end?: string, courseId?: string) => {
    form.resetFields();
    form.setFieldsValue({
      location: "",
      kind: courseId ? "course" : "other",
      note: "",
      details: "",
      note_scope: "single",
      details_scope: "single",
      start_at: start,
      end_at: end,
      course_id: courseId,
      event_type_id: courseId ? undefined : otherType?.id,
    });
    setEditing(null);
  };
  const openNewSeries = (courseId?: string) => {
    seriesForm.resetFields();
    seriesForm.setFieldsValue({
      course_id: courseId,
      timezone: profile.timezone,
      weekdays: [0],
      start_date: week,
      end_date: DateTime.fromISO(week)
        .setZone(profile.timezone)
        .plus({ days: 7 })
        .toISODate(),
      start_time: "09:00",
      end_time: "10:00",
      note: "",
      details: "",
    });
    seriesKey.current = crypto.randomUUID();
    setSeriesOpen(true);
  };
  const closeEditor = () => {
    setEditing(undefined);
    if (isNewEvent) {
      navigate(back.to, { replace: true });
    } else if (params.has("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  };
  const closeSeries = () => {
    setSeriesOpen(false);
    if (isNewSeries) {
      navigate(back.to, { replace: true });
    }
  };
  const openCourse = (target: "event" | "series" | null) => {
    courseForm.resetFields();
    setCourseTarget(target);
    setCourseOpen(true);
  };
  useEffect(() => {
    if (!isNewEvent && !isNewSeries) return;
    if (isNewEvent) {
      const raw = params.get("date");
      const start = raw
        ? raw.length === 10
          ? `${raw}T09:00`
          : raw
        : `${week}T09:00`;
      const end = raw
        ? DateTime.fromISO(start, { zone: profile.timezone })
            .plus({ minutes: 60 })
            .toFormat("yyyy-MM-dd'T'HH:mm")
        : `${week}T10:00`;
      openNewEvent(start, end, params.get("course") ?? undefined);
    } else {
      openNewSeries(params.get("course") ?? undefined);
    }
    // The create route is resolved once when the page is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const courses = useQuery({
    queryKey: ["courses"],
    queryFn: () => api<Course[]>("/courses"),
  });
  const series = useQuery({
    queryKey: ["series"],
    queryFn: () => api<Series[]>("/event-series"),
  });
  const eventTypes = useQuery({
    queryKey: ["event-types"],
    queryFn: () => api<EventType[]>("/event-types"),
  });
  const otherType = eventTypes.data?.find((t) => t.system_key === "other");
  const typeValue =
    kind === "course" ? "course" : (eventTypeId ?? otherType?.id);
  const write = useMutation({
    mutationFn: ({ path, method = "POST", body }: Write) =>
      api(path, method, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["events"] });
      void client.invalidateQueries({ queryKey: ["courses"] });
      void client.invalidateQueries({ queryKey: ["rules"] });
      void client.invalidateQueries({ queryKey: ["series"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      void message.success("已保存");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const createCourse = useMutation({
    mutationFn: (values: { name: string; semester?: string }) =>
      api<Course>("/courses", "POST", values),
    onSuccess: (course) => {
      void client.invalidateQueries({ queryKey: ["courses"] });
      if (courseTarget === "event") form.setFieldValue("course_id", course.id);
      if (courseTarget === "series")
        seriesForm.setFieldValue("course_id", course.id);
      setCourseOpen(false);
      setCourseTarget(null);
      void message.success("课程已创建");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const createEventType = useMutation({
    mutationFn: (values: { name: string; color: string }) =>
      api<EventType>("/event-types", "POST", values),
    onSuccess: (eventType) => {
      void client.invalidateQueries({ queryKey: ["event-types"] });
      form.setFieldsValue({ kind: "other", event_type_id: eventType.id });
      setTypeOpen(false);
      typeForm.resetFields();
      void message.success("事件类型已创建");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (eventId: string) =>
      api(`/events/${eventId}`, "DELETE", { confirmed: true }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["events"] });
      void client.invalidateQueries({ queryKey: ["series"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      navigate(back.to);
    },
    onError: (e) => void message.error(e.message),
  });
  const monthView = calendarView === "dayGridMonth";
  const rangeStart = monthView
    ? DateTime.fromISO(week, { zone: profile.timezone }).startOf("month")
    : DateTime.fromISO(week, { zone: profile.timezone });
  const rangeEnd = monthView
    ? rangeStart.plus({ months: 1 })
    : rangeStart.plus({ days: 7 });
  const visible = (events.data ?? []).filter((e) =>
    id
      ? e.id === id
      : DateTime.fromISO(e.start_at) < rangeEnd &&
        DateTime.fromISO(e.end_at) > rangeStart,
  );
  const edit = (event: Event | null) => {
    form.resetFields();
    const noteScope =
      event?.series_id && event.single_note != null
        ? "single"
        : event?.series_id
          ? "series"
          : "single";
    const detailsScope =
      event?.series_id && event.single_details != null
        ? "single"
        : event?.series_id
          ? "series"
          : "single";
    form.setFieldsValue(
      event
        ? {
            title: event.title,
            location: event.location,
            start_at: toLocal(event.start_at, profile.timezone),
            end_at: toLocal(event.end_at, profile.timezone),
            kind: event.kind,
            course_id: event.course_id,
            event_type_id: event.event_type_id,
            note: event.series_id
              ? noteScope === "single"
                ? (event.single_note ?? "")
                : (event.series_note ?? "")
              : event.note,
            details: event.series_id
              ? detailsScope === "single"
                ? (event.single_details ?? "")
                : (event.series_details ?? "")
              : event.details,
            note_scope: noteScope,
            details_scope: detailsScope,
          }
        : {
            location: "",
            kind: "other",
            note: "",
            details: "",
            note_scope: "single",
            details_scope: "single",
          },
    );
    setEditing(event);
  };
  const switchScope = (field: "note" | "details", value: string) => {
    if (!editing?.series_id) return;
    const source =
      field === "note"
        ? value === "single"
          ? editing.single_note
          : editing.series_note
        : value === "single"
          ? editing.single_details
          : editing.series_details;
    form.setFieldValue(field, source ?? "");
  };
  const skip = async (event: Event) => {
    const next = !event.is_skipped;
    try {
      const updated = await api<Event>(`/events/${event.id}/skip`, "PATCH", {
        is_skipped: next,
        confirmed: true,
      });
      client.setQueryData<Event[]>(["events"], (current) =>
        current?.map((item) => (item.id === event.id ? updated : item)),
      );
      void client.invalidateQueries({ queryKey: ["series"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      if (updated.replan_suggested) {
        void message.warning("恢复参加后与当前计划重叠，建议重新生成安排。");
      }
      message.open({
        type: "success",
        duration: 8,
        content: (
          <Space wrap>
            <span>{next ? "已设为本次不参加" : "已恢复参加本次课程"}</span>
            <Button
              type="text"
              size="small"
              onClick={() => void skip({ ...event, is_skipped: next })}
            >
              撤销
            </Button>
          </Space>
        ),
      });
    } catch (error) {
      void message.error(errorText(error));
    }
  };
  return (
    <>
      <header>
        <div>
          <h1>{id ? "事件详情" : "日历"}</h1>
          <p className="muted">固定安排保留原始时间，单次变更单独记录。</p>
        </div>
        {!id && (
          <Space wrap>
            <Button type="text" onClick={() => openCourse(null)}>添加课程</Button>
            <Button type="text" onClick={() => openNewSeries()}>建立每周课程</Button>
            <Button
              type="primary"
              onClick={() =>
                openNewEvent(
                  `${week}T09:00`,
                  `${week}T10:00`,
                )
              }
            >
              添加事件
            </Button>
          </Space>
        )}
      </header>
      {(courses.error || events.error || series.error) && (
        <Alert
          type="error"
          message={errorText(courses.error ?? events.error ?? series.error)}
        />
      )}
      {!id && (
        <>
          <div className="calendar-layout">
            <section className="section course-sidebar">
              <h3>课程与每周课程</h3>
              {courses.isPending ? (
                <Spin />
              ) : courses.error ? null : courses.data?.length ? (
                courses.data.map((c) => (
                  <div key={c.id} className="toolbar">
                    <Link
                      to={withFrom(`/calendar/courses/${c.id}`, calendarUrl)}
                    >
                      {c.name}
                    </Link>
                    {c.semester && (
                      <span className="muted"> · {c.semester}</span>
                    )}
                    {series.data
                      ?.filter((s) => s.course_id === c.id)
                      .map((s) => (
                        <p key={s.id}>
                          <Link
                            to={withFrom(`/calendar/series/${s.id}`, calendarUrl)}
                          >
                            {s.dtstart_local.slice(0, 10)} 起 ·{" "}
                            {s.event_ids.length} 次
                          </Link>
                        </p>
                      ))}
                  </div>
                ))
              ) : (
                <Empty description="尚未添加课程" />
              )}
            </section>
            <div>
              {events.data && !events.error && (
                <CalendarPage
                  profile={profile}
                  week={week}
                  view={calendarView}
                  onDatesChange={setCalendarDates}
                  onSelect={(start, end) =>
                    openNewEvent(
                      DateTime.fromJSDate(start)
                        .setZone(profile.timezone)
                        .toFormat("yyyy-MM-dd'T'HH:mm"),
                      DateTime.fromJSDate(end)
                        .setZone(profile.timezone)
                        .toFormat("yyyy-MM-dd'T'HH:mm"),
                    )
                  }
                />
              )}
              <p className="muted">
                {monthView
                  ? `选中月：${rangeStart.toFormat("yyyy-MM")}`
                  : `选中周：${week}`}
                （下方列出{monthView ? "本月" : "本周"}事件，点击日历或事件可查看详情
                {monthView ? "；点击日期可新建事件" : ""}）
              </p>
            </div>
          </div>
        </>
      )}
      {id && (
        <Space className="toolbar row-actions">
          <Link to={back.to}>{back.label}</Link>
          <Link to="/settings/rules?tab=courses">查看相关并行规则</Link>
        </Space>
      )}
      {events.error ? null : events.isPending ? (
        <Spin />
      ) : !visible.length ? (
        <div className="empty-state">
          <Empty description={id ? "事件不存在或已删除" : monthView ? "本月没有事件" : "本周没有事件"} />
        </div>
      ) : (
        <div className="rows">
          {visible.map((event) => (
            <article key={event.id} className="task-row event-row">
              <div className="card-heading">
                <h3>
                  <Link
                    to={withFrom(
                      weekParam
                        ? `/calendar/events/${event.id}?week=${encodeURIComponent(week)}`
                        : `/calendar/events/${event.id}`,
                      id ? back.to : here,
                    )}
                  >
                    {event.title}
                  </Link>
                </h3>
                <Tag
                  color={
                    event.is_skipped ? "orange" : eventTypeColor(event)
                  }
                >
                  {eventTypeLabel(event)}
                  {event.is_skipped ? " · 本次不参加" : ""}
                </Tag>
              </div>
              <p>
                {displayTime(event.start_at, profile.timezone)} —{" "}
                {displayTime(event.end_at, profile.timezone)}
              </p>
              <p className="muted">
                {event.location || "未设置地点"}
                {event.series_id && " · 每周课程实例"}
              </p>
              {event.note && <p className="event-note">{event.note}</p>}
              {id && event.details && (
                <p className="event-details">{event.details}</p>
              )}
              {id && <ActivityFeedbackPanel eventId={event.id} />}
              {event.start_at !== event.original_start_at && (
                <p className="muted">
                  原定：
                  {displayTime(
                    event.original_start_at,
                    profile.timezone,
                  )} — {displayTime(event.original_end_at, profile.timezone)}
                </p>
              )}
              {id && event.replan_suggested && (
                <Alert
                  type="warning"
                  showIcon
                  message="恢复参加后与当前计划重叠，建议重新生成安排。"
                  action={<Link to="/plans/new">重新安排</Link>}
                />
              )}
              {id && (
                <Select
                  className="policy-select"
                  aria-label={`${event.title}本次并行设置`}
                  value={event.parallel_policy_override ?? "inherit"}
                  options={policyOptions}
                  disabled={write.isPending}
                  onChange={(value) =>
                    write.mutate({
                      path: `/events/${event.id}/parallel-policy`,
                      method: "PATCH",
                      body: {
                        parallel_policy: value === "inherit" ? null : value,
                      },
                    })
                  }
                />
              )}
              <div className="row-actions">
                {event.course_id && (
                  <Link
                    to={
                      back.to.startsWith(
                        `/calendar/courses/${event.course_id}`,
                      )
                        ? back.to
                        : withFrom(
                            `/calendar/courses/${event.course_id}`,
                            back.to,
                          )
                    }
                  >
                    所属课程
                  </Link>
                )}
                {event.series_id && (
                  <Link
                    to={
                      back.to.startsWith(
                        `/calendar/series/${event.series_id}`,
                      )
                        ? back.to
                        : withFrom(
                            `/calendar/series/${event.series_id}`,
                            back.to,
                          )
                    }
                  >
                    所属每周课程
                  </Link>
                )}
                <SourceButton objectId={event.id} />
                {id && (
                  <Button
                    danger
                    loading={remove.isPending}
                    onClick={() => setConfirmingDeleteId(event.id)}
                  >
                    删除事件
                  </Button>
                )}
                <Button onClick={() => edit(event)}>编辑事件</Button>
                {event.kind === "course" && (
                  <Button
                    disabled={write.isPending}
                    onClick={() => void skip(event)}
                  >
                    {event.is_skipped ? "恢复参加" : "本次不参加"}
                  </Button>
                )}
                {confirmingDeleteId === event.id && (
                  <InlineConfirm
                    message={
                      event.series_id
                        ? "将永久删除本次课程和对应的本次调整。其他周次与每周课程保留，但该周次永久缺失，后续编辑每周课程不会补回；导入来源与历史计划保留，当前计划将标记为依据已变化。"
                        : "将永久删除本次事件和对应的本次调整；导入来源与历史计划保留，当前计划会标记过期。"
                    }
                    confirmLabel="确认删除事件"
                    loading={remove.isPending}
                    onCancel={() => setConfirmingDeleteId(null)}
                    onConfirm={() => {
                      setConfirmingDeleteId(null);
                      remove.mutate(event.id);
                    }}
                  />
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <div ref={panelRef}>
      {editing !== undefined && (
        <section className="section inline-editor">
          <div className="section-inline-heading">
            <h3>{editing ? "编辑事件" : "添加事件"}</h3>
            <Button type="text" onClick={closeEditor}>
              收起
            </Button>
          </div>
        <Form
          form={form}
          initialValues={{
            location: "",
            kind: "other",
            note: "",
            details: "",
            note_scope: "single",
            details_scope: "single",
          }}
          layout="vertical"
          onFinish={async (values) => {
            try {
              const start = toInstant(values.start_at, profile.timezone);
              const end = toInstant(values.end_at, profile.timezone);
              if (!start || !end) throw new Error("请填写起止时间");
              const body: EventInput = {
                ...values,
                start_at: start,
                end_at: end,
                timezone: profile.timezone,
                course_id: values.course_id ?? null,
              };
              await write.mutateAsync({
                path: editing ? `/events/${editing.id}` : "/events",
                method: editing ? "PUT" : "POST",
                body,
              });
              closeEditor();
            } catch (e) {
              if (e instanceof Error && !(e instanceof ApiError))
                void message.error(e.message);
            }
          }}
        >
          {editing?.series_id && (
            <Alert
              type="info"
              message="备注和详情可分别选择仅本次或全部周次；每周课程默认值会与单次值同时展示。"
            />
          )}
          <Form.Item
            name="title"
            label="事件标题"
            rules={[{ required: true, whitespace: true, max: 200 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="kind" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="event_type_id" hidden>
            <Input />
          </Form.Item>
          <Form.Item label="事件类型">
            <Select
              aria-label="事件类型"
              disabled={!!editing?.series_id}
              value={typeValue}
              options={[
                { value: "course", label: "课程" },
                ...(eventTypes.data ?? []).map((type) => ({
                  value: type.id,
                  label: type.name,
                })),
              ]}
              onChange={(value) => {
                if (value === "course") {
                  form.setFieldsValue({
                    kind: "course",
                    event_type_id: undefined,
                  });
                } else {
                  form.setFieldsValue({
                    kind: "other",
                    event_type_id: value,
                  });
                }
              }}
            />
          </Form.Item>
          {!editing?.series_id && (
            <Button
              size="small"
              className="toolbar"
              onClick={() => {
                typeForm.setFieldsValue({ name: "", color: "#1677ff" });
                setTypeOpen(true);
              }}
            >
              新建事件类型
            </Button>
          )}
          <Form.Item
            name="course_id"
            label="关联课程"
            rules={[
              {
                required: kind === "course",
                message: "请选择课程，或先新建课程",
              },
            ]}
          >
            <Select
              allowClear
              disabled={!!editing?.series_id}
              options={courses.data?.map((c) => ({
                value: c.id,
                label: c.name,
              }))}
            />
          </Form.Item>
          {!editing?.series_id && (
            <Button
              size="small"
              className="toolbar"
              onClick={() => openCourse("event")}
            >
              新建课程
            </Button>
          )}
          <Form.Item
            name="start_at"
            label={`开始时间（${profile.timezone}）`}
            rules={[{ required: true }]}
          >
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item
            name="end_at"
            label={`结束时间（${profile.timezone}）`}
            rules={[{ required: true }]}
          >
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="location" label="地点">
            <Input maxLength={500} />
          </Form.Item>
          {editing?.series_id && (
            <Form.Item
              name="note_scope"
              label="备注应用范围"
              extra="全部周次会更新每周课程默认值；已有单次值仍会保留并与每周课程默认值同时展示。"
            >
              <Radio.Group
                onChange={(e) => switchScope("note", e.target.value)}
                options={[
                  { value: "single", label: "仅本次" },
                  { value: "series", label: "全部周次" },
                ]}
              />
            </Form.Item>
          )}
          <Form.Item
            name="note"
            label="备注（短，显示在卡片和日历）"
            rules={[{ max: 120 }]}
          >
            <Input maxLength={120} showCount />
          </Form.Item>
          {editing?.series_id && (
            <Form.Item
              name="details_scope"
              label="详情应用范围"
              extra="详情只在事件详情显示；每周课程默认值会与单次值拼接。"
            >
              <Radio.Group
                onChange={(e) => switchScope("details", e.target.value)}
                options={[
                  { value: "single", label: "仅本次" },
                  { value: "series", label: "全部周次" },
                ]}
              />
            </Form.Item>
          )}
          <Form.Item
            name="details"
            label="详情（仅在事件详情显示）"
            rules={[{ max: 5000 }]}
          >
            <Input.TextArea rows={5} maxLength={5000} showCount />
          </Form.Item>
          {editing?.series_id &&
            (editing.series_note || editing.series_details) && (
              <details>
                <summary>查看每周课程默认备注和详情</summary>
                {editing.series_note && <p>备注：{editing.series_note}</p>}
                {editing.series_details && (
                  <p className="event-details">{editing.series_details}</p>
                )}
              </details>
            )}
        </Form>
          <div className="row-actions">
            <Button type="text" onClick={closeEditor}>
              取消
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={write.isPending}
              onClick={() => form.submit()}
            >
              保存事件
            </Button>
          </div>
        </section>
      )}
      {typeOpen && (
        <section className="section inline-editor">
          <div className="section-inline-heading">
            <h3>新建事件类型</h3>
            <Button type="text" onClick={() => setTypeOpen(false)}>
              收起
            </Button>
          </div>
        <Form
          form={typeForm}
          layout="vertical"
          onFinish={(values) => createEventType.mutate(values)}
        >
          <Form.Item
            name="name"
            label="类型名称"
            rules={[
              { required: true, whitespace: true, max: 100 },
              {
                validator: (_, value: string) =>
                  ["课程", "每周课程", "考试", "会议", "其他"].includes(value)
                    ? Promise.reject(new Error("该名称是保留类型"))
                    : Promise.resolve(),
              },
            ]}
          >
            <Input placeholder="例如：社团活动、实验、讲座" />
          </Form.Item>
          <Form.Item name="color" label="颜色">
            <Input type="color" />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={createEventType.isPending}
          >
            保存事件类型
          </Button>
        </Form>
        </section>
      )}
      {courseOpen && (
        <section className="section inline-editor">
          <div className="section-inline-heading">
            <h3>新建课程</h3>
            <Button
              type="text"
              onClick={() => {
                setCourseOpen(false);
                setCourseTarget(null);
              }}
            >
              收起
            </Button>
          </div>
        <Form
          form={courseForm}
          layout="vertical"
          onFinish={(values) => createCourse.mutate(values)}
        >
          <Form.Item
            name="name"
            label="课程名称"
            rules={[{ required: true, whitespace: true, max: 200 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="semester" label="学期" initialValue="">
            <Input maxLength={100} />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={createCourse.isPending}
          >
            保存课程
          </Button>
        </Form>
        </section>
      )}
      {seriesOpen && (
        <section className="section inline-editor">
          <div className="section-inline-heading">
            <h3>建立每周课程</h3>
            <Button type="text" onClick={closeSeries}>
              收起
            </Button>
          </div>
        <Form
          form={seriesForm}
          layout="vertical"
          onFinish={async (values) => {
            try {
              const body: SeriesInput = {
                ...values,
                location: values.location ?? "",
                idempotency_key: seriesKey.current,
              };
              await write.mutateAsync({ path: "/event-series", body });
              closeSeries();
            } catch {
              /* keep form and idempotency key for retry */
            }
          }}
        >
          <Form.Item
            name="course_id"
            label="选择课程"
            rules={[{ required: true }]}
          >
            <Select
              options={courses.data?.map((c) => ({
                value: c.id,
                label: c.name,
              }))}
            />
          </Form.Item>
          <Button
            size="small"
            className="toolbar"
            onClick={() => openCourse("series")}
          >
            新建课程
          </Button>
          <div className="form-grid">
            <Form.Item
              name="start_date"
              label="起始日期"
              rules={[{ required: true }]}
            >
              <Input type="date" />
            </Form.Item>
            <Form.Item
              name="end_date"
              label="结束日期"
              rules={[{ required: true }]}
            >
              <Input type="date" />
            </Form.Item>
          </div>
          <Form.Item
            name="weekdays"
            label="每周上课日"
            rules={[{ required: true }]}
          >
            <Checkbox.Group
              options={["一", "二", "三", "四", "五", "六", "日"].map(
                (v, i) => ({ value: i, label: `周${v}` }),
              )}
            />
          </Form.Item>
          <div className="form-grid">
            <Form.Item
              name="start_time"
              label="上课时间"
              rules={[{ required: true }]}
            >
              <Input type="time" />
            </Form.Item>
            <Form.Item
              name="end_time"
              label="下课时间"
              rules={[{ required: true }]}
            >
              <Input type="time" />
            </Form.Item>
          </div>
          <Form.Item
            name="timezone"
            label="每周课程时区"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="location" label="上课地点">
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item
            name="note"
            label="每周课程默认备注（短，显示在卡片和日历）"
            rules={[{ max: 120 }]}
          >
            <Input maxLength={120} showCount />
          </Form.Item>
          <Form.Item
            name="details"
            label="每周课程默认详情（仅在事件详情显示）"
            rules={[{ max: 5000 }]}
          >
            <Input.TextArea rows={4} maxLength={5000} showCount />
          </Form.Item>
          <p className="muted">
            日期范围包含首尾两天，最多 366
            天。夏令时歧义会明确提示，确认保存后生成各次课程。
          </p>
          <Button
            type="primary"
            htmlType="submit"
            loading={write.isPending}
          >
            保存每周课程
          </Button>
        </Form>
        </section>
      )}
      </div>
    </>
  );
}
