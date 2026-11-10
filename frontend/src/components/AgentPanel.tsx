import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Select, Spin, Tag, Typography } from "antd";
import { PaperClipOutlined, CloseOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useLocation } from "react-router-dom";
import AgentTaskResult from "./AgentTaskResult";
import {
  ApiError,
  api,
  type AgentAction,
  type AgentCapabilities,
  type AgentConversation,
  type AgentConversationDetail,
  type AgentImage,
} from "../api";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试";

const riskLabel: Record<string, string> = {
  low: "常规",
  medium: "需确认",
  high: "高风险",
};

const statusLabel: Record<string, string> = {
  proposed: "待确认",
  confirmed: "执行中",
  rejected: "已忽略",
  executed: "已执行",
  failed: "失败",
  expired: "已过期",
  undone: "已撤销",
};

const previewLabels: Record<string, string> = {
  target: "对象",
  title: "标题",
  event_type: "事件类型",
  start_at: "开始",
  end_at: "结束",
  timezone: "时区",
  location: "地点",
  note: "备注",
  details: "详情",
  deadline_at: "截止",
  deadline_all_day: "全天截止",
  remind_at: "提醒时间",
  priority: "优先级",
  status: "状态",
  tags: "标签",
  estimate_minutes: "预计用时",
  flagged: "旗标",
  description: "描述",
  links: "链接",
  recurrence: "重复",
  recurrence_interval: "重复间隔",
  name: "名称",
  color: "颜色",
  semester: "学期",
};

const previewHidden = new Set([
  "id",
  "event_id",
  "task_id",
  "course_id",
  "series_id",
  "list_id",
  "event_type_id",
  "parent_id",
  "predecessor_ids",
  "action_key",
]);

const dateFields = new Set(["start_at", "end_at", "deadline_at", "remind_at", "created_at"]);

const priorityLabels: Record<number, string> = {
  1: "最高",
  2: "高",
  3: "中",
  4: "低",
};

function surfaceForPath(pathname: string): string {
  if (pathname.startsWith("/tasks") || pathname.startsWith("/inbox")) return "tasks";
  if (
    pathname.startsWith("/calendar") ||
    pathname.startsWith("/events") ||
    pathname.startsWith("/courses") ||
    pathname.startsWith("/series")
  ) {
    return "calendar";
  }
  if (pathname.startsWith("/plans") || pathname.startsWith("/compatibility")) return "planning";
  if (pathname.startsWith("/imports")) return "imports";
  if (pathname.startsWith("/settings")) return "settings";
  return "agent";
}

const relatedQueries: Array<[string, string[]]> = [
  ["task", ["tasks", "task-lists", "task-list-groups", "tags", "saved-filters"]],
  ["worklog", ["worklogs", "tasks"]],
  ["event", ["events", "courses", "series", "event-types", "plans"]],
  ["course", ["courses", "series", "events", "plans"]],
  ["series", ["series", "courses", "events", "plans"]],
  ["plan", ["plans"]],
  ["compatibility", ["rules"]],
  ["policy", ["type-policies", "tasks"]],
  ["import", ["imports", "drafts", "tasks", "events"]],
  ["draft", ["drafts", "tasks"]],
  ["profile", ["me"]],
  ["list", ["task-lists", "task-list-groups", "saved-filters", "me"]],
  ["tag", ["tags", "saved-filters", "me"]],
  ["filter", ["saved-filters"]],
];

