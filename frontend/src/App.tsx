import { useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
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
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import luxonPlugin from "@fullcalendar/luxon3";
import zhLocale from "@fullcalendar/core/locales/zh-cn";
import { api, ApiError, setCsrf } from "./api";
import type {
  Auth,
  Event,
  EventInput,
  Profile,
  ProfileInput,
  Task,
  TaskInput,
} from "./api";
import { displayTime, toInstant, toLocal } from "./time";

const states = [
  { value: "todo", label: "待开始" },
  { value: "in_progress", label: "进行中" },
  { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];
const priorities = [1, 2, 3, 4].map((value) => ({
  value,
  label: ["低", "普通", "高", "紧急"][value - 1],
}));
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

function Login({
  initialized,
  onDone,
}: {
  initialized: boolean;
  onDone: (auth: Auth) => void;
}) {
  const mutation = useMutation({
    mutationFn: (values: { username: string; password: string }) =>
      api<Auth>(
        initialized ? "/auth/login" : "/auth/setup",
        "POST",
        initialized
          ? values
          : {
              ...values,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
      ),
    onSuccess: onDone,
  });
  return (
    <main className="login">
      <div className="brand">STUDENT AGENT</div>
      <h1>
        让每一天，
        <br />
        更有安排。
      </h1>
      <p className="muted">从一个任务开始，逐步找到适合自己的节奏。</p>
      <Card title={initialized ? "欢迎回来" : "创建你的个人账号"}>
        {mutation.error && (
          <Alert type="error" message={errorText(mutation.error)} showIcon />
        )}
        <Form layout="vertical" onFinish={(values) => mutation.mutate(values)}>
          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, max: 64 }]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[
              {
                required: true,
                min: 10,
                max: 128,
                message: "密码需为 10–128 个字符",
              },
            ]}
          >
            <Input.Password
              autoComplete={initialized ? "current-password" : "new-password"}
            />
          </Form.Item>
          <Button
            block
            type="primary"
            htmlType="submit"
            loading={mutation.isPending}
          >
            {initialized ? "登录" : "创建账号并进入"}
          </Button>
        </Form>
      </Card>
    </main>
  );
}

