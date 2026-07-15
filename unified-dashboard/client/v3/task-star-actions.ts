import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

export type TaskStarOperationIdFactory = (prefix: string) => string;

export async function setTaskStarred(
  api: PageApiClient,
  pageId: string,
  starred: boolean,
  idFactory: TaskStarOperationIdFactory = operationId,
): Promise<PageDto> {
  const current = await api.getPage(pageId);
  const updated = await api.setStarred(pageId, {
    starred,
    expectedVersion: current.page.version,
    idempotencyKey: idFactory("task-star"),
    reason: "v3 planner task star toggle",
  });
  return updated.page;
}

function operationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("브라우저 randomUUID 지원이 필요합니다");
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}
