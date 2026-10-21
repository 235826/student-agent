import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Modal, Spin } from "antd";
import { api, type ImportJob } from "../api";

export default function SourceButton({ objectId }: { objectId: string }) {
  const [open, setOpen] = useState(false);
  const sources = useQuery({
    queryKey: ["origins", objectId],
    queryFn: () =>
      api<ImportJob[]>(
        `/imports/origins?object_id=${encodeURIComponent(objectId)}`,
      ),
    enabled: open,
  });
  return (
    <>
      <Button onClick={() => setOpen(true)}>查看来源</Button>
      <Modal
        title="导入来源"
        open={open}
        footer={null}
        onCancel={() => setOpen(false)}
      >
        {sources.isPending && <Spin />}
        {sources.error && (
          <Alert type="error" message={sources.error.message} />
        )}
        {sources.data?.length === 0 && <p>此记录没有导入来源。</p>}
        {sources.data?.map((job) => (
          <div key={job.id}>
            {job.source.deleted_at ? (
              <p>原始材料已删除，来源关联仍保留。</p>
            ) : (
              <>
                <a href={`/imports?job=${job.id}`}>打开导入记录与字段依据</a>
                {job.source.kind === "text" ? (
                  <pre style={{ whiteSpace: "pre-wrap" }}>
                    {job.source.text}
                  </pre>
                ) : (
                  <img
                    src={`/api/v1/imports/${job.id}/source`}
                    alt="原始课表"
                    style={{ maxWidth: "100%" }}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </Modal>
    </>
  );
}
