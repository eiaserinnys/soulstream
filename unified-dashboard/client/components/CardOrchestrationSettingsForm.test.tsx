/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CardOrchestrationSettingsForm } from "./CardOrchestrationSettingsForm";
const policy = {
  enabled: false,
  candidates: [
    {
      agentId: "ariella-orchestrator",
      nodeId: "eiaserinnys",
      modelPreset: "claude-opus",
      minimumRemainingPercent: 15,
    },
    {
      agentId: "ariella-orchestrator",
      nodeId: "eiaserinnys",
      modelPreset: "codex-6-astra",
      minimumRemainingPercent: 15,
    },
  ],
  usageMaxAgeMs: 300000,
  sessionFolderId: null,
  systemFolderParentId: null,
};
const payload = (version: number) => ({
  settings: {
    key: "card_orchestration",
    version,
    policy,
    updatedAt: "2026-10-01T00:00:00Z",
    updatedBy: "admin",
  },
  status: { state: "blocked", reason: "usage_stale" },
});
let root: Root | undefined;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(CardOrchestrationSettingsForm)));
  await settle();
}
function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  )!;
  expect(button).toBeDefined();
  flushSync(() => button.click());
}
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
it("persists changed priority, threshold and optional folders with CAS", async () => {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(response(payload(1)))
    .mockResolvedValueOnce(response(payload(2)));
  vi.stubGlobal("fetch", mock);
  await mount();
  expect(document.body.textContent).toContain("usage_stale");
  click("2순위 위로");
  click("배정 정책 저장");
  await settle();
  const saved = JSON.parse(mock.mock.calls[1]![1].body);
  expect(saved.expectedVersion).toBe(1);
  expect(saved.policy).toEqual({
    ...policy,
    candidates: [policy.candidates[1], policy.candidates[0]],
  });
});
it("reloads after conflict, keeps inactive policy and disables edits during save", async () => {
  let finish!: (r: Response) => void;
  const mock = vi
    .fn()
    .mockResolvedValueOnce(response(payload(1)))
    .mockReturnValueOnce(new Promise<Response>((r) => (finish = r)))
    .mockResolvedValueOnce(response(payload(3)));
  vi.stubGlobal("fetch", mock);
  await mount();
  click("자동 배정 켜기");
  click("배정 정책 저장");
  await settle();
  expect([...document.querySelectorAll("input")].every((i) => i.disabled)).toBe(
    true,
  );
  finish(
    response(
      {
        detail: {
          error: { code: "CARD_ORCHESTRATION_CONFLICT", message: "conflict" },
        },
      },
      409,
    ),
  );
  await settle();
  expect(document.body.textContent).toContain("최신 정책");
  expect(document.body.textContent).toContain("v3");
  expect(document.body.textContent).toContain("자동 배정 켜기");
});
