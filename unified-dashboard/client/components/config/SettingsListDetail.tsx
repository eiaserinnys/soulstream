import { useEffect, useRef, type ReactNode } from "react";
import { inputControlClassName, inputFieldClassName } from "@seosoyoung/soul-ui/components/ui/input";

/**
 * 설정 탭의 목록-상세 틀. 반복 작업과 영구 에이전트 세션이 같은 구현을 쓴다.
 * 왼쪽에 목록, 오른쪽에 선택한 항목의 상세가 놓인다. 좁은 화면은 한 칸이며,
 * 칸의 최소 폭을 0으로 두어 긴 이름이 칸 밖으로 밀어내지 못하게 한다.
 */
export function SettingsListDetailFrame({ testId, list, children }: {
  testId: string;
  list: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(13rem,0.8fr)_minmax(0,1.6fr)]">
      <aside className="min-h-0 rounded border border-border bg-muted/20 p-3">{list}</aside>
      <div className="min-h-0 space-y-4 overflow-y-auto pr-1">{children}</div>
    </section>
  );
}

export function SettingsListHeader({ title, description, actions }: {
  title: string;
  description: string;
  actions: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}

export function SettingsListSection({ title, isEmpty, emptyText = "없음", children }: {
  title?: string;
  isEmpty: boolean;
  emptyText?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-4">
      {title ? <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p> : null}
      <div className="space-y-1">
        {isEmpty ? <p className="px-2 py-1 text-xs text-muted-foreground">{emptyText}</p> : children}
      </div>
    </div>
  );
}

export function SettingsListRow({ title, meta, selected, onSelect, portrait }: {
  title: string;
  meta: string;
  selected: boolean;
  onSelect(): void;
  portrait?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`w-full rounded px-2 py-2 text-left text-sm ${selected ? "bg-accent-blue/15 text-foreground" : "hover:bg-muted"}`}
      onClick={onSelect}
    >
      {portrait ? <span className="flex items-center gap-2">{portrait}<span className="min-w-0"><span className="block truncate font-medium">{title}</span><span className="block truncate text-xs text-muted-foreground">{meta}</span></span></span> : <><span className="block truncate font-medium">{title}</span><span className="block truncate text-xs text-muted-foreground">{meta}</span></>}
    </button>
  );
}

export function SettingsDetailHeader({ title, subtitle, actions }: {
  title: string;
  subtitle?: string | null;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function SettingsGroupBox({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded border border-border p-3">
      {title ? <p className="mb-2 text-sm font-medium">{title}</p> : null}
      {children}
    </div>
  );
}

/** scrollIntoView를 켜면 나타날 때 화면 안으로 스크롤한다. 눌러서 생긴 오류가 보이지 않는 곳에 뜨는 긴 상세용이다. */
export function SettingsAlert({ children, scrollIntoView = false }: { children: ReactNode; scrollIntoView?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollIntoView) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [scrollIntoView]);
  return (
    <div ref={ref} role="alert" className="rounded border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-sm text-accent-red">
      {children}
    </div>
  );
}

export function SettingsField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** 여러 줄 입력. 한 줄 입력(soul-ui Input)과 같은 표면과 포커스 모양을 쓰고 크기 조절은 끈다. */
export function SettingsMultilineField({ label, value, rows = 5, placeholder, onChange }: {
  label: string;
  value: string;
  rows?: number;
  placeholder?: string;
  onChange(value: string): void;
}) {
  return (
    <SettingsField label={label}>
      <span className={inputControlClassName} data-slot="input-control">
        <textarea
          aria-label={label}
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={`${inputFieldClassName} resize-none py-2`}
        />
      </span>
    </SettingsField>
  );
}
