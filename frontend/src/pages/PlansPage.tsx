import { Link, useParams, useNavigate } from "react-router-dom";
import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Spin,
} from "antd";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import luxonPlugin from "@fullcalendar/luxon3";
import zhLocale from "@fullcalendar/core/locales/zh-cn";
import { DateTime } from "luxon";
import { api } from "../api";
import type { Plan, Profile, Event } from "../api";
import { displayTime, toInstant } from "../time";

export default function PlansPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const { id: selected } = useParams();
  const navigate = useNavigate();
  const setSelected = (id: string) => navigate(`/plans/${id}`);
  const request = useRef<{ payload: string; key: string } | null>(null);
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => api<Plan[]>("/plans"),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const active = selected
    ? plans.data?.find((p) => p.id === selected)
    : plans.data?.[0];
  const generate = useMutation({
    mutationFn: (body: unknown) => api<Plan>("/plans", "POST", body),
    onSuccess: (plan) => {
      setSelected(plan.id);
      request.current = null;
      void client.invalidateQueries({ queryKey: ["plans"] });
    },
    onError: (e) => void message.error(e.message),
  });
  const adopt = useMutation({
    mutationFn: (id: string) =>
      api<Plan>(`/plans/${id}/adopt`, "POST", { confirmed: true }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["plans"] });
      void message.success("已采用计划");
    },
    onError: (e) => {
      void message.error(e.message);
      void client.invalidateQueries({ queryKey: ["plans"] });
    },
  });
  const tomorrow = DateTime.now()
    .setZone(profile.timezone)
    .plus({ days: 1 })
    .startOf("day");
  const missing = active?.reports.some(
    (r) => r.unscheduled_minutes === null || r.unscheduled_minutes > 0,
  );
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">MAKE A PLAN</div>
          <h1>学习计划</h1>
          <p className="muted">
            先预览，再确认采用。当前时区：{profile.timezone}
          </p>
        </div>
      </header>
      <Alert
        type="info"
        message="采用新计划将替换整个当前计划，旧版本保留。未完成任务按完整预计用时安排；实际耗时扣减将在后续阶段加入。"
      />
      {!profile.available_windows?.length && (
        <Alert
          type="warning"
          message="尚未设置可用时间，请先到设置页添加每周可用时段。"
        />
      )}
      {!selected && (
        <Card className="toolbar" title="生成计划草稿">
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              start_at: tomorrow.toFormat("yyyy-MM-dd'T'HH:mm"),
              end_at: tomorrow.plus({ days: 7 }).toFormat("yyyy-MM-dd'T'HH:mm"),
              min_block_minutes: 25,
              max_block_minutes: 90,
            }}
            onFinish={(values) => {
              try {
                const body = {
                  ...values,
                  start_at: toInstant(values.start_at, profile.timezone),
                  end_at: toInstant(values.end_at, profile.timezone),
                };
                const payload = JSON.stringify(body);
                if (request.current?.payload !== payload)
                  request.current = { payload, key: crypto.randomUUID() };
                generate.mutate({
                  ...body,
                  idempotency_key: request.current.key,
                });
              } catch (e) {
                void message.error(e instanceof Error ? e.message : "时间无效");
              }
            }}
          >
            <div className="form-grid">
              <Form.Item
                name="start_at"
                label="排程开始"
                rules={[{ required: true }]}
              >
                <Input type="datetime-local" />
              </Form.Item>
              <Form.Item
                name="end_at"
                label="排程结束"
                rules={[{ required: true }]}
              >
                <Input type="datetime-local" />
              </Form.Item>
            </div>
            <div className="form-grid">
              <Form.Item
                name="min_block_minutes"
                label="最小工作块（分钟）"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={90} />
              </Form.Item>
              <Form.Item
                name="max_block_minutes"
                label="最大工作块（分钟）"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={180} />
              </Form.Item>
            </div>
            <Button
              type="primary"
              htmlType="submit"
              loading={generate.isPending}
            >
              生成草稿
            </Button>
            <p className="muted">
              最多安排未来 31
              天范围内的任务；最后一个工作块可短于最小值。休息窗口不会安排任务。
            </p>
          </Form>
        </Card>
      )}
      {plans.error && <Alert type="error" message={plans.error.message} />}
      {events.error && <Alert type="error" message={events.error.message} />}
      {plans.isPending ? (
        <Spin />
      ) : !selected ? (
        <div className="cards">
          {!plans.data?.length && !plans.error && (
            <Empty description="还没有计划，先生成一份草稿" />
          )}
          {plans.data?.map((p) => (
            <Card
              key={p.id}
              title={
                p.status === "adopted"
                  ? "当前计划"
                  : p.status === "draft"
                    ? "计划草稿"
                    : "历史计划"
              }
            >
              <p>{displayTime(p.created_at, profile.timezone)}</p>
              <p>
                {p.blocks.length} 个工作块{" "}
                {p.stale && <Tag color="orange">依据已变化</Tag>}
              </p>
              <Link to={`/plans/${p.id}`}>查看计划详情</Link>
            </Card>
          ))}
        </div>
      ) : !active ? (
        <Empty description="计划不存在" />
      ) : (
        <>
          <Card className="toolbar">
            <Select
              className="activity-select"
              aria-label="计划版本"
              value={active.id}
              options={plans.data?.map((p, i) => ({
                value: p.id,
                label: `${plans.data.length - i} · ${displayTime(p.created_at, profile.timezone)} · ${p.status === "adopted" ? "当前计划" : p.status === "draft" ? "草稿" : "历史计划"}`,
              }))}
              onChange={setSelected}
            />
            <Space wrap>
              <Tag>
                {active.status === "adopted"
                  ? "当前计划"
                  : active.status === "draft"
                    ? "待确认草稿"
                    : "历史计划"}
              </Tag>
              <span>
                新增 {active.differences.added} 块 · 移除{" "}
                {active.differences.removed} 块 · 保留{" "}
                {active.differences.unchanged} 块
              </span>
            </Space>
            <p className="muted">
              调整时间的工作块计为移除旧块并新增新块。范围：
              {displayTime(active.start_at, profile.timezone)} —{" "}
              {displayTime(active.end_at, profile.timezone)}
            </p>
            <Collapse
              items={[
                {
                  key: "changes",
                  label: "查看工作块变更明细",
                  children: (
                    <>
                      {active.differences.added_blocks.map((b, i) => (
                        <p key={`add-${i}`}>
                          <Tag color="green">新增</Tag>
                          {b.title} ·{" "}
                          {displayTime(b.start_at, profile.timezone)} —{" "}
                          {displayTime(b.end_at, profile.timezone)}
                        </p>
                      ))}
                      {active.differences.removed_blocks.map((b, i) => (
                        <p key={`remove-${i}`}>
                          <Tag color="red">移除</Tag>
                          {b.title} ·{" "}
                          {displayTime(b.start_at, profile.timezone)} —{" "}
                          {displayTime(b.end_at, profile.timezone)}
                        </p>
                      ))}
                      {!active.differences.added &&
                        !active.differences.removed && (
                          <p>工作块时间与当前计划一致。</p>
                        )}
                    </>
                  ),
                },
              ]}
            />
            {active.stale && (
              <Alert
                type="warning"
                message="任务、课表、规则或当前计划已变化，或草稿时间已过期；请重新生成，历史计划仍保留。"
                action={<Link to="/plans">重新生成</Link>}
              />
            )}
            {missing && (
              <Alert
                type="warning"
                message="部分任务尚未完整安排，请查看下方未排工时与原因。"
                action={
                  <Button
                    onClick={() =>
                      document
                        .getElementById("reports")
                        ?.scrollIntoView({ behavior: "smooth" })
                    }
                  >
                    查看未排任务
                  </Button>
                }
              />
            )}
            {active.status === "draft" && (
              <Button
                type="primary"
                disabled={active.stale}
                loading={adopt.isPending}
                onClick={() =>
                  modal.confirm({
                    title: "确认采用这份计划？",
                    content: missing
                      ? "部分任务仍有未排工时或缺少估时。采用后将替换整个当前计划，旧版本保留。"
                      : "采用后将替换整个当前计划，旧版本保留。",
                    onOk: () =>
                      adopt.mutateAsync(active.id).then(() => undefined),
                  })
                }
              >
                确认采用
              </Button>
            )}
          </Card>
          <Card className="calendar">
            <FullCalendar
              key={active.id}
              plugins={[timeGridPlugin, listPlugin, luxonPlugin]}
              locale={zhLocale}
              timeZone={profile.timezone}
              initialDate={active.start_at}
              initialView={
                window.innerWidth < 700 ? "listWeek" : "timeGridWeek"
              }
              height="auto"
              allDaySlot={false}
              headerToolbar={{
                left: "prev,next",
                center: "title",
                right: "timeGridWeek,listWeek",
              }}
              events={[
                ...(events.data ?? []).map((e) => ({
                  title: e.title + (e.is_skipped ? "（不参加）" : ""),
                  start: e.start_at,
                  end: e.end_at,
                  color: e.is_skipped ? "#999" : "#37735c",
                })),
                ...active.blocks.map((b) => ({
                  title: b.title,
                  start: b.start_at,
                  end: b.end_at,
                  color: active.status === "draft" ? "#82649c" : "#3873ac",
                })),
              ]}
            />
          </Card>
          <div id="reports" className="cards toolbar">
            {active.reports.map((r) => (
              <Card key={r.task_id}>
                <h3>
                  <Link to={`/tasks/${r.task_id}`}>{r.title}</Link>
                </h3>
                <p>
                  已排 {r.scheduled_minutes} 分钟 ·{" "}
                  {r.unscheduled_minutes === null
                    ? "缺少估时"
                    : `未排 ${r.unscheduled_minutes} 分钟`}
                </p>
                <p className="muted">{r.reason}</p>
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
