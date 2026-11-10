import { useRef, useState } from "react";

export default function InlineTaskComposer({
  label,
  onCreate,
  quiet = false,
  hint,
}: {
  label: string;
  onCreate: (title: string) => Promise<unknown>;
  quiet?: boolean;
  hint?: string;
}) {
  const [active, setActive] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const continueEditing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const save = async (keep: boolean) => {
    if (lock.current) {
      if (!keep) continueEditing.current = false;
      return;
    }
    continueEditing.current = keep;
    if (!title.trim()) {
      if (!continueEditing.current) setActive(false);
      return;
    }
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      await onCreate(title.trim());
      setTitle("");
      if (!continueEditing.current) setActive(false);
      else requestAnimationFrame(() => input.current?.focus());
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败，按回车重试");
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  return active ? (
    <div className="inline-task-composer">
      <span className="reminder-empty-circle" aria-hidden="true" />
      <input
        ref={input}
        autoFocus
        aria-label={label}
        value={title}
        maxLength={200}
        placeholder="输入任务，回车继续添加"
        readOnly={saving}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          if (!error) void save(false);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void save(true);
          }
          if (event.key === "Escape" && !saving) {
            setActive(false);
            setTitle("");
            setError("");
          }
        }}
      />
      {saving && (
        <span className="muted" role="status">
          保存中…
        </span>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  ) : (
    <button
      type="button"
      className={`inline-task-add${quiet ? " inline-task-add-quiet" : ""}`}
      aria-label={label}
      onClick={() => setActive(true)}
    >
      <span className="reminder-empty-circle" aria-hidden="true" />
      {!quiet && "添加任务"}
      {quiet && hint && <span className="quiet-add-hint">{hint}</span>}
    </button>
  );
}
