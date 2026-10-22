import {
  NavLink,
  Navigate,
  Route,
  Routes,
  Link,
  useSearchParams,
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
function ImportEntry({ profile }: { profile: Profile }) {
  const [params] = useSearchParams();
  const job = params.get("job");
  return job ? (
    <Navigate replace to={`/imports/${encodeURIComponent(job)}`} />
  ) : (
    <ImportsPage profile={profile} />
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
            ["/", "今日"],
            ["/inbox", "待确认"],
            ["/tasks", "任务"],
            ["/plans", "学习计划"],
            ["/calendar", "日历与课程"],
          ].map(([path, label]) => (
            <NavLink end={path === "/"} to={path} key={path}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link to="/settings">设置</Link>
          <Link to="/imports">导入整理</Link>
          <Link to="/settings/rules">并行规则</Link>
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
          <Route path="/imports" element={<ImportEntry profile={profile} />} />
          <Route path="/plans" element={<PlansPage profile={profile} />} />
          <Route path="/tasks" element={<TasksPage profile={profile} />} />
          <Route path="/events" element={<Navigate to="/calendar" replace />} />
          <Route path="/calendar" element={<EventsPage profile={profile} />} />
          <Route path="/inbox" element={<TasksPage profile={profile} />} />
          <Route path="/tasks/:id" element={<TasksPage profile={profile} />} />
          <Route path="/plans/:id" element={<PlansPage profile={profile} />} />
          <Route
            path="/imports/:id"
            element={<ImportEntry profile={profile} />}
          />
          <Route
            path="/events/:id"
            element={<EventsPage profile={profile} />}
          />
          <Route
            path="/courses/:id"
            element={<EventsPage profile={profile} />}
          />
          <Route
            path="/series/:id"
            element={<EventsPage profile={profile} />}
          />
          <Route
            path="/compatibility"
            element={<Navigate to="/settings/rules" replace />}
          />
          <Route
            path="/settings/rules"
            element={<CompatibilityPage profile={profile} />}
          />
          <Route
            path="/settings"
            element={<SettingsPage profile={profile} />}
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
