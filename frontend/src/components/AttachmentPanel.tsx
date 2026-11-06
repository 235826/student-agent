import { useState } from "react";
import { App, Button, List, Space, Upload } from "antd";
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

export default function AttachmentPanel({ taskId }: { taskId: string }) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
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
    <section className="section">
      <h3>附件</h3>
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
                ...(previewable(attachment.media_type)
                  ? [
                      <Button
                        key="preview"
                        type="link"
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
                confirming === attachment.id ? (
                  <>
                    <Button
                      key="confirm-delete"
                      type="link"
                      danger
                      loading={
                        remove.isPending && remove.variables === attachment.id
                      }
                      onClick={() => {
                        setConfirming(null);
                        remove.mutate(attachment.id);
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
                    onClick={() => setConfirming(attachment.id)}
                  >
                    删除
                  </Button>
                ),
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
        <Button type="text" loading={upload.isPending}>
          上传附件
        </Button>
      </Upload>
      <p className="muted">单个附件不超过 20 MiB，每个任务最多 20 个。</p>
      {preview && (
        <div className="attachment-inline-preview">
          <div className="section-inline-heading">
            <span>{preview.filename}</span>
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
