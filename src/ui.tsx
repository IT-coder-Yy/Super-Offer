import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement<{ id?: string }>(children)
        ? cloneElement(children, { id })
        : children}
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function Dialog({
  title,
  children,
  onCancel,
  actions,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
  actions: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide-dialog" : ""}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onCancel}
          aria-label="关闭对话框"
        >
          ×
        </button>
      </header>
      <div className="dialog-content">{children}</div>
      <footer>{actions}</footer>
    </dialog>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <svg
        width="56"
        height="56"
        viewBox="0 0 56 56"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="12"
          y="8"
          width="32"
          height="40"
          rx="5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M20 21h16M20 28h16M20 35h9"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export const formatDate = (value: string | null, withTime = true) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        ...(withTime ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}),
      }).format(new Date(value))
    : "—";
export const localDateTime = (
  value: string | null = new Date().toISOString(),
) =>
  value
    ? new Date(
        new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
export const bytesLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
