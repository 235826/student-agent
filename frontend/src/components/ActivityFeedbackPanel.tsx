import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Form,
  Input,
  Rate,
  Select,
  Space,
  Tag,
} from "antd";
import { api, type ActivityFeedback } from "../api";

const tagOptions = ["顺利", "一般", "分心", "疲劳", "效率下降", "较轻松"].map(
  (value) => ({ value, label: value }),
);

type Values = {
  rating: number;
  tags: string[];
  reflection: string;
};

export default function ActivityFeedbackPanel({ eventId }: { eventId: string }) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();
  const [editing, setEditing] = useState(false);
  const feedback = useQuery({
    queryKey: ["activity-feedback", eventId],
    queryFn: () =>
      api<ActivityFeedback | null>(`/events/${eventId}/feedback`),
  });
  useEffect(() => {
    if (feedback.data) {
      form.setFieldsValue({
        rating: feedback.data.rating,
        tags: feedback.data.tags,
        reflection: feedback.data.reflection,
      });
      setEditing(false);
    } else if (feedback.data === null) {
      form.resetFields();
      setEditing(true);
    }
  }, [feedback.data, form]);
  const save = useMutation({
    mutationFn: (values: Values) =>
      api<ActivityFeedback>(
        `/events/${eventId}/feedback`,
        feedback.data ? "PUT" : "POST",
        values,
      ),
    onSuccess: () => {
      setEditing(false);
      void client.invalidateQueries({
        queryKey: ["activity-feedback", eventId],
      });
      void message.success("活动反馈已保存");
    },
    onError: (e) => void message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/events/${eventId}/feedback`, "DELETE"),
    onSuccess: () => {
      form.resetFields();
      setEditing(true);
      void client.invalidateQueries({
        queryKey: ["activity-feedback", eventId],
      });
      void message.success("活动反馈已删除");
    },
    onError: (e) => void message.error(e.message),
  });
  return (
    <section className="activity-feedback">
      <div className="section-inline-heading">
        <h4>活动反馈</h4>
        {feedback.data && !editing && (
          <Button type="text" onClick={() => setEditing(true)}>
            修改
          </Button>
        )}
      </div>
      {feedback.isPending ? null : !editing && feedback.data ? (
        <div className="feedback-summary">
          <Space wrap>
            <Rate disabled value={feedback.data.rating} />
            {(feedback.data.tags ?? []).map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </Space>
          {feedback.data.reflection && <p>{feedback.data.reflection}</p>}
          <Button
            type="text"
            danger
            size="small"
            loading={remove.isPending}
            onClick={() => remove.mutate()}
          >
            删除反馈
          </Button>
        </div>
      ) : (
        <Form<Values>
          form={form}
          layout="vertical"
          initialValues={{ rating: 3, tags: [], reflection: "" }}
          onFinish={(values) => save.mutate(values)}
        >
          <Form.Item name="rating" label="整体感受" rules={[{ required: true }]}>
            <Rate />
          </Form.Item>
          <Form.Item name="tags" label="可选标签">
            <Select mode="tags" options={tagOptions} placeholder="选择或输入标签" />
          </Form.Item>
          <Form.Item name="reflection" label="自由文本">
            <Input.TextArea
              rows={3}
              maxLength={5000}
              placeholder="例如：在数据库课读论文容易分心，速度比平时慢"
            />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={save.isPending}>
              保存反馈
            </Button>
            {feedback.data && (
              <Button onClick={() => setEditing(false)}>取消</Button>
            )}
          </Space>
        </Form>
      )}
    </section>
  );
}
