import ImportRecords from "../components/ImportRecords";
import {
  Link,
  useNavigate,
  useParams,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import SourceButton from "../components/SourceButton";
import { Fragment, useState } from "react";
import { backTarget, currentLocation, withFrom } from "../navigation";
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
import { priorities, priorityLabel } from "../semantics";

const states = [
  { value: "todo", label: "待开始" },
  { value: "in_progress", label: "进行中" },
  { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];
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
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const inbox = location.pathname === "/inbox";
  const isNew = location.pathname === "/tasks/new";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("status");
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [tab, setTab] = useState<"tasks" | "trash">("tasks");
  const [editor, setEditor] = useState<Editor | null>(
    isNew || params.has("new") ? { kind: "task" } : null,
  );
  const [form] = Form.useForm();
  const closeEditor = () => {
    setEditor(null);
    if (isNew) {
      const back = backTarget(params.get("from"), {
        to: "/tasks",
        label: "返回任务列表",
      });
      navigate(back.to, { replace: true });
    } else if (params.has("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  };
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
  const writeOptions = {
    mutationFn: ({ path, method = "POST", body }: Write) =>
      api(path, method, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["drafts"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      closeEditor();
      void message.success("已保存");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  };
  const mutation = useMutation(writeOptions);
  const draftSave = useMutation({
    ...writeOptions,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["drafts"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      closeEditor();
      if (!inbox) {
        void message.success("草稿已保存到收件箱");
        navigate("/inbox");
      } else {
        void message.success("草稿已保存");
      }
    },
  });
  const trashWrite = useMutation(writeOptions);
  const publishWrite = useMutation(writeOptions);
  const draftDelete = useMutation(writeOptions);
  const restoreWrite = useMutation(writeOptions);
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
      if (!asDraft && !form.getFieldValue("title")?.trim()) {
        form.setFields([{ name: "title", errors: ["创建任务必须填写标题"] }]);
        return;
      }
      if (asDraft) form.setFields([{ name: "title", errors: [] }]);
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
        draftSave.mutate({
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
          trashWrite.mutateAsync({ path: path + "?confirm_impact=true" }),
      });
    else
      modal.confirm({
        title: "确认移入垃圾箱",
        content: "任务将停止参与排程，可从垃圾箱恢复。",
        onOk: () => trashWrite.mutateAsync({ path }),
      });
  };
  const publish = (draft: Draft) =>
    modal.confirm({
      title: "确认发布任务草稿",
      content: `将“${draft.payload.title || "未命名草稿"}”（版本 ${draft.revision}）发布为正式任务。发布前会再次检查字段和依赖。`,
      onOk: () =>
        publishWrite.mutateAsync({
          path: `/drafts/${draft.id}/publish`,
          body: {
            revision: draft.revision,
            idempotency_key: `draft-${draft.id}-r${draft.revision}`,
          },
        }),
    });
  const current = tab === "trash" ? trash : tasks;
  const visible = (
    id ? catalog.filter((t) => t.id === id) : (current.data ?? [])
  )
    .filter(
      (t) =>
        (id || status === "all" || t.status === status) &&
        (id ||
          `${t.title} ${t.description}`
            .toLowerCase()
            .includes(search.toLowerCase())),
    )
    .sort((a, b) =>
      sort === "deadline"
        ? (a.deadline_at ?? "9999").localeCompare(b.deadline_at ?? "9999")
        : sort === "priority"
          ? b.priority - a.priority
          : a.status.localeCompare(b.status),
    );
  const here = currentLocation(
    location.pathname,
    location.search,
    location.hash,
  );
  const back = backTarget(params.get("from"), {
    to: "/tasks",
    label: "返回任务列表",
  });
  const taskLink = (relationId: string) =>
    withFrom(`/tasks/${relationId}`, here);
  const relations = (ids: string[]) =>
    ids.map((relationId) => (
      <Link key={relationId} to={taskLink(relationId)} style={{ marginRight: 8 }}>
        {titleOf(relationId)}
      </Link>
    ));
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
          <h1>{inbox ? "收件箱" : id ? "任务详情" : "任务"}</h1>
          <p className="muted">
            {inbox
              ? "集中处理导入材料与任务草稿。"
              : "从草稿开始，明确每一步的先后关系。"}
          </p>
        </div>
        {inbox ? (
          <Button type="primary" onClick={() => open({ kind: "draft" })}>
            新建任务草稿
          </Button>
        ) : !id ? (
          <Button type="primary" onClick={() => open({ kind: "task" })}>
            新建任务
          </Button>
        ) : null}
      </header>
      {!inbox && !id && (
        <Space className="toolbar" wrap>
          {(
            [
              ["tasks", "我的任务"],
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
      )}
      {id && (
        <Space className="toolbar">
          <Link to={back.to}>{back.label}</Link>
          <Link to="/settings/rules?tab=check">查看相关并行规则</Link>
        </Space>
      )}
      {!inbox && !id && (
        <Space wrap className="toolbar">
          <Input.Search
            aria-label="搜索任务"
            placeholder="搜索标题或描述"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            aria-label="筛选状态"
            value={status}
            onChange={setStatus}
            options={[{ value: "all", label: "全部状态" }, ...states]}
          />
          <Select
            aria-label="任务排序"
            value={sort}
            onChange={setSort}
            options={[
              { value: "status", label: "按状态分组" },
              { value: "deadline", label: "截止时间" },
              { value: "priority", label: "优先级" },
            ]}
          />
        </Space>
      )}
      {inbox ? (
        <>
          <Card title="材料待处理" className="toolbar">
            <Space wrap>
              <Link to="/inbox/imports">提交新材料</Link>
              <Link to="/inbox/imports">查看全部导入记录</Link>
            </Space>
            <ImportRecords timezone={profile.timezone} pendingOnly />
          </Card>
          <h2>手动任务草稿</h2>
          {drafts.error && (
            <Alert type="error" message={errorText(drafts.error)} />
          )}
          {drafts.error ? null : drafts.isPending ? (
            <Spin />
          ) : !drafts.data?.length ? (
            <Card>
              <Empty description="没有待发布的任务草稿" />
            </Card>
          ) : (
            <div className="cards">
              {drafts.data.map((draft) => (
                <Card key={draft.id}>
                  <h3>{draft.payload.title || "未命名草稿"}</h3>
                  <Tag>任务草稿 · 版本 {draft.revision}</Tag>
                  <p className="description">
                    {draft.payload.description ||
                      "可以继续补充内容，草稿不会参与排程。"}
                  </p>
                  <Space wrap>
                    <Button onClick={() => open({ kind: "draft", draft })}>
                      编辑任务草稿
                    </Button>
                    <Button
                      type="primary"
                      disabled={
                        publishWrite.isPending &&
                        publishWrite.variables?.path.includes(draft.id)
                      }
                      onClick={() => publish(draft)}
                    >
                      发布任务
                    </Button>
                    <Button
                      danger
                      onClick={() =>
                        modal.confirm({
                          title: "删除任务草稿？",
                          content: "任务草稿将被删除，不会影响正式任务。",
                          onOk: () =>
                            draftDelete.mutateAsync({
                              path: `/drafts/${draft.id}?revision=${draft.revision}`,
                              method: "DELETE",
                            }),
                        })
                      }
                    >
                      删除任务草稿
                    </Button>
                  </Space>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {(current.error || (id && trash.error)) && (
            <Alert
              type="error"
              message={errorText(current.error ?? trash.error)}
            />
          )}{" "}
          {current.error || (id && trash.error) ? null : current.isPending ||
            (id && trash.isPending) ? (
            <Spin />
          ) : !visible.length ? (
            <Card>
              <Empty
                description={
                  id
                    ? "任务不存在或已删除"
                    : tab === "trash"
                      ? "垃圾箱为空"
                      : "还没有任务，先添加一件想完成的事"
                }
              />
            </Card>
          ) : (
            <div className="cards">
              {visible.map((task, index) => (
                <Fragment key={task.id}>
                  {!id &&
                    sort === "status" &&
                    visible[index - 1]?.status !== task.status && (
                      <h2 style={{ gridColumn: "1 / -1", margin: 0 }}>
                        {states.find((s) => s.value === task.status)?.label}
                      </h2>
                    )}
                  <Card className="task-card">
                    <div className="card-heading">
                      <h3>
                        <Link to={`/tasks/${task.id}`}>{task.title}</Link>
                      </h3>
                      <Tag color={task.status === "done" ? "green" : "default"}>
                        {states.find((s) => s.value === task.status)?.label}
                      </Tag>
                    </div>
                    <p className="description">
                      {task.description || "暂无描述"}
                    </p>
                    {task.parent_id && (
                      <p className="muted">
                        父任务：{relations([task.parent_id])}
                      </p>
                    )}
                    {task.predecessor_ids.length > 0 && (
                      <p className="muted">
                        前置：{relations(task.predecessor_ids)}
                      </p>
                    )}
                    {task.child_ids.length > 0 && (
                      <p className="muted">
                        子任务：{relations(task.child_ids)}
                      </p>
                    )}
                    {task.blocked_by.length > 0 && task.status !== "done" && (
                      <Alert
                        type="warning"
                        message={
                          <span>
                            等待前置：
                            {relations(
                              task.predecessor_ids.filter((predecessorId) => {
                                const predecessor = catalog.find(
                                  (t) => t.id === predecessorId,
                                );
                                return (
                                  predecessor &&
                                  (predecessor.trashed_at ||
                                    predecessor.status !== "done")
                                );
                              }),
                            )}
                          </span>
                        }
                      />
                    )}
                    <div className="meta">
                      截止：{displayTime(task.deadline_at, profile.timezone)} ·
                      预计 {task.estimate_minutes ?? "—"} 分钟 ·{" "}
                      {priorityLabel(task.priority)}
                    </div>
                    <Space wrap>
                      {task.trashed_at ? (
                        <Button
                          onClick={() =>
                            restoreWrite.mutate({
                              path: `/tasks/${task.id}/restore`,
                            })
                          }
                          loading={
                            restoreWrite.isPending &&
                            restoreWrite.variables?.path.includes(task.id)
                          }
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
                            disabled={
                              trashWrite.isPending &&
                              trashWrite.variables?.path.includes(task.id)
                            }
                            onClick={() => remove(task)}
                          >
                            移入垃圾箱
                          </Button>
                        </>
                      )}
                    </Space>
                  </Card>
                </Fragment>
              ))}
            </div>
          )}
        </>
      )}
      <Modal
        title={
          editor?.kind === "draft"
            ? editor.draft
              ? "编辑任务草稿"
              : "新建任务草稿"
            : currentTask
              ? "编辑任务"
              : "新建任务"
        }
        open={!!editor}
        onCancel={closeEditor}
        destroyOnHidden
        footer={
          <Space>
            <Button onClick={closeEditor}>取消</Button>
            {editor?.kind === "task" && !currentTask && (
              <Button
                disabled={draftSave.isPending}
                onClick={() => void save(true)}
              >
                保存草稿
              </Button>
            )}
            <Button
              type="primary"
              loading={
                editor?.kind === "draft"
                  ? draftSave.isPending
                  : mutation.isPending
              }
              onClick={() => void save(editor?.kind === "draft")}
            >
              {editor?.kind === "draft"
                ? "保存草稿"
                : currentTask
                  ? "保存修改"
                  : "创建任务"}
            </Button>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            title: "",
            status: "todo",
            priority: 2,
            parallel_policy: "inherit",
          }}
        >
          <Form.Item
            name="title"
            label="任务标题"
            extra="创建正式任务必填；保存草稿可留空"
            rules={[{ max: 200 }]}
          >
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
