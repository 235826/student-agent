import ImportRecords, { importLabels } from "../components/ImportRecords";
import {
  Link,
  useParams,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useRef, useState } from "react";
import { backTarget } from "../navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Tag,
  Spin,
} from "antd";
import { DateTime } from "luxon";
import {
  api,
  type ImportJob,
  type ImportCandidate,
  type Profile,
} from "../api";
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
const fieldLabels: Record<string, string> = {
  title: "标题",
  description: "说明",
  priority: "优先级",
  deadline_local: "截止时间",
  start_local: "开始时间",
  end_local: "结束时间",
  recurrence: "课程重复时间",
  estimate_minutes: "预计用时",
  location: "地点",
  parent_key: "父任务",
  predecessor_keys: "前置任务",
  event_kind: "事件类型",
};
export default function ImportsPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [context, setContext] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef<{ payload: string; key: string } | null>(null);
  const [reference, setReference] = useState(
    DateTime.now().setZone(profile.timezone).toFormat("yyyy-MM-dd'T'HH:mm"),
  );
  const { id: jobId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const setJobId = (id: string) => navigate(`/inbox/imports/${id}`);
  const back = backTarget(params.get("from"), {
    to: "/inbox/imports",
    label: "返回导入记录",
  });
  const [consent, setConsent] = useState(false);
  const capabilities = useQuery({
    queryKey: ["import-capabilities"],
    queryFn: () =>
      api<{ configured: boolean; images: boolean; worker_online: boolean }>(
        "/imports/capabilities",
      ),
    refetchInterval: 10000,
  });
  const job = useQuery({
    queryKey: ["import", jobId],
    queryFn: () => api<ImportJob>(`/imports/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) =>
      ["queued", "running"].includes(q.state.data?.status ?? "") ? 1500 : false,
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["import", jobId] });
    await client.invalidateQueries({ queryKey: ["imports"] });
    await client.invalidateQueries({ queryKey: ["tasks"] });
    await client.invalidateQueries({ queryKey: ["events"] });
  };
  const submit = useMutation({
    mutationFn: async (parse: boolean) => {
      const referenceAt = DateTime.fromISO(reference, {
        zone: profile.timezone,
      });
      if (!referenceAt.isValid) throw new Error("请填写有效的参考时间");
      if (parse && !consent) throw new Error("解析前请同意发送给模型");
      const payload = JSON.stringify({
        text,
        context,
        reference,
        parse,
        file: file ? [file.name, file.size, file.lastModified] : null,
      });
      if (request.current?.payload !== payload)
        request.current = { payload, key: crypto.randomUUID() };
      const key = request.current.key;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        form.append("context", context);
        form.append("reference_at", referenceAt.toISO()!);
        form.append("idempotency_key", key);
        form.append("confirmed", String(parse && consent));
        form.append("parse", String(parse));
        return api<ImportJob>("/imports/image", "POST", form);
      }
      return api<ImportJob>("/imports/text", "POST", {
        text,
        context,
        reference_at: referenceAt.toISO(),
        idempotency_key: key,
        confirmed: parse && consent,
        parse,
      });
    },
    onSuccess: async (result) => {
      setJobId(result.id);
      await client.invalidateQueries({ queryKey: ["imports"] });
    },
  });
  return (
    <div className="imports-page">
      <header>
        <div>
          <div className="eyebrow">IMPORT & REVIEW</div>
          <h1>先整理，再确认</h1>
          <p className="muted">
            文本和课表图片会先生成草稿，确认前不会改变任务或日历。
          </p>
        </div>
      </header>
      {!jobId && (
        <Card title="提交材料">
          {capabilities.data &&
            (!capabilities.data.configured ||
              !capabilities.data.worker_online) && (
              <Alert
                type="warning"
                showIcon
                message={
                  !capabilities.data.configured
                    ? "模型尚未配置：可以仅保存材料，直接手动整理草稿。"
                    : "解析服务暂未就绪，任务将等待后台处理。"
                }
              />
            )}
          <label>
            原文
            <Input.TextArea
              aria-label="导入原文"
              rows={5}
              value={text}
              maxLength={20000}
              onChange={(e) => setText(e.target.value)}
              disabled={!!file}
              placeholder="粘贴作业通知、考试安排或课表文字"
            />
          </label>
          <label>
            或上传课表图片（PNG/JPEG/WebP，最大 8 MiB）
            <input
              ref={fileInput}
              aria-label="课表图片"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {file && (
            <Button
              onClick={() => {
                setFile(null);
                if (fileInput.current) fileInput.current.value = "";
              }}
            >
              移除图片 / 切回文本输入
            </Button>
          )}
          {file && !capabilities.data?.images && (
            <Alert
              type="warning"
              message="当前模型未启用图片输入；可手动整理，或配置图片模型后重试。"
            />
          )}
          <label>
            补充说明
            <Input.TextArea
              aria-label="补充说明"
              rows={2}
              maxLength={4000}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="学期起止日期、第 1 周星期一日期、每节课起止时间、单双周说明"
            />
          </label>
          <label>
            相对日期的参考时间（{profile.timezone}）
            <Input
              aria-label="参考时间"
              type="datetime-local"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <Checkbox
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          >
            我同意将本次原文或图片及补充说明发送给已配置的模型服务
          </Checkbox>
          <div className="toolbar">
            <Button
              disabled={!text.trim() && !file}
              loading={submit.isPending && submit.variables === false}
              onClick={() => submit.mutate(false)}
            >
              仅保存材料
            </Button>
            <Button
              type="primary"
              disabled={
                !consent ||
                (!text.trim() && !file) ||
                capabilities.data?.configured === false
              }
              title={
                capabilities.data?.configured === false
                  ? "模型尚未配置，请先仅保存材料"
                  : undefined
              }
              loading={submit.isPending && submit.variables === true}
              onClick={() => submit.mutate(true)}
            >
              保存并解析
            </Button>
          </div>
          {submit.error && (
            <Alert type="error" message={errorText(submit.error)} />
          )}
        </Card>
      )}
      {!jobId && (
        <Card title="导入记录（最近 100 批）">
          <ImportRecords timezone={profile.timezone} />
        </Card>
      )}
      {jobId && (
        <Space className="toolbar">
          {params.get("from") && <Link to={back.to}>{back.label}</Link>}
          <Link to="/inbox/imports">返回导入记录</Link>
          <Link to="/inbox">返回收件箱</Link>
        </Space>
      )}
      {jobId && job.isPending && <Spin />}
      {job.error && <Alert type="error" message={errorText(job.error)} />}
      {job.data && (
        <DraftEditor
          key={`${job.data.id}:${job.data.revision}`}
          job={job.data}
          refresh={refresh}
        />
      )}
    </div>
  );
}

function DraftEditor({
  job,
  refresh,
}: {
  job: ImportJob;
  refresh: () => Promise<void>;
}) {
  const [items, setItems] = useState<ImportCandidate[]>(job.candidates);
  const [context, setContext] = useState(job.context);
  const [dirty, setDirty] = useState(false);
  const busy = ["queued", "running"].includes(job.status);
  const selected = items.filter((i) => i.selected);
  const blockers = selected.filter((i) => !i.reviewed || !i.title.trim());
  const reviewed = selected.filter((i) => i.reviewed).length;
  const reason = busy
    ? "请等待解析结束，或取消解析后手动整理。"
    : dirty
      ? "请先保存校对结果，再确认入库。"
      : !selected.length
        ? "请至少选中一个条目。"
        : blockers.length
          ? "请补全标题并逐项校对。"
          : "";
  const readOnly = busy || !!job.published_revision || !!job.source.deleted_at;
  const change = (index: number, patch: Partial<ImportCandidate>) => {
    setItems((prev) =>
      prev.map((item, i) =>
        i === index
          ? { ...item, ...patch, reviewed: patch.reviewed ?? false }
          : item,
      ),
    );
    setDirty(true);
  };
  const action = useMutation({
    mutationFn: ({
      name,
      body,
      method = "POST",
    }: {
      name: string;
      body?: unknown;
      method?: string;
    }) =>
      api<ImportJob>(
        `/imports/${job.id}/${name}`,
        method,
        body ?? { revision: job.revision, confirmed: true },
      ),
    onSuccess: refresh,
  });
  const act = (name: string, body?: unknown, method?: string) =>
    action.mutate({ name, body, method });
  return (
    <Card
      title={
        job.published_revision
          ? "已确认入库"
          : `草稿 · ${importLabels[job.status]}`
      }
    >
      <p>
        参考时间：
        {DateTime.fromISO(job.reference_at)
          .setZone(job.timezone)
          .toFormat("yyyy-MM-dd HH:mm")}
        （{job.timezone}）
      </p>
      {job.source.deleted_at ? (
        <Alert type="info" message="来源已删除；已创建的任务和事件仍保留。" />
      ) : (
        <details open>
          <summary>查看原始材料</summary>
          {job.source.kind === "text" ? (
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {job.source.text}
            </pre>
          ) : (
            <a
              href={`/api/v1/imports/${job.id}/source`}
              target="_blank"
              rel="noreferrer"
            >
              <img
                alt="原始课表"
                src={`/api/v1/imports/${job.id}/source`}
                style={{ maxWidth: "100%", maxHeight: 480 }}
              />
            </a>
          )}
        </details>
      )}
      {job.error && <Alert type="warning" message={job.error} />}
      {job.warnings.map((warning, i) => (
        <Alert key={i} type="warning" message={warning} />
      ))}
      {action.error && <Alert type="error" message={errorText(action.error)} />}
      {busy && (
        <Button onClick={() => act("cancel")} loading={action.isPending}>
          取消解析，手动整理
        </Button>
      )}
      {!readOnly && (
        <>
          <label>
            重试时的补充说明
            <Input.TextArea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              maxLength={4000}
            />
          </label>
          <Popconfirm
            title="重新发送材料和说明给模型，并替换当前草稿？"
            onConfirm={() =>
              act("retry", { revision: job.revision, confirmed: true, context })
            }
          >
            <Button disabled={action.isPending}>重新解析</Button>
          </Popconfirm>
        </>
      )}
      <p>
        已校对 {reviewed}/{selected.length}
      </p>
      {!job.published_revision && reason && (
        <Alert
          type="info"
          message={reason}
          action={
            blockers.length ? (
              <Button
                onClick={() =>
                  document
                    .getElementById(`candidate-${blockers[0].key}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" })
                }
              >
                定位待补全条目
              </Button>
            ) : undefined
          }
        />
      )}
      {items.map((item, index) => (
        <Card
          key={item.key}
          id={`candidate-${item.key}`}
          size="small"
          style={{ marginTop: 16 }}
          title={`条目 ${index + 1}`}
        >
          <Space wrap>
            <Checkbox
              checked={item.selected}
              disabled={readOnly}
              onChange={(e) => change(index, { selected: e.target.checked })}
            >
              纳入本次入库
            </Checkbox>
            <Select
              aria-label={`条目 ${index + 1} 类型`}
              value={item.kind}
              disabled={readOnly}
              options={[
                { value: "task", label: "任务" },
                { value: "event", label: "固定事件" },
                { value: "course", label: "每周课程" },
              ]}
              onChange={(kind) =>
                change(index, { kind, parent_key: null, predecessor_keys: [] })
              }
            />
            <Button
              disabled={readOnly}
              onClick={() => {
                setItems(items.filter((_, i) => i !== index));
                setDirty(true);
              }}
            >
              移除条目
            </Button>
          </Space>
          <label>
            标题
            <Input
              aria-label={`条目 ${index + 1} 标题`}
              value={item.title}
              disabled={readOnly}
              maxLength={200}
              onChange={(e) => change(index, { title: e.target.value })}
            />
          </label>
          {item.kind === "task" && (
            <>
              <label>
                说明
                <Input.TextArea
                  value={item.description}
                  disabled={readOnly}
                  maxLength={20000}
                  onChange={(e) =>
                    change(index, { description: e.target.value })
                  }
                />
              </label>
              <label>
                截止时间（留空表示待定）
                <Input
                  type="datetime-local"
                  value={item.deadline_local ?? ""}
                  disabled={readOnly}
                  onChange={(e) =>
                    change(index, { deadline_local: e.target.value || null })
                  }
                />
              </label>
              <label>
                预计分钟{" "}
                {item.estimate_is_suggestion && <Tag>建议值，需校对</Tag>}
                <InputNumber
                  min={1}
                  max={100000}
                  value={item.estimate_minutes}
                  disabled={readOnly}
                  onChange={(v) =>
                    change(index, {
                      estimate_minutes: v,
                      estimate_is_suggestion: false,
                    })
                  }
                />
              </label>
              <label>
                优先级（1 最高）
                <InputNumber
                  min={1}
                  max={4}
                  value={item.priority}
                  disabled={readOnly}
                  onChange={(v) => change(index, { priority: v ?? 2 })}
                />
              </label>
              <label>
                父任务
                <Select
                  style={{ width: "100%" }}
                  allowClear
                  value={item.parent_key}
                  disabled={readOnly}
                  options={items
                    .filter((c) => c.kind === "task" && c.key !== item.key)
                    .map((c) => ({ value: c.key, label: c.title || c.key }))}
                  onChange={(v) => change(index, { parent_key: v ?? null })}
                />
              </label>
              <label>
                前置任务
                <Select
                  style={{ width: "100%" }}
                  mode="multiple"
                  value={item.predecessor_keys}
                  disabled={readOnly}
                  options={items
                    .filter((c) => c.kind === "task" && c.key !== item.key)
                    .map((c) => ({ value: c.key, label: c.title || c.key }))}
                  onChange={(v) => change(index, { predecessor_keys: v })}
                />
              </label>
            </>
          )}
          {item.kind === "event" && (
            <>
              <label>
                开始时间
                <Input
                  type="datetime-local"
                  disabled={readOnly}
                  value={item.start_local ?? ""}
                  onChange={(e) =>
                    change(index, { start_local: e.target.value || null })
                  }
                />
              </label>
              <label>
                结束时间
                <Input
                  type="datetime-local"
                  disabled={readOnly}
                  value={item.end_local ?? ""}
                  onChange={(e) =>
                    change(index, { end_local: e.target.value || null })
                  }
                />
              </label>
              <Select
                aria-label="事件类型"
                value={item.event_kind}
                disabled={readOnly}
                options={[
                  { value: "other", label: "其他" },
                  { value: "exam", label: "考试" },
                  { value: "meeting", label: "会议" },
                ]}
                onChange={(event_kind) => change(index, { event_kind })}
              />
            </>
          )}
          {item.kind === "course" && (
            <>
              <Alert
                type="info"
                message="课程按选定日期范围每周重复；单双周或不连续周次请拆成多个条目。"
              />
              {(
                ["start_date", "end_date", "start_time", "end_time"] as const
              ).map((field, i) => (
                <label key={field}>
                  {["起始日期", "结束日期", "上课时间", "下课时间"][i]}
                  <Input
                    type={field.endsWith("date") ? "date" : "time"}
                    disabled={readOnly}
                    value={item.recurrence?.[field] ?? ""}
                    onChange={(e) =>
                      change(index, {
                        recurrence: {
                          ...item.recurrence,
                          [field]: e.target.value || null,
                        },
                      })
                    }
                  />
                </label>
              ))}
              <Checkbox.Group
                disabled={readOnly}
                options={[
                  "周一",
                  "周二",
                  "周三",
                  "周四",
                  "周五",
                  "周六",
                  "周日",
                ].map((label, value) => ({ label, value }))}
                value={item.recurrence?.weekdays ?? []}
                onChange={(v) =>
                  change(index, {
                    recurrence: { ...item.recurrence, weekdays: v as number[] },
                  })
                }
              />
            </>
          )}
          {item.kind !== "task" && (
            <label>
              地点
              <Input
                value={item.location}
                disabled={readOnly}
                maxLength={500}
                onChange={(e) => change(index, { location: e.target.value })}
              />
            </label>
          )}
          <details>
            <summary>字段依据</summary>
            {Object.entries(item.evidence ?? {}).map(([field, quote]) => (
              <p key={field}>
                <strong>{fieldLabels[field] ?? field}：</strong>
                {quote}
              </p>
            ))}
          </details>
          {item.uncertainties?.map((text, i) => (
            <Alert key={i} type="warning" message={text} />
          ))}
          <Checkbox
            disabled={readOnly}
            checked={item.reviewed}
            onChange={(e) => change(index, { reviewed: e.target.checked })}
          >
            已核对该条目的标题、日期、时间及关联关系
          </Checkbox>
        </Card>
      ))}
      {!readOnly && (
        <Space wrap style={{ marginTop: 16 }}>
          <Button
            onClick={() => {
              setItems([
                ...items,
                {
                  key: crypto.randomUUID(),
                  kind: "task",
                  title: "",
                  description: "",
                  priority: 2,
                  estimate_is_suggestion: true,
                  location: "",
                  event_kind: "other",
                  predecessor_keys: [],
                  evidence: {},
                  uncertainties: [],
                  selected: true,
                  reviewed: false,
                },
              ]);
              setDirty(true);
            }}
          >
            添加条目
          </Button>
          <Button
            loading={action.isPending}
            onClick={() =>
              act("draft", { revision: job.revision, candidates: items }, "PUT")
            }
          >
            保存校对
          </Button>
          <Popconfirm
            title="将所有选中且已校对的条目一次性写入任务和日历？"
            onConfirm={() =>
              act("publish", {
                revision: job.revision,
                confirmed: true,
                idempotency_key: crypto.randomUUID(),
              })
            }
          >
            <Button
              type="primary"
              disabled={
                dirty ||
                !items.some((c) => c.selected) ||
                items.some(
                  (c) => c.selected && (!c.reviewed || !c.title.trim()),
                ) ||
                action.isPending
              }
            >
              确认入库
            </Button>
          </Popconfirm>
        </Space>
      )}
      {job.published_revision && (
        <Alert
          type="success"
          message={`已入库 ${job.published_records.length} 项；重复确认不会再次创建。`}
          description={
            <Space>
              <Link to="/tasks">查看任务</Link>
              <Link to="/calendar">查看课表</Link>
            </Space>
          }
        />
      )}
      {!job.source.deleted_at && (
        <div className="toolbar">
          <Popconfirm
            title="删除原始材料及草稿依据？已创建的任务和课程会保留。"
            onConfirm={() => act("source", undefined, "DELETE")}
          >
            <Button danger disabled={action.isPending}>
              删除来源
            </Button>
          </Popconfirm>
        </div>
      )}
    </Card>
  );
}
