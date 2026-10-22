import HierarchyPage from "./pages/HierarchyPage";
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
import { api, ApiError, setCsrf, type Auth, type Profile } from "./api";
import Login from "./pages/Login";
import TodayPage from "./pages/TodayPage";
import SettingsPage from "./pages/SettingsPage";
import ImportsPage from "./pages/ImportsPage";
import PlansPage from "./pages/PlansPage";
import TasksPage from "./pages/TasksPage";
import EventsPage from "./pages/EventsPage";
import CompatibilityPage from "./pages/CompatibilityPage";
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
  return (
    <HierarchyPage key={`${kind}:${id}`} kind={kind} profile={profile} />
  );
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
  const nav = [
    ["/", "今日"],
    ["/inbox", "收件箱"],
    ["/tasks", "任务"],
    ["/calendar", "日历与课程"],
    ["/plans", "学习计划"],
  ];
  return (
    <div className="shell">
      <aside>
        <div className="brand">STUDENT AGENT</div>
        <div className="brand-sub">你的学习安排</div>
        <nav>
          {nav.map(([path, label]) => (
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
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <NavLink
            to="/settings"
            className={() =>
              pathname.startsWith("/settings") ? "active" : ""
            }
          >
            设置
          </NavLink>
          <NavLink
            to="/settings/rules"
            className={() =>
              pathname.startsWith("/settings/rules") ? "active" : ""
            }
          >
            并行规则
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
          <Route path="/plans/new" element={<PlansPage profile={profile} />} />
          <Route path="/plans/:id" element={<PlansPage profile={profile} />} />
          <Route path="/tasks" element={<TasksPage profile={profile} />} />
          <Route path="/tasks/new" element={<TasksPage profile={profile} />} />
          <Route path="/tasks/:id" element={<TasksPage profile={profile} />} />
          <Route path="/calendar" element={<EventsPage profile={profile} />} />
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
      </main>
    </div>
  );
}
