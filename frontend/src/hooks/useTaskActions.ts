import { useRef, useState } from "react";
import { App } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Task, type TaskInput } from "../api";
import { toTaskInput } from "../tasks";

type Entry = { label: string; undo: () => Promise<unknown> };
export type TaskChange = { id: string; patch: Partial<TaskInput> };

export function useTaskActions() {
  const client = useQueryClient();
  const { message } = App.useApp();
  const stack = useRef<Entry[]>([]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const [busy, setBusy] = useState(false);
  const [undoLabel, setUndoLabel] = useState("");
  const refresh = () => {
    for (const key of ["tasks", "plans", "tags", "task-lists"]) {
      void client.invalidateQueries({ queryKey: [key] });
    }
  };
  const remember = (label: string, undo: Entry["undo"]) => {
    message.destroy("task-undo");
    stack.current.push({ label, undo });
    if (stack.current.length > 50) stack.current.shift();
    setUndoLabel(label);
  };
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    pending.current += 1;
    setBusy(true);
    const result = queue.current.then(async () => {
      try {
        return await work();
      } catch (error) {
        void message.error(
          error instanceof Error ? error.message : "保存失败，请重试",
        );
        throw error;
      } finally {
        pending.current -= 1;
        setBusy(pending.current > 0);
        refresh();
      }
    });
    queue.current = result.catch(() => undefined);
    return result;
  };
  const write = (current: Task, patch: Partial<TaskInput>) => {
    const keys = Object.keys(patch);
    if (keys.length === 1 && keys[0] === "flagged")
      return api<Task>(`/tasks/${current.id}/flag`, "PATCH", patch);
    if (keys.length === 1 && keys[0] === "remind_at")
      return api<Task>(`/tasks/${current.id}/reminder`, "PATCH", patch);
    if (
      keys.length > 0 &&
      keys.every((key) => key === "deadline_at" || key === "deadline_all_day")
    ) {
      return api<Task>(`/tasks/${current.id}/deadline`, "PATCH", {
        deadline_at: current.deadline_at,
        deadline_all_day: current.deadline_all_day,
        ...patch,
      });
    }
    if (keys.length === 1 && patch.status === "done")
      return api<Task>(`/tasks/${current.id}/complete`, "POST");
    if (
      keys.length === 1 &&
      patch.status === "todo" &&
      current.status === "done"
    )
      return api<Task>(`/tasks/${current.id}/reopen`, "POST");
    return api<Task>(`/tasks/${current.id}`, "PUT", {
      ...toTaskInput(current),
      ...patch,
    });
  };
  const recordUpdate = (before: Task, after: Task) => {
    const keys = (
      Object.keys(toTaskInput(before)) as Array<keyof TaskInput>
    ).filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    if (!keys.length) return;
    remember("编辑任务", async () => {
      const current = await api<Task>(`/tasks/${before.id}`);
      if (
        keys.some(
          (key) => JSON.stringify(current[key]) !== JSON.stringify(after[key]),
        )
      ) {
        throw new Error("任务已再次修改，请核对后再操作");
      }
      await write(
        current,
        Object.fromEntries(keys.map((key) => [key, before[key]])),
      );
    });
  };
  const patch = (changes: TaskChange[], label = "修改任务", order?: string[]) =>
    run(async () => {
      const undoSteps: Array<() => Promise<unknown>> = [];
      const results: Task[] = [];
      try {
        for (const change of changes) {
          const before = await api<Task>(`/tasks/${change.id}`);
          const after = await write(before, change.patch);
          results.push(after);
          const keys = Object.keys(change.patch) as Array<keyof TaskInput>;
          const inverse = Object.fromEntries(
            keys.map((key) => [key, before[key]]),
          );
          undoSteps.push(async () => {
            const current = await api<Task>(`/tasks/${change.id}`);
            if (
              keys.some(
                (key) =>
                  JSON.stringify(current[key]) !== JSON.stringify(after[key]),
              )
            ) {
              throw new Error(`「${current.title}」已被再次修改，无法直接撤销`);
            }
            await write(current, inverse);
          });
        }
        if (order?.length) {
          const catalog = await api<Task[]>("/tasks");
          const originalOrder = catalog
            .filter((task) => order.includes(task.id))
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((task) => task.id);
          await api("/tasks/reorder", "POST", { task_ids: order });
          undoSteps.push(() =>
            api("/tasks/reorder", "POST", { task_ids: originalOrder }),
          );
        }
        return results;
      } finally {
        // Keep successful steps undoable even if a later request fails.
        if (undoSteps.length)
          remember(label, async () => {
            while (undoSteps.length) {
              await undoSteps[undoSteps.length - 1]();
              undoSteps.pop();
            }
          });
      }
    });
  const create = (input: Pick<TaskInput, "title"> & Partial<TaskInput>) =>
    run(async () => {
      const task = await api<Task>("/tasks", "POST", input);
      remember("新增任务", () => api(`/tasks/${task.id}/trash`, "POST"));
      return task;
    });
  const trash = (ids: string[], confirmed = false, label = "删除任务") =>
    run(async () => {
      const changed: string[] = [];
      try {
        for (const id of ids) {
          await api(
            `/tasks/${id}/trash${confirmed ? "?confirm_impact=true" : ""}`,
            "POST",
          );
          changed.push(id);
        }
        return changed.length;
      } finally {
        if (changed.length)
          remember(label, async () => {
            while (changed.length) {
              await api(
                `/tasks/${changed[changed.length - 1]}/restore`,
                "POST",
              );
              changed.pop();
            }
          });
      }
    });
  const undo = () =>
    run(async () => {
      message.destroy("task-undo");
      const entry = stack.current.at(-1);
      if (!entry) return;
      await entry.undo();
      stack.current.pop();
      setUndoLabel(stack.current.at(-1)?.label ?? "");
      void message.success(`已撤销${entry.label}`);
    });
  return {
    busy,
    undoLabel,
    remember,
    recordUpdate,
    patch,
    create,
    trash,
    undo,
  };
}

export type TaskActions = ReturnType<typeof useTaskActions>;
