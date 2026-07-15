/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOrchestratorStore, type OrchestratorNode } from "../store/orchestrator-store";
import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";

function node(nodeId: string): OrchestratorNode {
  return {
    nodeId,
    host: "127.0.0.1",
    port: 5200,
    status: "connected",
    capabilities: {},
    connectedAt: 1,
    sessionCount: 0,
  };
}

function response(agents: Array<{ id: string; name: string }>) {
  return Promise.resolve({
    ok: true,
    json: async () => ({ agents }),
  } as Response);
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 40; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("AgentNodeAssignmentFields", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useOrchestratorStore.setState({
      nodes: new Map([
        ["node-a", node("node-a")],
        ["node-b", node("node-b")],
      ]),
      connectionStatus: "connected",
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    useOrchestratorStore.setState({ nodes: new Map(), connectionStatus: "connecting" });
  });

  it("fetches once per node, keeps options during refresh, and ignores callback identity churn", async () => {
    let resolveNodeB: (value: Response) => void = () => {
      throw new Error("node-b 요청이 시작되지 않았습니다.");
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("node-a")) return response([{ id: "agent-a", name: "에이전트 A" }]);
      return new Promise<Response>((resolve) => { resolveNodeB = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);

    const render = (nodeId: string, agentId: string) => {
      flushSync(() => {
        root.render(createElement(AgentNodeAssignmentFields, {
          nodeId,
          agentId,
          fallbackToAvailable: true,
          onNodeIdChange: vi.fn(),
          onAgentIdChange: vi.fn(),
          onAgentInfoChange: vi.fn(),
          onError: vi.fn(),
        }));
      });
    };

    render("node-a", "");
    await waitFor(() => expect(container.textContent).toContain("에이전트 A"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    render("node-a", "agent-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("에이전트 A");

    render("node-b", "agent-a");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(container.textContent).toContain("에이전트 A");

    resolveNodeB({
      ok: true,
      json: async () => ({ agents: [{ id: "agent-b", name: "에이전트 B" }] }),
    } as Response);
    await waitFor(() => expect(container.textContent).toContain("에이전트 B"));
    expect(container.textContent).not.toContain("에이전트 A");
  });
});
