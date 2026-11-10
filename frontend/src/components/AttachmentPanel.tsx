import { useState } from "react";
import {
  App,
  Button,
  List,
  Popconfirm,
  Space,
  Typography,
} from "antd";
import {
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Attachment } from "../api";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const previewable = (mediaType: string) =>
  ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"].includes(
    mediaType,
  );

const fileIcon = (mediaType: string) => {
  if (mediaType === "application/pdf") return <FilePdfOutlined />;
  if (mediaType.startsWith("image/")) return <FileImageOutlined />;
  return <FileOutlined />;
};

export default function AttachmentPanel({ taskId }: { taskId: string }) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [preview, setPreview] = useState<Attachment | null>(null);
  const attachments = useQuery({
    queryKey: ["tasks", "attachments", taskId],
    queryFn: () => api<Attachment[]>(`/tasks/${taskId}/attachments`),
  });
  const refresh = () => {
    void client.invalidateQueries({
      queryKey: ["tasks", "attachments", taskId],
    });
  };
  const remove = useMutation({
    mutationFn: (id: string) => api(`/attachments/${id}`, "DELETE"),
    onSuccess: () => {
      refresh();
      void message.success("附件已删除");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  if (attachments.error) {
    return <p className="danger-text attachment-error">附件加载失败</p>;
  }
  if (attachments.isPending || !attachments.data?.length) return null;
  return (
    <section className="section attachment-section">
      <h4>附件 {attachments.data.length}</h4>
      <List
        size="small"
        split={false}
        dataSource={attachments.data}
        renderItem={(attachment) => (
          <List.Item
            className="attachment-item"
            actions={[
              ...(previewable(attachment.media_type)
                ? [
                    <Button
                      key="preview"
                      type="link"
                      size="small"
                      onClick={() => setPreview(attachment)}
                    >
                      预览
                    </Button>,
                  ]
                : []),
              <a
                key="download"
                href={`/api/v1/attachments/${attachment.id}`}
                download
              >
                下载
              </a>,
              <Popconfirm
                key="delete"
                title="删除这个附件？"
                description="删除后无法恢复。"
                okText="确认删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => remove.mutate(attachment.id)}
              >
                <Button
                  type="link"
                  size="small"
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
            <List.Item.Meta
              avatar={fileIcon(attachment.media_type)}
              title={attachment.filename}
              description={
                <Typography.Text type="secondary">
                  {formatSize(attachment.size_bytes)}
                </Typography.Text>
              }
            />
          </List.Item>
        )}
      />
      {preview && (
        <div className="attachment-inline-preview">
          <div className="section-inline-heading">
            <Space size={4}>
              {fileIcon(preview.media_type)}
              <span>{preview.filename}</span>
            </Space>
            <Button type="text" size="small" onClick={() => setPreview(null)}>
              收起
            </Button>
          </div>
          {preview.media_type === "application/pdf" ? (
            <iframe
              className="attachment-preview-frame"
              src={`/api/v1/attachments/${preview.id}?inline=true`}
              title={preview.filename}
            />
          ) : (
            <img
              className="attachment-preview-image"
              src={`/api/v1/attachments/${preview.id}?inline=true`}
              alt={preview.filename}
            />
          )}
        </div>
      )}
    </section>
  );
}