function formatPreviewValue(key: string, value: unknown): string {
  if (key === "priority" && typeof value === "number") {
    return `${priorityLabels[value] ?? value}（${value}）`;
  }
  if (dateFields.has(key) && typeof value === "string") {
    const parsed = DateTime.fromISO(value);
    return parsed.isValid ? parsed.toFormat("yyyy-MM-dd HH:mm") : value;
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map((item) => String(item)).join("、");
  return String(value);
}

function previewEntries(action: AgentAction): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const preview = action.preview ?? {};
  const source = Object.keys(preview).length > 0 ? preview : action.payload;
  for (const [key, value] of Object.entries(source)) {
    if (previewHidden.has(key) || value === null || value === undefined || value === "") {
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const text = formatPreviewValue(key, value);
    entries.push([previewLabels[key] ?? key, text.length > 160 ? `${text.slice(0, 160)}…` : text]);
  }
  return entries;
}

function ActionCard({
  action,
  siblings,
  busy,
  onConfirm,
  onReject,
}: {
  action: AgentAction;
  siblings: AgentAction[];
  busy: boolean;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const missing = action.depends_on.filter((key) => {
    const dependency = siblings.find((item) => item.action_key === key);
    return dependency?.status !== "executed";
  });
  const ready = missing.length === 0;
  const entries = previewEntries(action);
  if (
    action.operation === "create_task" &&
    ["executed", "undone"].includes(action.status)
  ) {
    return (
      <div className="agent-action risk-low">
        <div className="agent-action-head">
          <span className="agent-action-summary">{action.summary}</span>
          <Tag color={action.status === "executed" ? "green" : undefined}>
            {action.status === "executed" ? "已创建" : "已撤销"}
          </Tag>
        </div>
        <AgentTaskResult action={action} />
      </div>
    );
  }
  return (
    <div className={`agent-action risk-${action.risk}`}>
      <div className="agent-action-head">
        <Tag color={action.risk === "high" ? "red" : action.risk === "medium" ? "orange" : "green"}>
          {riskLabel[action.risk] ?? action.risk}
        </Tag>
        <span className="agent-action-summary">{action.summary}</span>
        <Tag>{statusLabel[action.status] ?? action.status}</Tag>
      </div>
      {action.depends_on.length > 0 && (
        <div className="agent-action-note">
          依赖步骤：{action.depends_on.join("、")}
          {missing.length > 0 && "（请先确认前面的动作）"}
        </div>
      )}
      {entries.length > 0 && (
        <dl className="agent-action-preview">
          {entries.map(([label, value]) => (
            <div key={label} className="agent-action-preview-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <details className="agent-action-payload">
        <summary>查看原始 JSON</summary>
        <pre>{JSON.stringify(action.payload, null, 2)}</pre>
      </details>
      {action.status === "proposed" && (
        <div className="agent-action-buttons">
          <Button
            size="small"
            type="primary"
            danger={action.risk === "high"}
            disabled={!ready || busy}
            loading={busy}
            onClick={() => onConfirm(action.id)}
          >
            {action.risk === "high" ? "确认执行（高风险）" : "确认执行"}
          </Button>
          <Button size="small" disabled={busy} onClick={() => onReject(action.id)}>
            忽略
          </Button>
        </div>
      )}
      {action.status === "executed" && action.result && (
        <div className="agent-action-note">
          已执行：
          {typeof action.result.title === "string"
            ? action.result.title
            : typeof action.result.id === "string"
              ? `记录 ${action.result.id.slice(0, 8)}`
              : "操作成功"}
        </div>
      )}
      {action.status === "failed" && action.error && (
        <Alert type="error" showIcon message={action.error} />
      )}
    </div>
  );
}

export default function AgentPanel({ compact = false }: { compact?: boolean }) {
  const client = useQueryClient();
  const location = useLocation();
  const [conversationId, setConversationId] = useState<string>(
    () => localStorage.getItem("agent:conversation") ?? "",
  );
  const [draft, setDraft] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [pendingImages, setPendingImages] = useState<AgentImage[]>([]);
  const [streamRunId, setStreamRunId] = useState("");
  const [streamText, setStreamText] = useState("");
  const [streamPhase, setStreamPhase] = useState("");
  const bottom = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const autoRun = useRef("");

  const capabilities = useQuery({
    queryKey: ["agent-capabilities"],
    queryFn: () => api<AgentCapabilities>("/agent/capabilities"),
    refetchInterval: 15000,
  });
  const conversations = useQuery({
    queryKey: ["agent-conversations"],
    queryFn: () => api<AgentConversation[]>("/agent/conversations"),
  });
  const detail = useQuery({
    queryKey: ["agent-conversation", conversationId],
    queryFn: () => api<AgentConversationDetail>(`/agent/conversations/${conversationId}`),
    enabled: !!conversationId,
    refetchInterval: (query) => {
      const status = query.state.data?.latest_run?.status;
      return status === "queued" || status === "running" ? 1500 : false;
    },
  });

  const select = (id: string) => {
    setStreamRunId("");
    setStreamText("");
    setStreamPhase("");
    autoRun.current = "";
    setConversationId(id);
    localStorage.setItem("agent:conversation", id);
  };

  useEffect(() => {
    if (!conversationId && conversations.data?.length) {
      select(conversations.data[0].id);
    }
  }, [conversationId, conversations.data]);

  useEffect(() => {
    const latest = detail.data?.latest_run;
    if (
      latest &&
      (latest.status === "queued" || latest.status === "running") &&
      autoRun.current !== latest.id
    ) {
      autoRun.current = latest.id;
      setStreamRunId(latest.id);
    }
  }, [detail.data?.latest_run]);

  useEffect(() => {
    if (!streamRunId) return;
    setStreamText("");
    setStreamPhase("");
    let lastPending = -1;
    const source = new EventSource(`/api/v1/agent/runs/${streamRunId}/stream`);
    source.onmessage = (event) => {
      let data: {
        status?: string;
        phase?: string;
        partial_content?: string;
        pending_actions?: number;
      };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      setStreamPhase(data.phase ?? "");
      setStreamText(data.partial_content ?? "");
      const pending = data.pending_actions ?? 0;
      if (pending !== lastPending) {
        lastPending = pending;
        if (pending > 0) {
          void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
        }
      }
      if (data.status && !["queued", "running"].includes(data.status)) {
        source.close();
        setStreamRunId("");
        setStreamText("");
        setStreamPhase("");
        void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
        void client.invalidateQueries({ queryKey: ["agent-conversations"] });
      }
    };
    source.onerror = () => {
      source.close();
      setStreamRunId("");
    };
    return () => source.close();
  }, [streamRunId, client, conversationId]);

  const invalidateRelated = (operation: string) => {
    void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
    for (const [prefix, keys] of relatedQueries) {
      if (operation.includes(prefix)) {
        for (const key of keys) {
          void client.invalidateQueries({ queryKey: [key] });
        }
      }
    }
  };

  const taskReceipts = (detail.data?.actions ?? [])
    .filter(
      (action) =>
        action.operation === "create_task" &&
        ["executed", "undone"].includes(action.status),
    )
    .map((action) => `${action.id}:${action.status}`)
    .join(",");
  useEffect(() => {
    if (taskReceipts) void client.invalidateQueries({ queryKey: ["tasks"] });
  }, [taskReceipts, client]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail.data?.messages.length, detail.data?.actions.length, streamText]);

  const create = useMutation({
    mutationFn: () =>
      api<AgentConversation>("/agent/conversations", "POST", { consent: true }),
    onSuccess: (conversation) => {
      select(conversation.id);
      void client.invalidateQueries({ queryKey: ["agent-conversations"] });
    },
  });

  const send = useMutation({
    mutationFn: (content: string) =>
      api<{ run_id: string; conversation_id: string }>(
        `/agent/conversations/${conversationId}/messages`,
        "POST",
        {
          content,
          idempotency_key: crypto.randomUUID(),
          image_ids: pendingImages.map((img) => img.id),
          surface: surfaceForPath(location.pathname),
          task_list_id:
            surfaceForPath(location.pathname) === "tasks"
              ? (() => {
                  const list = new URLSearchParams(location.search).get("list");
                  return list && !["all", "inbox"].includes(list) ? list : null;
                })()
              : null,
        },
      ),
    onSuccess: (result) => {
      setDraft("");
      setPendingImages([]);
      autoRun.current = result.run_id;
      setStreamRunId(result.run_id);
      void client.invalidateQueries({ queryKey: ["agent-conversations"] });
      void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
    },
  });

  const confirm = useMutation({
    mutationFn: (id: string) =>
      api<AgentAction>(`/agent/actions/${id}/confirm`, "POST", {}),
    onMutate: (id) => setBusyAction(id),
    onSettled: () => setBusyAction(""),
    onSuccess: (action) => {
      invalidateRelated(action.operation);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
      }
    },
  });

  const reject = useMutation({
    mutationFn: (id: string) =>
      api<AgentAction>(`/agent/actions/${id}/reject`, "POST", { reason: "" }),
    onMutate: (id) => setBusyAction(id),
    onSettled: () => setBusyAction(""),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
      }
    },
  });

  const enabled = capabilities.data?.configured && capabilities.data?.tools;
  const imagesEnabled = enabled && capabilities.data?.images === true;
  const latest = detail.data?.latest_run;
  const running = !!streamRunId || latest?.status === "queued" || latest?.status === "running";
  const actionsByRun = useMemo(() => {
    const groups = new Map<string, AgentAction[]>();
    for (const action of detail.data?.actions ?? []) {
      groups.set(action.run_id, [...(groups.get(action.run_id) ?? []), action]);
    }
    return groups;
  }, [detail.data?.actions]);
  const orphanActions = useMemo(() => {
    const attached = new Set(
      (detail.data?.messages ?? [])
        .map((message) => message.run_id)
        .filter((value): value is string => !!value),
    );
    return (detail.data?.actions ?? []).filter(
      (action) => !attached.has(action.run_id),
    );
  }, [detail.data?.actions, detail.data?.messages]);
  const disabled = !enabled || running || send.isPending || !conversationId;

  const uploadImage = async (file: File) => {
    if (!conversationId || pendingImages.length >= 4) return;
    const form = new FormData();
    form.append("file", file);
    const result = await api<AgentImage>(
      `/agent/conversations/${conversationId}/images`,
      "POST",
      form,
    );
    setPendingImages((prev) => [...prev, result]);
    void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void uploadImage(file);
    event.target.value = "";
  };

  const handlePaste = (event: React.ClipboardEvent) => {
    if (!imagesEnabled) return;
    const file = Array.from(event.clipboardData.items).find(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (file) {
      const image = file.getAsFile();
      if (image) {
        event.preventDefault();
        void uploadImage(image);
      }
    }
  };

  const removeImage = (id: string) => {
    setPendingImages((prev) => prev.filter((img) => img.id !== id));
  };

  return (
    <div className={compact ? "agent-panel compact" : "agent-panel"}>
      <div className="agent-toolbar">
        <Select
          size="small"
          value={conversationId || undefined}
          placeholder="选择会话"
          style={{ flex: 1 }}
          options={(conversations.data ?? []).map((item) => ({
            value: item.id,
            label: item.title,
          }))}
          onChange={select}
        />
        <Button size="small" onClick={() => create.mutate()} loading={create.isPending}>
          新对话
        </Button>
      </div>
      {capabilities.data && !enabled && (
        <Alert
          type="warning"
          showIcon
          message="Agent 暂不可用"
          description="服务端尚未配置模型或未启用工具调用。请管理员在 .env 中设置 SA_LLM_* 并开启 SA_LLM_SUPPORTS_TOOLS。"
        />
      )}
      {capabilities.data && enabled && !capabilities.data.worker_online && (
        <Alert
          type="info"
          showIcon
          message="Agent 后台暂未在线，消息会排队等待处理。"
        />
      )}
      {create.error && (
        <Alert type="error" showIcon message={errorText(create.error)} />
      )}
      {detail.error && (
        <Alert type="error" showIcon message={errorText(detail.error)} />
      )}
      {!conversationId && !create.isPending && (
        <div className="agent-consent">
          <Typography.Paragraph>
            Agent
            会把你发送的内容、相关任务与日历摘要发送给配置的模型服务商，用于理解和生成操作。
            普通任务会直接创建，可在结果卡片修改或撤销；其他写操作需要逐条确认。
          </Typography.Paragraph>
          <Button type="primary" onClick={() => create.mutate()} loading={create.isPending}>
            同意并开始
          </Button>
        </div>
      )}
      {conversationId && (
        <div className="agent-messages">
          {detail.isPending && <Spin />}
          {detail.data?.messages.map((message) => {
            const actions = message.run_id
              ? (actionsByRun.get(message.run_id) ?? [])
              : [];
            return (
              <div key={message.id} className={`agent-message ${message.role}`}>
                <div className="agent-bubble">{message.content}</div>
                {message.images && message.images.length > 0 && (
                  <div className="agent-message-images">
                    {message.images.map((img) => (
                      <img
                        key={img.id}
                        src={`/api/v1/agent/images/${img.id}`}
                        alt={img.media_type}
                        className="agent-message-image"
                      />
                    ))}
                  </div>
                )}
                {actions.length > 0 && (
                  <div className="agent-actions">
                    {actions.map((action) => (
                      <ActionCard
                        key={action.id}
                        action={action}
                        siblings={detail.data?.actions ?? []}
                        busy={busyAction === action.id}
                        onConfirm={(id) => confirm.mutate(id)}
                        onReject={(id) => reject.mutate(id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {orphanActions.length > 0 && (
            <div className="agent-actions">
              {orphanActions.map((action) => (
                <ActionCard
                  key={action.id}
                  action={action}
                  siblings={detail.data?.actions ?? []}
                  busy={busyAction === action.id}
                  onConfirm={(id) => confirm.mutate(id)}
                  onReject={(id) => reject.mutate(id)}
                />
              ))}
            </div>
          )}
          {running && (
            <>
              {streamText && (
                <div className="agent-message assistant">
                  <div className="agent-bubble">{streamText}</div>
                </div>
              )}
              <div className="agent-thinking">
                <Spin size="small" /> {streamPhase || "正在理解并准备操作…"}
              </div>
            </>
          )}
          {latest?.status === "failed" && latest.error && (
            <Alert type="error" showIcon message={latest.error} />
          )}
          {confirm.error && (
            <Alert type="error" showIcon message={errorText(confirm.error)} />
          )}
          {reject.error && (
            <Alert type="error" showIcon message={errorText(reject.error)} />
          )}
          {send.error && (
            <Alert type="error" showIcon message={errorText(send.error)} />
          )}
          <div ref={bottom} />
        </div>
      )}
      {conversationId && (
        <div className="agent-compose">
          {imagesEnabled && pendingImages.length > 0 && (
            <div className="agent-image-thumbs">
              {pendingImages.map((img) => (
                <div key={img.id} className="agent-image-thumb">
                  <img
                    src={`/api/v1/agent/images/${img.id}`}
                    alt={img.media_type}
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<CloseOutlined />}
                    onClick={() => removeImage(img.id)}
                    className="agent-image-remove"
                  />
                </div>
              ))}
            </div>
          )}
          <div className="agent-compose-row">
            {imagesEnabled && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: "none" }}
                  onChange={handleFileSelect}
                />
                <Button
                  size="small"
                  icon={<PaperClipOutlined />}
                  disabled={disabled || pendingImages.length >= 4}
                  onClick={() => fileInput.current?.click()}
                  title="添加图片（最多 4 张）"
                />
              </>
            )}
            <Input.TextArea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="例如：把明天的复习任务改到周五，并提醒我前先检查依赖"
              autoSize={{ minRows: 2, maxRows: 5 }}
              disabled={disabled}
              onPaste={handlePaste}
              onPressEnter={(event) => {
                if (!event.shiftKey) {
                  event.preventDefault();
                  if (draft.trim() && !disabled) send.mutate(draft.trim());
                }
              }}
            />
            <Button
              type="primary"
              loading={send.isPending}
              disabled={disabled || !draft.trim()}
              onClick={() => draft.trim() && send.mutate(draft.trim())}
            >
              发送
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
