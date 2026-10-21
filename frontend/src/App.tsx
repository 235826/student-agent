import ImportsPage from "./pages/ImportsPage";
import PlansPage from "./pages/PlansPage";
import type { Plan } from "./api";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Form,
  Input,
  Select,
  Spin,
} from "antd";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import luxonPlugin from "@fullcalendar/luxon3";
import zhLocale from "@fullcalendar/core/locales/zh-cn";
import { api, ApiError, setCsrf } from "./api";
import type { Auth, Event, Profile, ProfileInput } from "./api";
import TasksPage from "./pages/TasksPage";
import EventsPage from "./pages/EventsPage";
import CompatibilityPage from "./pages/CompatibilityPage";

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
            ["/imports", "导入整理"],
            ["/plans", "学习计划"],
            ["/events", "课表 / 事件"],
            ["/compatibility", "并行规则"],
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
          <Route path="/imports" element={<ImportsPage profile={profile} />} />
          <Route path="/plans" element={<PlansPage profile={profile} />} />
          <Route path="/tasks" element={<TasksPage profile={profile} />} />
          <Route path="/events" element={<EventsPage profile={profile} />} />
          <Route
            path="/compatibility"
            element={<CompatibilityPage profile={profile} />}
          />
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
  const plan = useQuery({
    queryKey: ["plans", "current"],
    queryFn: () => api<Plan | null>("/plans/current"),
  });
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
        message={
          plan.data?.stale
            ? "当前计划的依据已变化，请到学习计划页重新生成并确认。"
            : "展示固定事件与已采用的任务工作块；可到学习计划页生成草稿。"
        }
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
          slotMinTime="00:00:00"
          slotMaxTime="24:00:00"
          events={[
            ...(events.data?.map((e) => ({
              id: e.id,
              title: e.title + (e.is_skipped ? "（本次不参加）" : ""),
              start: e.start_at,
              end: e.end_at,
              color: e.is_skipped ? "#a6a6a6" : "#37735c",
            })) ?? []),
            ...(plan.data?.blocks.map((b) => ({
              id: `${b.task_id}-${b.start_at}`,
              title: b.title,
              start: b.start_at,
              end: b.end_at,
              color: "#3873ac",
            })) ?? []),
          ]}
        />
      </Card>
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
