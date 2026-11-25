// 구성 보기의 소스 줄과 그 밑에 붙어 펼쳐지는 실린 문서 트리.
import { useLayoutEffect, useState, type MutableRefObject, type ReactNode } from "react";
import { ChevronRight, ExternalLink, FileText } from "lucide-react";
import { Badge, DashboardIconCap } from "@seosoyoung/soul-ui";

import { conditionSummary } from "./AgentAtomContextFields";
import { formatChars, loadedHow, type LoadedHow, type SkillGuide } from "../lib/skill-guides";
import { rowMeta, rowTitle, type Row, type RowStatus } from "./agent-context-assembly-model";
import { howLabel } from "./guides/GuideParts";
import "../v3/v3-run-history.css";

/** 목록 칸 폭이 이만큼보다 좁으면 소스 줄이 좁은 모양(글자 수는 메타 줄로, 단추는 펼친 트리 머리로)이 된다. 칸 폭 기준이라 넓은 화면의 좁은 칸에도 맞는다. */
const COMPACT_BELOW = 432;
const COMPACT_HYSTERESIS = 24;

/**
 * 칸 요소의 폭을 지켜보다가 COMPACT_BELOW보다 좁으면 true. 요소가 사라졌다 다시 서도(본문 보기를 다녀온 뒤) 이어서 지켜본다.
 * 크기 관찰이 없는 환경에서는 넓은 모양이다.
 */
export function useCompact(): [(element: HTMLElement | null) => void, boolean] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    // 처음 그리기 전에 한 번 재서 넓은 모양이 한 프레임 비치지 않게 한다(관찰자의 첫 통지는 그린 뒤에 온다).
    if (element.clientWidth > 0) setCompact(element.clientWidth < COMPACT_BELOW);
    // 줄 모양이 바뀌면 목록 높이가 달라져 세로 스크롤바가 생기거나 사라지며 폭이 15px쯤 흔들린다. 되돌아올 때는 여유를 두어 문턱에서 깜빡이지 않게 한다.
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? COMPACT_BELOW;
      setCompact(current => width < COMPACT_BELOW + (current ? COMPACT_HYSTERESIS : 0));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, compact];
}

/** 줄 머리에 붙는 상태 배지. 정상(들어감)은 적지 않고 빠짐, 실패, 중복, 비어 있음만 보인다. */
function StatusBadge({ status }: { status: RowStatus }) {
  if (status === "error") return <Badge variant="error">실패</Badge>;
  if (status === "filtered") return <Badge variant="secondary">빠짐</Badge>;
  if (status === "empty") return <Badge variant="outline">비어 있음</Badge>;
  if (status === "duplicate") return <Badge variant="outline">중복</Badge>;
  return null;
}

