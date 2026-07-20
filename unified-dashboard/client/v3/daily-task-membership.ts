import type { PageApiClient, PageDto, PageReadResponse } from "@seosoyoung/soul-ui/page";

import { loadAllMountBacklinks } from "./page-backlinks";

export type DailyTaskMembershipResult = "added" | "removed" | "unchanged";

interface DailyTaskMembershipInput {
  api: PageApiClient;
  dailyPageId: string;
  taskPage: Pick<PageDto, "id" | "title">;
  idempotencyKey(): string;
  reason: string;
}

export async function setDailyTaskMembership(
  input: DailyTaskMembershipInput & { present: boolean },
): Promise<DailyTaskMembershipResult> {
  return await mutateDailyTaskMembership(input, input.present);
}

export async function toggleDailyTaskMembership(
  input: DailyTaskMembershipInput,
): Promise<"added" | "removed"> {
  const result = await mutateDailyTaskMembership(input, null);
  if (result === "unchanged") {
    throw new Error("오늘 플래너 토글 결과를 결정하지 못했습니다");
  }
  return result;
}

async function mutateDailyTaskMembership(
  input: DailyTaskMembershipInput,
  requestedPresence: boolean | null,
): Promise<DailyTaskMembershipResult> {
  const snapshot = await input.api.getPage(input.dailyPageId);
  const mountBlockIds = await dailyMountBlockIds(
    input.api,
    input.dailyPageId,
    input.taskPage.id,
  );
  const currentlyPresent = mountBlockIds.length > 0;
  const nextPresent = requestedPresence ?? !currentlyPresent;
  if (nextPresent === currentlyPresent) return "unchanged";

  const idempotencyKey = input.idempotencyKey();
  await input.api.applyOperations(input.dailyPageId, {
    expectedVersion: snapshot.page.version,
    expectedStateVector: decodeStateVector(snapshot.state_vector),
    idempotencyKey,
    reason: input.reason,
    operations: nextPresent
      ? [createMountOperation(snapshot, input.taskPage.title, idempotencyKey)]
      : mountBlockIds.map((blockId) => ({
          op: "delete_block_subtree" as const,
          block_id: blockId,
        })),
  });
  return nextPresent ? "added" : "removed";
}

async function dailyMountBlockIds(
  api: PageApiClient,
  dailyPageId: string,
  taskPageId: string,
): Promise<string[]> {
  const backlinks = await loadAllMountBacklinks(api, taskPageId);
  return [...new Set(backlinks.flatMap((backlink) => (
    backlink.sourcePageId === dailyPageId && backlink.targetPageId === taskPageId
      ? [backlink.sourceBlockId]
      : []
  )))];
}

function createMountOperation(
  snapshot: PageReadResponse,
  taskTitle: string,
  idempotencyKey: string,
) {
  return {
    op: "create_block" as const,
    temp_id: `${idempotencyKey}:mount`,
    parent_id: null,
    after_block_id: snapshot.blocks
      .filter((block) => block.parent_id === null)
      .at(-1)?.id ?? null,
    block_type: "paragraph",
    text: `[[${taskTitle}]]`,
    properties: {},
    collapsed: false,
  };
}

function decodeStateVector(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
