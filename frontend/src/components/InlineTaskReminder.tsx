import { useState } from "react";
import { Button } from "antd";
import { toInstant, toLocal } from "../time";

export default function InlineTaskReminder({
  value,
  timezone,
  onSave,
  onClose,
}: {
  value: string | null;
  timezone: string;
  onSave: (value: string | null) => Promise<unknown>;
  onClose: () => void;
}) {
  const [local, setLocal] = useState(toLocal(value, timezone));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <div
      className="inline-reminder-editor"
      onClick={(event) => event.stopPropagation()}
    >
      <label>
        提醒时间（{timezone}）
        <input
          autoFocus
          type="datetime-local"
          aria-label="任务提醒时间"
          value={local}
          onChange={(event) => setLocal(event.target.value)}
        />
      </label>
      <Button
        size="small"
        loading={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onSave(toInstant(local, timezone));
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : "保存失败");
          } finally {
            setSaving(false);
          }
        }}
      >
        保存提醒
      </Button>
      <Button size="small" disabled={saving} onClick={onClose}>
        取消
      </Button>
      <span className="muted">留空可取消提醒</span>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
