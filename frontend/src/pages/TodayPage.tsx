import { Link } from "react-router-dom";
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
  InputNumber,
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
import InlineDeadline from "../components/InlineDeadline";
import { eventTypeLabel, priorityLabel, staleInfo } from "../semantics";
import { recurrenceLabel } from "../tasks";
import { parseQuickAdd, type ParsedQuickAdd } from "../nlp";

export default function TodayPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [draft, setDraft] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [completing, setCompleting] = useState<Task | null>(null);
  const completionRef = useRef<HTMLElement | null>(null);
  const [completeForm] = Form.useForm();
  useEffect(() => {
    if (!completing) return;
    completionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [completing]);
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
            <span>
              已完成“{task.title}”
              {task.recurrence ? "，下一次已生成" : ""}
            </span>
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
      const recurring = !!completing?.recurrence;
      setCompleting(null);
      completeForm.resetFields();
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["worklogs"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      void message.success(
        `任务已完成，实际耗时已记录${recurring ? "，下一次已生成" : ""}`,
      );
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
  const active = (tasks.data ?? []).filter((t) => t.status !== "done");
  const todayTasks = active
    .filter(
      (t) =>
        t.status === "in_progress" ||
        (t.deadline_at && DateTime.fromISO(t.deadline_at) < tomorrow),
    )
    .sort(
      (a, b) =>
        (a.deadline_at ?? "9999").localeCompare(b.deadline_at ?? "9999") ||
        a.sort_order - b.sort_order ||
        b.created_at.localeCompare(a.created_at),
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
      return (
        a.deadline_at.localeCompare(b.deadline_at) ||
        a.sort_order - b.sort_order ||
        b.created_at.localeCompare(a.created_at)
      );
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
    const expanded = expandedId === task.id;
    const taskList = (lists.data ?? []).find(
      (list) => list.id === task.list_id,
    );
    const toggle = () => setExpandedId(expanded ? null : task.id);
    return (
      <div
        className={expanded ? "task-row task-card expanded" : "task-row task-card"}
        key={task.id}
      >
        <Checkbox
          aria-label={`完成 ${task.title}`}
          checked={false}
          onChange={() => complete.mutate(task)}
        />
        <div className="task-row-main">
          <div className="task-row-titleline">
            <button
              type="button"
              className="row-title-button"
              onClick={toggle}
              aria-expanded={expanded}
            >
              <h3>{task.title}</h3>
            </button>
            <InlineDeadline
              task={task}
              timezone={profile.timezone}
              onChange={(deadline_at, deadline_all_day) =>
                setDeadline.mutate({ task, deadline_at, deadline_all_day })
              }
            />
            {task.remind_at && (
              <span className="task-row-reminder">
                提醒 {displayTime(task.remind_at, profile.timezone)}
              </span>
            )}
            {taskList && (
              <span className="task-row-list">
                <span
                  className="task-row-list-dot"
                  style={{ background: taskList.color }}
                />
                {taskList.name}
              </span>
            )}
            {task.status === "in_progress" && (
              <span className="task-row-list">进行中</span>
            )}
            {task.priority >= 3 && (
              <span className="task-row-priority">
                {priorityLabel(task.priority)}
              </span>
            )}
            {task.flagged && (
              <span className="task-row-flag" aria-label="已标记为重点">
                ★
              </span>
            )}
            <span className="row-chevron" aria-hidden="true">
              {expanded ? "▾" : "▸"}
            </span>
          </div>
          {expanded && (
            <div
              className="row-detail"
              onClick={(event) => event.stopPropagation()}
            >
              {task.description && (
                <p className="description">{task.description}</p>
              )}
              {task.tags.length > 0 && (
                <div className="row-detail-meta">
                  {task.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              )}
              <div className="row-detail-meta">
                <span>{priorityLabel(task.priority)}</span>
                <span>预计 {task.estimate_minutes ?? "—"} 分钟</span>
                {task.recurrence &&
                  `重复：${recurrenceLabel(
                    task.recurrence,
                    task.recurrence_interval,
                    task.recurrence_from_completion,
                  )}`}
              </div>
              <div className="row-actions">
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    setFlag.mutate({ task, flagged: !task.flagged })
                  }
                  loading={
                    setFlag.isPending &&
                    setFlag.variables?.task.id === task.id
                  }
                >
                  {task.flagged ? "取消标记" : "标记"}
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
          )}
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
      {completing && (
        <section className="section inline-editor" ref={completionRef}>
          <div className="section-inline-heading">
            <h3>完成“{completing.title}”</h3>
            <Button type="text" onClick={() => setCompleting(null)}>
              收起
            </Button>
          </div>
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
          <div className="row-actions">
            <Button type="text" onClick={() => setCompleting(null)}>
              取消
            </Button>
            <Button
              type="text"
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
          </div>
        </section>
      )}
    </>
  );
}
