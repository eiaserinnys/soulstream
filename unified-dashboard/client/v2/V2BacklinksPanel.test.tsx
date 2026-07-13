/** @vitest-environment jsdom */
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { V2BacklinksPanel } from "./V2BacklinksPanel";

describe("V2BacklinksPanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    flushSync(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("distinguishes kinds, follows source blocks, paginates, and isolates a deleted source", async () => {
    const getBacklinks = vi.fn()
      .mockResolvedValueOnce({
        items: [
          backlink("mount", "mount-source", "Mounted page"),
          backlink("inline_page", "inline-source", "Mentioned page"),
          backlink("block_ref", "block-source", "Referenced block"),
        ],
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        items: [{ ...backlink("block_ref", "deleted-source", ""), sourcePageId: "", sourceBlockId: "" }],
        nextCursor: null,
      });
    const onOpenSource = vi.fn();
    render(api({ getBacklinks }), onOpenSource);
    await waitFor(() => container!.textContent?.includes("Referenced block") === true);

    expect(container!.textContent).toContain("Mount");
    expect(container!.textContent).toContain("Page mention");
    expect(container!.textContent).toContain("Block reference");
    flushSync(() => container!.querySelector<HTMLButtonElement>('[data-backlink-id="inline-source"]')!.click());
    expect(onOpenSource).toHaveBeenCalledWith("page-inline-source", "block-inline-source");

    flushSync(() => container!.querySelector<HTMLButtonElement>('[data-testid="backlinks-load-more"]')!.click());
    await waitFor(() => container!.textContent?.includes("unavailable or deleted") === true);
    expect(getBacklinks).toHaveBeenNthCalledWith(2, "page-current", {
      kinds: ["mount", "inline_page", "block_ref"],
      cursor: "next-page",
      limit: 20,
    });
  });

  it("does not append an old page cursor after navigation", async () => {
    let resolveOldPage!: (value: { items: ReturnType<typeof backlink>[]; nextCursor: null }) => void;
    const getBacklinks = vi.fn()
      .mockResolvedValueOnce({ items: [backlink("mount", "old", "Old page")], nextCursor: "old-cursor" })
      .mockImplementationOnce(() => new Promise<{ items: ReturnType<typeof backlink>[]; nextCursor: null }>((resolve) => {
        resolveOldPage = resolve;
      }))
      .mockResolvedValueOnce({ items: [backlink("inline_page", "new", "New page")], nextCursor: null });
    const client = api({ getBacklinks });
    render(client, vi.fn());
    await waitFor(() => container!.textContent?.includes("Old page") === true);

    flushSync(() => container!.querySelector<HTMLButtonElement>('[data-testid="backlinks-load-more"]')!.click());
    flushSync(() => root!.render(
      <V2BacklinksPanel pageId="page-next" apiClient={client} onOpenSource={vi.fn()} />,
    ));
    await waitFor(() => container!.textContent?.includes("New page") === true);

    resolveOldPage({ items: [backlink("block_ref", "stale", "Stale page")], nextCursor: null });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container!.textContent).not.toContain("Stale page");
    expect(container!.textContent).toContain("New page");
  });

  function render(client: PageApiClient, onOpenSource: (pageId: string, blockId: string) => void) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <V2BacklinksPanel pageId="page-current" apiClient={client} onOpenSource={onOpenSource} />,
    ));
  }
});

function backlink(kind: "mount" | "inline_page" | "block_ref", id: string, preview: string) {
  return {
    id,
    sourcePageId: `page-${id}`,
    sourcePageTitle: `Page ${id}`,
    sourceBlockId: `block-${id}`,
    sourceTextPreview: preview,
    linkKind: kind,
    targetPageId: "page-current",
    targetBlockId: null,
    sourceStart: 0,
    sourceEnd: 1,
  };
}

function api(overrides: Partial<PageApiClient>): PageApiClient {
  return {
    listPages: vi.fn(),
    searchPages: vi.fn(),
    searchBlocks: vi.fn(),
    getBlock: vi.fn(),
    getBacklinks: vi.fn(),
    getPage: vi.fn(),
    getDailyPage: vi.fn(),
    applyOperations: vi.fn(),
    setStarred: vi.fn(),
    ...overrides,
    transferBlocks: overrides.transferBlocks ?? vi.fn(),
  };
}

async function waitFor(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
