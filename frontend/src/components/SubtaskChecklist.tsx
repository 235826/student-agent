import { useState } from "react";
import { Link } from "react-router-dom";
import { App, Button, Card, Checkbox, Input, Space, Tag } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Task } from "../api";

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

export default function SubtaskChecklist({ parent }: { parent: Task }) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [title, setTitle] = useState("");
  const tasks = useQuery({
    queryKey: ["tasks", false],
    queryFn: () => api<Task[]>("/tasks"),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["tasks"] });
    void client.invalidateQueries({ queryKey: ["plans"] });
  };
  const add = useMutation({
    mutationFn: (value: string) =>
      api<Task>("/tasks", "POST", {
        title: value,
        parent_id: parent.id,
        list_id: parent.list_id,
      }),
    onSuccess: () => {
      setTitle("");
      refresh();
      void message.success("子任务已添加");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const complete = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}/complete`, "POST"),
    onSuccess: () => {
      refresh();
      void message.success("子任务已完成");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const reopen = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}/reopen`, "POST"),
    onSuccess: () => {
      refresh();
      void message.success("子任务已恢复");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const children = (tasks.data ?? [])
    .filter((task) => task.parent_id === parent.id)
    .sort(
      (a, b) =>
        Number(a.status === "done") - Number(b.status === "done") ||
        a.created_at.localeCompare(b.created_at),
    );
  const done = children.filter((task) => task.status === "done").length;
  const submit = () => {
    const value = title.trim();
    if (value) add.mutate(value);
  };
  return (
    <Card title={`子任务 ${done}/${children.length}`} className="toolbar">
      {children.length ? (
        <Space direction="vertical" size={0} style={{ width: "100%" }}>
          {children.map((task) => (
            <div className="subtask-row" key={task.id}>
              <Checkbox
                aria-label={
                  task.status === "done"
                    ? `恢复 ${task.title}`
                    : `完成 ${task.title}`
                }
                checked={task.status === "done"}
                disabled={task.status === "cancelled"}
                onChange={(e) => {
                  if (task.status === "done") reopen.mutate(task);
                  else if (e.target.checked) complete.mutate(task);
                }}
              />
              <div className="subtask-row-main">
                <Link to={`/tasks/${task.id}`}>{task.title}</Link>
                {task.status === "done" && <Tag color="green">已完成</Tag>}
                {task.status === "cancelled" && <Tag>已取消</Tag>}
              </div>
            </div>
          ))}
        </Space>
      ) : (
        <p className="muted">把任务拆成更小的步骤，完成情况会显示在这里。</p>
      )}
      <Space.Compact className="subtask-add">
        <Input
          aria-label="添加子任务"
          value={title}
          placeholder="添加子任务，按回车保存"
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={submit}
        />
        <Button
          type="primary"
          loading={add.isPending}
          disabled={!title.trim()}
          onClick={submit}
        >
          添加
        </Button>
      </Space.Compact>
    </Card>
  );
}
