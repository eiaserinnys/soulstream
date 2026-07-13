import { describe, expect, it } from "vitest";

import {
  createPageEditorPendingHandle,
  hasPendingPageEditorMutations,
  waitForPageEditorMutationsToFlush,
} from "./page-editor-pending-registry";

describe("page editor pending registry", () => {
  it("waits for every active editor controller to flush", async () => {
    const first = createPageEditorPendingHandle();
    const second = createPageEditorPendingHandle();
    first.setPending(true);
    second.setPending(true);

    const flushed = waitForPageEditorMutationsToFlush();
    first.setPending(false);
    expect(hasPendingPageEditorMutations()).toBe(true);
    second.dispose();

    await expect(flushed).resolves.toBe(true);
    expect(hasPendingPageEditorMutations()).toBe(false);
  });
});
