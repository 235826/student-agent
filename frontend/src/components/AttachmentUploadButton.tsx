import { App, Button, Tooltip, Upload } from "antd";
import { PaperClipOutlined } from "@ant-design/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Attachment } from "../api";

export default function AttachmentUploadButton({ taskId }: { taskId: string }) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api<Attachment>(`/tasks/${taskId}/attachments`, "POST", form);
    },
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ["tasks", "attachments", taskId],
      });
      void message.success("附件已上传");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  return (
    <Tooltip title="单个附件不超过 20 MiB，每个任务最多 20 个">
      <Upload
        showUploadList={false}
        beforeUpload={(file) => {
          upload.mutate(file);
          return false;
        }}
      >
        <Button
          type="text"
          size="small"
          icon={<PaperClipOutlined />}
          loading={upload.isPending}
        >
          添加附件
        </Button>
      </Upload>
    </Tooltip>
  );
}
