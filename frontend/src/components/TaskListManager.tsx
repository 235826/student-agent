import { useState } from "react";
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Spin,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TaskList, type TaskListInput } from "../api";

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

export default function TaskListManager({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<TaskListInput>();
  const [edits, setEdits] = useState<Record<string, TaskListInput>>({});
  const lists = useQuery({
    queryKey: ["task-lists"],
    queryFn: () => api<TaskList[]>("/task-lists"),
    enabled: open,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["task-lists"] });
    void client.invalidateQueries({ queryKey: ["tasks"] });
  };
  const create = useMutation({
    mutationFn: (body: TaskListInput) =>
      api<TaskList>("/task-lists", "POST", body),
    onSuccess: () => {
      form.resetFields();
      refresh();
      void message.success("清单已创建");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: TaskListInput }) =>
      api<TaskList>(`/task-lists/${id}`, "PUT", body),
    onSuccess: (_data, variables) => {
      setEdits((current) => {
        const next = { ...current };
        delete next[variables.id];
        return next;
      });
      refresh();
      void message.success("清单已更新");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/task-lists/${id}`, "DELETE"),
    onSuccess: () => {
      refresh();
      void message.success("清单已删除，任务已移入收件箱");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const reorder = useMutation({
    mutationFn: (list_ids: string[]) =>
      api("/task-lists/reorder", "POST", { list_ids }),
    onSuccess: () => refresh(),
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const valueOf = (list: TaskList): TaskListInput =>
    edits[list.id] ?? { name: list.name, color: list.color };
  const change = (list: TaskList, patch: Partial<TaskListInput>) =>
    setEdits((current) => ({
      ...current,
      [list.id]: { ...valueOf(list), ...patch },
    }));
  const move = (list: TaskList, delta: number) => {
    const data = lists.data ?? [];
    const from = data.findIndex((item) => item.id === list.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= data.length) return;
    const next = [...data];
    [next[from], next[to]] = [next[to], next[from]];
    reorder.mutate(next.map((item) => item.id));
  };
  return (
    <Modal
      title="管理清单"
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="inline"
        initialValues={{ color: "#245c48" }}
        onFinish={(values) => create.mutate(values)}
      >
        <Form.Item
          name="name"
          rules={[{ required: true, message: "请输入清单名称" }]}
        >
          <Input aria-label="新清单名称" placeholder="新清单名称" maxLength={100} />
        </Form.Item>
        <Form.Item name="color">
          <Input type="color" style={{ width: 44, padding: 2 }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending}>
            创建清单
          </Button>
        </Form.Item>
      </Form>
      {lists.error ? (
        <p className="danger-text">{errorText(lists.error)}</p>
      ) : lists.isPending ? (
        <Spin />
      ) : !lists.data?.length ? (
        <Empty description="还没有清单" />
      ) : (
        <List
          className="task-list-manager"
          dataSource={lists.data}
          renderItem={(list, index) => {
            const value = valueOf(list);
            return (
              <List.Item
                actions={[
                  <Button
                    key="up"
                    type="text"
                    aria-label={`上移清单 ${list.name}`}
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => move(list, -1)}
                  >
                    ↑
                  </Button>,
                  <Button
                    key="down"
                    type="text"
                    aria-label={`下移清单 ${list.name}`}
                    disabled={
                      index === (lists.data?.length ?? 0) - 1 ||
                      reorder.isPending
                    }
                    onClick={() => move(list, 1)}
                  >
                    ↓
                  </Button>,
                  <Button
                    key="save"
                    type="link"
                    disabled={!edits[list.id]}
                    loading={
                      update.isPending && update.variables?.id === list.id
                    }
                    onClick={() =>
                      update.mutate({ id: list.id, body: value })
                    }
                  >
                    保存
                  </Button>,
                  <Popconfirm
                    key="delete"
                    title="删除清单？"
                    description="其中的任务会移入收件箱。"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => remove.mutate(list.id)}
                  >
                    <Button
                      type="link"
                      danger
                      loading={
                        remove.isPending && remove.variables === list.id
                      }
                    >
                      删除
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <Space>
                  <Input
                    aria-label={`${list.name} 颜色`}
                    type="color"
                    value={value.color}
                    onChange={(e) => change(list, { color: e.target.value })}
                    style={{ width: 44, padding: 2 }}
                  />
                  <Input
                    aria-label={`${list.name} 名称`}
                    value={value.name}
                    onChange={(e) => change(list, { name: e.target.value })}
                    maxLength={100}
                    style={{ width: 220 }}
                  />
                </Space>
              </List.Item>
            );
          }}
        />
      )}
    </Modal>
  );
}
