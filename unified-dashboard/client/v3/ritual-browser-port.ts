import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { setDailyFolderMembership } from "./daily-folder-membership";
import type { RitualActionPort } from "./ritual-model";

export class BrowserRitualActionPort implements RitualActionPort {
  constructor(
    private readonly dailyPageId: string,
    private readonly api: PageApiClient,
  ) {}

  async mountToday(input: { folderPageId: string; folderTitle: string }) {
    await mountRitualFolderToday(
      this.api,
      this.dailyPageId,
      input.folderPageId,
      input.folderTitle,
    );
  }

  async removeFromDaily(input: {
    dailyPageId: string;
    folderPageId: string;
    folderTitle: string;
  }) {
    await removeRitualFolderFromDaily(
      this.api,
      input.dailyPageId,
      input.folderPageId,
      input.folderTitle,
    );
  }
}

export async function mountRitualFolderToday(
  api: PageApiClient,
  dailyPageId: string,
  folderPageId: string,
  folderTitle: string,
): Promise<void> {
  await setDailyFolderMembership({
    api,
    dailyPageId,
    folderPage: { id: folderPageId, title: folderTitle },
    present: true,
    idempotencyKey: () => ritualOperationId("daily-mount"),
    reason: "v3 morning ritual daily mount",
  });
}

export async function removeRitualFolderFromDaily(
  api: PageApiClient,
  dailyPageId: string,
  folderPageId: string,
  folderTitle: string,
  idFactory: () => string = () => ritualOperationId("daily-unmount"),
): Promise<void> {
  await setDailyFolderMembership({
    api,
    dailyPageId,
    folderPage: { id: folderPageId, title: folderTitle },
    present: false,
    idempotencyKey: idFactory,
    reason: "v3 morning ritual daily unmount",
  });
}

function ritualOperationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("브라우저 randomUUID 지원이 필요합니다");
  }
  return `ritual-${prefix}-${globalThis.crypto.randomUUID()}`;
}
