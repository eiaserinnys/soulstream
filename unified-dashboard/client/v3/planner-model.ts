import { type FolderTranslate } from "./folder-messages";
import type { BlockDto, PageDto } from "../../../packages/page-model/src/types";
import type {
  CatalogFolder,
  PlannerFolderStatus,
  SessionSummary,
} from "@seosoyoung/soul-ui";

const STATUS_PRESENTATION = {
  open: { icon: "○", label: "folders.planner.statusOpen" },
  in_progress: { icon: "●", label: "folders.planner.inProgress" },
  review: { icon: "◆", label: "folders.planner.review" },
  completed: { icon: "✓", label: "folders.planner.completed" },
} as const satisfies Record<PlannerFolderStatus, { icon: string; label: string }>;

export function derivePlannerFolderStatus(snapshot: {
  folder: { status: "open" | "completed" };
  cards: readonly { status: string }[];
}): PlannerFolderStatus {
  if (snapshot.folder.status === "completed") return "completed";
  if (snapshot.cards.some((item) => item.status === "review")) return "review";
  if (snapshot.cards.some((item) => item.status === "running")) return "in_progress";
  return "open";
}

export function plannerStatusPresentation(status: PlannerFolderStatus, t: FolderTranslate) {
  const { icon, label } = STATUS_PRESENTATION[status];
  return { icon, label: t(label) };
}

export function folderContextCount(blocks: readonly BlockDto[]): number {
  return blocks.filter((block) => (
    block.block_type !== "paragraph" && block.block_type !== "folder_ref"
  )).length;
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

function timestamp(session: SessionSummary): number {
  const value = session.updatedAt ?? session.createdAt;
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
