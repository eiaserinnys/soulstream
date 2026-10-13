/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageSummarySnapshot } from "@seosoyoung/soul-ui";
import { useUsageSummary, type UseUsageSummaryOptions } from "./useUsageSummary";

const pasNode: UsageSummarySnapshot["nodes"][number] = {
  nodeId: "pas-node",
  fetchedAt: "2026-10-11T00:00:00.000Z",
  stale: false,
  staleSince: null,
  providers: {
    claude: {
      status: "auto",
      weeklyRemainingPercent: 73,
      weeklyResetAt: 1_900_000_000,
      shortRemainingPercent: null,
      shortResetAt: null,
      quotas: [],
    },
    codex: null,
    gemini: null,
  },
};
const otherNode: UsageSummarySnapshot["nodes"][number] = {
  ...pasNode,
  nodeId: "other-node",
  providers: {
    ...pasNode.providers,
    claude: { ...pasNode.providers.claude!, weeklyRemainingPercent: 41 },
    codex: {
      status: "auto",
      weeklyRemainingPercent: 22,
      weeklyResetAt: null,
      shortRemainingPercent: null,
      shortResetAt: null,
      quotas: [],
    },
  },
};
const usage: UsageSummarySnapshot = {
  generatedAt: "2026-10-11T00:00:00.000Z",
  collectedAt: null,
  nodes: [pasNode, otherNode],
};

type Props = UseUsageSummaryOptions;
function Probe(props: Props) {
  const state = useUsageSummary(props);
  return <div>
    <output data-testid="state" data-load-state={state.loadState} data-loading={String(state.loading)}>
      <span data-max-gauge-count={state.maxGaugeCount} />
      {state.node?.nodeId ?? "none"}:{state.gauges.map((gauge) => `${gauge.id}=${gauge.remainingPercent}`).join(",")}
    </output>
    <button type="button" onClick={state.retry}>retry</button>
  </div>;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(props: Props) {
  await act(async () => root.render(<Probe {...props} />));
}

function currentState() {
  return container.querySelector("[data-testid=state]") as HTMLOutputElement;
}

function response(value: UsageSummarySnapshot) {
  return Response.json(value);
}

describe("useUsageSummary", () => {
  it("loads immediately, stops while closed, reopens immediately, retains a failed refresh, retries, then resets on scope change", async () => {
    let resolveScopeRequest!: (value: Response) => void;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(usage))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response(usage))
      .mockResolvedValueOnce(response(usage))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveScopeRequest = resolve; }));
    const initial: Props = {
      enabled: true,
      nodeId: "pas-node",
      scopeKey: "account-a",
      request,
    };

    await render(initial);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(currentState().textContent).toContain("claude=73");

    await render({ ...initial, selectedNodeId: "other-node" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(currentState().dataset.loadState).toBe("ready");
    expect(currentState().textContent).toContain("other-node:claude=41,codex=22");
    expect(currentState().firstElementChild?.getAttribute("data-max-gauge-count")).toBe("2");

    await render({ ...initial, selectedNodeId: "missing-node" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(currentState().textContent).toContain("pas-node:claude=73");

    await render({ ...initial, selectedNodeId: "other-node" });
    await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000); });
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(currentState().dataset.loadState).toBe("connectionError");
    expect(currentState().textContent).toContain("other-node:claude=41,codex=22");

    await render({ ...initial, selectedNodeId: "pas-node" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(currentState().textContent).toContain("pas-node:claude=73");

    const retry = container.querySelector("button") as HTMLButtonElement;
    await act(async () => retry.click());
    await settle();
    expect(request).toHaveBeenCalledTimes(3);
    expect(currentState().dataset.loadState).toBe("ready");

    await render({ ...initial, enabled: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000); });
    expect(request).toHaveBeenCalledTimes(3);

    await render(initial);
    await settle();
    expect(request).toHaveBeenCalledTimes(4);
    expect(currentState().dataset.loadState).toBe("ready");

    await render({ ...initial, scopeKey: "account-b" });
    expect(currentState().textContent).toContain("none:");
    expect(currentState().dataset.loading).toBe("true");
    expect(request).toHaveBeenCalledTimes(5);
    await act(async () => resolveScopeRequest(response(usage)));
    await settle();
    expect(currentState().textContent).toContain("claude=73");
  });

  it("hides same-scope cached values after a 404", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(usage))
      .mockResolvedValueOnce(new Response("pending", { status: 404 }));
    const props: Props = { enabled: true, nodeId: "pas-node", scopeKey: "account-a", request };

    await render(props);
    await settle();
    await render({ ...props, enabled: false });
    await render(props);
    await settle();

    expect(currentState().dataset.loadState).toBe("serverPending");
    expect(currentState().textContent).toContain("none:");
    expect(currentState().textContent).not.toContain("claude=73");
  });
});
