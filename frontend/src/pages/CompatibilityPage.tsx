import { Link, useSearchParams } from "react-router-dom";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Tabs,
  Spin,
} from "antd";
import { api } from "../api";
import type {
  Compatibility,
  Course,
  Event,
  Profile,
  Rule,
  RuleInput,
  Selector,
  Task,
  TypePolicy,
} from "../api";
import { displayTime } from "../time";
const scopes = [
  { value: "course", label: "课程" },
  { value: "event", label: "单次事件" },
  { value: "task", label: "具体任务" },
  { value: "task_type", label: "任务类型" },
  { value: "all", label: "所有活动" },
];
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
export default function CompatibilityPage({ profile }: { profile: Profile }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "types";
  const setTab = (value: string) => setParams({ tab: value });
  const [includePast, setIncludePast] = useState(false);
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const tasks = useQuery({
    queryKey: ["tasks", false],
    queryFn: () => api<Task[]>("/tasks"),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const courses = useQuery({
    queryKey: ["courses"],
    queryFn: () => api<Course[]>("/courses"),
  });
  const types = useQuery({
    queryKey: ["type-policies"],
    queryFn: () => api<TypePolicy[]>("/task-type-policies"),
  });
  const rules = useQuery({
    queryKey: ["rules"],
    queryFn: () => api<Rule[]>("/compatibility-rules"),
  });
  const [editing, setEditing] = useState<Rule | null | undefined>(undefined);
  const [selected, setSelected] = useState<string[]>([]);
  const [form] = Form.useForm();
  const [typeForm] = Form.useForm();
  const decision = Form.useWatch("decision", form);
  const leftScope = Form.useWatch(["left", "scope"], form);
  const rightScope = Form.useWatch(["right", "scope"], form);
  const write = useMutation({
    mutationFn: ({
      path,
      method = "POST",
      body,
    }: {
      path: string;
      method?: string;
      body?: unknown;
    }) => api(path, method, body),
    onSuccess: (_, variables) => {
      void client.invalidateQueries({ queryKey: ["rules"] });
      void client.invalidateQueries({ queryKey: ["type-policies"] });
      void client.invalidateQueries({ queryKey: ["courses"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      if (variables.path.includes("compatibility-rules")) setTab("rules");
      setEditing(undefined);
      check.reset();
      void message.success("规则设置已保存");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const check = useMutation({
    mutationFn: () =>
      api<Compatibility>("/compatibility/check", "POST", {
        activities: selected.map((value) => {
          const [kind, id] = value.split(":");
          return { kind, id };
        }),
      }),
  });
  const options = (scope: string) =>
    scope === "course"
      ? (courses.data ?? []).map((c) => ({ value: c.id, label: c.name }))
      : scope === "task"
        ? (tasks.data ?? []).map((t) => ({ value: t.id, label: t.title }))
        : (events.data ?? []).map((e) => ({
            value: e.id,
            label: `${e.title} · ${displayTime(e.start_at, profile.timezone)}`,
          }));
  const label = (selector: Selector) =>
    selector.scope === "all"
      ? "所有活动"
      : selector.scope === "task_type"
        ? `类型：${selector.key}`
        : (options(selector.scope).find((o) => o.value === selector.key)
            ?.label ?? "已不可用的活动");
  const activityLabel = (kind: "task" | "event", id: string) =>
    label({ scope: kind, key: id });
  const open = (rule: Rule | null) => {
    form.resetFields();
    form.setFieldsValue(
      rule
        ? {
            left: rule.left,
            right: rule.right,
            decision: rule.decision,
            override_conflicts: false,
          }
        : {
            left: { scope: "course" },
            right: { scope: "task_type" },
            decision: "allow",
            override_conflicts: false,
          },
    );
    setEditing(rule);
  };
  const activityOptions = [
    ...(tasks.data ?? [])
      .filter((t) => !["done", "cancelled"].includes(t.status))
      .map((t) => ({ value: `task:${t.id}`, label: `任务：${t.title}` })),
    ...(events.data ?? [])
      .filter(
        (e) =>
          !e.is_skipped &&
          (includePast || new Date(e.end_at).getTime() > Date.now()),
      )
      .map((e) => ({
        value: `event:${e.id}`,
        label: `事件：${e.title} · ${displayTime(e.start_at, profile.timezone)}${e.is_skipped ? "（不参加）" : ""}`,
      })),
  ];
  const queryError =
    tasks.error ?? events.error ?? courses.error ?? types.error ?? rules.error;
  const canOverride =
    decision === "allow" &&
    ["event", "task"].includes(leftScope) &&
    ["event", "task"].includes(rightScope);
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">YOUR RULES</div>
          <h1>并行规则</h1>
          <p className="muted">决定哪些活动可以同时进行，每个判断都有依据。</p>
        </div>
        <Button type="primary" onClick={() => open(null)}>
          添加组合允许规则
        </Button>
      </header>
      <Alert
        type="info"
        message="默认禁止重叠。通常需要双方均接受并行，再设置组合允许规则。此处配置与检查并行规则，生成计划请到学习计划。"
      />
      {queryError && <Alert type="error" message={errorText(queryError)} />}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "types", label: "任务类型偏好" },
          { key: "courses", label: "课程默认设置" },
          { key: "rules", label: "组合允许规则" },
          { key: "check", label: "兼容性检查" },
        ]}
      />
      {queryError ? null : [tasks, events, courses, types, rules].some(
          (q) => q.isPending,
        ) ? (
        <Spin />
      ) : (
        <>
          {tab === "types" && (
            <Card title="任务类型偏好" className="toolbar">
              <Form
                form={typeForm}
                layout="vertical"
                initialValues={{ parallel_policy: "none" }}
                onFinish={(values) =>
                  write.mutate({
                    path: "/task-type-policies",
                    method: "PUT",
                    body: values,
                  })
                }
              >
                <div className="form-grid">
                  <Form.Item
                    name="task_type"
                    label="任务类型"
                    rules={[{ required: true, whitespace: true, max: 100 }]}
                  >
                    <Input placeholder="例如 reading" />
                  </Form.Item>
                  <Form.Item name="parallel_policy" label="类型默认设置">
                    <Select
                      options={[
                        { value: "none", label: "禁止并行" },
                        { value: "allow_selected", label: "接受已允许的组合" },
                      ]}
                    />
                  </Form.Item>
                </div>
                <Button htmlType="submit" loading={write.isPending}>
                  保存类型设置
                </Button>
              </Form>
              <Space className="type-policies" wrap>
                {types.data?.map((t) => (
                  <Button
                    key={t.id}
                    onClick={() =>
                      typeForm.setFieldsValue({
                        task_type: t.task_type,
                        parallel_policy: t.parallel_policy,
                      })
                    }
                  >
                    {t.task_type}：
                    {t.parallel_policy === "none" ? "禁止" : "接受选定组合"}
                  </Button>
                ))}
              </Space>
              <p className="muted">
                具体任务的单项设置优先于类型偏好；单次覆盖在事件详情管理。
              </p>
            </Card>
          )}
          {tab === "courses" && (
            <Card title="课程默认设置">
              <p className="muted">
                应用于没有单次覆盖的课程实例；任务与课程都接受并行后，仍需组合允许规则。
              </p>
              {courses.data?.length ? (
                courses.data.map((course) => (
                  <div className="course-settings toolbar" key={course.id}>
                    <Link to={`/courses/${course.id}`}>{course.name}</Link>
                    <Select
                      className="activity-select"
                      aria-label={`${course.name}默认并行设置`}
                      value={course.parallel_policy}
                      options={[
                        { value: "none", label: "禁止并行" },
                        { value: "allow_selected", label: "接受已允许的组合" },
                      ]}
                      onChange={(parallel_policy) =>
                        write.mutate({
                          path: `/courses/${course.id}/parallel-policy`,
                          method: "PATCH",
                          body: { parallel_policy },
                        })
                      }
                    />
                  </div>
                ))
              ) : (
                <Empty description="尚未添加课程" />
              )}
            </Card>
          )}
          {tab === "rules" && (
            <div className="cards toolbar">
              {rules.data?.length ? (
                rules.data.map((rule) => (
                  <Card key={rule.id}>
                    <h3>
                      {label(rule.left)} ＋ {label(rule.right)}
                    </h3>
                    <Space wrap>
                      <Tag color={rule.decision === "allow" ? "green" : "red"}>
                        {rule.decision === "allow" ? "允许组合" : "禁止组合"}
                      </Tag>
                      <Tag>
                        {rule.status === "confirmed" ? "用户已确认" : "已停用"}
                      </Tag>
                      {rule.override_conflicts && (
                        <Tag color="orange">包含明确覆盖确认</Tag>
                      )}
                    </Space>
                    <p className="muted">
                      修改时间：{displayTime(rule.updated_at, profile.timezone)}
                    </p>
                    <Space>
                      <Button onClick={() => open(rule)}>编辑规则</Button>
                      {rule.status === "confirmed" && (
                        <Button
                          danger
                          disabled={write.isPending}
                          onClick={() =>
                            modal.confirm({
                              title: "停用组合规则？",
                              content:
                                "后续检查将不再使用此规则；历史记录保留。",
                              onOk: () =>
                                write.mutateAsync({
                                  path: `/compatibility-rules/${rule.id}`,
                                  method: "DELETE",
                                }),
                            })
                          }
                        >
                          停用规则
                        </Button>
                      )}
                    </Space>
                  </Card>
                ))
              ) : (
                <Card>
                  <Empty description="还没有组合规则" />
                </Card>
              )}
            </div>
          )}
          {tab === "check" && (
            <Card title="检查两项或多项活动能否同时进行">
              <Checkbox
                checked={includePast}
                onChange={(e) => {
                  setIncludePast(e.target.checked);
                  setSelected([]);
                  check.reset();
                }}
              >
                包含过去事件
              </Checkbox>
              <Select
                className="activity-select"
                aria-label="选择待检查活动"
                mode="multiple"
                maxCount={20}
                value={selected}
                options={activityOptions}
                optionFilterProp="label"
                onChange={(value) => {
                  setSelected(value);
                  check.reset();
                }}
                placeholder="选择至少两项活动"
              />
              <Button
                type="primary"
                disabled={selected.length < 2}
                loading={check.isPending}
                onClick={() => check.mutate()}
              >
                检查兼容性
              </Button>
              {check.error && (
                <Alert type="error" message={errorText(check.error)} />
              )}
              {check.data && (
                <div className="check-result">
                  <Alert
                    type={check.data.allowed ? "success" : "warning"}
                    message={
                      check.data.allowed
                        ? "所有两两组合均通过"
                        : "存在不允许同时进行的组合"
                    }
                  />
                  {check.data.pairs.map((pair, i) => (
                    <div key={i} className="pair-result">
                      <strong>
                        {activityLabel(pair.left.kind, pair.left.id)} ＋{" "}
                        {activityLabel(pair.right.kind, pair.right.id)}
                      </strong>
                      <p>
                        <Tag color={pair.allowed ? "green" : "red"}>
                          {pair.allowed ? "允许" : "不允许"}
                        </Tag>
                        {pair.reason}
                      </p>
                      <p className="muted">
                        {(pair.rule_ids ?? []).length
                          ? `依据 ${(pair.rule_ids ?? []).length} 条用户确认的组合规则及双方设置`
                          : "依据活动状态、依赖关系或默认禁止规则"}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </>
      )}
      <Modal
        title={editing ? "编辑组合允许规则" : "添加组合允许规则"}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        onOk={() => form.submit()}
        confirmLoading={write.isPending}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            const body: RuleInput = {
              ...values,
              override_conflicts: canOverride && !!values.override_conflicts,
            };
            write.mutate({
              path: editing
                ? `/compatibility-rules/${editing.id}`
                : "/compatibility-rules",
              method: editing ? "PUT" : "POST",
              body,
            });
          }}
        >
          {(["left", "right"] as const).map((side, index) => {
            const scope = side === "left" ? leftScope : rightScope;
            return (
              <div key={side}>
                <Form.Item
                  name={[side, "scope"]}
                  label={`活动${index === 0 ? "一" : "二"}范围`}
                  rules={[{ required: true }]}
                >
                  <Select
                    options={scopes}
                    onChange={(value) =>
                      form.setFieldValue(
                        [side, "key"],
                        value === "all" ? "*" : undefined,
                      )
                    }
                  />
                </Form.Item>
                <Form.Item
                  name={[side, "key"]}
                  label={`活动${index === 0 ? "一" : "二"}对象`}
                  rules={[{ required: true, whitespace: true }]}
                >
                  {scope === "all" ? (
                    <Input disabled />
                  ) : scope === "task_type" ? (
                    <Input placeholder="例如 reading" maxLength={100} />
                  ) : (
                    <Select
                      showSearch
                      optionFilterProp="label"
                      options={options(scope)}
                    />
                  )}
                </Form.Item>
              </div>
            );
          })}
          <Form.Item name="decision" label="组合决定">
            <Select
              options={[
                { value: "allow", label: "允许同时进行" },
                { value: "deny", label: "禁止同时进行" },
              ]}
            />
          </Form.Item>
          {canOverride && (
            <Form.Item name="override_conflicts" valuePropName="checked">
              <Checkbox>
                我明确允许本次具体组合覆盖当前较泛化的禁止设置
              </Checkbox>
            </Form.Item>
          )}
          <p className="muted">
            同级允许与禁止规则冲突时先禁止。明确覆盖只针对当前设置，后续新增或修改禁止设置需要重新确认。任务依赖不能通过并行规则绕过。
          </p>
        </Form>
      </Modal>
    </>
  );
}
