import { Link } from "react-router-dom";
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
  Modal,
  Space,
  Spin,
  Tag,
} from "antd";
import { api, type EventType } from "../api";

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

export default function EventTypesPage() {
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [editing, setEditing] = useState<EventType | null | undefined>(
    undefined,
  );
  const [form] = Form.useForm<{ name: string; color: string }>();
  const types = useQuery({
    queryKey: ["event-types", "all"],
    queryFn: () => api<EventType[]>("/event-types?include_archived=true"),
  });
  const save = useMutation({
    mutationFn: (values: { name: string; color: string }) =>
      editing
        ? api(`/event-types/${editing.id}`, "PUT", values)
        : api("/event-types", "POST", values),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["event-types"] });
      setEditing(undefined);
      void message.success(editing ? "事件类型已更新" : "事件类型已创建");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api(`/event-types/${id}`, "DELETE"),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["event-types"] });
      void message.success("事件类型已归档");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const open = (type: EventType | null) => {
    form.setFieldsValue({
      name: type?.name ?? "",
      color: type?.color ?? "#1677ff",
    });
    setEditing(type);
  };
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">YOUR EVENT TYPES</div>
          <h1>事件类型</h1>
          <p className="muted">
            课程和每周课程是固定身份；其余事件可以按自己的习惯分类。
          </p>
        </div>
        <Space wrap>
          <Link to="/settings">返回设置</Link>
          <Button type="primary" onClick={() => open(null)}>
            新建事件类型
          </Button>
        </Space>
      </header>
      {types.error && <Alert type="error" message={errorText(types.error)} />}
      {types.isPending ? (
        <Spin />
      ) : !types.data?.length ? (
        <Card>
          <Empty description="还没有事件类型" />
        </Card>
      ) : (
        <div className="cards">
          {types.data.map((type) => (
            <Card key={type.id}>
              <div className="card-heading">
                <h3>
                  <span
                    className="event-type-dot"
                    style={{ backgroundColor: type.color }}
                  />
                  {type.name}
                </h3>
                <Space wrap>
                  {type.system_key && <Tag>内置</Tag>}
                  {type.archived_at && <Tag color="orange">已归档</Tag>}
                </Space>
              </div>
              <p className="muted">已用于 {type.usage_count} 个事件</p>
              {!type.system_key && (
                <Space wrap>
                  <Button onClick={() => open(type)}>编辑</Button>
                  {!type.archived_at && (
                    <Button
                      danger
                      loading={archive.isPending}
                      onClick={() =>
                        modal.confirm({
                          title: "归档这个事件类型？",
                          content:
                            "归档后不能用于新事件，已有事件和历史记录仍显示原类型。",
                          onOk: () =>
                            archive.mutateAsync(type.id).then(() => undefined),
                        })
                      }
                    >
                      归档
                    </Button>
                  )}
                </Space>
              )}
            </Card>
          ))}
        </div>
      )}
      <Modal
        title={editing ? "编辑事件类型" : "新建事件类型"}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Form.Item
            name="name"
            label="类型名称"
            rules={[
              { required: true, whitespace: true, max: 100 },
              {
                validator: (_, value: string) =>
                  ["课程", "每周课程", "考试", "会议", "其他"].includes(value)
                    ? Promise.reject(new Error("该名称是保留类型"))
                    : Promise.resolve(),
              },
            ]}
          >
            <Input placeholder="例如：社团活动、实验、讲座" />
          </Form.Item>
          <Form.Item name="color" label="颜色">
            <Input type="color" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
