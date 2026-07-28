/**
 * @vitest-environment jsdom
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionModelPresetBadge } from "./SessionModelPresetBadge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderBadge(
  session: { nodeId?: string; modelPreset?: string | null } | null,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(SessionModelPresetBadge, { session }));
  });

  return { container, root };
}

describe("SessionModelPresetBadge", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders nothing and does not fetch for sessions without an explicit preset", async () => {
    ({ container, root } = await renderBadge({
      nodeId: "node-a",
      modelPreset: null,
    }));

    expect(container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders only the server-provided label for an explicitly selected preset", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({
        model_presets: [
          {
            id: "preset-from-server",
            label: "Server supplied label",
            backend: "server-backend",
            available: true,
            reason: null,
            reason_label: null,
            resets_at: null,
            usage_warning: false,
          },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    ({ container, root } = await renderBadge({
      nodeId: "node/a",
      modelPreset: "preset-from-server",
    }));

    await vi.waitFor(() => {
      expect(container?.querySelector('[data-testid="session-model-preset"]')?.textContent)
        .toBe("Server supplied label");
    });
    expect(container?.textContent).not.toContain("preset-from-server");
    expect(fetchMock).toHaveBeenCalledWith("/api/nodes/node%2Fa/model-presets", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
  });

  it("stays absent when the server no longer advertises the stored preset", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ model_presets: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    ({ container, root } = await renderBadge({
      nodeId: "node-a",
      modelPreset: "retired-preset",
    }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(container.textContent).toBe("");
  });
});
