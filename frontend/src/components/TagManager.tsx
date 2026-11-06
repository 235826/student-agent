import { useState } from "react";
import {
  App,
  Button,
  Empty,
  Input,
  List,
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
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!open) return null;
  return (
    <section className="section">
      <div className="section-inline-heading">
        <h3>管理标签</h3>
        <Button type="text" onClick={onClose}>
          收起
        </Button>
      </div>
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
                  confirming === tag.id ? (
                    <>
                      <Button
                        key="confirm-delete"
                        type="link"
                        danger
                        loading={
                          remove.isPending && remove.variables === tag.id
                        }
                        onClick={() => {
                          setConfirming(null);
                          remove.mutate(tag.id);
                        }}
                      >
                        确认删除
                      </Button>,
                      <Button
                        key="cancel-delete"
                        type="link"
                        onClick={() => setConfirming(null)}
                      >
                        取消
                      </Button>,
                    </>
                  ) : (
                    <Button
                      key="delete"
                      type="link"
                      danger
                      onClick={() => setConfirming(tag.id)}
                    >
                      删除
                    </Button>
                  ),
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
    </section>
  );
}
