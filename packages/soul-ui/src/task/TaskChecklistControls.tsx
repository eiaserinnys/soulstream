import {
  Fragment,
  forwardRef,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type PointerEvent,
} from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/menu";
import { cn } from "../lib/cn";

export interface RowAction {
  key: string;
  label: string;
  icon: "edit" | "add" | "up" | "down" | "archive";
  disabled?: boolean;
  destructive?: boolean;
  onSelect: () => void;
}

const icons = {
  edit: Pencil,
  add: Plus,
  up: ArrowUp,
  down: ArrowDown,
  archive: Archive,
};

export const TaskRowActionButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function TaskRowActionButton({ className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      data-task-row-action=""
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/60",
        className,
      )}
      {...props}
    />
  );
});

export function TaskRowActions({
  label,
  actions,
  onPointerDown,
}: {
  label: string;
  actions: readonly RowAction[];
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <TaskRowActionButton
            aria-label={label}
            data-testid="task-row-menu"
            className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
            onPointerDown={onPointerDown}
          />
        }
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {actions.map((action, index) => {
          const Icon = icons[action.icon];
          const separator = action.destructive && index > 0;
          return (
            <Fragment key={action.key}>
              {separator ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                disabled={action.disabled}
                variant={action.destructive ? "destructive" : "default"}
                onClick={action.onSelect}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {action.label}
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SectionTitleForm({
  initialTitle,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initialTitle: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  useEffect(() => setTitle(initialTitle), [initialTitle]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = title.trim();
    if (next) onSubmit(next);
  }

  return (
    <form
      data-testid="task-section-editor"
      className="rounded-lg bg-muted/25 px-2.5 py-2"
      onSubmit={submit}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        autoFocus
        aria-label="섹션 제목"
        value={title}
        disabled={pending}
        className="h-8 w-full rounded-md border border-[var(--lg-line)] bg-background/70 px-2.5 text-sm text-foreground outline-none focus:border-accent-blue/60"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <EditorFooter
        submitLabel={submitLabel}
        submitDisabled={!title.trim() || pending}
        pending={pending}
        error={error}
        onCancel={onCancel}
      />
    </form>
  );
}

export function ItemEditorForm({
  initialTitle,
  initialHowTo,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initialTitle: string;
  initialHowTo: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (title: string, howTo: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [howTo, setHowTo] = useState(initialHowTo);
  useEffect(() => {
    setTitle(initialTitle);
    setHowTo(initialHowTo);
  }, [initialHowTo, initialTitle]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = title.trim();
    if (next) onSubmit(next, howTo);
  }

  return (
    <form
      data-testid="task-item-editor"
      className="rounded-lg bg-muted/25 px-2.5 py-2"
      onSubmit={submit}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        autoFocus
        aria-label="항목 제목"
        value={title}
        disabled={pending}
        className="h-8 w-full rounded-md border border-[var(--lg-line)] bg-background/70 px-2.5 text-sm text-foreground outline-none focus:border-accent-blue/60"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <textarea
        aria-label="항목 절차"
        value={howTo}
        disabled={pending}
        placeholder="절차 (선택)"
        rows={3}
        className="mt-2 w-full resize-y rounded-md border border-[var(--lg-line)] bg-background/70 px-2.5 py-2 text-sm leading-relaxed text-foreground outline-none focus:border-accent-blue/60"
        onChange={(event) => setHowTo(event.target.value)}
      />
      <EditorFooter
        submitLabel={submitLabel}
        submitDisabled={!title.trim() || pending}
        pending={pending}
        error={error}
        onCancel={onCancel}
      />
    </form>
  );
}

export function QuietAddButton({
  children,
  disabled = false,
  onClick,
}: {
  children: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/60 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </button>
  );
}

function EditorFooter({
  submitLabel,
  submitDisabled,
  pending,
  error,
  onCancel,
}: {
  submitLabel: string;
  submitDisabled: boolean;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
      {error ? <span className="mr-auto text-xs text-accent-red">{error}</span> : null}
      <button
        type="button"
        disabled={pending}
        className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/45 disabled:opacity-50"
        onClick={onCancel}
      >
        취소
      </button>
      <button
        type="submit"
        disabled={submitDisabled}
        className={cn(
          "h-7 rounded-md bg-accent-blue px-2.5 text-xs font-medium text-white",
          "disabled:cursor-not-allowed disabled:opacity-45",
        )}
      >
        {pending ? "저장 중" : submitLabel}
      </button>
    </div>
  );
}
