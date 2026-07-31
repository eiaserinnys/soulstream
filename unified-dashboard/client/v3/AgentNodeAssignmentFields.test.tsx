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

  it("marks the explicit compact desktop row layout without changing field order", () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("model-presets") ? presetResponse([]) : response([])
    ));

    flushSync(() => {
      root.render(createElement(AgentNodeAssignmentFields, {
        nodeId: "node-a",
        agentId: "",
        modelPreset: "",
        presentation: "session",
        layout: "compact-row",
        onNodeIdChange: vi.fn(),
        onAgentIdChange: vi.fn(),
        onModelPresetChange: vi.fn(),
      }));
    });

    const assignment = container.querySelector(".v3-succession-assignment");
    expect(assignment?.classList.contains("v3-succession-assignment--compact-row")).toBe(true);
    const labels = [...container.querySelectorAll("label")].map((label) =>
      label.firstChild?.textContent?.trim(),
    );
    expect(labels).toEqual(["노드", "에이전트", "모델"]);
  });

  it("reuses a provided node preset catalog without fetching the same API again", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes("model-presets")) {
        throw new Error("model preset API must not be fetched twice");
      }
      return response([{ id: "agent-a", name: "에이전트 A" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    flushSync(() => {
      root.render(createElement(AgentNodeAssignmentFields, {
        nodeId: "node-a",
        agentId: "agent-a",
        modelPreset: "preset-sol",
        presentation: "session",
        modelPresetCatalog: {
          status: "ready",
          nodeId: "node-a",
          presets: [{
            id: "preset-sol",
            label: "Codex - 5.6 Sol",
            backend: "codex",
            available: true,
            reason: null,
            reason_label: null,
            resets_at: null,
            usage_warning: false,
          }],
        },
        onNodeIdChange: vi.fn(),
        onAgentIdChange: vi.fn(),
        onModelPresetChange: vi.fn(),
      }));
    });

    await waitFor(() => expect(modelTrigger().textContent).toContain("Codex - 5.6 Sol"));
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("model-presets"))).toBe(true);
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
    await waitFor(() => expect(modelTrigger().textContent).toContain("프리셋 제한"));
    modelTrigger().click();
    const limitedItem = await waitForSelectItem("프리셋 제한");
    expect(limitedItem.hasAttribute("data-disabled")).toBe(true);
    expect(container.textContent).toContain(
      "선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.",
    );
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    render("preset-warning");
    await waitFor(() => expect(container.textContent).toContain("사용량 확인 지연"));
    modelTrigger().click();
    const warningItem = await waitForSelectItem("프리셋 경고 (사용량 확인 지연)");
    expect(warningItem.hasAttribute("data-disabled")).toBe(false);
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  });

  it("keeps the model picker usable while availability is still loading", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("model-presets")
        ? new Promise<Response>(() => undefined)
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
      }));
    });

    await waitFor(() => expect(modelTrigger().textContent).toContain("선택한 모델 확인 중"));
    expect(modelTrigger().disabled).toBe(false);
    modelTrigger().click();
    expect((await waitForSelectItem("미지정")).hasAttribute("data-disabled")).toBe(false);
  });

  it("removes the previous node presets as soon as the node changes", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("model-presets") && url.includes("node-a")) {
        return presetResponse([{
          id: "old-preset",
          label: "이전 노드 모델",
          backend: "backend-a",
          available: true,
          reason: null,
          reason_label: null,
          resets_at: null,
          usage_warning: false,
        }]);
      }
      if (url.includes("model-presets")) return new Promise<Response>(() => undefined);
      return response([{ id: "agent-a", name: "에이전트 A" }]);
    }));

    const render = (nodeId: string) => {
      flushSync(() => {
        root.render(createElement(AgentNodeAssignmentFields, {
          nodeId,
          agentId: "agent-a",
          modelPreset: "",
          presentation: "session",
          onNodeIdChange: vi.fn(),
          onAgentIdChange: vi.fn(),
          onModelPresetChange: vi.fn(),
        }));
      });
    };

    render("node-a");
    await waitFor(() => expect(modelTrigger().textContent).toContain("미지정"));
    modelTrigger().click();
    await waitForSelectItem("이전 노드 모델");

    render("node-b");
    await waitFor(() => {
      const itemText = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
        .map((item) => item.textContent);
      expect(itemText).not.toContain("이전 노드 모델");
      expect(itemText).toContain("미지정");
    });
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

    await waitFor(() => expect(onError).toHaveBeenCalledWith("모델 목록을 불러오지 못했습니다"));
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
    expect(modelTrigger().textContent).toContain("모델 목록을 불러오지 못했습니다");
    expect(container.textContent).not.toContain("이 노드에서 사용할 수 없습니다");
  });

  function modelTrigger(): HTMLButtonElement {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="모델 선택"]');
    if (!trigger) throw new Error("모델 선택 트리거가 없습니다.");
    return trigger;
  }

  async function waitForSelectItem(text: string): Promise<HTMLElement> {
    let matched: HTMLElement | null = null;
    await waitFor(() => {
      matched = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
        .find((item) => item.textContent?.includes(text)) ?? null;
      expect(matched).not.toBeNull();
    });
    return matched!;
  }
});
