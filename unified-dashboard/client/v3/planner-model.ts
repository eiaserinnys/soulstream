import type {
  BlockDto,
  PageDto,
} from "@seosoyoung/soul-ui/page";
import type {
  CatalogFolder,
  SessionSummary,
} from "@seosoyoung/soul-ui";
import type {
  RunbookItemRow,
  RunbookSnapshot,
} from "@seosoyoung/soul-ui/stores/runbook-store";

export type PlannerTaskStatus = "open" | "in_progress" | "review" | "completed";

const STATUS_PRESENTATION = {
  open: { icon: "○", label: "Open" },
  in_progress: { icon: "●", label: "진행" },
  review: { icon: "◆", label: "검수" },
  completed: { icon: "✓", label: "완료" },
} as const satisfies Record<PlannerTaskStatus, { icon: string; label: string }>;

export type MountedPageClassification =
  | { kind: "task"; runbookId: string }
  | { kind: "document" };

export function classifyMountedPage(
  blocks: readonly Pick<BlockDto, "block_type" | "properties">[],
): MountedPageClassification {
  for (const block of blocks) {
    if (block.block_type !== "runbook_ref") continue;
    const properties = block.properties as Record<string, unknown>;
    if (properties.primary !== true) continue;
    const runbookId = nonEmptyString(properties.runbookId);
    if (runbookId) return { kind: "task", runbookId };
  }
  return { kind: "document" };
}

export function parseSingleMountTitle(
  block: Pick<BlockDto, "block_type" | "text">,
): string | null {
  if (block.block_type !== "paragraph") return null;
  const match = /^\[\[([^\[\]]+)\]\]$/.exec(block.text.trim());
  return match ? nonEmptyString(match[1]) : null;
}

export function derivePlannerTaskStatus(snapshot: {
  runbook: { status?: string | null };
  items: readonly { status: string }[];
}): PlannerTaskStatus {
  const runbookStatus = snapshot.runbook.status;
  if (runbookStatus === "completed") return "completed";
  if (runbookStatus === "review") return "review";
  if (runbookStatus === "in_progress") return "in_progress";
  if (snapshot.items.some((item) => item.status === "review")) return "review";
  if (snapshot.items.some((item) => item.status === "in_progress")) return "in_progress";
  return "open";
}

export function plannerStatusPresentation(status: PlannerTaskStatus) {
  return STATUS_PRESENTATION[status];
}

export function plannerProgress(snapshot: RunbookSnapshot | null): number | null {
  if (!snapshot || snapshot.items.length === 0) return null;
  const completed = snapshot.items.filter((item) => item.status === "completed").length;
  return Math.round((completed / snapshot.items.length) * 100);
}

export function taskContextCount(blocks: readonly BlockDto[]): number {
  return blocks.filter((block) => (
    block.block_type !== "paragraph" && block.block_type !== "runbook_ref"
  )).length;
}

export function taskAssignee(snapshot: RunbookSnapshot | null): string {
  if (!snapshot) return "담당 미확인";
  const item = preferredAssigneeItem(snapshot.items);
  if (!item) return "담당 미지정";
  return item.assignee_agent_id
    ?? item.assignee_user_id
    ?? (item.assignee_session_id ? "세션 담당" : "담당 미지정");
}

export function latestRun(
  sessionIds: readonly string[],
  sessions: readonly SessionSummary[],
): { session: SessionSummary; number: number } | null {
  const allowed = new Set(sessionIds);
  const ordered = sessions
    .filter((session) => allowed.has(session.agentSessionId))
    .sort((left, right) => timestamp(left) - timestamp(right));
  const session = ordered.at(-1);
  return session ? { session, number: ordered.length } : null;
}

export function resolveProjectFolderId(
  page: Pick<PageDto, "id">,
  folders: readonly CatalogFolder[],
): string | null {
  return folders.find((folder) => folder.projectPageId === page.id)?.id ?? null;
}

function preferredAssigneeItem(items: readonly RunbookItemRow[]): RunbookItemRow | null {
  const active = items.find((item) => item.status === "in_progress")
    ?? items.find((item) => item.status === "review")
    ?? items.find((item) => item.status === "pending")
    ?? items[0];
  return active ?? null;
}

function timestamp(session: SessionSummary): number {
  const value = session.updatedAt ?? session.createdAt;
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
