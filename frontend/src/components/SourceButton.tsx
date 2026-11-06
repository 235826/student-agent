import { Link, useLocation } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { api, type ImportJob } from "../api";
import { currentLocation, withFrom } from "../navigation";

export default function SourceButton({ objectId }: { objectId: string }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const here = currentLocation(
    location.pathname,
    location.search,
    location.hash,
  );
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
      <Button type="text" size="small" onClick={() => setOpen((value) => !value)}>
        {open ? "收起来源" : "查看来源"}
      </Button>
      {open && (
        <div className="source-inline-panel">
          {sources.isPending && <p className="muted">正在加载来源…</p>}
          {sources.error && (
            <p className="danger-text">{sources.error.message}</p>
          )}
          {sources.data?.length === 0 && <p>此记录没有导入来源。</p>}
          {sources.data?.map((job) => (
            <div key={job.id}>
              {job.source.deleted_at ? (
                <p>原始材料已删除，来源关联仍保留。</p>
              ) : (
                <>
                  <Link
                    to={withFrom(`/inbox/imports/${job.id}`, here)}
                    className="text-action"
                  >
                    打开导入记录与字段依据
                  </Link>
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
        </div>
      )}
    </>
  );
}
