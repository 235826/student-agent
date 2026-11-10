import { useState } from "react";
import { Link } from "react-router-dom";
import { App, Button, Checkbox, Input, Space, Tag } from "antd";
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
  const reorder = useMutation({
    mutationFn: ({
      parentId,
      task_ids,
    }: {
      parentId: string;
      task_ids: string[];
    }) =>
      api(`/tasks/${parentId}/subtasks/reorder`, "POST", { task_ids }),
    onSuccess: () => refresh(),
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const batchComplete = useMutation({
    mutationFn: async (items: Task[]) => {
      let failed = 0;
      let firstError = "";
      let processed = 0;
      for (const task of items) {
        if (["done", "cancelled"].includes(task.status)) continue;
        try {
          await api(`/tasks/${task.id}/complete`, "POST");
          processed += 1;
        } catch (e) {
          failed += 1;
          if (!firstError) firstError = errorText(e);
        }
      }
      if (failed) {
        throw new Error(
          `已处理 ${processed} 个子任务，失败 ${failed} 个：${firstError}`,
        );
      }
      return processed;
    },
    onSuccess: (count) => {
      refresh();
      void message.success(`已完成 ${count} 个子任务`);
    },
    onError: (e: Error) => {
      refresh();
      void message.error(e.message);
    },
  });
  const clearDone = useMutation({
    mutationFn: async (items: Task[]) => {
      let failed = 0;
      let firstError = "";
      let processed = 0;
      for (const task of items) {
        try {
          await api(
            `/tasks/${task.id}/trash?confirm_impact=true`,
            "POST",
          );
          processed += 1;
        } catch (e) {
          failed += 1;
          if (!firstError) firstError = errorText(e);
        }
      }
      if (failed) {
        throw new Error(
          `已清除 ${processed} 个子任务，失败 ${failed} 个：${firstError}`,
        );
      }
      return processed;
    },
    onSuccess: (count) => {
      refresh();
      void message.success(`已清除 ${count} 个完成子任务`);
    },
    onError: (e: Error) => {
      refresh();
      void message.error(e.message);
    },
  });

  const childrenByParent = new Map<string, Task[]>();
  for (const task of tasks.data ?? []) {
    if (!task.parent_id) continue;
    const group = childrenByParent.get(task.parent_id) ?? [];
    group.push(task);
    childrenByParent.set(task.parent_id, group);
  }
  for (const group of childrenByParent.values()) {
    group.sort(
      (a, b) =>
        a.subtask_order - b.subtask_order ||
        a.created_at.localeCompare(b.created_at),
    );
  }
  const collect = (id: string, result: Task[] = []) => {
    for (const task of childrenByParent.get(id) ?? []) {
      result.push(task);
      collect(task.id, result);
    }
    return result;
  };
  const descendants = collect(parent.id);
  const done = descendants.filter((task) => task.status === "done").length;
  const incomplete = descendants.filter(
    (task) => !["done", "cancelled"].includes(task.status),
  );
  const completed = descendants.filter((task) => task.status === "done");

  const move = (
    groupParentId: string,
    task: Task,
    siblings: Task[],
    delta: number,
  ) => {
    const from = siblings.findIndex((item) => item.id === task.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    const next = [...siblings];
    [next[from], next[to]] = [next[to], next[from]];
    reorder.mutate({
      parentId: groupParentId,
      task_ids: next.map((item) => item.id),
    });
  };

  const renderChildren = (parentId: string, depth: number) =>
    (childrenByParent.get(parentId) ?? []).map((task, index, siblings) => (
      <div key={task.id}>
        <div
          className="subtask-row"
          style={{ paddingLeft: 4 + depth * 16 }}
        >
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
          <Space size={0} className="subtask-actions">
            <Button
              type="text"
              size="small"
              aria-label={`上移子任务 ${task.title}`}
              disabled={index === 0 || reorder.isPending}
              onClick={() => move(parentId, task, siblings, -1)}
            >
              ↑
            </Button>
            <Button
              type="text"
              size="small"
              aria-label={`下移子任务 ${task.title}`}
              disabled={index === siblings.length - 1 || reorder.isPending}
              onClick={() => move(parentId, task, siblings, 1)}
            >
              ↓
            </Button>
          </Space>
        </div>
        {renderChildren(task.id, depth + 1)}
      </div>
    ));

  const submit = () => {
    const value = title.trim();
    if (value) add.mutate(value);
  };
  return (
    <section className="section subtask-section">
      <div className="section-inline-heading">
        <h4>
          子任务 {done}/{descendants.length}
        </h4>
        {descendants.length > 0 && (
          <Space wrap size={4}>
            <Button
              type="text"
              size="small"
              disabled={!incomplete.length}
              loading={batchComplete.isPending}
              onClick={() => batchComplete.mutate(incomplete)}
            >
              全部完成
            </Button>
            <Button
              type="text"
              size="small"
              disabled={!completed.length}
              loading={clearDone.isPending}
              onClick={() => clearDone.mutate(completed)}
            >
              清除已完成
            </Button>
          </Space>
        )}
      </div>
      {descendants.length > 0 && renderChildren(parent.id, 0)}
      <Space.Compact size="small" className="subtask-add">
        <Input
          size="small"
          aria-label="添加子任务"
          value={title}
          placeholder="添加子任务，按回车保存"
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={submit}
        />
        <Button
          type="primary"
          size="small"
          loading={add.isPending}
          disabled={!title.trim()}
          onClick={submit}
        >
          添加
        </Button>
      </Space.Compact>
    </section>
  );
}
