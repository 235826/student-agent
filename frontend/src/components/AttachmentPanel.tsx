import {
  App,
  Button,
  Card,
  List,
  Popconfirm,
  Space,
  Upload,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Attachment } from "../api";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function AttachmentPanel({ taskId }: { taskId: string }) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const attachments = useQuery({
    queryKey: ["tasks", "attachments", taskId],
    queryFn: () => api<Attachment[]>(`/tasks/${taskId}/attachments`),
  });
  const refresh = () => {
    void client.invalidateQueries({
      queryKey: ["tasks", "attachments", taskId],
    });
  };
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api<Attachment>(`/tasks/${taskId}/attachments`, "POST", form);
    },
    onSuccess: () => {
      refresh();
      void message.success("附件已上传");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/attachments/${id}`, "DELETE"),
    onSuccess: () => {
      refresh();
      void message.success("附件已删除");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  return (
    <Card title="附件" className="toolbar">
      {attachments.error ? (
        <p className="danger-text">{attachments.error.message}</p>
      ) : attachments.isPending ? (
        <p className="muted">正在加载附件…</p>
      ) : !attachments.data?.length ? (
        <p className="muted">还没有附件。</p>
      ) : (
        <List
          dataSource={attachments.data}
          renderItem={(attachment) => (
            <List.Item
              actions={[
                <a
                  key="download"
                  href={`/api/v1/attachments/${attachment.id}`}
                  download
                >
                  下载
                </a>,
                <Popconfirm
                  key="delete"
                  title="删除附件？"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => remove.mutate(attachment.id)}
                >
                  <Button
                    type="link"
                    danger
                    loading={
                      remove.isPending && remove.variables === attachment.id
                    }
                  >
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <Space direction="vertical" size={0}>
                <span>{attachment.filename}</span>
                <span className="muted">{formatSize(attachment.size_bytes)}</span>
              </Space>
            </List.Item>
          )}
        />
      )}
      <Upload
        showUploadList={false}
        beforeUpload={(file) => {
          upload.mutate(file);
          return false;
        }}
      >
        <Button loading={upload.isPending}>上传附件</Button>
      </Upload>
      <p className="muted">单个附件不超过 20 MiB，每个任务最多 20 个。</p>
    </Card>
  );
}