export default function App() {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const auth = await api<Auth>("/auth/me");
      setCsrf(auth.csrf_token);
      return auth;
    },
  });
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api<{ initialized: boolean }>("/auth/status"),
    enabled: me.error instanceof ApiError && me.error.status === 401,
  });
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", "POST"),
    onSuccess: async () => {
      setCsrf("");
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      await client.resetQueries({ queryKey: ["me"] });
    },
  });
  if (me.isPending)
    return (
      <div className="center">
        <Spin tip="正在加载" />
      </div>
    );
  if (!me.data || (me.error instanceof ApiError && me.error.status === 401)) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      if (status.isPending)
        return (
          <div className="center">
            <Spin />
          </div>
        );
      if (status.data)
        return (
          <Login
            initialized={status.data.initialized}
            onDone={(auth) => {
              setCsrf(auth.csrf_token);
              client.setQueryData(["me"], auth);
            }}
          />
        );
    }
    return (
      <div className="center">
        <Alert
          type="error"
          message={errorText(status.error ?? me.error)}
          action={
            <Button
              onClick={() => {
                void me.refetch();
                void status.refetch();
              }}
            >
              重试
            </Button>
          }
        />
      </div>
    );
  }
  const profile = me.data.user;
  return (
    <div className="shell">
      <aside>
        <div className="brand">STUDENT AGENT</div>
        <div className="brand-sub">你的学习安排</div>
        <nav>
          {[
            ["/", "今日 / 本周"],
            ["/tasks", "任务"],
            ["/events", "课表 / 事件"],
            ["/settings", "设置"],
          ].map(([path, label]) => (
            <NavLink end={path === "/"} to={path} key={path}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="account">
          <span>{profile.username}</span>
          <Button
            type="text"
            onClick={() => logout.mutate()}
            loading={logout.isPending}
          >
            退出
          </Button>
        </div>
      </aside>
      <main className="content">
        {logout.error && (
          <Alert type="error" message={errorText(logout.error)} />
        )}
        <Routes>
          <Route path="/" element={<CalendarPage profile={profile} />} />
          <Route path="/tasks" element={<TasksPage profile={profile} />} />
          <Route path="/events" element={<EventsPage profile={profile} />} />
          <Route
            path="/settings"
            element={<SettingsPage profile={profile} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function CalendarPage({ profile }: { profile: Profile }) {
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">YOUR WEEK</div>
          <h1>留出时间，专注当下</h1>
          <p className="muted">
            查看固定安排，从容开始本周。当前时区：{profile.timezone}
          </p>
        </div>
      </header>
      <Alert
        type="info"
        message="当前展示手动创建的固定事件；智能排程将在后续阶段接入。"
      />
      {events.error && <Alert type="error" message={errorText(events.error)} />}
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
          allDaySlot={false}
          slotMinTime="06:00:00"
          slotMaxTime="24:00:00"
          events={
            events.data?.map((e) => ({
              id: e.id,
              title: e.title,
              start: e.start_at,
              end: e.end_at,
              color: "#37735c",
            })) ?? []
          }
        />
      </Card>
    </>
  );
}

function TasksPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message } = AntApp.useApp();
  const [trashed, setTrashed] = useState(false);
  const [editing, setEditing] = useState<Task | null | undefined>(undefined);
  const [form] = Form.useForm();
  const tasks = useQuery({
    queryKey: ["tasks", trashed],
    queryFn: () => api<Task[]>(`/tasks?trashed=${trashed}`),
  });
  const mutation = useMutation({
    mutationFn: ({
      path,
      body,
      method = "POST",
    }: {
      path: string;
      body?: unknown;
      method?: string;
    }) => api(path, method, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      setEditing(undefined);
      void message.success("已保存");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const edit = (task: Task | null) => {
    form.resetFields();
    form.setFieldsValue(
      task
        ? { ...task, deadline_at: toLocal(task.deadline_at, profile.timezone) }
        : { status: "todo", priority: 2, description: "" },
    );
    setEditing(task);
  };
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">ONE STEP AT A TIME</div>
          <h1>任务</h1>
          <p className="muted">把想做的事记下来，为每一步留出空间。</p>
        </div>
        <Button type="primary" onClick={() => edit(null)}>
          新建任务
        </Button>
      </header>
      <Space className="toolbar">
        <Button
          type={!trashed ? "primary" : "default"}
          onClick={() => setTrashed(false)}
        >
          我的任务
        </Button>
        <Button
          type={trashed ? "primary" : "default"}
          onClick={() => setTrashed(true)}
        >
          垃圾箱
        </Button>
      </Space>
      {tasks.error && <Alert type="error" message={errorText(tasks.error)} />}
      {tasks.isPending ? (
        <Spin />
      ) : !tasks.data?.length ? (
        <Card>
          <Empty
            description={
              trashed ? "垃圾箱为空" : "还没有任务，先添加一件想完成的事"
            }
          />
        </Card>
      ) : (
        <div className="cards">
          {tasks.data.map((task) => (
            <Card key={task.id} className="task-card">
              <div className="card-heading">
                <h3>{task.title}</h3>
                <Tag color={task.status === "done" ? "green" : "default"}>
                  {states.find((s) => s.value === task.status)?.label}
                </Tag>
              </div>
              <p className="description">{task.description || "暂无描述"}</p>
              <div className="meta">
                截止：{displayTime(task.deadline_at, profile.timezone)} · 预计{" "}
                {task.estimate_minutes ?? "—"} 分钟 ·{" "}
                {priorities[task.priority - 1].label}
              </div>
              <Space wrap>
                {trashed ? (
                  <Button
                    onClick={() =>
                      mutation.mutate({ path: `/tasks/${task.id}/restore` })
                    }
                    disabled={mutation.isPending}
                  >
                    恢复任务
                  </Button>
                ) : (
                  <>
                    <Button onClick={() => edit(task)}>编辑</Button>
                    <Button
                      danger
                      onClick={() =>
                        mutation.mutate({ path: `/tasks/${task.id}/trash` })
                      }
                      disabled={mutation.isPending}
                    >
                      移入垃圾箱
                    </Button>
                  </>
                )}
              </Space>
            </Card>
          ))}
        </div>
      )}
      <Modal
        title={editing ? "编辑任务" : "新建任务"}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        onOk={() => form.submit()}
        confirmLoading={mutation.isPending}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            try {
              const body: TaskInput = {
                ...values,
                deadline_at: toInstant(
                  values.deadline_at ?? "",
                  profile.timezone,
                ),
                estimate_minutes: values.estimate_minutes ?? null,
                task_type: values.task_type || null,
              };
              mutation.mutate({
                path: editing ? `/tasks/${editing.id}` : "/tasks",
                method: editing ? "PUT" : "POST",
                body,
              });
            } catch (e) {
              void message.error(errorText(e));
            }
          }}
        >
          <Form.Item
            name="title"
            label="任务标题"
            rules={[{ required: true, whitespace: true, max: 200 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label="任务描述">
            <Input.TextArea rows={3} maxLength={20000} />
          </Form.Item>
          <div className="form-grid">
            <Form.Item name="status" label="执行状态">
              <Select options={states} />
            </Form.Item>
            <Form.Item name="priority" label="优先级">
              <Select options={priorities} />
            </Form.Item>
          </div>
          <Form.Item
            name="deadline_at"
            label={`截止时间（${profile.timezone}）`}
          >
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="estimate_minutes" label="预计用时（分钟，可留空）">
            <InputNumber min={1} max={100000} precision={0} />
          </Form.Item>
          <Form.Item name="task_type" label="任务类型（可选）">
            <Input placeholder="例如 reading / coding" maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function EventsPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState<Event | null | undefined>(undefined);
  const [form] = Form.useForm();
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const mutation = useMutation({
    mutationFn: (body: EventInput) =>
      api(
        editing ? `/events/${editing.id}` : "/events",
        editing ? "PUT" : "POST",
        body,
      ),
    onSuccess: () => {
      setEditing(undefined);
      void client.invalidateQueries({ queryKey: ["events"] });
      void message.success("事件已保存");
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
          }
        : { location: "" },
    );
    setEditing(event);
  };
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">MAKE ROOM</div>
          <h1>课表 / 事件</h1>
          <p className="muted">手动添加课程、会议和其他固定安排。</p>
        </div>
        <Button type="primary" onClick={() => edit(null)}>
          添加事件
        </Button>
      </header>
      {events.error && <Alert type="error" message={errorText(events.error)} />}
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
                <Tag>固定时间</Tag>
              </div>
              <p>
                {displayTime(event.start_at, profile.timezone)} —{" "}
                {displayTime(event.end_at, profile.timezone)}
              </p>
              <p className="muted">{event.location || "未设置地点"}</p>
              <Button onClick={() => edit(event)}>编辑事件</Button>
            </Card>
          ))}
        </div>
      )}
      <Modal
        title={editing ? "编辑事件" : "添加事件"}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        onOk={() => form.submit()}
        confirmLoading={mutation.isPending}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            try {
              const start = toInstant(values.start_at, profile.timezone);
              const end = toInstant(values.end_at, profile.timezone);
              if (!start || !end) throw new Error("请填写起止时间");
              mutation.mutate({
                ...values,
                start_at: start,
                end_at: end,
                timezone: profile.timezone,
                locked: editing?.locked ?? true,
                course_id: editing?.course_id ?? null,
              });
            } catch (e) {
              void message.error(errorText(e));
            }
          }}
        >
          <Form.Item
            name="title"
            label="事件标题"
            rules={[{ required: true, whitespace: true, max: 200 }]}
          >
            <Input />
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
    </>
  );
}

function SettingsPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (body: ProfileInput) => api<Profile>("/profile", "PUT", body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["me"] });
      void message.success("设置已保存");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">YOUR OWN RHYTHM</div>
          <h1>按自己的节奏</h1>
          <p className="muted">可以先使用默认设置，之后随时调整。</p>
        </div>
      </header>
      <Card className="settings">
        <Form
          form={form}
          layout="vertical"
          initialValues={profile}
          onFinish={(values) => save.mutate(values)}
        >
          <Form.Item
            name="timezone"
            label="显示时区（IANA）"
            rules={[{ required: true }]}
          >
            <Input placeholder="Asia/Shanghai" />
          </Form.Item>
          <Button
            className="toolbar"
            onClick={() =>
              form.setFieldValue(
                "timezone",
                Intl.DateTimeFormat().resolvedOptions().timeZone,
              )
            }
          >
            使用浏览器时区
          </Button>
          <p className="muted">
            更改时区只改变显示方式，已有事件对应的真实时间保持不变。
          </p>
          {(["available_windows", "rest_windows"] as const).map((field) => (
            <section key={field}>
              <h3>
                {field === "available_windows"
                  ? "每周可用时间"
                  : "通常休息时段"}
              </h3>
              <p className="muted">
                可留空；跨午夜的窗口请拆为两天。星期一为一周起点。
              </p>
              <Form.List name={field}>
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(({ key, name, ...rest }) => (
                      <div className="window-row" key={key}>
                        <Form.Item
                          {...rest}
                          name={[name, "weekday"]}
                          rules={[{ required: true }]}
                        >
                          <Select
                            aria-label="星期"
                            options={[
                              "一",
                              "二",
                              "三",
                              "四",
                              "五",
                              "六",
                              "日",
                            ].map((v, i) => ({ value: i, label: `周${v}` }))}
                          />
                        </Form.Item>
                        <Form.Item
                          {...rest}
                          name={[name, "start"]}
                          rules={[{ required: true }]}
                        >
                          <Input aria-label="窗口开始" type="time" />
                        </Form.Item>
                        <Form.Item
                          {...rest}
                          name={[name, "end"]}
                          rules={[{ required: true }]}
                        >
                          <Input aria-label="窗口结束" type="time" />
                        </Form.Item>
                        <Button onClick={() => remove(name)}>移除</Button>
                      </div>
                    ))}
                    <Button
                      onClick={() =>
                        add({ weekday: 0, start: "09:00", end: "17:00" })
                      }
                    >
                      添加时段
                    </Button>
                  </>
                )}
              </Form.List>
            </section>
          ))}
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            保存设置
          </Button>
        </Form>
      </Card>
    </>
  );
}
