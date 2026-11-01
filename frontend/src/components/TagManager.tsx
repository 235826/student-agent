import { useState } from "react";
import {
  App,
  Button,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Spin,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TagRecord } from "../api";

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

export default function TagManager({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<TagRecord[]>("/tags"),
    enabled: open,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["tags"] });
    void client.invalidateQueries({ queryKey: ["tasks"] });
  };
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<TagRecord>(`/tags/${id}`, "PUT", { name }),
    onSuccess: (_data, variables) => {
      setEdits((current) => {
        const next = { ...current };
        delete next[variables.id];
        return next;
      });
      refresh();
      void message.success("标签已更新");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/tags/${id}`, "DELETE"),
    onSuccess: () => {
      refresh();
      void message.success("标签已删除");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  return (
    <Modal
      title="管理标签"
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      {tags.error ? (
        <p className="danger-text">{errorText(tags.error)}</p>
      ) : tags.isPending ? (
        <Spin />
      ) : !tags.data?.length ? (
        <Empty description="还没有标签" />
      ) : (
        <List
          dataSource={tags.data}
          renderItem={(tag) => {
            const value = edits[tag.id] ?? tag.name;
            return (
              <List.Item
                actions={[
                  <Button
                    key="save"
                    type="link"
                    disabled={edits[tag.id] === undefined}
                    loading={
                      rename.isPending && rename.variables?.id === tag.id
                    }
                    onClick={() => rename.mutate({ id: tag.id, name: value })}
                  >
                    保存
                  </Button>,
                  <Popconfirm
                    key="delete"
                    title="删除标签？"
                    description={`将从 ${tag.usage_count} 个任务移除该标签。`}
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => remove.mutate(tag.id)}
                  >
                    <Button
                      type="link"
                      danger
                      loading={remove.isPending && remove.variables === tag.id}
                    >
                      删除
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <Space>
                  <Input
                    aria-label={`${tag.name} 名称`}
                    value={value}
                    onChange={(e) =>
                      setEdits((current) => ({
                        ...current,
                        [tag.id]: e.target.value,
                      }))
                    }
                    maxLength={50}
                    style={{ width: 220 }}
                  />
                  <span className="muted">使用 {tag.usage_count} 次</span>
                </Space>
              </List.Item>
            );
          }}
        />
      )}
    </Modal>
  );
}
