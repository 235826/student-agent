import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button, Modal, Space, Steps } from "antd";
import { api, type Event, type TaskSummary } from "../api";

const steps = [
  {
    title: "记下第一个任务",
    description: "写标题即可保存；截止时间、优先级和标签都可以之后补。",
    action: "/tasks/new",
    actionLabel: "新建任务",
  },
  {
    title: "导入课表和作业",
    description: "粘贴文本或上传课表图片，校对后再写入日历和任务。",
    action: "/inbox/imports",
    actionLabel: "去导入",
  },
  {
    title: "设置可用时间",
    description: "设置每周可以投入学习的时段，需要安排时再生成计划。",
    action: "/settings/schedule",
    actionLabel: "去设置",
  },
];

export default function OnboardingWizard() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(0);
  const summary = useQuery({
    queryKey: ["tasks", "summary"],
    queryFn: () => api<TaskSummary>("/tasks/summary"),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Event[]>("/events"),
  });
  const empty =
    summary.data &&
    summary.data.active === 0 &&
    summary.data.trashed === 0 &&
    (events.data?.length ?? 0) === 0;
  useEffect(() => {
    if (localStorage.getItem("onboarding_done") || !empty) return;
    setOpen(true);
  }, [empty]);
  useEffect(() => {
    const openWizard = () => {
      setCurrent(0);
      setOpen(true);
    };
    window.addEventListener("onboarding:open", openWizard);
    return () => window.removeEventListener("onboarding:open", openWizard);
  }, []);
  const close = () => {
    localStorage.setItem("onboarding_done", "1");
    setOpen(false);
  };
  const step = steps[current];
  return (
    <Modal
      open={open}
      title="开始使用 Student Agent"
      width={640}
      onCancel={close}
      footer={
        <Space>
          <Button type="text" onClick={close}>
            跳过
          </Button>
          {current > 0 && (
            <Button onClick={() => setCurrent((value) => value - 1)}>
              上一步
            </Button>
          )}
          <Button
            onClick={() => {
              close();
              navigate(step.action);
            }}
          >
            {step.actionLabel}
          </Button>
          {current < steps.length - 1 ? (
            <Button
              type="primary"
              onClick={() => setCurrent((value) => value + 1)}
            >
              下一步
            </Button>
          ) : (
            <Button type="primary" onClick={close}>
              开始使用
            </Button>
          )}
        </Space>
      }
    >
      <Steps
        current={current}
        size="small"
        items={steps.map((item) => ({ title: item.title }))}
      />
      <section className="onboarding-step">
        <h3>{step.title}</h3>
        <p className="muted">{step.description}</p>
      </section>
    </Modal>
  );
}
