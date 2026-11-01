import { Link } from "react-router-dom";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Dropdown,
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
import {
  api,
  type Plan,
  type Event,
  type Task,
  type Profile,
  type TaskList,
} from "../api";
import { displayTime } from "../time";
import { withFrom } from "../navigation";
import { eventTypeLabel, priorityLabel, staleInfo } from "../semantics";
import { deadlineLabel, quickDeadlineOptions } from "../tasks";
import { parseQuickAdd, type ParsedQuickAdd } from "../nlp";

export default function TodayPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [draft, setDraft] = useState("");
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
  const lists = useQuery({
    queryKey: ["task-lists"],
    queryFn: () => api<TaskList[]>("/task-lists"),
  });
  const create = useMutation({
    mutationFn: (parsed: ParsedQuickAdd) =>
      api<Task>("/tasks", "POST", {
        title: parsed.title.trim(),
        priority: parsed.priority,
        deadline_at: parsed.deadline_at,
        deadline_all_day: parsed.deadline_all_day,
        tags: parsed.tags,
        estimate_minutes: parsed.estimate_minutes,
        list_id: parsed.list_id,
      }),
    onSuccess: () => {
      setDraft("");
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      void client.invalidateQueries({ queryKey: ["tags"] });
      void message.success("任务已添加");
    },
    onError: (e) => void message.error(e.message),
  });
  const refreshTasks = () => {
    void client.invalidateQueries({ queryKey: ["tasks"] });
    void client.invalidateQueries({ queryKey: ["plans"] });
  };
  const reopen = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}/reopen`, "POST"),
    onSuccess: () => {
      refreshTasks();
      void message.success("任务已恢复为待办");
    },
    onError: (e) => void message.error(e.message),
  });
  const complete = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}/complete`, "POST"),
    onSuccess: (_data, task) => {
      setCompleting(null);
      refreshTasks();
      message.open({
        type: "success",
        duration: 8,
        content: (
          <Space wrap>
            <span>已完成“{task.title}”</span>
            <Button
              type="link"
              size="small"
              onClick={() => reopen.mutate(task)}
            >
              撤销
            </Button>
          </Space>
        ),
      });
    },
    onError: (e) => void message.error(e.message),
  });
  const setDeadline = useMutation({
    mutationFn: ({
      task,
      deadline_at,
      deadline_all_day,
    }: {
      task: Task;
      deadline_at: string | null;
      deadline_all_day: boolean;
    }) =>
      api(`/tasks/${task.id}/deadline`, "PATCH", {
        deadline_at,
        deadline_all_day,
      }),
    onSuccess: () => {
      refreshTasks();
      void message.success("截止时间已更新");
    },
    onError: (e) => void message.error(e.message),
  });
  const setFlag = useMutation({
    mutationFn: ({ task, flagged }: { task: Task; flagged: boolean }) =>
      api(`/tasks/${task.id}/flag`, "PATCH", { flagged }),
    onSuccess: () => refreshTasks(),
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
  const quick = parseQuickAdd(
    draft,
    now,
    profile.timezone,
    lists.data ?? [],
  );
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
  const overdueTasks = todayTasks.filter(
    (t) => t.deadline_at && DateTime.fromISO(t.deadline_at) < now,
  );
  const overdueIds = new Set(overdueTasks.map((t) => t.id));
  const dueToday = todayTasks.filter((t) => !overdueIds.has(t.id));
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
  const deadlineOptions = quickDeadlineOptions(now);
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
          onChange={() => complete.mutate(task)}
        />
        <div className="task-row-main">
          <Link to={withFrom(`/tasks/${task.id}`, "/")}>{task.title}</Link>
          <div className="task-row-meta">
            {deadline ? (
              <span className={overdue ? "danger-text" : ""}>
                {overdue ? "已逾期 · " : "截止 · "}
                {deadlineLabel(
                  task.deadline_at,
                  task.deadline_all_day,
                  profile.timezone,
                )}
              </span>
            ) : (
              <span>未设置截止时间</span>
            )}
            <span>{priorityLabel(task.priority)}</span>
            {task.status === "in_progress" && <Tag color="blue">进行中</Tag>}
            <Dropdown
              menu={{
                items: deadlineOptions.map(({ key, label }) => ({
                  key,
                  label,
                })),
                onClick: ({ key }) => {
                  const option = deadlineOptions.find(
                    (item) => item.key === key,
                  );
                  if (option)
                    setDeadline.mutate({
                      task,
                      deadline_at: option.deadline_at,
                      deadline_all_day: option.deadline_all_day,
                    });
                },
              }}
            >
              <Button type="text" size="small">
                改期
              </Button>
            </Dropdown>
            <Button
              type="text"
              size="small"
              className={task.flagged ? "flag-button active" : "flag-button"}
              aria-label={
                task.flagged
                  ? `取消标记 ${task.title}`
                  : `标记 ${task.title}`
              }
              loading={
                setFlag.isPending && setFlag.variables?.task.id === task.id
              }
              onClick={() =>
                setFlag.mutate({ task, flagged: !task.flagged })
              }
            >
              {task.flagged ? "★" : "☆"}
            </Button>
            <Button
              type="text"
              size="small"
              onClick={() => {
                completeForm.resetFields();
                completeForm.setFieldsValue({
                  actual_minutes: task.estimate_minutes ?? undefined,
                  cause: "unknown",
                });
                setCompleting(task);
              }}
            >
              记录用时
            </Button>
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
      <div className="quick-add-block">
        <section className="quick-add">
          <Input
            aria-label="快速添加任务"
            size="large"
            value={draft}
            placeholder="例如：明天下午3点交高数作业 #数学 !高 预计30分钟"
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={() => {
              if (quick.title.trim()) create.mutate(quick);
            }}
          />
          <Button
            type="primary"
            size="large"
            loading={create.isPending}
            disabled={!quick.title.trim()}
            onClick={() => create.mutate(quick)}
          >
            添加
          </Button>
        </section>
        {draft.trim() &&
          (quick.chips.length > 0 || quick.warnings.length > 0) && (
            <div className="quick-add-preview">
              <span className="muted">
                {quick.title ? `将创建：${quick.title}` : quick.warnings[0]}
              </span>
              {quick.chips.map((chip) => (
                <Tag key={chip.key}>{chip.label}</Tag>
              ))}
            </div>
          )}
      </div>
      {plan.isPending || events.isPending || tasks.isPending ? (
        <Spin />
      ) : (
        <>
          {overdueTasks.length > 0 && (
            <section className="today-block">
              <div className="section-heading">
                <h2>逾期</h2>
                <span className="muted">{overdueTasks.length} 项</span>
              </div>
              {overdueTasks.map(taskLine)}
            </section>
          )}
          <section className="today-block">
            <div className="section-heading">
              <h2>今天要做</h2>
              <span className="muted">{dueToday.length} 项</span>
            </div>
            {dueToday.length ? (
              dueToday.map(taskLine)
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
