import { useRef, useState } from "react";

export default function InlineTaskTitle({
  title,
  disabled,
  onSave,
  onSelect,
}: {
  title: string;
  disabled?: boolean;
  onSave: (title: string) => Promise<unknown>;
  onSelect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const keepFocus = useRef(false);
  const cancelled = useRef(false);
  const row = useRef<HTMLElement | null>(null);
  const returnFocus = () =>
    requestAnimationFrame(() => row.current?.focus({ preventScroll: true }));
  const save = async (focus = false) => {
    if (lock.current) {
      if (!focus) keepFocus.current = false;
      return;
    }
    if (cancelled.current) return;
    keepFocus.current = focus;
    if (!value.trim()) {
      setError("请输入任务标题");
      return;
    }
    if (value.trim() === title) {
      setEditing(false);
      if (keepFocus.current) returnFocus();
      return;
    }
    lock.current = true;
    setSaving(true);
    try {
      await onSave(value.trim());
      setEditing(false);
      setError("");
      if (keepFocus.current) returnFocus();
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败");
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  if (editing)
    return (
      <div className="inline-task-title">
        <input
          autoFocus
          aria-label={`任务标题：${title}`}
          maxLength={200}
          value={value}
          readOnly={saving}
          onFocus={(event) => event.target.select()}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            if (!error) void save();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void save(true);
            }
            if (event.key === "Escape" && !lock.current) {
              cancelled.current = true;
              setEditing(false);
              setError("");
              returnFocus();
            }
          }}
        />
        {saving && <span role="status">保存中…</span>}
        {error && <span role="alert">{error}</span>}
      </div>
    );
  return (
    <button
      type="button"
      className="row-title-button"
      disabled={disabled}
      onClick={(event) => {
        row.current =
          event.currentTarget.closest<HTMLElement>("[data-task-id]");
        onSelect();
        setValue(title);
        cancelled.current = false;
        setEditing(true);
      }}
    >
      <h3>{title}</h3>
    </button>
  );
}
