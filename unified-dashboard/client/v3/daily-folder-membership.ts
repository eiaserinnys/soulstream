import type { PageApiClient, PageDto, PageReadResponse } from "@seosoyoung/soul-ui/page";

import { loadAllMountBacklinks } from "./page-backlinks";

export type DailyFolderMembershipResult = "added" | "removed" | "unchanged";

interface DailyFolderMembershipInput {
  api: PageApiClient;
  dailyPageId: string;
  folderPage: Pick<PageDto, "id" | "title">;
  idempotencyKey(): string;
  reason: string;
}

export async function setDailyFolderMembership(
  input: DailyFolderMembershipInput & { present: boolean },
): Promise<DailyFolderMembershipResult> {
  return await mutateDailyFolderMembership(input, input.present);
}

export async function toggleDailyFolderMembership(
  input: DailyFolderMembershipInput,
): Promise<"added" | "removed"> {
  const result = await mutateDailyFolderMembership(input, null);
  if (result === "unchanged") {
    throw new Error("오늘 플래너 토글 결과를 결정하지 못했습니다");
  }
  return result;
}

async function mutateDailyFolderMembership(
  input: DailyFolderMembershipInput,
  requestedPresence: boolean | null,
): Promise<DailyFolderMembershipResult> {
  const snapshot = await input.api.getPage(input.dailyPageId);
  const mountBlockIds = await dailyMountBlockIds(
    input.api,
    input.dailyPageId,
    input.folderPage.id,
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
      ? [createMountOperation(snapshot, input.folderPage.title, idempotencyKey)]
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
  folderPageId: string,
): Promise<string[]> {
  const backlinks = await loadAllMountBacklinks(api, folderPageId);
  return [...new Set(backlinks.flatMap((backlink) => (
    backlink.sourcePageId === dailyPageId && backlink.targetPageId === folderPageId
      ? [backlink.sourceBlockId]
      : []
  )))];
}

function createMountOperation(
  snapshot: PageReadResponse,
  folderTitle: string,
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
    text: `[[${folderTitle}]]`,
    properties: {},
    collapsed: false,
  };
}

function decodeStateVector(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
