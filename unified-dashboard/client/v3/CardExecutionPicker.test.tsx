/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardAssignment } from "@seosoyoung/soul-ui/cards/card-types";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { CardExecutionPickerView, useCardExecutionPicker } from "./CardExecutionPicker";

const preset = (id: string, label: string, backend: string, extra: Record<string, unknown> = {}) =>
  ({ id, label, backend, available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false, ...extra });
const agents = [
  { id: "roselin", name: "로젤린", backend: "claude", default_preset: "opus" },
  { id: "codex-default", name: "Codex Default", backend: "codex", default_preset: "" },
  { id: "plain", name: "백엔드 없음", default_preset: "" },
];
const catalogs: Record<string, unknown[]> = {
  "main-node": [
    preset("opus", "Opus", "claude"),
    preset("gpt-5", "GPT 5", "codex"),
    preset("sol", "Sol", "codex", { reason: "quota_exhausted", reason_label: "7일 사용량 제한", resets_at: new Date(2030, 10, 28, 3, 20).toISOString() }),
    preset("flash", "Flash", "antigravity"),
  ],
  "bare-node": [
    preset("opus", "Opus", "claude", { available: false, reason: "not_authenticated", reason_label: "미인증" }),
    preset("gpt-5", "GPT 5", "codex", { available: false, reason: "not_authenticated", reason_label: "미인증" }),
  ],
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useOrchestratorStore.setState({ nodes: new Map(["main-node", "bare-node"].map(nodeId => [nodeId, { nodeId, status: "connected" } as never])) });
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    const nodeId = decodeURIComponent(url.split("/")[3]);
    return new Response(JSON.stringify(url.endsWith("/agents") ? { agents } : { model_presets: catalogs[nodeId] }), { status: 200 });
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ initial }: { initial: CardAssignment }) {
  const [selection, setSelection] = useState(initial);
  const picker = useCardExecutionPicker({ selection, onChange: setSelection, onError: () => undefined, disabled: false, open: true, onClose: () => undefined });
  return <CardExecutionPickerView {...picker.view} />;
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
const mount = async (initial: Partial<CardAssignment>) => {
  await act(async () => root.render(<Harness initial={{ folderId: "f", agentId: "", nodeId: "", modelPreset: "", ...initial } as CardAssignment} />));
  await settle();
};
const section = (name: string) => container.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
const press = async (name: string, text: string) => {
  const button = [...section(name).querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent?.includes(text))!;
  await act(async () => button.click());
  await settle();
};
const confirm = () => [...container.querySelectorAll<HTMLButtonElement>(".v3-card-execution-actions button")].find(button => button.textContent === "확인")!;
const modelNames = () => [...section("모델").querySelectorAll("button")].map(button => button.querySelector(".v3-card-execution-name")?.textContent ?? button.textContent);

it("한도를 다 쓴 모델에 사유와 해제 시각을 붙이고 선택은 막지 않는다", async () => {
  await mount({ agentId: "roselin", nodeId: "main-node", modelPreset: "opus" });

  const sol = [...section("모델").querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Sol"))!;
  expect(sol.querySelector(".v3-card-execution-name")?.textContent).toBe("Sol");
  expect(sol.querySelector(".v3-card-execution-reason")?.textContent).toBe("7일 사용량 제한 · 11. 28. 03:20 해제");
  expect(sol.disabled).toBe(false);
  await press("모델", "Sol");
  expect(sol.getAttribute("aria-pressed")).toBe("true");
  expect(confirm().disabled).toBe(false);
});

it("모델을 고르기 전에는 확인 단추가 꺼지고 사용할 수 있는 모델을 고르면 켜진다", async () => {
  await mount({ agentId: "codex-default", nodeId: "main-node", modelPreset: "" });
  expect(confirm().disabled).toBe(true);

  await press("모델", "GPT 5");
  expect(confirm().disabled).toBe(false);
});

it("노드를 바꾸면 모델이 비워져 확인이 다시 꺼진다", async () => {
  await mount({ agentId: "roselin", nodeId: "main-node", modelPreset: "opus" });
  expect(confirm().disabled).toBe(false);

  await press("노드", "bare-node");
  expect(confirm().disabled).toBe(true);
});

it("고른 노드에 쓸 수 있는 모델이 없으면 안내 문구를 보인다", async () => {
  await mount({ agentId: "roselin", nodeId: "bare-node", modelPreset: "" });

  const guide = [...section("모델").querySelectorAll("p")].map(node => node.textContent);
  expect(guide).toEqual(["쓸 수 있는 모델이 없습니다. 설정의 「코딩 에이전트 연결」에서 이 노드의 로그인을 확인하세요."]);
  expect(confirm().disabled).toBe(true);
});

it("쓸 수 있는 모델이 하나라도 있으면 안내 문구를 보이지 않는다", async () => {
  await mount({ agentId: "roselin", nodeId: "main-node", modelPreset: "opus" });
  expect(section("모델").querySelector("p")).toBeNull();
});

it("고른 에이전트의 backend 모델을 앞에 두고 나머지는 카탈로그 순서로 둔다", async () => {
  await mount({ agentId: "codex-default", nodeId: "main-node", modelPreset: "" });
  expect(modelNames()).toEqual(["GPT 5", "Sol", "Opus", "Flash"]);

  await press("에이전트", "로젤린");
  expect(modelNames()).toEqual(["Opus", "GPT 5", "Sol", "Flash"]);
});

it("에이전트에 backend가 없으면 카탈로그 순서를 그대로 둔다", async () => {
  await mount({ agentId: "plain", nodeId: "main-node", modelPreset: "" });
  expect(modelNames()).toEqual(["Opus", "GPT 5", "Sol", "Flash"]);
});
