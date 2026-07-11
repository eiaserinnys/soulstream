/**
 * @vitest-environment jsdom
 */

import * as React from "react";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageApiError, type PageApiClient, type PageDto, type PageYjsClient } from "@seosoyoung/soul-ui/page";
import { createV2PageRouteController } from "./useV2PageRoute";
import { useV2PageWorkspace } from "./useV2PageWorkspace";

const page: PageDto = {
  id: "page-daily",
  title: "Daily",
  daily_date: "2026-07-12",
  version: 1,
  archived: false,
  metadata: { starred: false },
  created_at: "2026-07-12T00:00:00Z",
  updated_at: "2026-07-12T00:00:00Z",
};

function createTarget(pathname: string) {
  const listeners = new Set<() => void>();
  const target = {
    location: { pathname },
    history: {
      pushState: vi.fn((_state: unknown, _unused: string, path: string) => { target.location.pathname = path; }),
      replaceState: vi.fn((_state: unknown, _unused: string, path: string) => { target.location.pathname = path; }),
    },
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  };
  return target;
}

function createApi(overrides: Partial<PageApiClient> = {}): PageApiClient {
  return {
    listPages: vi.fn(async () => ({ items: [], next_cursor: null })),
    getPage: vi.fn(async () => ({ page, blocks: [], state_vector: "" })),
    getDailyPage: vi.fn(async () => ({ page, created: false })),
    applyOperations: vi.fn(),
    setStarred: vi.fn(async (_pageId, input) => ({
      page: { ...page, version: page.version + 1, metadata: { starred: input.starred } },
      blocks: [],
      operation: { id: "op-1" },
      temp_id_mapping: {},
    })),
    ...overrides,
  };
}

function createReadyClient(pageId: string): PageYjsClient {
  const snapshot = { status: "ready", ready: true, connected: true, synced: true, error: null } as const;
  const documentSnapshot = {
    page: { id: pageId, title: "Daily", dailyDate: "2026-07-12", mutationVersion: 1, archived: false, metadata: { starred: false } },
    blocks: [],
  } as const;
  return {
    pageId,
    doc: {} as PageYjsClient["doc"],
    awareness: {} as PageYjsClient["awareness"],
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    getProjection: () => ({
      getSnapshot: () => documentSnapshot,
      subscribe: () => () => undefined,
      destroy: vi.fn(),
    }),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    destroy: vi.fn(),
  };
}

function Harness({ api, pathname, createClient = createReadyClient }: {
  api: PageApiClient;
  pathname: string;
  createClient?: (pageId: string) => PageYjsClient;
}) {
  const target = React.useMemo(() => createTarget(pathname), [pathname]);
  const controller = React.useMemo(() => createV2PageRouteController(target), [target]);
  const workspace = useV2PageWorkspace({ apiClient: api, routeController: controller, createPageClient: createClient });
  React.useEffect(() => () => controller.destroy(), [controller]);
  return createElement(
    "div",
    null,
    createElement("output", {
      "data-status": workspace.pageState.status,
      "data-page-id": workspace.selectedPageId ?? "",
      "data-path": target.location.pathname,
      "data-starred": workspace.pageState.status === "ready"
        ? String(workspace.pageState.page.metadata.starred === true)
        : "",
    }, workspace.pageState.status === "ready" ? workspace.pageState.page.title : workspace.pageState.message),
    createElement("button", {
      type: "button",
      "data-testid": "toggle-star",
      onClick: () => { void workspace.toggleCurrentPageStar(); },
    }),
  );
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("useV2PageWorkspace", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  async function render(
    api: PageApiClient,
    pathname: string,
    createClient?: (pageId: string) => PageYjsClient,
    strict = false,
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const harness = createElement(Harness, { api, pathname, createClient });
    flushSync(() => root!.render(strict ? createElement(React.StrictMode, null, harness) : harness));
    await settle();
    return container.querySelector("output")!;
  }

  it("lazy get-or-creates daily once and replaces /v2 with its deep link", async () => {
    const api = createApi();
    const output = await render(api, "/v2", undefined, true);
    expect(api.getDailyPage).toHaveBeenCalledTimes(1);
    expect(api.getPage).toHaveBeenCalledWith("page-daily");
    expect(output.dataset.path).toBe("/v2/pages/page-daily");
    expect(output.dataset.status).toBe("ready");
  });

  it("restores a deep link without calling daily", async () => {
    const api = createApi();
    const output = await render(api, "/v2/pages/page-daily");
    expect(api.getDailyPage).not.toHaveBeenCalled();
    expect(api.getPage).toHaveBeenCalledWith("page-daily");
    expect(output.dataset.status).toBe("ready");
  });

  it("shows HTTP authentication failure explicitly", async () => {
    const api = createApi({
      getPage: vi.fn(async () => { throw new PageApiError("Sign in again", 401, "authentication"); }),
    });
    const output = await render(api, "/v2/pages/page-daily");
    expect(output.dataset.status).toBe("authentication");
    expect(output.textContent).toContain("Sign in again");
  });

  it("shows websocket authentication failure explicitly", async () => {
    const createClient = (pageId: string) => {
      const client = createReadyClient(pageId);
      const authenticationSnapshot = {
        status: "authentication_failed",
        ready: false,
        connected: false,
        synced: false,
        error: { kind: "authentication", message: "Page sync denied" },
      } as const;
      return {
        ...client,
        getSnapshot: () => authenticationSnapshot,
      } as PageYjsClient;
    };
    const output = await render(createApi(), "/v2/pages/page-daily", createClient);
    expect(output.dataset.status).toBe("authentication");
    expect(output.textContent).toContain("Page sync denied");
  });

  it("shows a disconnected websocket as an error instead of an endless loading page", async () => {
    const createClient = (pageId: string) => {
      const client = createReadyClient(pageId);
      const disconnectedSnapshot = {
        status: "disconnected",
        ready: false,
        connected: false,
        synced: false,
        error: { kind: "connection", message: "Page sync disconnected" },
      } as const;
      return { ...client, getSnapshot: () => disconnectedSnapshot } as PageYjsClient;
    };
    const output = await render(createApi(), "/v2/pages/page-daily", createClient);
    expect(output.dataset.status).toBe("error");
    expect(output.textContent).toContain("Page sync disconnected");
  });

  it("uses the current page version for an explicit starred toggle", async () => {
    const api = createApi();
    await render(api, "/v2/pages/page-daily");
    flushSync(() => {
      container!.querySelector<HTMLButtonElement>('[data-testid="toggle-star"]')!.click();
    });
    await settle();
    expect(api.setStarred).toHaveBeenCalledWith("page-daily", expect.objectContaining({
      starred: true,
      expectedVersion: 1,
    }));
    expect(container!.querySelector("output")!.getAttribute("data-starred")).toBe("true");
  });
});
