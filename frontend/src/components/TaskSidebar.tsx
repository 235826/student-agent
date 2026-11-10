import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { api, type TaskList, type TaskListGroup } from "../api";

export default function TaskSidebar() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const lists = useQuery({
    queryKey: ["task-lists"],
    queryFn: () => api<TaskList[]>("/task-lists"),
  });
  const groups = useQuery({
    queryKey: ["task-list-groups"],
    queryFn: () => api<TaskListGroup[]>("/task-list-groups"),
  });
  const listLink = (list: TaskList | null) => {
    const key = list?.id ?? "inbox";
    return (
      <Link
        key={key}
        to={`/tasks?list=${encodeURIComponent(key)}`}
        data-task-list-drop={key}
        className={
          location.pathname === "/tasks" && params.get("list") === key
            ? "active"
            : ""
        }
        onDragOver={(event) => {
          event.preventDefault();
          event.currentTarget.classList.add("task-list-drop-active");
        }}
        onDragLeave={(event) =>
          event.currentTarget.classList.remove("task-list-drop-active")
        }
        onDrop={(event) => {
          event.preventDefault();
          event.currentTarget.classList.remove("task-list-drop-active");
          try {
            const ids: unknown = JSON.parse(
              event.dataTransfer.getData("application/student-agent-tasks"),
            );
            if (
              Array.isArray(ids) &&
              ids.every((id) => typeof id === "string")
            ) {
              window.dispatchEvent(
                new CustomEvent("task-list-drop", {
                  detail: { ids, listId: list?.id ?? null },
                }),
              );
            }
          } catch {
            /* Ignore unrelated external drops. */
          }
        }}
      >
        <span
          className="task-row-list-dot"
          style={{ background: list?.color ?? "#8c8c8c" }}
        />
        {list?.name ?? "未分类"}
      </Link>
    );
  };
  return (
    <div className="sidebar-task-nav" aria-label="任务快捷导航">
      <div className="sidebar-smart-lists">
        {[
          ["today", "今天"],
          ["scheduled", "已计划"],
          ["all", "全部任务"],
          ["flagged", "已标记"],
          ["done", "已完成"],
        ].map(([view, label]) => (
          <Link
            key={view}
            to={`/tasks?view=${view}`}
            className={
              location.pathname === "/tasks" &&
              !params.has("list") &&
              (params.get("view") ?? "all") === view
                ? "active"
                : ""
            }
          >
            {label}
          </Link>
        ))}
      </div>
      <div className="sidebar-list-heading">我的清单</div>
      {listLink(null)}
      {groups.data?.map((group) => (
        <details key={group.id} open>
          <summary>{group.name}</summary>
          {lists.data
            ?.filter((list) => list.group_id === group.id)
            .map(listLink)}
        </details>
      ))}
      {lists.data?.filter((list) => !list.group_id).map(listLink)}
    </div>
  );
}
