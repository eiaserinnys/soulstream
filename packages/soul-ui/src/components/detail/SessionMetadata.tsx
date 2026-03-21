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
  git_branch_delete: { icon: "\uD83D\uDDD1\uFE0F", label: "Branches Deleted" },
  git_worktree_create: { icon: "\uD83C\uDF33", label: "Worktrees" },
  git_worktree_remove: { icon: "\uD83D\uDDD1\uFE0F", label: "Worktrees Removed" },
  trello_card: { icon: "\uD83D\uDCCB", label: "Trello Cards" },
  trello_card_update: { icon: "\uD83D\uDCCB", label: "Trello Updates" },
  trello_card_move: { icon: "\uD83D\uDCCB", label: "Trello Moves" },
  serendipity_page: { icon: "\uD83D\uDCD6", label: "Serendipity" },
  serendipity_page_update: { icon: "\uD83D\uDCD6", label: "Serendipity Updates" },
  serendipity_block: { icon: "\uD83D\uDCD6", label: "Serendipity Blocks" },
  file_write: { icon: "\uD83D\uDCC4", label: "Files Created" },
  file_edit: { icon: "\u270F\uFE0F", label: "Files Modified" },
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

/** file_write/file_edit 타입에서 동일 파일 경로를 합쳐 카운트를 집계한다 */
function deduplicateFileEntries(entries: MetadataEntry[]): Array<{ entry: MetadataEntry; count: number }> {
  const counts = new Map<string, { entry: MetadataEntry; count: number }>();
  for (const entry of entries) {
    const key = entry.value;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { entry, count: 1 });
    }
  }
  return Array.from(counts.values());
}

/** 파일 타입 판별용 상수 */
const FILE_TYPES = new Set(["file_write", "file_edit"]);

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
        const isFileType = FILE_TYPES.has(type);
        const dedupedEntries = isFileType ? deduplicateFileEntries(entries) : null;
        return (
          <div key={type}>
            <SectionLabel>
              {config.icon} {config.label} ({dedupedEntries ? dedupedEntries.length : entries.length})
            </SectionLabel>
            <div className="flex flex-col">
              {dedupedEntries
                ? dedupedEntries.map(({ entry, count }) => (
                    <div key={entry.value} className="flex items-start gap-2 py-1">
                      <span className="text-[13px] text-foreground break-words min-w-0 font-mono text-[12px]">
                        {entry.value}
                      </span>
                      {count > 1 && (
                        <span className="text-[11px] text-muted-foreground shrink-0">{"\u00D7"}{count}</span>
                      )}
                    </div>
                  ))
                : entries.map((entry, i) => (
                    <MetadataItem key={`${entry.value}-${i}`} entry={entry} />
                  ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
