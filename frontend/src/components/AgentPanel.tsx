import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Select, Spin, Tag, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AgentAction,
  type AgentCapabilities,
  type AgentConversation,
  type AgentConversationDetail,
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
};

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
      <details className="agent-action-payload">
        <summary>查看操作参数</summary>
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
  const [conversationId, setConversationId] = useState<string>(
    () => localStorage.getItem("agent:conversation") ?? "",
  );
  const [draft, setDraft] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const bottom = useRef<HTMLDivElement | null>(null);

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
    setConversationId(id);
    localStorage.setItem("agent:conversation", id);
  };

  useEffect(() => {
    if (!conversationId && conversations.data?.length) {
      select(conversations.data[0].id);
    }
  }, [conversationId, conversations.data]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail.data?.messages.length, detail.data?.actions.length]);

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
      api<{ run_id: string }>(
        `/agent/conversations/${conversationId}/messages`,
        "POST",
        { content, idempotency_key: crypto.randomUUID() },
      ),
    onSuccess: () => {
      setDraft("");
      void client.invalidateQueries({ queryKey: ["agent-conversations"] });
      void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
    },
  });

  const confirm = useMutation({
    mutationFn: (id: string) =>
      api<AgentAction>(`/agent/actions/${id}/confirm`, "POST", {}),
    onMutate: (id) => setBusyAction(id),
    onSettled: () => setBusyAction(""),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["agent-conversation", conversationId] });
      void client.invalidateQueries();
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
  });

  const enabled = capabilities.data?.configured && capabilities.data?.tools;
  const latest = detail.data?.latest_run;
  const running = latest?.status === "queued" || latest?.status === "running";
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
      {create.error && <Alert type="error" showIcon message={errorText(create.error)} />}
      {detail.error && <Alert type="error" showIcon message={errorText(detail.error)} />}
      {!conversationId && !create.isPending && (
        <div className="agent-consent">
          <Typography.Paragraph>
            Agent 会把你发送的内容、相关任务与日历摘要发送给配置的模型服务商，用于理解和生成操作。
            写操作不会自动执行，你需要在下面逐条确认。
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
            const actions = message.run_id ? actionsByRun.get(message.run_id) ?? [] : [];
            return (
              <div key={message.id} className={`agent-message ${message.role}`}>
                <div className="agent-bubble">{message.content}</div>
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
            <div className="agent-thinking">
              <Spin size="small" /> 正在理解并准备操作…
            </div>
          )}
          {latest?.status === "failed" && latest.error && (
            <Alert type="error" showIcon message={latest.error} />
          )}
          {confirm.error && <Alert type="error" showIcon message={errorText(confirm.error)} />}
          {reject.error && <Alert type="error" showIcon message={errorText(reject.error)} />}
          {send.error && <Alert type="error" showIcon message={errorText(send.error)} />}
          <div ref={bottom} />
        </div>
      )}
      {conversationId && (
        <div className="agent-compose">
          <Input.TextArea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="例如：把明天的复习任务改到周五，并提醒我前先检查依赖"
            autoSize={{ minRows: 2, maxRows: 5 }}
            disabled={disabled}
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
      )}
    </div>
  );
}
