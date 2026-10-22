import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Button, Card, Form, Input, Select } from "antd";
import { api, type Profile, type ProfileInput } from "../api";
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
export default function SettingsPage({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const { message } = AntApp.useApp();
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
          <div className="eyebrow">YOUR OWN RHYTHM</div>
          <h1>按自己的节奏</h1>
          <p className="muted">可以先使用默认设置，之后随时调整。</p>
        </div>
      </header>
      <p>
        <Link to="/settings/rules">并行规则</Link>
      </p>
      <Card className="settings">
        <Form
          form={form}
          layout="vertical"
          initialValues={profile}
          onFinish={(values) => save.mutate(values)}
        >
          <Form.Item
            name="timezone"
            label="显示时区（IANA）"
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
            更改时区只改变显示方式，已有事件对应的真实时间保持不变。
          </p>
          {(["available_windows", "rest_windows"] as const).map((field) => (
            <section key={field}>
              <h3>
                {field === "available_windows"
                  ? "每周可用时间"
                  : "通常休息时段"}
              </h3>
              <p className="muted">
                可留空；跨午夜的窗口请拆为两天。星期一为一周起点。
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
