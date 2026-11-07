/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@seosoyoung/soul-ui", async () => {
  const usage = await import("../../../packages/soul-ui/src/lib/usage-summary");
  return {
    ...usage,
    cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
    nodeIdToHue: () => 200,
    useTheme: () => ["dark", () => undefined],
    ScrollArea: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => <div {...props}>{children}</div>,
    DashboardIconCap: ({ label, ...props }: { label?: string } & Record<string, unknown>) => (
      <button type="button" aria-label={label} {...props} />
    ),
  };
});

vi.mock("./CogitoHealthPanel", () => ({ CogitoHealthPanel: () => null }));
vi.mock("./NodeProvidersPanel", () => ({
  NodeProvidersPanel: (props: { node: { fetchedAt: string | null } | null; loading: boolean }) => (
    <div
      data-testid="providers"
      data-fetched-at={props.node?.fetchedAt ?? ""}
      data-loading={String(props.loading)}
    />
  ),
}));

import { NodePanel } from "./NodePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function data(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function summaryNode(fetchedAt: string | null, stale = false, staleSince: string | null = null) {
  return {
    nodeId: "node-a",
    fetchedAt,
    stale,
    staleSince,
    providers: { claude: null, codex: null, antigravity: null, opencode_go: null },
  };
}

function snapshot(node: ReturnType<typeof summaryNode>) {
  return { generatedAt: "2026-11-07T15:50:00+09:00", collectedAt: "2026-11-07T15:50:00+09:00", nodes: [node] };
}

const hourMinute = (iso: string) => new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(new Date(iso));

function nodesMap() {
  return new Map([["node-a", { nodeId: "node-a", status: "connected" }]]);
}

describe("NodePanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });

  async function settle() {
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function mount(request: typeof fetch) {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <NodePanel request={request} sampleNodes={nodesMap() as never} />
      </QueryClientProvider>,
    ));
    await settle();
  }

  const card = () => host.querySelector<HTMLElement>('[data-testid="node-card"]')!;
  const head = () => card().firstElementChild as HTMLElement;
  const providers = () => host.querySelector<HTMLElement>('[data-testid="providers"]');

  async function expand() {
    await act(async () => head().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
  }

  it("fetches the usage summary only after the node is expanded", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/usage/summary")) return data(snapshot(summaryNode("2026-11-07T15:50:00+09:00")));
      return data({});
    });

    await mount(request as unknown as typeof fetch);
    expect(request.mock.calls.some(([input]) => String(input).endsWith("/api/usage/summary"))).toBe(false);

    await expand();
    expect(request.mock.calls.some(([input]) => String(input).endsWith("/api/usage/summary"))).toBe(true);
    expect(providers()).not.toBeNull();
  });

  it("shows the update time of the expanded node next to the node name", async () => {
    const request = vi.fn(async () => data(snapshot(summaryNode("2026-11-07T15:50:00+09:00"))));

    await mount(request as unknown as typeof fetch);
    await expand();

    expect(head().textContent).toContain(`${hourMinute("2026-11-07T15:50:00+09:00")} 갱신`);
    expect(head().querySelector('button[aria-label="사용량 새로 고침"]')).not.toBeNull();
  });

  it("marks a stale summary with the collection delay badge", async () => {
    const request = vi.fn(async () => data(snapshot(summaryNode("2026-11-07T14:00:00+09:00", true, "2026-11-07T15:20:00+09:00"))));

    await mount(request as unknown as typeof fetch);
    await expand();

    expect(head().textContent).toContain(`수집 지연 · ${hourMinute("2026-11-07T15:20:00+09:00")}`);
    expect(head().textContent).not.toContain("갱신");
  });

  it("posts a refresh, keeps the node expanded and swaps in the returned snapshot", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/usage/refresh")) return data(snapshot(summaryNode("2026-11-07T16:05:00+09:00")));
      return data(snapshot(summaryNode("2026-11-07T15:50:00+09:00")));
    });

    await mount(request as unknown as typeof fetch);
    await expand();
    expect(providers()?.dataset.fetchedAt).toBe("2026-11-07T15:50:00+09:00");

    const refreshCap = head().querySelector<HTMLButtonElement>('button[aria-label="사용량 새로 고침"]')!;
    await act(async () => refreshCap.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    const refreshCall = request.mock.calls.find(([input]) => String(input).endsWith("/api/usage/refresh"));
    expect(refreshCall).toBeDefined();
    expect(providers()?.dataset.fetchedAt).toBe("2026-11-07T16:05:00+09:00");
    expect(head().textContent).toContain(`${hourMinute("2026-11-07T16:05:00+09:00")} 갱신`);
  });

  it("keeps the previous values and marks the failure when the refresh fails", async () => {
    let failRefresh = false;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/usage/refresh")) {
        if (failRefresh) throw new TypeError("network down");
        return data(snapshot(summaryNode("2026-11-07T16:05:00+09:00")));
      }
      return data(snapshot(summaryNode("2026-11-07T15:50:00+09:00")));
    });

    await mount(request as unknown as typeof fetch);
    await expand();
    failRefresh = true;

    const refreshCap = head().querySelector<HTMLButtonElement>('button[aria-label="사용량 새로 고침"]')!;
    await act(async () => refreshCap.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    expect(providers()?.dataset.fetchedAt).toBe("2026-11-07T15:50:00+09:00");
    expect(head().textContent).toContain("갱신 실패");
    expect(providers()).not.toBeNull();
  });

  it("does not collapse the node when the refresh cap is pressed", async () => {
    const request = vi.fn(async () => data(snapshot(summaryNode("2026-11-07T15:50:00+09:00"))));

    await mount(request as unknown as typeof fetch);
    await expand();

    const refreshCap = head().querySelector<HTMLButtonElement>('button[aria-label="사용량 새로 고침"]')!;
    await act(async () => refreshCap.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    expect(providers()).not.toBeNull();
  });
});
