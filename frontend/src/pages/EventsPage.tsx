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
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
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
  Profile,
  SeriesInput,
  Series,
} from "../api";
import { displayTime, toInstant, toLocal } from "../time";
import { backTarget, withFrom } from "../navigation";
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
  const fallbackWeek = DateTime.now()
    .setZone(profile.timezone)
    .startOf("week")
    .toISODate()!;
  const weekParam = params.get("week");
  const week =
    weekParam &&
    /^\d{4}-\d{2}-\d{2}$/.test(weekParam) &&
    DateTime.fromISO(weekParam, { zone: profile.timezone }).isValid
      ? weekParam
      : fallbackWeek;
  const from = params.get("from");
  const back = backTarget(from, {
    to: weekParam ? `/calendar?week=${encodeURIComponent(week)}` : "/calendar",
    label: "返回日历",
  });
  const setWeek = (day: string) => {
    const next = new URLSearchParams(params);
    next.set("week", day);
    setParams(next, { replace: true });
  };
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [editing, setEditing] = useState<Event | null | undefined>(
    isNewEvent || params.has("new") ? null : undefined,
  );
  const [seriesOpen, setSeriesOpen] = useState(isNewSeries);
  const [courseOpen, setCourseOpen] = useState(false);
  const [courseTarget, setCourseTarget] = useState<"event" | "series" | null>(
    null,
  );
  const [form] = Form.useForm();
  const [seriesForm] = Form.useForm();
  const [courseForm] = Form.useForm();
  const seriesKey = useRef("");
  const kind = Form.useWatch("kind", form);
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
      navigate(from ?? `/calendar?week=${encodeURIComponent(week)}`, {
        replace: true,
      });
    } else if (params.has("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  };
  const closeSeries = () => {
    setSeriesOpen(false);
    if (isNewSeries) {
      navigate(from ?? `/calendar?week=${encodeURIComponent(week)}`, {
        replace: true,
      });
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
  const visible = (events.data ?? []).filter((e) =>
    id
      ? e.id === id
      : DateTime.fromISO(e.start_at) <
          DateTime.fromISO(week, { zone: profile.timezone }).plus({
            days: 7,
          }) &&
        DateTime.fromISO(e.end_at) >
          DateTime.fromISO(week, { zone: profile.timezone }),
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
  const skip = (event: Event) =>
    modal.confirm({
      title: event.is_skipped ? "确认恢复参加本次课程" : "确认本次不参加",
      content:
        "仅改变这一次课程的参加状态，原课表和其他周次保持不变。恢复参加后，该时段重新计为占用。",
      onOk: () =>
        write.mutateAsync({
          path: `/events/${event.id}/skip`,
          method: "PATCH",
          body: { is_skipped: !event.is_skipped, confirmed: true },
        }),
    });
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">MAKE ROOM</div>
          <h1>{id ? "事件详情" : "日历与课程"}</h1>
          <p className="muted">固定课程保留原始安排，单次变更单独记录。</p>
        </div>
        {!id && (
          <Space wrap>
            <Button onClick={() => openCourse(null)}>添加课程</Button>
            <Button onClick={() => openNewSeries()}>建立重复课表</Button>
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
            <Card className="toolbar course-sidebar" title="课程与系列">
              {courses.isPending ? (
                <Spin />
              ) : courses.error ? null : courses.data?.length ? (
                courses.data.map((c) => (
                  <div key={c.id} className="toolbar">
                    <Link
                      to={withFrom(
                        `/calendar/courses/${c.id}`,
                        `/calendar?week=${week}`,
                      )}
                    >
                      {c.name}
                    </Link>
                    {series.data
                      ?.filter((s) => s.course_id === c.id)
                      .map((s) => (
                        <p key={s.id}>
                          <Link
                            to={withFrom(
                              `/calendar/series/${s.id}`,
                              `/calendar?week=${week}`,
                            )}
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
            </Card>
            <div>
              {events.data && !events.error && (
                <CalendarPage
                  profile={profile}
                  week={week}
                  onWeekChange={setWeek}
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
                选中周：{week}（仅显示本周事件，点击日历或下方事件进入详情）
              </p>
            </div>
          </div>
        </>
      )}
      {id && (
        <Space className="toolbar">
          <Link to={back.to}>{back.label}</Link>
          <Link to="/settings/rules?tab=courses">查看相关并行规则</Link>
        </Space>
      )}
      {events.error ? null : events.isPending ? (
        <Spin />
      ) : !visible.length ? (
        <Card>
          <Empty description={id ? "事件不存在或已删除" : "本周没有固定事件"} />
        </Card>
      ) : (
        <div className="cards">
          {visible.map((event) => (
            <Card key={event.id}>
              <div className="card-heading">
                <h3>
                  <Link
                    to={
                      weekParam
                        ? `/calendar/events/${event.id}?week=${encodeURIComponent(week)}`
                        : `/calendar/events/${event.id}`
                    }
                  >
                    {event.title}
                  </Link>
                </h3>
                <Tag color={event.is_skipped ? "orange" : "default"}>
                  {event.is_skipped
                    ? "本次不参加"
                    : event.kind === "exam"
                      ? "考试"
                      : "固定时间"}
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
              {event.start_at !== event.original_start_at && (
                <p className="muted">
                  原定：
                  {displayTime(
                    event.original_start_at,
                    profile.timezone,
                  )} — {displayTime(event.original_end_at, profile.timezone)}
                </p>
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
              <Space wrap>
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
                    所属系列
                  </Link>
                )}
                <SourceButton objectId={event.id} />
                {id && (
                  <Button
                    danger
                    loading={remove.isPending}
                    onClick={() =>
                      modal.confirm({
                        title: "删除这次事件？",
                        content: event.series_id
                          ? "将永久删除本次课程和对应单次覆盖。系列与其他周次保留，但该周次永久缺失，后续编辑系列不会补回；导入来源与历史计划保留，当前计划会标记过期。"
                          : "将永久删除本次事件和对应单次覆盖；导入来源与历史计划保留，当前计划会标记过期。",
                        onOk: () =>
                          remove.mutateAsync(event.id).then(() => undefined),
                      })
                    }
                  >
                    删除事件
                  </Button>
                )}
                <Button onClick={() => edit(event)}>编辑事件</Button>
                {event.kind === "course" && (
                  <Button
                    disabled={write.isPending}
                    onClick={() => skip(event)}
                  >
                    {event.is_skipped ? "恢复参加" : "本次不参加"}
                  </Button>
                )}
              </Space>
            </Card>
          ))}
        </div>
      )}
      <Modal
        title={editing ? "编辑事件" : "添加事件"}
        open={editing !== undefined}
        onCancel={closeEditor}
        onOk={() => form.submit()}
        confirmLoading={write.isPending}
        destroyOnHidden
      >
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
                locked: editing?.locked ?? true,
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
              message="备注和详情可分别选择仅本次或整个系列；系列值会与单次值同时展示。"
            />
          )}
          <Form.Item
            name="title"
            label="事件标题"
            rules={[{ required: true, whitespace: true, max: 200 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="kind" label="事件类型">
            <Select
              disabled={!!editing?.series_id}
              options={[
                { value: "other", label: "其他活动" },
                { value: "meeting", label: "会议" },
                { value: "course", label: "课程" },
                { value: "exam", label: "考试（不可跳过）" },
              ]}
            />
          </Form.Item>
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
              extra="整个系列会更新系列默认值；已有单次值仍会保留并与系列值同时展示。"
            >
              <Radio.Group
                onChange={(e) => switchScope("note", e.target.value)}
                options={[
                  { value: "single", label: "仅本次" },
                  { value: "series", label: "整个系列" },
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
              extra="详情只在事件详情显示；系列值会与单次值拼接。"
            >
              <Radio.Group
                onChange={(e) => switchScope("details", e.target.value)}
                options={[
                  { value: "single", label: "仅本次" },
                  { value: "series", label: "整个系列" },
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
                <summary>查看系列默认备注和详情</summary>
                {editing.series_note && <p>备注：{editing.series_note}</p>}
                {editing.series_details && (
                  <p className="event-details">{editing.series_details}</p>
                )}
              </details>
            )}
        </Form>
      </Modal>
      <Modal
        title="新建课程"
        open={courseOpen}
        onCancel={() => {
          setCourseOpen(false);
          setCourseTarget(null);
        }}
        onOk={() => courseForm.submit()}
        confirmLoading={createCourse.isPending}
      >
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
        </Form>
      </Modal>
      <Modal
        title="建立每周重复课表"
        open={seriesOpen}
        onCancel={closeSeries}
        onOk={() => seriesForm.submit()}
        confirmLoading={write.isPending}
      >
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
            label="课表时区"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="location" label="上课地点">
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item
            name="note"
            label="系列备注（短，显示在卡片和日历）"
            rules={[{ max: 120 }]}
          >
            <Input maxLength={120} showCount />
          </Form.Item>
          <Form.Item
            name="details"
            label="系列详情（仅在事件详情显示）"
            rules={[{ max: 5000 }]}
          >
            <Input.TextArea rows={4} maxLength={5000} showCount />
          </Form.Item>
          <p className="muted">
            日期范围包含首尾两天，最多 366
            天。夏令时歧义会明确提示，确认保存后生成各次课程。
          </p>
        </Form>
      </Modal>
    </>
  );
}
