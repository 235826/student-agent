import { useRef, useState } from "react";
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
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { api, ApiError } from "../api";
import type { Course, Event, EventInput, Profile, SeriesInput } from "../api";
import { displayTime, toInstant, toLocal } from "../time";
const policyOptions = [
  { value: "inherit", label: "沿用课程设置 / 默认禁止" },
  { value: "none", label: "本次禁止并行" },
  { value: "allow_selected", label: "本次接受已允许的组合" },
];
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
type Write = { path: string; method?: string; body?: unknown };
export default function EventsPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [editing, setEditing] = useState<Event | null | undefined>(undefined);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [courseOpen, setCourseOpen] = useState(false);
  const [form] = Form.useForm();
  const [seriesForm] = Form.useForm();
  const [courseForm] = Form.useForm();
  const seriesKey = useRef("");
  const kind = Form.useWatch("kind", form);
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const courses = useQuery({
    queryKey: ["courses"],
    queryFn: () => api<Course[]>("/courses"),
  });
  const write = useMutation({
    mutationFn: ({ path, method = "POST", body }: Write) =>
      api(path, method, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["events"] });
      void client.invalidateQueries({ queryKey: ["courses"] });
      void client.invalidateQueries({ queryKey: ["rules"] });
      void message.success("已保存");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const edit = (event: Event | null) => {
    form.resetFields();
    form.setFieldsValue(
      event
        ? {
            title: event.title,
            location: event.location,
            start_at: toLocal(event.start_at, profile.timezone),
            end_at: toLocal(event.end_at, profile.timezone),
            kind: event.kind,
            course_id: event.course_id,
          }
        : { location: "", kind: "other" },
    );
    setEditing(event);
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
          <h1>课表 / 事件</h1>
          <p className="muted">固定课程保留原始安排，单次变更单独记录。</p>
        </div>
        <Space wrap>
          <Button
            onClick={() => {
              courseForm.resetFields();
              setCourseOpen(true);
            }}
          >
            添加课程
          </Button>
          <Button
            onClick={() => {
              seriesForm.resetFields();
              seriesForm.setFieldsValue({
                timezone: profile.timezone,
                weekdays: [0],
                start_time: "09:00",
                end_time: "10:00",
              });
              seriesKey.current = crypto.randomUUID();
              setSeriesOpen(true);
            }}
          >
            建立重复课表
          </Button>
          <Button type="primary" onClick={() => edit(null)}>
            添加事件
          </Button>
        </Space>
      </header>
      {courses.error && (
        <Alert type="error" message={errorText(courses.error)} />
      )}
      {events.error && <Alert type="error" message={errorText(events.error)} />}
      {courses.data?.length ? (
        <Card className="toolbar" title="课程默认并行设置">
          <div className="course-settings">
            {courses.data.map((course) => (
              <div key={course.id}>
                <strong>{course.name}</strong>
                <Select
                  aria-label={`${course.name}默认并行设置`}
                  value={course.parallel_policy}
                  disabled={write.isPending}
                  options={[
                    { value: "none", label: "禁止并行" },
                    { value: "allow_selected", label: "接受已允许的组合" },
                  ]}
                  onChange={(value) =>
                    write.mutate({
                      path: `/courses/${course.id}/parallel-policy`,
                      method: "PATCH",
                      body: { parallel_policy: value },
                    })
                  }
                />
              </div>
            ))}
          </div>
          <p className="muted">
            此设置应用于没有单次覆盖的课程实例；组合规则在“并行规则”页面设置。
          </p>
        </Card>
      ) : null}
      {events.isPending ? (
        <Spin />
      ) : !events.data?.length ? (
        <Card>
          <Empty description="还没有固定事件" />
        </Card>
      ) : (
        <div className="cards">
          {events.data.map((event) => (
            <Card key={event.id}>
              <div className="card-heading">
                <h3>{event.title}</h3>
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
              {event.start_at !== event.original_start_at && (
                <p className="muted">
                  原定：{displayTime(event.original_start_at, profile.timezone)}{" "}
                  — {displayTime(event.original_end_at, profile.timezone)}
                </p>
              )}
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
              <Space wrap>
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
        onCancel={() => setEditing(undefined)}
        onOk={() => form.submit()}
        confirmLoading={write.isPending}
        destroyOnHidden
      >
        <Form
          form={form}
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
              setEditing(undefined);
            } catch (e) {
              if (e instanceof Error && !(e instanceof ApiError))
                void message.error(e.message);
            }
          }}
        >
          {editing?.series_id && (
            <Alert
              type="info"
              message="此处只编辑当前课程实例，不改变其他周次及原始排课。"
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
                message: "请选择课程，或先添加课程",
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
        </Form>
      </Modal>
      <Modal
        title="添加课程"
        open={courseOpen}
        onCancel={() => setCourseOpen(false)}
        onOk={() => courseForm.submit()}
        confirmLoading={write.isPending}
      >
        <Form
          form={courseForm}
          layout="vertical"
          onFinish={async (values) => {
            try {
              await write.mutateAsync({ path: "/courses", body: values });
              setCourseOpen(false);
            } catch {
              /* mutation reports errors */
            }
          }}
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
        onCancel={() => setSeriesOpen(false)}
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
              setSeriesOpen(false);
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
          <p className="muted">
            日期范围包含首尾两天，最多 366
            天。夏令时歧义会明确提示，确认保存后生成各次课程。
          </p>
        </Form>
      </Modal>
    </>
  );
}
