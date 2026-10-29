import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type Dispatch, type ReactNode, type SetStateAction,
} from "react";
import "./v3-front-index.css";

/** 포인터가 머문 뒤 열기까지의 지연. 훑고 지나갈 때 열리지 않게 한다(호버 반응 100~200ms 범위). */
const HOVER_INTENT_MS = 120;

type Group = { openKey: string | null; setOpenKey: Dispatch<SetStateAction<string | null>> };
const FrontRowGroupContext = createContext<Group | null>(null);

/** 한 목록 안에서는 한 행만 열린다. */
export function FrontRowGroup({ className, children, label }: { className?: string; children: ReactNode; label?: string }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const value = useMemo(() => ({ openKey, setOpenKey }), [openKey]);
  return <FrontRowGroupContext.Provider value={value}>
    <ul className={`fi-rows${className ? ` ${className}` : ""}`} aria-label={label}>{children}</ul>
  </FrontRowGroupContext.Provider>;
}

/**
 * 장부 한 행. 접힌 행은 여백 칸(시각이나 순번)과 두 줄이다.
 * 펼침은 아래 행을 덮는 층으로 그린다. 층은 접힌 행과 같은 자리에서 시작해 아래로만 열리고,
 * 목록의 배치는 바뀌지 않는다. 층의 아랫변은 덮는 마지막 행의 아래 괘선에 맞춰, 덮인 행은 통째로
 * 가리고 덮이지 않은 행은 통째로 보이게 한다. 마우스는 실제로 움직여 머물면 열리고(행이 포인터 밑으로
 * 밀려 들어온 것만으로는 열지 않는다), 키보드는 포커스로, 터치는 눌러서 연다.
 */
export function FrontRow({ rowKey, stamp, line1, line2, extra, leaving = false, onActivate, className, label }: {
  rowKey: string;
  stamp: ReactNode;
  line1: ReactNode;
  line2?: ReactNode;
  /** 펼쳤을 때만 보이는 것. 없으면 펼치지 않는 행이다. */
  extra?: ReactNode;
  /** 빠지는 중(「확인했어」 뒤). 높이를 접으며 사라진다. */
  leaving?: boolean;
  /** 마우스나 키보드로 행을 눌렀을 때(카드 열기). */
  onActivate?(): void;
  className?: string;
  label?: string;
}) {
  const group = useContext(FrontRowGroupContext);
  if (!group) throw new Error("FrontRow는 FrontRowGroup 안에 둔다.");
  const { openKey, setOpenKey } = group;
  const expandable = Boolean(extra);
  const open = expandable && !leaving && openKey === rowKey;
  const extraId = useId();
  const timer = useRef<number | null>(null);
  const pointer = useRef("mouse");
  const enteredAt = useRef<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clear, [clear]);

  // 층의 높이: 닫힌 때는 접힌 행 높이, 열 때는 내용을 다 담는 첫 행 경계(같은 열의 아래 행 아랫변)까지.
  useLayoutEffect(() => {
    const row = rowRef.current, layer = layerRef.current;
    if (!row || !layer) return;
    if (getComputedStyle(layer).position !== "absolute") { layer.style.height = ""; return; }
    const collapsed = row.querySelector<HTMLElement>(".fi-row-head")?.offsetHeight ?? 0;
    if (!open) { if (layer.style.height) layer.style.height = `${collapsed}px`; return; }
    layer.style.height = `${collapsed}px`;
    const natural = layer.scrollHeight;
    const box = row.getBoundingClientRect();
    let target = natural;
    for (let next = row.nextElementSibling; next; next = next.nextElementSibling) {
      const rect = next.getBoundingClientRect();
      if (Math.abs(rect.left - box.left) > 1) continue;
      if (rect.bottom - box.top >= natural) { target = rect.bottom - box.top; break; }
    }
    void layer.offsetHeight;
    layer.style.height = `${target}px`;
  }, [open]);

  const openNow = () => { if (expandable && !leaving) setOpenKey(rowKey); };
  const closeNow = () => setOpenKey(current => current === rowKey ? null : current);
  const press = () => {
    if (pointer.current !== "mouse" && pointer.current !== "keyboard" && expandable) {
      if (open) closeNow(); else openNow();
      return;
    }
    onActivate?.();
  };

  return <li className={`fi-row${className ? ` ${className}` : ""}`}
    data-open={open || undefined} data-leaving={leaving || undefined} data-expandable={expandable || undefined}
    ref={rowRef}
    onPointerEnter={event => {
      if (event.pointerType !== "mouse" || !expandable) return;
      enteredAt.current = { x: event.clientX, y: event.clientY };
    }}
    onPointerMove={event => {
      if (event.pointerType !== "mouse" || !expandable || open || timer.current !== null) return;
      const from = enteredAt.current;
      if (from && from.x === event.clientX && from.y === event.clientY) return;
      timer.current = window.setTimeout(() => { timer.current = null; openNow(); }, HOVER_INTENT_MS);
    }}
    onPointerLeave={event => {
      if (event.pointerType !== "mouse") return;
      enteredAt.current = null;
      clear();
      closeNow();
    }}
    onFocus={event => { if ((event.target as HTMLElement).matches(":focus-visible")) openNow(); }}
    onBlur={event => {
      // 포커스가 다른 요소로 옮겨 갈 때만 닫는다. 휴대폰에서 연 행의 머리가 숨으며 포커스를 잃는 경우는 그대로 둔다.
      const next = event.relatedTarget as Node | null;
      if (next && !event.currentTarget.contains(next)) closeNow();
    }}
    onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); closeNow(); } }}>
    <div className="fi-row-frame">
      <button type="button" className="fi-row-head" aria-label={label} aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? extraId : undefined}
        onPointerDown={event => { pointer.current = event.pointerType; }}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") pointer.current = "keyboard"; }}
        onClick={press}>
        <span className="fi-stamp">{stamp}</span>
        <span className="fi-lines">
          <span className="fi-line1">{line1}</span>
          {line2 ? <span className="fi-line2">{line2}</span> : null}
        </span>
      </button>
      {expandable ? <div className="fi-row-layer" ref={layerRef} aria-hidden={!open || undefined}>
        <div className="fi-row-dup" aria-hidden="true"
          onPointerDown={event => { pointer.current = event.pointerType; }} onClick={press}>
          <span className="fi-stamp">{stamp}</span>
          <span className="fi-lines">
            <span className="fi-line1">{line1}</span>
            {line2 ? <span className="fi-line2">{line2}</span> : null}
          </span>
        </div>
        <div className="fi-row-extra" id={extraId}>
          <div className="fi-row-extra-inner">{extra}</div>
        </div>
      </div> : null}
    </div>
  </li>;
}

/** 움직임 줄이기 설정이면 빠지는 행을 바로 지운다. */
export function rowLeaveDelay(): number {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220;
}
