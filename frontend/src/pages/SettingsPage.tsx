import { Link, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
} from "antd";
import { DateTime } from "luxon";
import {
  api,
  type DataImportPreview,
  type Profile,
  type ProfileInput,
} from "../api";
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
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const save = useMutation({
    mutationFn: (body: ProfileInput) => api<Profile>("/profile", "PUT", body),
    onSuccess: () => {
      setDirty(false);
      void client.invalidateQueries({ queryKey: ["me"] });
      void message.success("设置已保存");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const [exporting, setExporting] = useState(false);
  const [importPreview, setImportPreview] = useState<DataImportPreview | null>(
    null,
  );
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionPassword, setDeletionPassword] = useState("");
  const [deletionConfirm, setDeletionConfirm] = useState("");
  const exportData = async () => {
    setExporting(true);
    try {
      const response = await fetch("/api/v1/data/export", {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("导出失败，请稍后重试");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^";]+)"?/);
      const name = match?.[1] ?? "student-agent-backup.json";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      void message.success("数据已导出");
    } catch (e) {
      void message.error(errorText(e));
    } finally {
      setExporting(false);
    }
  };
  const validateImport = async (file: File) => {
    setImporting(true);
    setImportPreview(null);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const preview = await api<DataImportPreview>(
        "/data/import/validate",
        "POST",
        payload,
      );
      setImportPreview(preview);
      void message.success("导入文件校验通过");
    } catch (e) {
      void message.error(
        e instanceof SyntaxError ? "文件不是有效的 JSON" : errorText(e),
      );
    } finally {
      setImporting(false);
      if (importInput.current) importInput.current.value = "";
    }
  };
  const requestDeletion = useMutation({
    mutationFn: () =>
      api("/account/deletion", "POST", {
        password: deletionPassword,
        confirmed: true,
      }),
    onSuccess: () => {
      setDeletionOpen(false);
      void message.success("注销申请已提交，账号进入 7 天冷静期");
      window.location.assign("/");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const cancelDeletion = useMutation({
    mutationFn: () => api("/account/deletion/cancel", "POST"),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["me"] });
      void message.success("已取消注销");
    },
    onError: (e) => void message.error(errorText(e)),
  });
  const windowsEditor = (field: "available_windows" | "rest_windows") => (
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
                  options={["一", "二", "三", "四", "五", "六", "日"].map(
                    (v, i) => ({ value: i, label: `周${v}` }),
                  )}
                />
              </Form.Item>
              <Form.Item
                {...rest}
                name={[name, "start"]}
                rules={[{ required: true }]}
              >
                <Input
                  className="native-datetime"
                  aria-label="窗口开始"
                  type="time"
                />
              </Form.Item>
              <Form.Item
                {...rest}
                name={[name, "end"]}
                rules={[{ required: true }]}
              >
                <Input
                  className="native-datetime"
                  aria-label="窗口结束"
                  type="time"
                />
              </Form.Item>
              <Button onClick={() => remove(name)}>移除</Button>
            </div>
          ))}
          <Button
            onClick={() => add({ weekday: 0, start: "09:00", end: "17:00" })}
          >
            添加时段
          </Button>
        </>
      )}
    </Form.List>
  );
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
      <nav className="settings-nav" aria-label="设置分区">
        <a href="#account">账号</a>
        <a href="#availability">时间与可用时段</a>
        <a href="#data">数据与隐私</a>
        <a href="#help">帮助</a>
      </nav>
      <section className="section toolbar" id="account">
        <h3>账号</h3>
        <p>{profile.username}</p>
        {profile.deletion_due_at && (
          <Alert
            type="warning"
            showIcon
            message={`账号将在 ${DateTime.fromISO(profile.deletion_due_at)
              .setZone(profile.timezone)
              .toFormat("yyyy年M月d日 HH:mm")} 删除`}
            description="冷静期内账号只读，可以导出数据或取消注销。"
            action={
              <Button
                size="small"
                loading={cancelDeletion.isPending}
                onClick={() => cancelDeletion.mutate()}
              >
                取消注销
              </Button>
            }
          />
        )}
        <Space wrap>
          <Button type="text" onClick={onLogout} loading={loggingOut}>
            退出账号
          </Button>
          {!profile.deletion_due_at && (
            <Button type="text" danger onClick={() => setDeletionOpen(true)}>
              删除账号
            </Button>
          )}
        </Space>
      </section>
      <section className="section settings" id="availability">
        <h3>时间与可用时段</h3>
        <Form
          form={form}
          layout="vertical"
          initialValues={profile}
          onValuesChange={() => setDirty(true)}
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
            type="text"
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
          <section>
            <h3>每周可用时间</h3>
            <p className="muted">
              可留空；跨午夜的窗口请拆为两天。星期一为一周起点。
            </p>
            {windowsEditor("available_windows")}
          </section>
          <details className="settings-advanced">
            <summary>休息时段（不排任务）</summary>
            <p className="muted">
              这些时段始终不会安排任务；跨午夜的窗口请拆为两天。
            </p>
            {windowsEditor("rest_windows")}
          </details>
          <div className="settings-save-bar">
            {dirty && <span className="dirty-hint">有未保存修改</span>}
            <Button type="primary" htmlType="submit" loading={save.isPending}>
              保存设置
            </Button>
          </div>
        </Form>
      </section>
      <section className="section settings" id="data">
        <h3>数据与隐私</h3>
        <p className="muted">
          导出任务、课程与事件、计划、工作记录、反馈、清单、标签、规则和偏好。备份不包含附件。
        </p>
        <Space wrap>
          <Button onClick={() => void exportData()} loading={exporting}>
            导出 JSON
          </Button>
          <Button
            onClick={() => importInput.current?.click()}
            loading={importing}
          >
            导入校验
          </Button>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void validateImport(file);
            }}
          />
        </Space>
        {importPreview && (
          <Alert
            type={importPreview.conflicts.length ? "warning" : "success"}
            showIcon
            message="导入文件校验通过"
            description={
              <div>
                <p>
                  {Object.entries(importPreview.counts)
                    .filter(([, count]) => count > 0)
                    .map(([name, count]) => `${name} ${count}`)
                    .join(" · ")}
                </p>
                {importPreview.conflicts.length > 0 && (
                  <p>与当前数据冲突：{importPreview.conflicts.join("；")}</p>
                )}
                {importPreview.warnings.length > 0 && (
                  <p>提示：{importPreview.warnings.slice(0, 5).join("；")}</p>
                )}
                <p className="muted">
                  P0 提供导出与导入校验；完整恢复流程将在 P1 提供。
                </p>
              </div>
            }
          />
        )}
        <p className="muted">
          删除账号后进入 7 天冷静期。到期后会删除业务数据、附件、导入来源和 Agent 对话；匿名审计保留 30 天。
        </p>
      </section>
      <section className="section settings" id="help">
        <h3>帮助</h3>
        <Button
          onClick={() => {
            localStorage.removeItem("onboarding_done");
            window.dispatchEvent(new Event("onboarding:open"));
          }}
        >
          重新查看新手引导
        </Button>
      </section>
      <Modal
        open={deletionOpen}
        title="删除账号"
        okText="确认注销"
        cancelText="取消"
        okButtonProps={{
          danger: true,
          disabled:
            deletionConfirm !== profile.username ||
            deletionPassword.length < 10,
        }}
        confirmLoading={requestDeletion.isPending}
        onCancel={() => setDeletionOpen(false)}
        onOk={() => requestDeletion.mutate()}
      >
        <Alert
          type="warning"
          showIcon
          message="账号将进入 7 天冷静期"
          description="冷静期内账号只读；重新登录可取消注销。到期后数据无法恢复。"
        />
        <Form layout="vertical">
          <Form.Item label="输入密码">
            <Input.Password
              value={deletionPassword}
              onChange={(event) => setDeletionPassword(event.target.value)}
            />
          </Form.Item>
          <Form.Item label={`输入用户名 ${profile.username} 确认`}>
            <Input
              value={deletionConfirm}
              onChange={(event) => setDeletionConfirm(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
