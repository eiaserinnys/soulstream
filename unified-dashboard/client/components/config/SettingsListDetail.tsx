import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { inputControlClassName, inputFieldClassName } from "@seosoyoung/soul-ui/components/ui/input";

/**
 * 설정 탭의 목록-상세 틀. 반복 작업과 영구 에이전트 세션이 같은 구현을 쓴다.
 * 왼쪽에 목록, 오른쪽에 선택한 항목의 상세가 놓인다. 좁은 화면은 한 칸이며,
 * 칸의 최소 폭을 0으로 두어 긴 이름이 칸 밖으로 밀어내지 못하게 한다.
 * fill을 주면 두 칸일 때 남는 높이를 채우고 목록과 상세가 따로 스크롤한다(항목이 백 개를 넘는 목록용).
 * fill과 함께 detailOpen을 주면 한 칸일 때 목록과 상세가 번갈아 보인다(true면 상세, false면 목록).
 */
export function SettingsListDetailFrame({ testId, list, children, fill = false, detailOpen }: {
  testId: string;
  list: ReactNode;
  children: ReactNode;
  fill?: boolean;
  detailOpen?: boolean;
}) {
  const detail = useRef<HTMLDivElement>(null);
  return (
    <section data-testid={testId} className={["grid min-h-0 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(13rem,0.8fr)_minmax(0,1.6fr)]", fill && "flex-1 grid-rows-[minmax(0,1fr)]"].filter(Boolean).join(" ")} onClick={(event) => {
      if (!(event.target instanceof Element) || !event.target.closest("aside [data-settings-list-row], aside [data-settings-open-detail]")) return;
      requestAnimationFrame(() => {
        const pane = detail.current;
        const header = pane?.querySelector("header");
        if (!pane || !header) return;
        const view = pane.closest(".config-detail")?.getBoundingClientRect();
        const paneBounds = pane.getBoundingClientRect();
        const bounds = header.getBoundingClientRect();
        const top = Math.max(view?.top ?? 0, paneBounds.top);
        const bottom = Math.min(view?.bottom ?? window.innerHeight, paneBounds.bottom);
        if (bounds.top < top - 1 || bounds.bottom > bottom + 1) {
          header.scrollIntoView?.({ block: "nearest", behavior: "instant" });
        }
      });
    }}>
      <aside className={["min-h-0 rounded-floor border border-border bg-muted/20 p-3", fill && "overflow-y-auto", fill && detailOpen && "max-lg:hidden"].filter(Boolean).join(" ")}>{list}</aside>
      <div ref={detail} className={fill ? ["flex min-h-0 flex-col gap-4", detailOpen === false && "max-lg:hidden"].filter(Boolean).join(" ") : "min-h-0 space-y-4 lg:-mr-1 lg:overflow-y-auto lg:pr-1"}>{children}</div>
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
        <p className="break-keep break-words text-xs text-muted-foreground">{description}</p>
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

export function SettingsListRow({ title, meta, selected, onSelect, portrait, badge, titleBadge, footer }: {
  title: string;
  meta: string;
  selected: boolean;
  onSelect(): void;
  portrait?: ReactNode;
  badge?: ReactNode;
  /** 제목 줄 오른쪽 끝에 두는 배지. 긴 설명을 한 줄로 줄인 채 상태를 함께 보일 때 쓴다. */
  titleBadge?: ReactNode;
  footer?: ReactNode;
}) {
  const heading = titleBadge
    ? <span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{title}</span>{titleBadge}</span>
    : <span className="block truncate font-medium">{title}</span>;
  const metadata = <span className={badge ? "flex flex-wrap items-center gap-1 text-xs text-muted-foreground" : "block truncate text-xs text-muted-foreground"}>{meta}{badge}</span>;
  return (
    <button
      type="button"
      data-settings-list-row
      className={`block w-full rounded-floor px-2 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${selected ? "bg-accent-blue/15 text-foreground" : "hover:bg-muted"}`}
      onClick={onSelect}
    >
      {portrait ? <span className="flex items-center gap-2">{portrait}<span className="min-w-0">{heading}{metadata}</span></span> : <>{heading}{metadata}</>}
      {footer ? <span className="mt-1 block">{footer}</span> : null}
    </button>
  );
}

/** 좁은 폭(640px 미만)에서 긴 부제를 세 줄로 접고 「더 보기」로 펼친다. 넘치지 않으면 단추가 없다. */
function ClampedSubtitle({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);
  return (
    <>
      <p ref={ref} data-v3-selectable-content="true" className={`text-xs text-muted-foreground ${open ? "" : "max-sm:line-clamp-3"}`}>{text}</p>
      {(overflow || open) && (
        <button type="button" aria-expanded={open} className="mt-1 rounded-floor text-xs font-medium text-muted-foreground underline outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden" onClick={() => setOpen(!open)}>{open ? "접기" : "더 보기"}</button>
      )}
    </>
  );
}

export function SettingsDetailHeader({ title, subtitle, actions, selectableTitle = false, leadingIcon, inlineActions = false, clampSubtitle = false }: {
  title: string;
  leadingIcon?: ReactNode;
  selectableTitle?: boolean;
  subtitle?: string | null;
  actions?: ReactNode;
  /** 부제가 여러 줄이어도 동작을 제목 줄 오른쪽에 둔다. 동작이 한두 개일 때만 쓴다. */
  inlineActions?: boolean;
  /** 좁은 폭에서 부제를 세 줄로 접는다. inlineActions와 함께 쓴다. */
  clampSubtitle?: boolean;
}) {
  if (inlineActions) {
    return (
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 data-v3-selectable-content={selectableTitle ? "true" : undefined} className="text-base font-semibold">{title}</h3>
          {subtitle ? (clampSubtitle ? <ClampedSubtitle text={subtitle} /> : <p data-v3-selectable-content="true" className="text-xs text-muted-foreground">{subtitle}</p>) : null}
        </div>
        {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
      </header>
    );
  }
  return (
    <header className="flex flex-wrap items-start justify-between gap-2">
      {leadingIcon ? <div className="flex min-w-0 items-center gap-2">{leadingIcon}<div className="min-w-0"><h3 data-v3-selectable-content={selectableTitle ? "true" : undefined} className="text-base font-semibold">{title}</h3>{subtitle ? <p data-v3-selectable-content="true" className="text-xs text-muted-foreground">{subtitle}</p> : null}</div></div> : <div>
        <h3 data-v3-selectable-content={selectableTitle ? "true" : undefined} className="text-base font-semibold">{title}</h3>
        {subtitle ? <p data-v3-selectable-content="true" className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function SettingsGroupBox({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded-floor border border-border p-3">
      {title ? <p className="mb-2 text-sm font-medium">{title}</p> : null}
      {children}
    </div>
  );
}

/** scrollIntoView를 켜면 나타날 때 화면 안으로 스크롤한다. 눌러서 생긴 오류가 보이지 않는 곳에 뜨는 긴 상세용이다. */
export function SettingsAlert({ children, scrollIntoView = false }: { children: ReactNode; scrollIntoView?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollIntoView) ref.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }, [scrollIntoView]);
  return (
    <div ref={ref} role="alert" data-v3-selectable-content="true" className="rounded-floor border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-sm text-destructive-foreground" style={{ scrollMarginBottom: 'var(--v3-space-6)', wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>
      {children}
    </div>
  );
}

/**
 * 한 줄 입력 칸. 칸(label)과 그 안의 한 줄 입력은 최소 폭 0을 가져야 한다.
 * 그리드 항목의 min-width가 auto면 입력의 고유 폭(브라우저 기본 20자)이 칸보다
 * 넓을 때 칸을 넘어 이웃 칸과 겹친다(카드 #1456, 226px 칸에서 276px 입력).
 * 프로젝트 한 줄 입력 부품(soul-ui Input, inputControlClassName)의 표면 span도
 * 그리드 항목이라 같은 이유로 min-width를 0으로 둔다.
 */
export function SettingsField({ label, hideLabel = false, children }: { label: string; hideLabel?: boolean; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1 text-sm [&>input]:w-full [&>input]:min-w-0 [&>[data-slot=input-control]]:min-w-0">
      <span className={hideLabel ? "sr-only" : "text-muted-foreground"}>{label}</span>
      {children}
    </label>
  );
}

/** 여러 줄 입력. 한 줄 입력(soul-ui Input)과 같은 표면과 포커스 모양을 쓰고 크기 조절은 끈다. */
export function SettingsMultilineField({ label, labelHidden = false, value, rows = 5, placeholder, maxLength, onChange }: {
  label: string;
  labelHidden?: boolean;
  value: string;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  onChange(value: string): void;
}) {
  return (
    <SettingsField label={label} hideLabel={labelHidden}>
      <span className={inputControlClassName} data-slot="input-control">
        <textarea
          aria-label={label}
          rows={rows}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          className={`${inputFieldClassName} resize-none py-2`}
        />
      </span>
    </SettingsField>
  );
}
