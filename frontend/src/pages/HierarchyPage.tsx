import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Spin,
} from "antd";
import { DateTime } from "luxon";
import {
  api,
  type Course,
  type Event,
  type Profile,
  type Series,
} from "../api";
import { displayTime } from "../time";
import SourceButton from "../components/SourceButton";
import { backTarget, withFrom } from "../navigation";

type Write = { path: string; method: string; body: unknown };
export default function HierarchyPage({
  profile,
  kind,
}: {
  profile: Profile;
  kind: "course" | "series";
}) {
  const { id } = useParams();
  const location = useLocation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { modal, message } = App.useApp();
  const courses = useQuery({
    queryKey: ["courses"],
    queryFn: () => api<Course[]>("/courses"),
  });
  const series = useQuery({
    queryKey: ["series"],
    queryFn: () => api<Series[]>("/event-series"),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const currentSeries = series.data?.find((s) => s.id === id);
  const course = courses.data?.find(
    (c) => c.id === (kind === "course" ? id : currentSeries?.course_id),
  );
  const instances = events.data?.filter((e) => e.series_id === id) ?? [];
  const here = `${location.pathname}${location.search}`;
  const back = backTarget(params.get("from"), {
    to: "/calendar",
    label: "返回日历",
  });
  const courseSeries = series.data?.filter((s) => s.course_id === id) ?? [];
  const courseEvents =
    events.data?.filter((e) => e.course_id === id && !e.series_id) ?? [];
  const blocked = courseSeries.length > 0 || courseEvents.length > 0;
  const refresh = () => {
    for (const key of ["courses", "series", "events", "plans"])
      void client.invalidateQueries({ queryKey: [key] });
  };
  const save = useMutation({
    mutationFn: ({ path, method, body }: Write) => api(path, method, body),
    onSuccess: () => {
      refresh();
      void message.success("已保存");
    },
    onError: (e) => void message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () =>
      api(
        `/${kind === "course" ? "courses" : "event-series"}/${id}`,
        "DELETE",
        { confirmed: true },
      ),
    onSuccess: () => {
      refresh();
      navigate(back.to);
    },
    onError: (e) => void message.error(e.message),
  });
  const attendance = useMutation({
    mutationFn: (is_skipped: boolean) =>
      api(`/event-series/${id}/attendance`, "POST", {
        is_skipped,
        confirmed: true,
      }),
    onSuccess: refresh,
    onError: (e) => void message.error(e.message),
  });
  const error = courses.error ?? series.error ?? events.error;
  if (error) return <Alert type="error" message={error.message} />;
  if (courses.isPending || series.isPending || events.isPending)
    return <Spin />;
  if (!course || (kind === "series" && !currentSeries))
    return (
      <Card>
        <Empty description="记录不存在或已删除">
          <Link to={back.to}>{back.label}</Link>
        </Empty>
      </Card>
    );
  return (
    <>
      <header>
        <div>
          <h1>
            {course.name} · {kind === "course" ? "课程详情" : "每周课程详情"}
          </h1>
          {kind === "course" && course.semester && (
            <p className="muted">{course.semester}</p>
          )}
          <Space wrap>
            <Link to={back.to}>{back.label}</Link>
            {kind === "series" && (
              <Link
                to={
                  back.to.startsWith(`/calendar/courses/${course.id}`)
                    ? back.to
                    : withFrom(`/calendar/courses/${course.id}`, back.to)
                }
              >
                所属课程
              </Link>
            )}
            <Link to="/settings/rules?tab=courses">查看相关并行规则</Link>
          </Space>
        </div>
      </header>
      {kind === "course" ? (
        <>
          <Card title="课程资料" className="toolbar">
            <Form
              key={course.id}
              layout="vertical"
              initialValues={course}
              onFinish={(values) =>
                save.mutate({
                  path: `/courses/${id}`,
                  method: "PUT",
                  body: values,
                })
              }
            >
              <Form.Item
                name="name"
                label="课程名称"
                rules={[{ required: true, whitespace: true, max: 200 }]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="semester" label="学期">
                <Input maxLength={100} />
              </Form.Item>
              <Button htmlType="submit" loading={save.isPending}>
                保存课程
              </Button>
            </Form>
          </Card>
          <Card title="课程默认设置" className="toolbar">
            <Select
              aria-label={`${course.name}默认并行设置`}
              className="activity-select"
              value={course.parallel_policy}
              options={[
                { value: "none", label: "禁止并行" },
                { value: "allow_selected", label: "接受已允许的组合" },
              ]}
              onChange={(parallel_policy) =>
                save.mutate({
                  path: `/courses/${id}/parallel-policy`,
                  method: "PATCH",
                  body: { parallel_policy },
                })
              }
            />
            <p>仅应用于没有单次调整的课程实例。</p>
          </Card>
          <Card title="每周课程" className="toolbar">
            <Button
              className="toolbar"
              onClick={() =>
                navigate(
                  withFrom(`/calendar/series/new?course=${id}`, here),
                )
              }
            >
              建立每周课程
            </Button>
            {courseSeries.map((s) => (
              <p key={s.id}>
                <Link
                  to={withFrom(
                    `/calendar/series/${s.id}`,
                    here,
                  )}
                >
                  {s.dtstart_local.slice(0, 10)} 起 · {s.event_ids.length} 次课程
                </Link>
              </p>
            ))}
            {!courseSeries.length && (
              <Empty description="尚未建立每周课程" />
            )}
          </Card>
          <Card title="单次课程事件">
            <Button
              className="toolbar"
              onClick={() =>
                navigate(
                  withFrom(
                    `/calendar/events/new?course=${id}&date=${DateTime.now()
                      .setZone(profile.timezone)
                      .toFormat("yyyy-MM-dd")}`,
                    here,
                  ),
                )
              }
            >
              添加课程事件
            </Button>
            {courseEvents.map((e) => (
              <p key={e.id}>
                <Link
                  to={withFrom(`/calendar/events/${e.id}`, here)}
                >
                  {e.title} · {displayTime(e.start_at, profile.timezone)}
                </Link>
              </p>
            ))}
            {!courseEvents.length && <p className="muted">暂无单次课程事件。</p>}
          </Card>
        </>
      ) : (
        <>
          <Card title="批量修改时间与地点" className="toolbar">
            <Alert
              type="info"
              message="修改整门每周课程的原始时间和地点；已有单次时间、地点、参加状态和并行覆盖保留。日期范围与星期不变。"
            />
            <Form
              key={id}
              layout="vertical"
              initialValues={{
                start_time: currentSeries!.dtstart_local.slice(11, 16),
                end_time: DateTime.fromISO(currentSeries!.dtstart_local)
                  .plus({ minutes: currentSeries!.duration_minutes })
                  .toFormat("HH:mm"),
                location: currentSeries!.location,
                note: currentSeries!.note,
                details: currentSeries!.details,
              }}
              onFinish={(values) =>
                modal.confirm({
                  title: "修改整门每周课程？",
                  content: `将修改 ${instances.length} 次课程的原始安排，保留已有的本次调整；当前计划将标记为依据已变化。`,
                  onOk: () =>
                    save
                      .mutateAsync({
                        path: `/event-series/${id}`,
                        method: "PUT",
                        body: { ...values, confirmed: true },
                      })
                      .then(() => undefined),
                })
              }
            >
              <Form.Item
                name="start_time"
                label={`上课时间（${currentSeries!.timezone}）`}
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
              <Button htmlType="submit" loading={save.isPending}>
                批量保存
              </Button>
            </Form>
          </Card>
          <Space wrap className="toolbar">
            {[true, false].map((skipped) => (
              <Button
                key={String(skipped)}
                loading={
                  attendance.isPending && attendance.variables === skipped
                }
                onClick={() =>
                  modal.confirm({
                    title: skipped ? "将整门每周课程设为不参加？" : "恢复整门每周课程参加？",
                    content: `将把全部 ${instances.length} 次课程设为${skipped ? "不参加" : "参加"}，覆盖已有的单次参加状态；时间、地点与来源记录保留，计划将标记为依据已变化。`,
                    onOk: () =>
                      attendance.mutateAsync(skipped).then(() => undefined),
                  })
                }
              >
                {skipped ? "全部不参加" : "全部恢复参加"}
              </Button>
            ))}
            <SourceButton objectId={id!} />
          </Space>
          <Card title="各周实例">
            <div className="instance-list">
              {instances.map((e, i) => (
                <p key={e.id}>
                  <Link
                    to={withFrom(`/calendar/events/${e.id}`, here)}
                  >
                    第 {i + 1} 次 · {displayTime(e.start_at, profile.timezone)}{" "}
                    · {e.title}
                  </Link>{" "}
                  {e.is_skipped ? "（不参加）" : ""}
                </p>
              ))}
            </div>
          </Card>
        </>
      )}
      {kind === "course" && blocked && (
        <Alert
          className="toolbar"
          type="info"
          message={`删除课程前需要先清理 ${courseSeries.length} 门每周课程和 ${courseEvents.length} 个独立事件。`}
          description={
            <Space wrap>
              {courseSeries[0] && (
                <Link
                  to={withFrom(
                    `/calendar/series/${courseSeries[0].id}`,
                    here,
                  )}
                >
                  查看每周课程
                </Link>
              )}
              {courseEvents[0] && (
                <Link
                  to={withFrom(
                    `/calendar/events/${courseEvents[0].id}`,
                    here,
                  )}
                >
                  查看独立事件
                </Link>
              )}
            </Space>
          }
        />
      )}
      <Button
        className="toolbar"
        danger
        disabled={kind === "course" && blocked}
        loading={remove.isPending}
        onClick={() =>
          modal.confirm({
            title: kind === "course" ? "删除空课程？" : "删除整门每周课程？",
            content:
              kind === "course"
                ? "仅允许删除没有每周课程和事件的空课程。请先逐项清理；不会级联删除其他数据。"
                : `将永久删除本每周课程 ${instances.length} 次事件及其本次调整，保留所属课程、导入来源与历史计划。当前计划将标记为依据已变化。`,
            onOk: () => remove.mutateAsync().then(() => undefined),
          })
        }
      >
        {kind === "course" ? "删除课程" : "删除每周课程"}
      </Button>
    </>
  );
}
