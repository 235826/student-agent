import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Button, Card, Form, Input, Select, Space } from "antd";
import { api, type Profile, type ProfileInput } from "../api";
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
export default function SettingsPage({
  profile,
  onLogout,
  loggingOut,
}: {
  profile: Profile;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  const client = useQueryClient();
  const location = useLocation();
  const { message } = AntApp.useApp();
  useEffect(() => {
    if (!location.hash) return;
    document
      .getElementById(location.hash.slice(1))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [location.hash]);
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (body: ProfileInput) => api<Profile>("/profile", "PUT", body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["me"] });
      void message.success("设置已保存");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  return (
    <>
      <header>
        <div>
          <h1>设置</h1>
          <p className="muted">基础设置保持简单；高级规则按需展开。</p>
        </div>
      </header>
      <Space wrap className="toolbar">
        <Link to="/settings/event-types">事件类型</Link>
        <Link to="/settings/rules">并行规则</Link>
      </Space>
      <Card title="账号" className="toolbar">
        <p>{profile.username}</p>
        <Button onClick={onLogout} loading={loggingOut}>
          退出账号
        </Button>
      </Card>
      <Card className="settings" id="availability">
        <Form
          form={form}
          layout="vertical"
          initialValues={profile}
          onFinish={(values) => save.mutate(values)}
        >
          <Form.Item
            name="timezone"
            label="显示与排程时区（IANA）"
            rules={[{ required: true }]}
          >
            <Input placeholder="Asia/Shanghai" />
          </Form.Item>
          <Button
            className="toolbar"
            onClick={() =>
              form.setFieldValue(
                "timezone",
                Intl.DateTimeFormat().resolvedOptions().timeZone,
              )
            }
          >
            使用浏览器时区
          </Button>
          <p className="muted">
            用于显示时间、新建任务和事件的本地时间，以及解释每周可用时间。更改后已有事件对应的真实时间不变，但之后生成的计划会按新时区解释每周窗口。
          </p>
          {(["available_windows", "rest_windows"] as const).map((field) => (
            <section key={field}>
              <h3>
                {field === "available_windows"
                  ? "每周可用时间"
                  : "休息时段（不排任务）"}
              </h3>
              <p className="muted">
                {field === "available_windows"
                  ? "可留空；跨午夜的窗口请拆为两天。星期一为一周起点。"
                  : "这些时段始终不会安排任务；跨午夜的窗口请拆为两天。"}
              </p>
              <Form.List name={field}>
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(({ key, name, ...rest }) => (
                      <div className="window-row" key={key}>
                        <Form.Item
                          {...rest}
                          name={[name, "weekday"]}
                          rules={[{ required: true }]}
                        >
                          <Select
                            aria-label="星期"
                            options={[
                              "一",
                              "二",
                              "三",
                              "四",
                              "五",
                              "六",
                              "日",
                            ].map((v, i) => ({ value: i, label: `周${v}` }))}
                          />
                        </Form.Item>
                        <Form.Item
                          {...rest}
                          name={[name, "start"]}
                          rules={[{ required: true }]}
                        >
                          <Input aria-label="窗口开始" type="time" />
                        </Form.Item>
                        <Form.Item
                          {...rest}
                          name={[name, "end"]}
                          rules={[{ required: true }]}
                        >
                          <Input aria-label="窗口结束" type="time" />
                        </Form.Item>
                        <Button onClick={() => remove(name)}>移除</Button>
                      </div>
                    ))}
                    <Button
                      onClick={() =>
                        add({ weekday: 0, start: "09:00", end: "17:00" })
                      }
                    >
                      添加时段
                    </Button>
                  </>
                )}
              </Form.List>
            </section>
          ))}
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            保存设置
          </Button>
        </Form>
      </Card>
    </>
  );
}
