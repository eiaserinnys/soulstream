import type { BrowserBacklinkDto, PageApiClient } from "@seosoyoung/soul-ui/page";

export async function loadAllMountBacklinks(
  api: PageApiClient,
  pageId: string,
): Promise<BrowserBacklinkDto[]> {
  const items: BrowserBacklinkDto[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await api.getBacklinks(pageId, {
      kinds: ["mount"],
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("마운트 목록 커서가 반복되었습니다");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}
