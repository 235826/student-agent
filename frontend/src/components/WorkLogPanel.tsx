import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tag,
  Timeline,
} from "antd";
import { api, type Event, type Task, type WorkLog } from "../api";
import { displayTime } from "../time";

const causes = [
  { value: "unknown", label: "不说明" },
  { value: "underestimated", label: "低估了难度" },
  { value: "scope_changed", label: "任务范围变了" },
  { value: "interrupted", label: "被打断" },
  { value: "scheduling_issue", label: "安排不合适" },
  { value: "other", label: "其他" },
];
const causeLabel = (value: string) =>
  causes.find((cause) => cause.value === value)?.label ?? value;

type FormValues = {
  actual_minutes: number;
  cause: string;
  note: string;
  reflection: string;
  contexts?: string[];
};

const contextValue = (kind: string, id: string) => `${kind}:${id}`;
const splitContext = (value: string) => {
  const [object_kind, ...rest] = value.split(":");
  return { object_kind, object_id: rest.join(":") };
};

export default function WorkLogPanel({
  taskId,
  timezone,
}: {
  taskId: string;
  timezone: string;
}) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WorkLog | null>(null);
  const [addForm] = Form.useForm<FormValues>();
  const [editForm] = Form.useForm<FormValues>();
  const logs = useQuery({
    queryKey: ["worklogs", taskId],
    queryFn: () => api<WorkLog[]>(`/tasks/${taskId}/worklogs`),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const tasks = useQuery({
    queryKey: ["tasks", "worklog-context"],
    queryFn: () => api<Task[]>("/tasks?view=all"),
  });
  const contextOptions = useMemo(
    () => [
      {
        label: "课程 / 事件",
        options: (events.data ?? []).map((event) => ({
          value: contextValue("event", event.id),
          label: `${event.title} · ${displayTime(event.start_at, timezone)}`,
        })),
      },
      {
        label: "任务",
        options: (tasks.data ?? [])
          .filter((task) => task.id !== taskId)
          .map((task) => ({
            value: contextValue("task", task.id),
            label: task.title,
          })),
      },
    ],
    [events.data, tasks.data, taskId, timezone],
  );
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["worklogs", taskId] });
    void client.invalidateQueries({ queryKey: ["plans"] });
  };
  const create = useMutation({
    mutationFn: (values: FormValues) =>
      api<WorkLog>(`/tasks/${taskId}/worklogs`, "POST", {
        ...values,
        parallel_contexts: (values.contexts ?? []).map(splitContext),
      }),
    onSuccess: () => {
      addForm.resetFields();
      setAdding(false);
      invalidate();
      void message.success("执行记录已保存");
    },
    onError: (e) => void message.error(e.message),
  });
  const update = useMutation({
    mutationFn: (values: FormValues) =>
      api<WorkLog>(`/worklogs/${editing!.id}`, "PUT", {
        cause: values.cause,
        note: values.note,
        reflection: values.reflection,
        parallel_contexts: (values.contexts ?? []).map(splitContext),
      }),
    onSuccess: () => {
      setEditing(null);
      editForm.resetFields();
      void client.invalidateQueries({ queryKey: ["worklogs", taskId] });
      void message.success("执行记录已更新");
    },
    onError: (e) => void message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (log: WorkLog) => api(`/worklogs/${log.id}`, "DELETE"),
    onSuccess: () => {
      invalidate();
      void message.success("执行记录已删除");
    },
    onError: (e) => void message.error(e.message),
  });
  const contextForm = (saving: boolean, label: string) => (
    <>
      <div className="form-grid">
        <Form.Item
          name="actual_minutes"
          label="实际用时（分钟）"
          rules={[{ required: true, message: "请填写实际用时" }]}
        >
          <InputNumber min={1} max={100000} precision={0} />
        </Form.Item>
        <Form.Item name="cause" label="和预计不一样的原因">
          <Select options={causes} />
        </Form.Item>
      </div>
      <Form.Item name="note" label="过程备注">
        <Input.TextArea rows={2} maxLength={2000} />
      </Form.Item>
      <Form.Item name="reflection" label="完成后的感受">
        <Input.TextArea rows={3} maxLength={5000} />
      </Form.Item>
      <Form.Item
        name="contexts"
        label="同时进行的课程 / 事件 / 任务"
        extra="可选；用于把主观反馈与当时的执行情境关联。"
      >
        <Select
          mode="multiple"
          allowClear
          options={contextOptions}
          placeholder="选择同时进行的活动"
          loading={events.isPending || tasks.isPending}
        />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>
          {label}
        </Button>
        <Button onClick={() => (editing ? setEditing(null) : setAdding(false))}>
          取消
        </Button>
      </Space>
    </>
  );
  const openEdit = (log: WorkLog) => {
    setEditing(log);
    editForm.setFieldsValue({
      actual_minutes: log.actual_minutes,
      cause: log.cause,
      note: log.note,
      reflection: log.reflection,
      contexts: (log.parallel_contexts ?? []).map((context) =>
        contextValue(context.object_kind, context.object_id),
      ),
    });
  };
  return (
    <section className="worklog-panel">
      <div className="section-inline-heading">
        <h4>执行记录</h4>
        <Button type="text" onClick={() => setAdding((open) => !open)}>
          {adding ? "收起" : "记录一次"}
        </Button>
      </div>
      {logs.isPending ? (
        <Empty description="正在加载执行记录" />
      ) : !logs.data?.length ? (
        <p className="muted">还没有执行记录。完成任务或补录实际用时会显示在这里。</p>
      ) : (
        <Timeline
          items={logs.data.map((log) => ({
            key: log.id,
            children: (
              <article className="worklog-item">
                <div className="worklog-head">
                  <strong>{log.actual_minutes} 分钟</strong>
                  <span className="muted">{causeLabel(log.cause)}</span>
                  <span className="muted">
                    {displayTime(log.created_at, timezone)}
                  </span>
                </div>
                {log.note && <p>{log.note}</p>}
                {log.reflection && (
                  <p className="worklog-reflection">感受：{log.reflection}</p>
                )}
                {!!log.parallel_contexts?.length && (
                  <Space wrap size={[4, 4]}>
                    {log.parallel_contexts.map((context) => (
                      <Tag key={`${context.object_kind}:${context.object_id}`}>
                        {context.object_kind === "event" ? "同时进行" : "同时处理"}：
                        {context.title}
                      </Tag>
                    ))}
                  </Space>
                )}
                <div className="row-actions">
                  <Button type="text" size="small" onClick={() => openEdit(log)}>
                    修改
                  </Button>
                  <Button
                    type="text"
                    size="small"
                    danger
                    loading={remove.isPending && remove.variables?.id === log.id}
                    onClick={() =>
                      Modal.confirm({
                        title: "删除这条执行记录？",
                        content: "删除后，排程会重新计算剩余工时。",
                        okText: "删除",
                        okButtonProps: { danger: true },
                        cancelText: "取消",
                        onOk: () => remove.mutate(log),
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              </article>
            ),
          }))}
        />
      )}
      {adding && (
        <Form<FormValues>
          form={addForm}
          layout="vertical"
          initialValues={{ cause: "unknown", note: "", reflection: "" }}
          onFinish={(values) => create.mutate(values)}
        >
          {contextForm(create.isPending, "保存记录")}
        </Form>
      )}
      <Modal
        open={!!editing}
        title="修改执行记录"
        footer={null}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        <Form<FormValues>
          form={editForm}
          layout="vertical"
          onFinish={(values) => update.mutate(values)}
        >
          {contextForm(update.isPending, "保存修改")}
        </Form>
      </Modal>
    </section>
  );
}
