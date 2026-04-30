/**
 * SessionMetadata - 세션 메타데이터 표시 컴포넌트
 *
 * 세션에 기록된 메타데이터 엔트리(커밋, 브랜치, 카드 등)를
 * 타입별로 그룹화하여 표시합니다.
 *
 * `entry.value`는 string 또는 객체일 수 있다 (caller_info 2026-04-21~ 도입).
 * MetadataItem이 분기:
 *   - caller_info → CallerInfoItem (전용 라벨)
 *   - 기타 객체 → ObjectMetadataItem (key-value fallback)
 *   - string → 기존 경로
 */

import type { MetadataEntry } from "@shared/types";
import { SectionLabel } from "./shared";
import { buildCallerInfoLines, getDedupKey } from "./session-metadata-helpers";

/** 메타데이터 타입별 아이콘 및 라벨 */
const TYPE_CONFIG: Record<string, { icon: string; label: string }> = {
  git_commit: { icon: "📝", label: "Commits" },
  git_branch_create: { icon: "🌿", label: "Branches" },
  git_branch_delete: { icon: "🗑️", label: "Branches Deleted" },
  git_worktree_create: { icon: "🌳", label: "Worktrees" },
  git_worktree_remove: { icon: "🗑️", label: "Worktrees Removed" },
  trello_card: { icon: "📋", label: "Trello Cards" },
  trello_card_update: { icon: "📋", label: "Trello Updates" },
  trello_card_move: { icon: "📋", label: "Trello Moves" },
  file_write: { icon: "📄", label: "Files Created" },
  file_edit: { icon: "✏️", label: "Files Modified" },
  arbor_item: { icon: "🏰", label: "Arbor" },
  caller_info: { icon: "☎️", label: "Caller" },
};

function getTypeConfig(type: string) {
  return TYPE_CONFIG[type] ?? { icon: "🔹", label: type };
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

/** file_write/file_edit 타입에서 동일 파일 경로를 합쳐 카운트를 집계한다.
 *
 * file_* 타입의 value는 항상 string이지만, 미래 회귀를 막기 위해 getDedupKey로
 * 객체 value도 안전하게 키화한다.
 */
function deduplicateFileEntries(entries: MetadataEntry[]): Array<{ entry: MetadataEntry; count: number }> {
  const counts = new Map<string, { entry: MetadataEntry; count: number }>();
  for (const entry of entries) {
    const key = getDedupKey(entry.value);
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

/** caller_info 전용 렌더러 — source/parent/node/agent 등 라벨화하여 표시 */
function CallerInfoItem({ value }: { value: Record<string, unknown> }) {
  const lines = buildCallerInfoLines(value);
  return (
    <div className="flex flex-col gap-0.5 py-1">
      {lines.map((l) => (
        <div key={l.label} className="flex items-baseline gap-2 text-xs">
          <span className="text-muted-foreground uppercase tracking-wide w-16 shrink-0">{l.label}</span>
          <span className="text-foreground break-words">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

/** 미지 객체 타입 fallback — 모든 키를 key-value로 표시 */
function ObjectMetadataItem({ entry }: { entry: MetadataEntry }) {
  const obj = entry.value as Record<string, unknown>;
  const entries = Object.entries(obj);
  return (
    <div className="flex flex-col gap-0.5 py-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-2 text-xs">
          <span className="text-muted-foreground uppercase tracking-wide w-24 shrink-0">{k}</span>
          <span className="text-foreground break-words">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 개별 메타데이터 엔트리 — value 타입에 따라 분기 */
function MetadataItem({ entry }: { entry: MetadataEntry }) {
  // caller_info 전용 렌더러 (value가 객체)
  if (entry.type === "caller_info" && typeof entry.value === "object" && entry.value !== null) {
    return <CallerInfoItem value={entry.value as Record<string, unknown>} />;
  }
  // 기타 객체 value → 일반 key-value fallback
  if (typeof entry.value === "object" && entry.value !== null) {
    return <ObjectMetadataItem entry={entry} />;
  }
  // string 경로 (기존)
  const valueStr = entry.value as string;
  const value = entry.label || valueStr;
  const shortValue = entry.type.startsWith("git_commit") && typeof entry.value === "string"
    ? valueStr.slice(0, 7)
    : null;

  return (
    <div className="flex items-start gap-2 py-1">
      {shortValue && (
        <code className="text-xs text-accent-blue font-mono shrink-0">
          {shortValue}
        </code>
      )}
      <span className="text-sm text-foreground break-words min-w-0">
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
      <div className="p-4 text-center text-muted-foreground text-sm">
        No metadata recorded yet
      </div>
    );
  }

  const groups = groupByType(metadata);

  return (
    <div className="p-4 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-base">{"📦"}</span>
        <div className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
          Session Artifacts
        </div>
        <span className="text-xs text-muted-foreground/60">
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
                    <div key={getDedupKey(entry.value)} className="flex items-start gap-2 py-1">
                      <span className="text-foreground break-words min-w-0 font-mono text-xs">
                        {typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)}
                      </span>
                      {count > 1 && (
                        <span className="text-xs text-muted-foreground shrink-0">{"×"}{count}</span>
                      )}
                    </div>
                  ))
                : entries.map((entry, i) => (
                    <MetadataItem key={`${getDedupKey(entry.value)}-${i}`} entry={entry} />
                  ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
