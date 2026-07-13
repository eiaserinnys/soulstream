// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { PageRichText } from "@seosoyoung/soul-ui/page-editor";

import { V2BacklinksPanel } from "./V2BacklinksPanel";

describe("page and runbook reference navigation", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    flushSync(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("navigates from a page mention to a runbook page and back through its backlink", async () => {
    const onOpenSource = vi.fn();
    const api = createApi();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => root!.render(
      <ReferenceNavigationHarness apiClient={api} onOpenSource={onOpenSource} />,
    ));
    await waitFor(() => container!.querySelector('[data-reference-state="ready"]') !== null);

    flushSync(() => container!.querySelector<HTMLButtonElement>('[data-reference-kind="page"]')!.click());
    await waitFor(() => container!.querySelector('[data-testid="v2-backlinks-panel"]') !== null);
    await waitFor(() => container!.querySelector('[data-backlink-id="link-source"]') !== null);

    expect(api.getBacklinks).toHaveBeenCalledWith("runbook-page", {
      kinds: ["mount", "inline_page", "block_ref"],
      limit: 20,
    });
    flushSync(() => container!.querySelector<HTMLButtonElement>('[data-backlink-id="link-source"]')!.click());
    expect(onOpenSource).toHaveBeenCalledWith("source-page", "source-block");
  });
});

function ReferenceNavigationHarness({
  apiClient,
  onOpenSource,
}: {
  apiClient: PageApiClient;
  onOpenSource(pageId: string, blockId: string): void;
}) {
  const [pageId, setPageId] = useState("source-page");
  return pageId === "source-page" ? (
    <PageRichText
      blockId="source-block"
      text="See [[Runbook Alpha]]"
      apiClient={apiClient}
      onEdit={() => undefined}
      onOpenPage={setPageId}
    />
  ) : (
    <V2BacklinksPanel pageId={pageId} apiClient={apiClient} onOpenSource={onOpenSource} />
  );
}

function createApi(): PageApiClient {
  return {
    listPages: vi.fn(),
    searchPages: vi.fn(async () => ({
      items: [{ pageId: "runbook-page", title: "Runbook Alpha" }],
    })),
    searchBlocks: vi.fn(),
    getBlock: vi.fn(),
    getBacklinks: vi.fn(async () => ({
      items: [{
        id: "link-source",
        sourcePageId: "source-page",
        sourcePageTitle: "Source page",
        sourceBlockId: "source-block",
        sourceTextPreview: "See Runbook Alpha",
        linkKind: "inline_page" as const,
        targetPageId: "runbook-page",
        targetBlockId: null,
        sourceStart: 4,
        sourceEnd: 21,
      }],
      nextCursor: null,
    })),
    getPage: vi.fn(),
    getDailyPage: vi.fn(),
    applyOperations: vi.fn(),
    transferBlocks: vi.fn(),
    setStarred: vi.fn(),
  } as PageApiClient;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (predicate()) return;
  }
  throw new Error("condition not met");
}