export function AssemblyRow({ rowKey, refs, title, titlePrefix = null, meta, status = null, size, compact = false, loading, inactive = false, strong = false, expanded, onClick }: {
  rowKey: string;
  refs: MutableRefObject<Map<string, HTMLButtonElement>>;
  title: string | null;
  /** 같은 이름의 소스를 가르는 부모 문서 제목. */
  titlePrefix?: string | null;
  meta: string | null;
  status?: RowStatus | null;
  /** 줄 오른쪽에 적는 수. 글자 수 하나로 적는다. */
  size: string | null;
  /** 좁은 칸: 오른쪽의 글자 수를 메타 줄 앞으로 옮겨 제목 자리를 넓힌다. */
  compact?: boolean;
  loading: boolean;
  inactive?: boolean;
  strong?: boolean;
  /** 주면 누를 때 실린 문서를 펼치는 줄이다. 안 주면 본문으로 들어가는 줄이다. */
  expanded?: boolean;
  onClick(): void;
}) {
  const left = status === "filtered" || status === "duplicate";
  const full = title === null ? undefined : titlePrefix ? `${titlePrefix} / ${title}` : title;
  return (
    <button
      type="button"
      ref={(element) => { if (element) refs.current.set(rowKey, element); else refs.current.delete(rowKey); }}
      className={`flex min-w-0 w-full items-center gap-3 rounded-floor border border-border bg-muted/10 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background enabled:hover:bg-muted disabled:cursor-default ${expanded ? "rounded-b-none" : ""}`}
      data-status={status ?? undefined}
      aria-expanded={expanded}
      disabled={loading || inactive}
      onClick={onClick}
    >
      {expanded !== undefined && !inactive && <ChevronRight className={`size-4 shrink-0 text-muted-foreground ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />}
      <span className={`min-w-0 flex-1 ${left ? "opacity-60" : ""}`}>
        <span className="flex min-w-0 items-center gap-2">
          {loading && !title ? <span className="flex h-5 flex-1 items-center"><span className="v3-run-skeleton v3-run-skeleton--title" /></span> : (
            // 두 줄까지 감싸고 넘치면 말줄임한다. 전체 이름은 툴팁으로 본다.
            <span className={`line-clamp-2 min-w-0 ${strong ? "font-semibold" : "font-medium"}`} style={{ wordBreak: "keep-all", overflowWrap: "anywhere" }} title={full} data-assembly-title="true">
              {titlePrefix && <span className="font-normal text-muted-foreground">{titlePrefix} / </span>}{title}
            </span>
          )}
          {!loading && status && <span className="shrink-0"><StatusBadge status={status} /></span>}
        </span>
        {(meta || (compact && size)) && <span className="block truncate text-xs text-muted-foreground">{compact && size && <span className="tabular-nums">{size}{meta ? " · " : ""}</span>}{meta}</span>}
      </span>
      {loading ? <span className="v3-run-skeleton v3-run-skeleton--badge" /> : !compact && size && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{size}</span>}
      {!inactive && expanded === undefined && <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
    </button>
  );
}

/** 소스 줄 하나: 줄, 줄 끝 단추 둘(본문 보기, atom에서 열기), 줄 바로 밑에 붙어 펼쳐지는 문서 트리. */
export function SourceItem({ row, title, compact, loading, inactive, ready, expanded, atomBaseUrl, skillsByEntryCard, refs, onToggle, onOpenBody }: {
  row: Row;
  title: string | null;
  /** 좁은 칸이면 단추 둘을 펼친 트리 머리로 옮긴다(줄은 제목 자리를 다 쓴다). */
  compact: boolean;
  loading: boolean;
  inactive: boolean;
  /** 미리보기를 받았다. 받기 전과 실패한 뒤에는 줄만 보인다. */
  ready: boolean;
  expanded: boolean;
  atomBaseUrl: string | null;
  skillsByEntryCard: ReadonlyMap<string, SkillGuide>;
  refs: MutableRefObject<Map<string, HTMLButtonElement>>;
  onToggle(): void;
  onOpenBody(): void;
}) {
  const expandable = row.documents !== null;
  const open = ready && expandable && expanded;
  const name = rowTitle(row);
  const moved = compact && expandable;
  const actions = ready ? (
    <>
      {expandable && <DashboardIconCap size="small" label={`${name} 본문 보기`} onClick={onOpenBody}><FileText className="size-4" aria-hidden="true" /></DashboardIconCap>}
      {atomBaseUrl && row.nodeId && <DashboardIconCap size="small" label={`${name} atom에서 열기`} onClick={() => window.open(`${atomBaseUrl}/#${row.nodeId}`, "_blank", "noopener")}><ExternalLink className="size-4" aria-hidden="true" /></DashboardIconCap>}
    </>
  ) : null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center" data-testid="agent-context-source">
      <AssemblyRow
        rowKey={row.key}
        refs={refs}
        title={title}
        titlePrefix={ready ? row.parentTitle : null}
        meta={rowMeta(row)}
        status={row.status}
        size={row.status === "ok" && row.chars !== null ? formatChars(row.chars) : null}
        compact={compact}
        loading={loading}
        inactive={inactive}
        expanded={expandable ? expanded : undefined}
        onClick={onToggle}
      />
      {actions && !moved && <div className="ms-2 flex items-center gap-2">{actions}</div>}
      {open && <div className="col-start-1"><DocumentTree row={row} skillsByEntryCard={skillsByEntryCard} actions={moved ? actions : null} /></div>}
    </div>
  );
}

const TREE_BOX = "rounded-b-floor border border-t-0 border-border bg-muted/10 px-3 py-2";

/** 문서 줄의 실린 방식이 둘 이상이고 모두 같으면 그 하나, 아니면 null. */
export function commonLoadedHow(hows: ReadonlyArray<LoadedHow | null>): LoadedHow | null {
  const present = hows.filter((how): how is LoadedHow => how !== null);
  return present.length >= 2 && present.every(how => how === present[0]) ? present[0]! : null;
}

function DocumentTree({ row, skillsByEntryCard, actions }: { row: Row; skillsByEntryCard: ReadonlyMap<string, SkillGuide>; actions: ReactNode }) {
  const documents = row.documents ?? [];
  if (documents.length === 0) {
    return (
      <div className={TREE_BOX}>
        {actions && <div className="flex justify-end gap-2 pb-1">{actions}</div>}
        <p className="text-xs text-muted-foreground">{row.status === "filtered" ? `이 조건에서는 빠집니다. ${conditionSummary(row.context.applies_when)}`
          : row.status === "duplicate" ? "앞에서 같은 소스가 이미 들어갑니다."
            : row.status === "error" ? "atom에서 읽지 못했습니다." : "실린 문서가 없습니다."}</p>
      </div>
    );
  }
  const nodeIds = new Set(documents.map(document => document.node_id));
  const hows = documents.map(document => loadedHow(row.context, document, skillsByEntryCard, nodeIds));
  // 실린 방식이 모두 같으면 머리에 한 번만 적고 줄마다 되풀이하지 않는다(스킬 구역과 같은 규칙).
  const common = commonLoadedHow(hows);
  return (
    <div className={TREE_BOX}>
      {(common || actions) && (
        <div className="flex items-center gap-3 pb-1">
          <span className="size-4 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-xs text-muted-foreground" data-testid={common ? "agent-context-documents-how" : undefined}>{common ? howLabel(common) : ""}</p>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <ul aria-label={`${rowTitle(row)}에 실린 문서`} data-testid="agent-context-documents">
        {documents.map((document, index) => {
          const how = hows[index]!;
          return (
            // 문서명은 소스 줄의 제목 시작선(들어 올림 칸 + 간격)에서 시작하고, 깊이는 그 안쪽으로 들여 쓴다.
            <li key={document.node_id} className="flex min-w-0 items-center gap-3 py-0.5 text-sm">
              <span className="size-4 shrink-0" aria-hidden="true" />
              <span className={`min-w-0 flex-1 truncate ${how ? "" : "text-muted-foreground"}`} style={{ paddingInlineStart: `calc(var(--v3-space-4) * ${document.depth})` }} title={document.title} data-v3-selectable-content="true">{document.title}</span>
              {how && !common && <span className={`shrink-0 whitespace-nowrap text-xs ${how === "body" ? "text-muted-foreground" : ""}`}>{howLabel(how)}</span>}
              <span className="min-w-14 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">{how && how !== "title" ? formatChars(document.chars) : ""}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
