import type { ApiClient } from '../api/client';
import type { PageReadResult } from '../api/pageEndpoints';

export async function readPlannerPageIfCurrent(input: {
  client: ApiClient;
  pageId: string;
  isCurrent(): boolean;
  canApply?: () => boolean;
  reconcile(result: PageReadResult): void;
  onFailure(): void;
}): Promise<boolean> {
  if (!input.isCurrent()) return false;
  try {
    const result = await input.client.getPage(input.pageId);
    if (!input.isCurrent() || (input.canApply && !input.canApply())) return false;
    input.reconcile(result);
    return true;
  } catch {
    if (input.canApply?.() && input.isCurrent()) input.onFailure();
    return false;
  }
}
