import SourceButton from "../components/SourceButton";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
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
import { api } from "../api";
import type { Draft, Profile, Task, TaskInput } from "../api";
import { displayTime, toInstant, toLocal } from "../time";

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
const policies = [
  { value: "inherit", label: "沿用任务类型设置（未设置则禁止）" },
  { value: "none", label: "明确禁止并行" },
  { value: "allow_selected", label: "接受已明确允许的组合" },
];
type Editor = { kind: "task"; task?: Task } | { kind: "draft"; draft?: Draft };
type Write = { path: string; method?: string; body?: unknown };
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

export default function TasksPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [tab, setTab] = useState<"tasks" | "trash" | "drafts">("tasks");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [form] = Form.useForm();
  const tasks = useQuery({
    queryKey: ["tasks", false],
    queryFn: () => api<Task[]>("/tasks"),
  });
  const trash = useQuery({
    queryKey: ["tasks", true],
    queryFn: () => api<Task[]>("/tasks?trashed=true"),
  });
  const drafts = useQuery({
    queryKey: ["drafts"],
    queryFn: () => api<Draft[]>("/drafts"),
  });
  const mutation = useMutation({
    mutationFn: ({ path, method = "POST", body }: Write) =>
      api(path, method, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["drafts"] });
      setEditor(null);
      void message.success("已保存");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const catalog = [...(tasks.data ?? []), ...(trash.data ?? [])];
  const titleOf = (id: string) =>
    catalog.find((t) => t.id === id)?.title ?? "不可用任务";
  const open = (next: Editor) => {
    form.resetFields();
    const payload = next.kind === "task" ? next.task : next.draft?.payload;
    form.setFieldsValue({
      ...payload,
      title: payload?.title ?? "",
      description: payload?.description ?? "",
      priority: payload?.priority ?? 2,
      status: payload?.status ?? "todo",
      predecessor_ids: payload?.predecessor_ids ?? [],
      parent_id: payload?.parent_id ?? undefined,
      parallel_policy: payload?.parallel_policy ?? "inherit",
      deadline_at: toLocal(payload?.deadline_at, profile.timezone),
    });
    setEditor(next);
  };
  const save = async (asDraft: boolean) => {
    try {
      const values = await form.validateFields();
      const body: TaskInput = {
        ...values,
        title: values.title?.trim() ?? "",
        deadline_at: toInstant(values.deadline_at ?? "", profile.timezone),
        task_type: values.task_type?.trim() || null,
        estimate_minutes: values.estimate_minutes ?? null,
        parent_id: values.parent_id ?? null,
        parallel_policy:
          values.parallel_policy === "inherit" ? null : values.parallel_policy,
        predecessor_ids: values.predecessor_ids ?? [],
      };
      if (asDraft) {
        const draft = editor?.kind === "draft" ? editor.draft : undefined;
        mutation.mutate({
          path: draft ? `/drafts/${draft.id}` : "/drafts",
          method: draft ? "PUT" : "POST",
          body: {
            payload: body,
            ...(draft ? { revision: draft.revision } : {}),
          },
        });
        return;
      }
      if (!body.title) {
        void message.error("正式任务需要填写标题");
        return;
      }
      const task = editor?.kind === "task" ? editor.task : undefined;
      const submit = (confirmed = false) =>
        mutation.mutate({
          path: task ? `/tasks/${task.id}` : "/tasks",
          method: task ? "PUT" : "POST",
          body: { ...body, confirm_impact: confirmed },
        });
      if (
        task &&
        body.status === "cancelled" &&
        task.status !== "cancelled" &&
        (task.dependent_ids.length || task.child_ids.length)
      ) {
        modal.confirm({
          title: "确认取消关联任务",
          content:
            "关联子任务和依赖会保留，后续任务将被阻塞。受影响任务：" +
            [...task.dependent_ids, ...task.child_ids].map(titleOf).join("、"),
          onOk: () => submit(true),
        });
      } else submit();
    } catch (e) {
      if (e instanceof Error) void message.error(e.message);
    }
  };
  const remove = (task: Task) => {
    const path = `/tasks/${task.id}/trash`;
    if (task.dependent_ids.length || task.child_ids.length)
      modal.confirm({
        title: "确认移入垃圾箱",
        content:
          "子任务和依赖不会被删除。后续任务会标记前置任务不可用：" +
          [...task.dependent_ids, ...task.child_ids].map(titleOf).join("、"),
        onOk: () =>
          mutation.mutateAsync({ path: path + "?confirm_impact=true" }),
      });
    else mutation.mutate({ path });
  };
  const publish = (draft: Draft) =>
    modal.confirm({
      title: "确认发布任务草稿",
      content: `将“${draft.payload.title || "未命名草稿"}”（版本 ${draft.revision}）发布为正式任务。发布前会再次检查字段和依赖。`,
      onOk: () =>
        mutation.mutateAsync({
          path: `/drafts/${draft.id}/publish`,
          body: {
            revision: draft.revision,
            idempotency_key: `draft-${draft.id}-r${draft.revision}`,
          },
        }),
    });
  const current = tab === "trash" ? trash : tasks;
  const currentTask = editor?.kind === "task" ? editor.task : undefined;
  const options = catalog
    .filter((t) => t.id !== currentTask?.id)
    .map((t) => ({
      value: t.id,
      label:
        t.title +
        (t.trashed_at
          ? "（垃圾箱）"
          : t.status === "cancelled"
            ? "（已取消）"
            : ""),
      disabled: !!t.trashed_at || t.status === "cancelled",
    }));
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">ONE STEP AT A TIME</div>
          <h1>任务</h1>
          <p className="muted">从草稿开始，明确每一步的先后关系。</p>
        </div>
        <Space wrap>
          <Button onClick={() => open({ kind: "draft" })}>新建草稿</Button>
          <Button type="primary" onClick={() => open({ kind: "task" })}>
            新建任务
          </Button>
        </Space>
      </header>
      <Space className="toolbar" wrap>
        {(
          [
            ["tasks", "我的任务"],
            ["drafts", "草稿"],
            ["trash", "垃圾箱"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            type={tab === key ? "primary" : "default"}
            onClick={() => setTab(key)}
          >
            {label}
          </Button>
        ))}
      </Space>
      {tab === "drafts" ? (
        <>
          {drafts.error && (
            <Alert type="error" message={errorText(drafts.error)} />
          )}
          {drafts.isPending ? (
            <Spin />
          ) : !drafts.data?.length ? (
            <Card>
              <Empty description="没有待发布草稿" />
            </Card>
          ) : (
            <div className="cards">
              {drafts.data.map((draft) => (
                <Card key={draft.id}>
                  <h3>{draft.payload.title || "未命名草稿"}</h3>
                  <Tag>草稿 · 版本 {draft.revision}</Tag>
                  <p className="description">
                    {draft.payload.description ||
                      "可以继续补充内容，草稿不会参与排程。"}
                  </p>
                  <Space wrap>
                    <Button onClick={() => open({ kind: "draft", draft })}>
                      编辑草稿
                    </Button>
                    <Button
                      type="primary"
                      disabled={mutation.isPending}
                      onClick={() => publish(draft)}
                    >
                      发布任务
                    </Button>
                    <Button
                      danger
                      onClick={() =>
                        modal.confirm({
                          title: "删除草稿？",
                          content: "草稿将被删除，不会影响正式任务。",
                          onOk: () =>
                            mutation.mutateAsync({
                              path: `/drafts/${draft.id}?revision=${draft.revision}`,
                              method: "DELETE",
                            }),
                        })
                      }
                    >
                      删除草稿
                    </Button>
                  </Space>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {current.error && (
            <Alert type="error" message={errorText(current.error)} />
          )}{" "}
          {current.isPending ? (
            <Spin />
          ) : !current.data?.length ? (
            <Card>
              <Empty
                description={
                  tab === "trash"
                    ? "垃圾箱为空"
                    : "还没有任务，先添加一件想完成的事"
                }
              />
            </Card>
          ) : (
            <div className="cards">
              {current.data.map((task) => (
                <Card key={task.id} className="task-card">
                  <div className="card-heading">
                    <h3>{task.title}</h3>
                    <Tag color={task.status === "done" ? "green" : "default"}>
                      {states.find((s) => s.value === task.status)?.label}
                    </Tag>
                  </div>
                  <p className="description">
                    {task.description || "暂无描述"}
                  </p>
                  {task.parent_id && (
                    <p className="muted">父任务：{titleOf(task.parent_id)}</p>
                  )}
                  {task.predecessor_ids.length > 0 && (
                    <p className="muted">
                      前置：{task.predecessor_ids.map(titleOf).join(" → ")}
                    </p>
                  )}
                  {task.child_ids.length > 0 && (
                    <p className="muted">
                      子任务：{task.child_ids.map(titleOf).join("、")}
                    </p>
                  )}
                  {task.blocked_by.length > 0 && task.status !== "done" && (
                    <Alert
                      type="warning"
                      message={"等待前置：" + task.blocked_by.join("、")}
                    />
                  )}
                  <div className="meta">
                    截止：{displayTime(task.deadline_at, profile.timezone)} ·
                    预计 {task.estimate_minutes ?? "—"} 分钟 ·{" "}
                    {priorities[task.priority - 1].label}
                  </div>
                  <Space wrap>
                    {tab === "trash" ? (
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
                        <SourceButton objectId={task.id} />
                        <Button onClick={() => open({ kind: "task", task })}>
                          编辑
                        </Button>
                        <Button
                          danger
                          disabled={mutation.isPending}
                          onClick={() => remove(task)}
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
        </>
      )}
      <Modal
        title={
          editor?.kind === "draft"
            ? "编辑任务草稿"
            : currentTask
              ? "编辑任务"
              : "新建任务"
        }
        open={!!editor}
        onCancel={() => setEditor(null)}
        destroyOnHidden
        footer={
          <Space>
            <Button onClick={() => setEditor(null)}>取消</Button>
            {editor?.kind === "task" && (
              <Button
                disabled={mutation.isPending}
                onClick={() => void save(true)}
              >
                另存为草稿
              </Button>
            )}
            <Button
              type="primary"
              loading={mutation.isPending}
              onClick={() => void save(editor?.kind === "draft")}
            >
              {editor?.kind === "draft" ? "保存草稿" : "确定"}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="任务标题" rules={[{ max: 200 }]}>
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
          <Form.Item name="parent_id" label="父任务（可选）">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={options}
            />
          </Form.Item>
          <Form.Item name="predecessor_ids" label="前置任务">
            <Select
              mode="multiple"
              optionFilterProp="label"
              options={options}
            />
          </Form.Item>
          <Form.Item name="parallel_policy" label="任务并行设置">
            <Select options={policies} />
          </Form.Item>
          <p className="muted">
            父子关系用于组织任务；执行先后由前置任务决定。允许并行仍须有匹配的组合规则。
          </p>
        </Form>
      </Modal>
    </>
  );
}
