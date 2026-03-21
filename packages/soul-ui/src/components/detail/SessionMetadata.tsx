/**
 * SessionMetadata - 세션 메타데이터 표시 컴포넌트
 *
 * 세션에 기록된 메타데이터 엔트리(커밋, 브랜치, 카드 등)를
 * 타입별로 그룹화하여 표시합니다.
 */

import type { MetadataEntry } from "@shared/types";
import { SectionLabel } from "./shared";

/** 메타데이터 타입별 아이콘 및 라벨 */
const TYPE_CONFIG: Record<string, { icon: string; label: string }> = {
  git_commit: { icon: "\uD83D\uDCDD", label: "Commits" },
  git_branch_create: { icon: "\uD83C\uDF3F", label: "Branches" },
  git_worktree_create: { icon: "\uD83C\uDF33", label: "Worktrees" },
  trello_card: { icon: "\uD83D\uDCCB", label: "Trello Cards" },
  trello_card_update: { icon: "\uD83D\uDCCB", label: "Trello Updates" },
  serendipity_page: { icon: "\uD83D\uDCD6", label: "Serendipity" },
  arbor_item: { icon: "\uD83C\uDFF0", label: "Arbor" },
};

function getTypeConfig(type: string) {
  return TYPE_CONFIG[type] ?? { icon: "\uD83D\uDD39", label: type };
}

/** 타입별 그룹화 */
function groupByType(entries: MetadataEntry[]): Map<string, MetadataEntry[]> {
  const groups = new Map<string, MetadataEntry[]>();
  for (const entry of entries) {
    const existing = groups.get(entry.type);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(entry.type, [entry]);
    }
  }
  return groups;
}

/** 개별 메타데이터 엔트리 */
function MetadataItem({ entry }: { entry: MetadataEntry }) {
  const value = entry.label || entry.value;
  const shortValue = entry.type.startsWith("git_commit")
    ? entry.value.slice(0, 7)
    : null;

  return (
    <div className="flex items-start gap-2 py-1">
      {shortValue && (
        <code className="text-[12px] text-accent-blue font-mono shrink-0">
          {shortValue}
        </code>
      )}
      <span className="text-[13px] text-foreground break-words min-w-0">
        {entry.url ? (
          <a
            href={entry.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-blue hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </span>
    </div>
  );
}

/** 세션 메타데이터 표시 (빈 상태 포함) */
export function SessionMetadata({ metadata }: { metadata: MetadataEntry[] }) {
  if (!metadata || metadata.length === 0) {
    return (
      <div className="p-4 text-center text-muted-foreground text-[13px]">
        No metadata recorded yet
      </div>
    );
  }

  const groups = groupByType(metadata);

  return (
    <div className="p-4 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-base">{"\uD83D\uDCE6"}</span>
        <div className="text-[12px] text-muted-foreground uppercase tracking-[0.05em] font-semibold">
          Session Artifacts
        </div>
        <span className="text-[11px] text-muted-foreground/60">
          {metadata.length}
        </span>
      </div>

      {Array.from(groups.entries()).map(([type, entries]) => {
        const config = getTypeConfig(type);
        return (
          <div key={type}>
            <SectionLabel>
              {config.icon} {config.label} ({entries.length})
            </SectionLabel>
            <div className="flex flex-col">
              {entries.map((entry, i) => (
                <MetadataItem key={`${entry.value}-${i}`} entry={entry} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
