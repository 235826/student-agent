import { useState } from "react";
import { Alert, Button, Input, Select } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import {
  api,
  type AgentAction,
  type Auth,
  type Task,
  type TaskList,
} from "../api";
import { toTaskInput } from "../tasks";
import { toInstant, toLocal } from "../time";

export default function AgentTaskResult({ action }: { action: AgentAction }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<"list" | "reminder" | null>(null);
  const [listId, setListId] = useState("");
  const [reminder, setReminder] = useState("");
  const taskId = String(action.result?.id ?? "");
  const task = useQuery({
    queryKey: ["tasks", "agent-result", taskId],
    queryFn: () => api<Task>(`/tasks/${taskId}`),
    enabled: !!taskId && action.status === "executed",
  });
  const lists = useQuery({
    queryKey: ["task-lists"],
    queryFn: () => api<TaskList[]>("/task-lists"),
  });
  const profile = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Auth>("/auth/me"),
  });
  const zone = profile.data?.user.timezone;
  const current = task.data;
  const change = useMutation({
    mutationFn: async (kind: "list" | "reminder" | "undo") => {
      if (kind === "undo")
        return api(`/agent/actions/${action.id}/undo`, "POST", {});
      if (kind === "reminder") {
        if (!zone) throw new Error("正在读取时区，请稍后重试");
        return api(`/tasks/${taskId}/reminder`, "PATCH", {
          remind_at: toInstant(reminder, zone),
        });
      }
      const latest = await api<Task>(`/tasks/${taskId}`);
      return api(`/tasks/${taskId}`, "PUT", {
        ...toTaskInput(latest),
        remind_at: latest.remind_at,
        list_id: listId || null,
      });
    },
    onSuccess: () => {
      setEditing(null);
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["agent-conversation"] });
    },
  });
  if (action.status === "undone") {
    return (
      <div className="agent-action-note">
        已撤销，任务已移入垃圾箱，可从垃圾箱恢复。
      </div>
    );
  }
  if (!current) {
    return task.error ? (
      <Alert type="error" message="无法读取任务，请刷新后重试" />
    ) : null;
  }
  const formatDate = (value: string, allDay = false) =>
    DateTime.fromISO(value)
      .setZone(zone)
      .toFormat(allDay ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm");
  return (
    <div className="agent-task-result">
      <div className="agent-action-note">
        清单：
        {current.list_id
          ? (lists.data?.find((list) => list.id === current.list_id)?.name ??
            "加载中…")
          : "收件箱"}
        {" · "}
        {current.deadline_at
          ? `日期：${formatDate(current.deadline_at, current.deadline_all_day)}`
          : "未设置日期"}
        {" · "}
        {current.remind_at
          ? `提醒：${formatDate(current.remind_at)}`
          : "未设置提醒"}
      </div>
      {current.trashed_at ? (
        <div className="agent-action-note">任务已移入垃圾箱</div>
      ) : (
        <>
          <div className="agent-action-buttons">
            <Button
              size="small"
              disabled={change.isPending}
              onClick={() => {
                setListId(current.list_id ?? "");
                setEditing("list");
              }}
            >
              更换清单
            </Button>
            <Button
              size="small"
              disabled={change.isPending || !zone}
              onClick={() => {
                setReminder(toLocal(current.remind_at, zone!));
                setEditing("reminder");
              }}
            >
              {current.remind_at ? "修改提醒" : "设置提醒"}
            </Button>
            <Button
              size="small"
              disabled={change.isPending}
              onClick={() => change.mutate("undo")}
            >
              撤销创建
            </Button>
          </div>
          {editing && (
            <div className="agent-action-buttons">
              {editing === "list" ? (
                <Select
                  aria-label="所属清单"
                  value={listId}
                  onChange={setListId}
                  style={{ minWidth: 150 }}
                  disabled={
                    change.isPending || lists.isPending || !!lists.error
                  }
                  options={[
                    { value: "", label: "收件箱" },
                    ...(lists.data ?? []).map((list) => ({
                      value: list.id,
                      label: list.name,
                    })),
                  ]}
                />
              ) : (
                <Input
                  aria-label="提醒时间"
                  type="datetime-local"
                  value={reminder}
                  onChange={(event) => setReminder(event.target.value)}
                  disabled={change.isPending}
                />
              )}
              <Button
                size="small"
                type="primary"
                loading={change.isPending}
                disabled={
                  editing === "list" && (lists.isPending || !!lists.error)
                }
                onClick={() => change.mutate(editing)}
              >
                保存
              </Button>
              <Button
                size="small"
                disabled={change.isPending}
                onClick={() => setEditing(null)}
              >
                取消
              </Button>
            </div>
          )}
          {editing === "reminder" && (
            <div className="agent-action-note">
              时区：{zone}；留空保存可取消提醒。
            </div>
          )}
        </>
      )}
      {change.error && <Alert type="error" message={change.error.message} />}
    </div>
  );
}
