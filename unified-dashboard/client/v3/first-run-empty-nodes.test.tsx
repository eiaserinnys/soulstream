/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PersistentSessionsTab } from "../components/PersistentSessionsTab";
import { CardExecutionPickerView } from "./CardExecutionPicker";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it("tells the execution picker has no connected node", async () => {
  await act(async () => root.render(
    <CardExecutionPickerView
      selection={{ agentId: "", nodeId: "", modelPreset: "" } as never}
      onChange={() => undefined}
      onCancel={() => undefined}
      onConfirm={() => undefined}
      canConfirm={false}
      disabled={false}
      connected={[]}
      agents={[]}
      byNode={{}}
      catalog={{ nodeId: "", status: "idle", presets: [] } as never}
    />,
  ));

  const nodeSection = container.querySelector<HTMLElement>('section[aria-label="노드"]')!;
  expect(nodeSection.textContent).toContain("연결된 노드가 없습니다");
  expect(nodeSection.querySelectorAll("button")).toHaveLength(0);
});

it("asks no node for agents when the create form has no node", async () => {
  const calls: string[] = [];
  const request = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === "/api/persistent-sessions") {
      return Response.json({
        sessions: [],
        total: 0,
        create_defaults: {
          node_id: "",
          preferred_agent_id: null,
          settings: {
            default_model: { model_preset: null, reasoning_effort: null },
            fallback_models: [], show_generation_separator: true, show_character: true,
            show_jev_candidates: true, animate_character: true, turn_usage_mode: "collapsed", show_turn_usage: true,
          },
          initial_instruction: "",
          unavailable_reason: null,
        },
      });
    }
    return Response.json({});
  }) as typeof fetch;

  await act(async () => root.render(<PersistentSessionsTab request={request} assignment={{ modelPresetCatalog: { status: "idle", presets: [] } } as never} />));
  await settle();
  await settle();

  expect(calls).toContain("/api/persistent-sessions");
  expect(calls.filter((path) => path.startsWith("/api/nodes/"))).toEqual([]);
});
