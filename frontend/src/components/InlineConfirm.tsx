import { useEffect, useRef, type ReactNode } from "react";

export default function InlineConfirm({
  message,
  confirmLabel = "确认删除",
  cancelLabel = "取消",
  danger = true,
  loading = false,
  onConfirm,
  onCancel,
}: {
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <div className="inline-confirm" role="group">
      <span>{message}</span>
      <button type="button" className="text-action" onClick={onCancel}>
        {cancelLabel}
      </button>
      <button
        ref={confirmRef}
        type="button"
        className={danger ? "text-action danger-text" : "text-action"}
        disabled={loading}
        onClick={onConfirm}
      >
        {loading ? "处理中…" : confirmLabel}
      </button>
    </div>
  );
}
