import { useState } from "react";
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
  const [registering, setRegistering] = useState(false);
  const endpoint = !initialized
    ? "/auth/setup"
    : registering
      ? "/auth/register"
      : "/auth/login";
  const mutation = useMutation({
    mutationFn: (values: { username: string; password: string }) =>
      api<Auth>(
        endpoint,
        "POST",
        initialized && !registering
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
      <Card
        title={
          !initialized
            ? "创建你的个人账号"
            : registering
              ? "创建新账号"
              : "欢迎回来"
        }
      >
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
              autoComplete={
                initialized && !registering
                  ? "current-password"
                  : "new-password"
              }
            />
          </Form.Item>
          <Button
            block
            type="primary"
            htmlType="submit"
            loading={mutation.isPending}
          >
            {!initialized
              ? "创建账号并进入"
              : registering
                ? "创建账号并进入"
                : "登录"}
          </Button>
        </Form>
        {initialized && (
          <Button
            type="link"
            block
            className="toolbar"
            onClick={() => {
              mutation.reset();
              setRegistering(!registering);
            }}
          >
            {registering ? "已有账号？返回登录" : "创建新账号"}
          </Button>
        )}
      </Card>
    </main>
  );
}
