import { Link } from "react-router-dom";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { DateTime } from "luxon";
import { api, type Plan, type Event, type Task, type Profile } from "../api";
import { displayTime } from "../time";
import { withFrom } from "../navigation";
import { eventTypeLabel, priorityLabel, staleInfo } from "../semantics";

function taskBody(task: Task, status = task.status) {
  return {
    title: task.title,
    description: task.description,
    status,
    priority: task.priority,
    deadline_at: task.deadline_at,
    estimate_minutes: task.estimate_minutes,
    task_type: task.task_type,
    parent_id: task.parent_id,
    predecessor_ids: task.predecessor_ids,
    parallel_policy: task.parallel_policy,
    confirm_impact: false,
  };
}

export default function TodayPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [title, setTitle] = useState("");
  const [completing, setCompleting] = useState<Task | null>(null);
  const [completeForm] = Form.useForm();
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
  const create = useMutation({
    mutationFn: () => api<Task>("/tasks", "POST", { title: title.trim() }),
    onSuccess: () => {
      setTitle("");
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      void message.success("任务已添加");
    },
    onError: (e) => void message.error(e.message),
  });
  const complete = useMutation({
    mutationFn: (task: Task) =>
      api(`/tasks/${task.id}`, "PUT", taskBody(task, "done")),
    onSuccess: () => {
      setCompleting(null);
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      void message.success("任务已完成");
    },
    onError: (e) => void message.error(e.message),
  });
  const logWork = useMutation({
    mutationFn: (values: {
      actual_minutes: number;
      cause?: string;
      note?: string;
      reflection?: string;
    }) =>
      api(`/tasks/${completing!.id}/worklogs`, "POST", {
        ...values,
        complete: true,
      }),
    onSuccess: () => {
      setCompleting(null);
      completeForm.resetFields();
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["worklogs"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      void message.success("任务已完成，实际耗时已记录");
    },
    onError: (e) => void message.error(e.message),
  });
  const now = DateTime.now().setZone(profile.timezone);
  const day = now.startOf("day");
  const tomorrow = day.plus({ days: 1 });
  const week = day.plus({ days: 7 });
  const active = (tasks.data ?? []).filter(
    (t) => !["done", "cancelled"].includes(t.status),
  );
  const todayTasks = active
    .filter(
      (t) =>
        t.status === "in_progress" ||
        (t.deadline_at && DateTime.fromISO(t.deadline_at) < tomorrow),
    )
    .sort((a, b) =>
      (a.deadline_at ?? "9999").localeCompare(b.deadline_at ?? "9999"),
    );
  const todayIds = new Set(todayTasks.map((t) => t.id));
  const upcoming = active
    .filter((t) => !todayIds.has(t.id))
    .sort((a, b) => {
      if (!a.deadline_at) return 1;
      if (!b.deadline_at) return -1;
      return a.deadline_at.localeCompare(b.deadline_at);
    })
    .filter(
      (t) => !t.deadline_at || DateTime.fromISO(t.deadline_at) < week,
    )
    .slice(0, 6);
  const agenda = (events.data ?? [])
    .filter(
      (e) =>
        !e.is_skipped &&
        DateTime.fromISO(e.start_at) < tomorrow &&
        DateTime.fromISO(e.end_at) > day,
    )
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  const stale = plan.data ? staleInfo(plan.data) : null;
  const error = plan.error ?? events.error ?? tasks.error;
  const taskLine = (task: Task) => {
    const deadline = task.deadline_at
      ? DateTime.fromISO(task.deadline_at).setZone(profile.timezone)
      : null;
    const overdue = deadline ? deadline < now : false;
    return (
      <div className="task-row" key={task.id}>
        <Checkbox
          aria-label={`完成 ${task.title}`}
          checked={false}
          onChange={() => {
            completeForm.resetFields();
            completeForm.setFieldsValue({
              actual_minutes: task.estimate_minutes ?? undefined,
              cause: "unknown",
            });
            setCompleting(task);
          }}
        />
        <div className="task-row-main">
          <Link to={withFrom(`/tasks/${task.id}`, "/")}>{task.title}</Link>
          <div className="task-row-meta">
            {deadline ? (
              <span className={overdue ? "danger-text" : ""}>
                {overdue ? "已逾期 · " : "截止 · "}
                {deadline.toFormat("MM-dd HH:mm")}
              </span>
            ) : (
              <span>未设置截止时间</span>
            )}
            <span>{priorityLabel(task.priority)}</span>
            {task.status === "in_progress" && <Tag color="blue">进行中</Tag>}
          </div>
        </div>
      </div>
    );
  };
  return (
    <>
      <header>
        <div>
          <h1>今天</h1>
          <p className="muted">
            {now.toFormat("yyyy年M月d日 cccc")} · {profile.timezone}
          </p>
        </div>
        <Space wrap>
          <Link to="/tasks/new?from=/">新建任务</Link>
          <Link
            to={`/calendar/events/new?date=${now.toFormat("yyyy-MM-dd")}&from=/`}
          >
            新建事件
          </Link>
          <Link to="/tasks">全部任务</Link>
          <Link to="/calendar">查看日历</Link>
        </Space>
      </header>
      {error && <Alert type="error" message={error.message} />}
      <section className="quick-add">
        <Input
          aria-label="快速添加任务"
          size="large"
          value={title}
          placeholder="记录一件要做的事，按回车添加"
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={() => {
            if (title.trim()) create.mutate();
          }}
        />
        <Button
          type="primary"
          size="large"
          loading={create.isPending}
          disabled={!title.trim()}
          onClick={() => create.mutate()}
        >
          添加
        </Button>
      </section>
      {plan.isPending || events.isPending || tasks.isPending ? (
        <Spin />
      ) : (
        <>
          <section className="today-block">
            <div className="section-heading">
              <h2>今天要做</h2>
              <span className="muted">{todayTasks.length} 项</span>
            </div>
            {todayTasks.length ? (
              todayTasks.map(taskLine)
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="今天没有待办任务"
              />
            )}
          </section>

          <section className="today-block">
            <div className="section-heading">
              <h2>今天的安排</h2>
              <Link to="/calendar">打开日历</Link>
            </div>
            {agenda.length ? (
              agenda.map((event) => (
                <p key={event.id} className="agenda-row">
                  <span className="agenda-time">
                    {displayTime(event.start_at, profile.timezone)}
                  </span>
                  <Tag color="default">{eventTypeLabel(event)}</Tag>
                  <Link to={withFrom(`/calendar/events/${event.id}`, "/")}>
                    {event.title}
                  </Link>
                </p>
              ))
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="今天没有课程或固定安排"
              />
            )}
          </section>

          {upcoming.length > 0 && (
            <section className="today-block">
              <div className="section-heading">
                <h2>接下来</h2>
                <Link to="/tasks">查看全部</Link>
              </div>
              {upcoming.map(taskLine)}
            </section>
          )}

          <section className="agent-card">
            <div>
              <strong>Agent 安排</strong>
              <p className="muted">
                {stale
                  ? stale.detail
                  : plan.data
                    ? "当前计划已生成。可以查看安排，或根据今天的情况重新安排。"
                    : "需要时再让 Agent 根据任务和课程安排时间。"}
              </p>
            </div>
            <Space wrap>
              {plan.data && !stale && (
                <Link to={`/plans/${plan.data.id}`}>查看当前安排</Link>
              )}
              <Link to={withFrom("/plans/new", "/")}>
                <Button type={plan.data && !stale ? "default" : "primary"}>
                  {plan.data && !stale ? "重新安排" : "让 Agent 安排"}
                </Button>
              </Link>
            </Space>
          </section>
        </>
      )}
      <Modal
        title={completing ? `完成“${completing.title}”` : "完成任务"}
        open={!!completing}
        onCancel={() => setCompleting(null)}
        okText="完成并记录"
        cancelText="取消"
        confirmLoading={logWork.isPending}
        footer={
          <Space>
            <Button onClick={() => setCompleting(null)}>取消</Button>
            <Button
              onClick={() => completing && complete.mutate(completing)}
              loading={complete.isPending}
            >
              不记录，直接完成
            </Button>
            <Button
              type="primary"
              loading={logWork.isPending}
              onClick={() => completeForm.submit()}
            >
              完成并记录
            </Button>
          </Space>
        }
      >
        <Form
          form={completeForm}
          layout="vertical"
          onFinish={(values) => logWork.mutate(values)}
        >
          <Form.Item
            name="actual_minutes"
            label="实际用了多少分钟"
            rules={[{ required: true, message: "请填写实际用时" }]}
          >
            <InputNumber min={1} max={100000} precision={0} />
          </Form.Item>
          <Form.Item name="cause" label="和预计不一样的原因">
            <Select
              options={[
                { value: "unknown", label: "不说明" },
                { value: "underestimated", label: "低估了难度" },
                { value: "scope_changed", label: "任务范围变了" },
                { value: "interrupted", label: "被打断" },
                { value: "scheduling_issue", label: "安排不合适" },
                { value: "other", label: "其他" },
              ]}
            />
          </Form.Item>
          <Form.Item name="note" label="过程备注">
            <Input maxLength={2000} />
          </Form.Item>
          <Form.Item name="reflection" label="完成后的感受（可选）">
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
