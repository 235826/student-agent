import { useMutation } from "@tanstack/react-query";
import { Alert, Button, Card, Form, Input } from "antd";
import { api, type Auth } from "../api";
const errorText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
export default function Login({
  initialized,
  onDone,
}: {
  initialized: boolean;
  onDone: (auth: Auth) => void;
}) {
  const mutation = useMutation({
    mutationFn: (values: { username: string; password: string }) =>
      api<Auth>(
        initialized ? "/auth/login" : "/auth/setup",
        "POST",
        initialized
          ? values
          : {
              ...values,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
      ),
    onSuccess: onDone,
  });
  return (
    <main className="login">
      <div className="brand">STUDENT AGENT</div>
      <h1>
        让每一天，
        <br />
        更有安排。
      </h1>
      <p className="muted">从一个任务开始，逐步找到适合自己的节奏。</p>
      <Card title={initialized ? "欢迎回来" : "创建你的个人账号"}>
        {mutation.error && (
          <Alert type="error" message={errorText(mutation.error)} showIcon />
        )}
        <Form layout="vertical" onFinish={(values) => mutation.mutate(values)}>
          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, max: 64 }]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[
              {
                required: true,
                min: 10,
                max: 128,
                message: "密码需为 10–128 个字符",
              },
            ]}
          >
            <Input.Password
              autoComplete={initialized ? "current-password" : "new-password"}
            />
          </Form.Item>
          <Button
            block
            type="primary"
            htmlType="submit"
            loading={mutation.isPending}
          >
            {initialized ? "登录" : "创建账号并进入"}
          </Button>
        </Form>
      </Card>
    </main>
  );
}
