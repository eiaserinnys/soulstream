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

function presetResponse(modelPresets: Array<Record<string, unknown>>) {
  return Promise.resolve({
    ok: true,
    json: async () => ({ model_presets: modelPresets }),
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
      if (url.includes("model-presets")) return presetResponse([]);
      if (url.includes("node-a")) return response([{ id: "agent-a", name: "에이전트 A" }]);
      return new Promise<Response>((resolve) => { resolveNodeB = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);

    const render = (nodeId: string, agentId: string) => {
      flushSync(() => {
        root.render(createElement(AgentNodeAssignmentFields, {
          nodeId,
          agentId,
          modelPreset: "",
          fallbackToAvailable: true,
          onNodeIdChange: vi.fn(),
          onAgentIdChange: vi.fn(),
          onModelPresetChange: vi.fn(),
          onAgentInfoChange: vi.fn(),
          onError: vi.fn(),
        }));
      });
    };

    render("node-a", "");
    await waitFor(() => expect(container.textContent).toContain("에이전트 A"));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    render("node-a", "agent-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("에이전트 A");

    render("node-b", "agent-a");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(container.textContent).toContain("에이전트 A");

    resolveNodeB({
      ok: true,
      json: async () => ({ agents: [{ id: "agent-b", name: "에이전트 B" }] }),
    } as Response);
    await waitFor(() => expect(container.textContent).toContain("에이전트 B"));
    expect(container.textContent).not.toContain("에이전트 A");
  });

  it("renders the session assignment as node then agent without execution terminology", () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("model-presets") ? presetResponse([]) : response([])
    ));

    flushSync(() => {
      root.render(createElement(AgentNodeAssignmentFields, {
        nodeId: "node-a",
        agentId: "",
        modelPreset: "",
        presentation: "session",
        onNodeIdChange: vi.fn(),
        onAgentIdChange: vi.fn(),
        onModelPresetChange: vi.fn(),
      }));
    });

    const labels = [...container.querySelectorAll("label")].map((label) =>
      label.firstChild?.textContent?.trim(),
    );
    expect(labels).toEqual(["노드", "에이전트", "모델"]);
    expect(container.textContent).not.toContain("실행");
  });

  it("shows unavailable presets as disabled and keeps usage warnings selectable", async () => {
    const onValidityChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("model-presets")
        ? presetResponse([
            {
              id: "preset-limited",
              label: "프리셋 제한",
              backend: "backend-a",
              available: false,
              reason: "quota_exhausted",
              reason_label: "주간 사용량 제한",
              resets_at: null,
              usage_warning: false,
            },
            {
              id: "preset-warning",
              label: "프리셋 경고",
              backend: "backend-a",
              available: true,
              reason: null,
              reason_label: null,
              resets_at: null,
              usage_warning: true,
            },
          ])
        : response([{ id: "agent-a", name: "에이전트 A" }])
    ));

    const render = (modelPreset: string) => {
      flushSync(() => {
        root.render(createElement(AgentNodeAssignmentFields, {
          nodeId: "node-a",
          agentId: "agent-a",
          modelPreset,
          presentation: "session",
          onNodeIdChange: vi.fn(),
          onAgentIdChange: vi.fn(),
          onModelPresetChange: vi.fn(),
          onModelPresetValidityChange: onValidityChange,
        }));
      });
    };

    render("preset-limited");
    await waitFor(() => expect(
      container.querySelector<HTMLOptionElement>('option[value="preset-limited"]')?.disabled,
    ).toBe(true));
    expect(container.textContent).toContain(
      "선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.",
    );
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));

    render("preset-warning");
    await waitFor(() => expect(container.textContent).toContain("(사용량 확인 지연)"));
    expect(container.querySelector<HTMLOptionElement>('option[value="preset-warning"]')?.disabled)
      .toBe(false);
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  });

  it("keeps submission valid when preset availability cannot be loaded", async () => {
    const onValidityChange = vi.fn();
    const onError = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("model-presets")
        ? Promise.reject(new Error("catalog unavailable"))
        : response([{ id: "agent-a", name: "에이전트 A" }])
    ));

    flushSync(() => {
      root.render(createElement(AgentNodeAssignmentFields, {
        nodeId: "node-a",
        agentId: "agent-a",
        modelPreset: "preset-inherited",
        presentation: "session",
        onNodeIdChange: vi.fn(),
        onAgentIdChange: vi.fn(),
        onModelPresetChange: vi.fn(),
        onModelPresetValidityChange: onValidityChange,
        onError,
      }));
    });

    await waitFor(() => expect(onError).toHaveBeenCalledWith("catalog unavailable"));
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
    expect(container.textContent).not.toContain("이 노드에서 사용할 수 없습니다");
  });
});
