import { FolderMessageError } from "./folder-messages";
import type { PageDto } from "../../../packages/page-model/src/types";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

export type FolderStarOperationIdFactory = (prefix: string) => string;

export async function setFolderStarred(
  api: PageApiClient,
  pageId: string,
  starred: boolean,
  idFactory: FolderStarOperationIdFactory = operationId,
): Promise<PageDto> {
  const current = await api.getPage(pageId);
  const updated = await api.setStarred(pageId, {
    starred,
    expectedVersion: current.page.version,
    idempotencyKey: idFactory("folder-star"),
    reason: "v3 planner folder star toggle",
  });
  return updated.page;
}

export function operationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new FolderMessageError("folders.errors.randomUuid");
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}
