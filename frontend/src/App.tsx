import { lazy, Suspense } from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  Link,
  useSearchParams,
  useLocation,
  useParams,
} from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Spin, Result } from "antd";
import { DateTime } from "luxon";
import {
  api,
  ApiError,
  setCsrf,
  type Auth,
  type Profile,
  type Task,
} from "./api";
const HierarchyPage = lazy(() => import("./pages/HierarchyPage"));
const Login = lazy(() => import("./pages/Login"));
const TodayPage = lazy(() => import("./pages/TodayPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ImportsPage = lazy(() => import("./pages/ImportsPage"));
const PlansPage = lazy(() => import("./pages/PlansPage"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const EventsPage = lazy(() => import("./pages/EventsPage"));
const CompatibilityPage = lazy(() => import("./pages/CompatibilityPage"));
const EventTypesPage = lazy(() => import("./pages/EventTypesPage"));
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";
function LegacyImports() {
  const [params] = useSearchParams();
  const { search } = useLocation();
  const job = params.get("job");
  return (
    <Navigate
      replace
      to={
        job
          ? `/inbox/imports/${encodeURIComponent(job)}`
          : `/inbox/imports${search}`
      }
    />
  );
}
function LegacyPath({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate replace to={`${to}${search}`} />;
}
function HierarchyRoute({
  kind,
  profile,
}: {
  kind: "course" | "series";
  profile: Profile;
}) {
  const { id } = useParams();
  return <HierarchyPage key={`${kind}:${id}`} kind={kind} profile={profile} />;
}
function LegacyDetail({ prefix }: { prefix: string }) {
  const { id } = useParams();
  const { search } = useLocation();
  return (
    <Navigate
      replace
      to={`${prefix}/${encodeURIComponent(id ?? "")}${search}`}
    />
  );
}
export default function App() {
  const { pathname } = useLocation();
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
  const tasks = useQuery({
    queryKey: ["tasks", false],
    queryFn: () => api<Task[]>("/tasks"),
    enabled: !!me.data,
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
          <Suspense
            fallback={
              <div className="center">
                <Spin />
              </div>
            }
          >
            <Login
              initialized={status.data.initialized}
              onDone={(auth) => {
                setCsrf(auth.csrf_token);
                client.setQueryData(["me"], auth);
              }}
            />
          </Suspense>
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
  const now = DateTime.now().setZone(profile.timezone);
  const tomorrow = now.startOf("day").plus({ days: 1 });
  const activeTasks = (tasks.data ?? []).filter(
    (task) => !["done", "cancelled"].includes(task.status),
  );
  const todayCount = activeTasks.filter(
    (task) =>
      task.status === "in_progress" ||
      (task.deadline_at &&
        DateTime.fromISO(task.deadline_at).setZone(profile.timezone) <
          tomorrow),
  ).length;
  const overdueCount = activeTasks.filter(
    (task) =>
      task.deadline_at &&
      DateTime.fromISO(task.deadline_at).setZone(profile.timezone) < now,
  ).length;
  const nav = [
    ["/", "今日", todayCount],
    ["/tasks", "任务", overdueCount],
    ["/calendar", "日历", 0],
    ["/inbox", "收件箱", 0],
  ] as const;
  return (
    <div className="shell">
      <aside>
        <div className="brand">STUDENT AGENT</div>
        <div className="brand-sub">你的学习安排</div>
        <nav>
          {nav.map(([path, label, count]) => (
            <NavLink
              end={path === "/"}
              to={path}
              key={path}
              className={({ isActive }) =>
                isActive ||
                (path === "/calendar" && pathname.startsWith("/calendar")) ||
                (path === "/inbox" && pathname.startsWith("/inbox"))
                  ? "active"
                  : ""
              }
            >
              {label}
              {count > 0 && (
                <span
                  className={
                    path === "/tasks" ? "nav-count danger" : "nav-count"
                  }
                >
                  {count}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <NavLink
            to="/settings"
            className={() => (pathname.startsWith("/settings") ? "active" : "")}
          >
            设置
          </NavLink>
        </div>
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
        <Suspense
          fallback={
            <div className="center">
              <Spin />
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<TodayPage profile={profile} />} />
            <Route path="/inbox" element={<TasksPage profile={profile} />} />
            <Route
              path="/inbox/imports"
              element={<ImportsPage profile={profile} />}
            />
            <Route
              path="/inbox/imports/:id"
              element={<ImportsPage profile={profile} />}
            />
            <Route path="/imports" element={<LegacyImports />} />
            <Route
              path="/imports/:id"
              element={<LegacyDetail prefix="/inbox/imports" />}
            />
            <Route path="/plans" element={<PlansPage profile={profile} />} />
            <Route
              path="/plans/new"
              element={<PlansPage profile={profile} />}
            />
            <Route
              path="/plans/:id"
              element={<PlansPage profile={profile} />}
            />
            <Route path="/tasks" element={<TasksPage profile={profile} />} />
            <Route
              path="/tasks/new"
              element={<TasksPage profile={profile} />}
            />
            <Route
              path="/tasks/:id"
              element={<TasksPage profile={profile} />}
            />
            <Route
              path="/calendar"
              element={<EventsPage profile={profile} />}
            />
            <Route
              path="/calendar/events/new"
              element={<EventsPage profile={profile} />}
            />
            <Route
              path="/calendar/events/:id"
              element={<EventsPage profile={profile} />}
            />
            <Route
              path="/calendar/courses/:id"
              element={<HierarchyRoute kind="course" profile={profile} />}
            />
            <Route
              path="/calendar/series/new"
              element={<EventsPage profile={profile} />}
            />
            <Route
              path="/calendar/series/:id"
              element={<HierarchyRoute kind="series" profile={profile} />}
            />
            <Route path="/events" element={<LegacyPath to="/calendar" />} />
            <Route
              path="/events/:id"
              element={<LegacyDetail prefix="/calendar/events" />}
            />
            <Route
              path="/courses/:id"
              element={<LegacyDetail prefix="/calendar/courses" />}
            />
            <Route
              path="/series/:id"
              element={<LegacyDetail prefix="/calendar/series" />}
            />
            <Route path="/settings/event-types" element={<EventTypesPage />} />
            <Route
              path="/settings/rules"
              element={<CompatibilityPage profile={profile} />}
            />
            <Route
              path="/compatibility"
              element={<Navigate to="/settings/rules" replace />}
            />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  profile={profile}
                  onLogout={() => logout.mutate()}
                  loggingOut={logout.isPending}
                />
              }
            />
            <Route
              path="/settings/schedule"
              element={
                <SettingsPage
                  profile={profile}
                  onLogout={() => logout.mutate()}
                  loggingOut={logout.isPending}
                />
              }
            />
            <Route
              path="*"
              element={
                <Result
                  status="404"
                  title="404"
                  subTitle="页面不存在，请检查地址"
                  extra={<Link to="/">返回今日</Link>}
                />
              }
            />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
