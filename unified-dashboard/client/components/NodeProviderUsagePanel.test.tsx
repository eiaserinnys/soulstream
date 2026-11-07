/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NodeProviderUsagePanel } from "./NodeProviderUsagePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function quota(id: string, label: string, usedPercent: number) {
  return {
    id, label, window: null, unit: null, used: null, remaining: null, limit: null,
    usedPercent, remainingPercent: 100 - usedPercent, resetAt: 1_794_182_400, model: null, source: null,
  };
}

const providerUsage = {
  generatedAt: "",
  providers: {
    claude: { status: "auto", source: "", planType: "Max", quotas: [quota("claude:7d", "7일", 50)] },
    codex: { status: "auto", source: "codex-api", planType: "Plus", quotas: [quota("codex:7d", "7일", 42)] },
    opencode_go: { status: "not_configured", source: "", planType: null, quotas: [] },
  },
};

let host: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderPanel(request: typeof fetch, providers: readonly ("claude" | "codex" | "antigravity" | "opencode_go")[]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<NodeProviderUsagePanel nodeId="node-a" request={request} providers={providers} />));
}

async function clickUsage() {
  await act(async () => {
    Array.from(host.querySelectorAll("button")).find(button => button.textContent === "사용량")!.click();
  });
}

it("draws only the requested providers the response carries", async () => {
  const request = vi.fn(async () => Response.json(providerUsage)) as unknown as typeof fetch;
  renderPanel(request, ["codex", "antigravity", "opencode_go"]);
  expect(host.textContent).not.toContain("Codex");
  await clickUsage();
  expect(request).toHaveBeenCalledWith("/api/nodes/node-a/provider-usage");
  expect(host.textContent).toContain("Codex");
  expect(host.textContent).toContain("OpenCode Go");
  expect(host.textContent).toContain("키 없음");
  expect(host.textContent).not.toContain("Claude Code");
  expect(host.textContent).not.toContain("Antigravity");
});

it("shows the failure in place", async () => {
  const request = vi.fn(async () => new Response("usage route down", { status: 500 })) as unknown as typeof fetch;
  renderPanel(request, ["codex", "antigravity", "opencode_go"]);
  await clickUsage();
  expect(host.textContent).toContain("usage route down");
});
