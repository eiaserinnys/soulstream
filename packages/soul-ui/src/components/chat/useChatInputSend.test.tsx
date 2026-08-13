/**
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { submitIntervention } from "./submitIntervention";
import {
  useChatInputSend,
  type UseChatInputSendArgs,
  type UseChatInputSendResult,
} from "./useChatInputSend";

vi.mock("../../providers/AuthProvider", () => ({
  useAuth: () => ({ isAuthenticated: false, user: null }),
}));

vi.mock("./submitIntervention", () => ({
  submitIntervention: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let latest: UseChatInputSendResult | null = null;

function Harness({ args }: { args: UseChatInputSendArgs }) {
  latest = useChatInputSend(args);
  return null;
}

describe("useChatInputSend intervention verdict", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    latest = null;
    vi.clearAllMocks();
  });

  it("restores the optimistic draft and preserves attachments for an unknown verdict", async () => {
    vi.mocked(submitIntervention).mockResolvedValue({
      ok: true,
      delivered: null,
      reason: "verdict_unknown",
      consumeWhen: null,
    });
    const resetLocal = vi.fn();
    const clearDraft = vi.fn();
    const onBeforeSend = vi.fn();
    const onAfterSend = vi.fn();
    const onSendError = vi.fn();
    const args: UseChatInputSendArgs = {
      activeSessionKey: "session-1",
      tree: null,
      isFinished: false,
      isLlmFinished: false,
      fileUploadUrl: "/api/attachments/sessions",
      uploadedPaths: ["/tmp/evidence.png"],
      hasFiles: true,
      resetLocal,
      clearDraft,
      setActiveSession: vi.fn(),
      onBeforeSend,
      onAfterSend,
      onSendError,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Harness args={args} />));

    await act(async () => {
      await latest?.send("  keep this draft  ");
    });

    expect(onBeforeSend).toHaveBeenCalledWith(
      "keep this draft\n\n[첨부 파일 로컬 경로: /tmp/evidence.png]",
    );
    expect(onSendError).toHaveBeenCalledWith("keep this draft");
    expect(resetLocal).not.toHaveBeenCalled();
    expect(onAfterSend).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
    expect(latest?.error).toBe("전달 여부를 확인할 수 없습니다: verdict_unknown");
  });
});
