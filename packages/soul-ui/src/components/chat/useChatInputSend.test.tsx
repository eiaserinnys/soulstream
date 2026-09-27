/**
 * @vitest-environment jsdom
 */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { submitIntervention } from "./submitIntervention";
import { SubmitInterventionHttpError } from "./submitIntervention";
import { useDashboardStore } from "../../stores/dashboard-store";
import type { PendingChatSend } from "../../stores/dashboard-store-types";
import {
  useChatInputSend,
  type UseChatInputSendArgs,
  type UseChatInputSendResult,
} from "./useChatInputSend";

vi.mock("../../providers/AuthProvider", () => ({
  useAuth: () => ({ isAuthenticated: false, user: null }),
}));

vi.mock("./submitIntervention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./submitIntervention")>()),
  submitIntervention: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type PendingSend = PendingChatSend;

type PendingSendActions = {
  getPendingChatSend: (sessionId: string) => PendingSend | undefined;
  setPendingChatSend: (sessionId: string, send: PendingSend | null) => void;
};

type ExtendedResult = UseChatInputSendResult & {
  retry: (sessionId: string, pending: PendingSend) => Promise<void>;
};

let latest: ExtendedResult | null = null;
let textareaValue: string | null = null;
let pendingReason: string | null = null;
let inputDisabled = true;
let sendDisabled = false;
let sendStatus = "";

function Harness({
  args,
  actions,
  onSendError,
  onSendFailure,
}: {
  args: UseChatInputSendArgs;
  actions: PendingSendActions;
  onSendError: (text: string) => void;
  onSendFailure: () => void;
}) {
  const [text, setText] = useState("draft to send");
  const pending = useDashboardStore((state) => (
    args.activeSessionKey ? state.pendingChatSends[args.activeSessionKey] : undefined
  ));
  latest = useChatInputSend({
    ...args,
    getPendingChatSend: actions.getPendingChatSend,
    setPendingChatSend: actions.setPendingChatSend,
    onBeforeSend: (messageText) => {
      args.onBeforeSend?.(messageText);
      setText("");
    },
    onSendError: (failedText) => {
      onSendError(failedText);
      setText(failedText);
    },
    onSendFailure,
  });
  textareaValue = text;
  pendingReason = pending?.reason ?? null;
  inputDisabled = false;
  sendDisabled = pending !== undefined;
  sendStatus = pending?.status === "sending" ? "보내는 중" : "";

  return (
    <>
      <textarea
        data-testid="composer"
        disabled={inputDisabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div data-testid="pending-status">{sendStatus}</div>
      <div data-testid="pending-reason">{pendingReason}</div>
      <button data-testid="send" disabled={sendDisabled} />
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useChatInputSend pending message", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let onSendError: ReturnType<typeof vi.fn>;
  let onSendFailure: ReturnType<typeof vi.fn>;
  let actions: PendingSendActions;
  let args: UseChatInputSendArgs;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setActiveSession("session-1");
    textareaValue = null;
    pendingReason = null;
    inputDisabled = true;
    sendDisabled = false;
    sendStatus = "";
    onSendError = vi.fn();
    onSendFailure = vi.fn();
    actions = {
      getPendingChatSend: (sessionId) => useDashboardStore.getState().pendingChatSends[sessionId],
      setPendingChatSend: (sessionId, pending) =>
        useDashboardStore.getState().setPendingChatSend(sessionId, pending),
    };
    args = {
      activeSessionKey: "session-1",
      tree: null,
      isFinished: false,
      isLlmFinished: false,
      fileUploadUrl: "/api/attachments/sessions",
      uploadedPaths: ["/tmp/evidence.png"],
      uploadedAttachments: [{
        id: "upload-1",
        file: new File(["evidence"], "evidence.png", { type: "image/png" }),
        path: "/tmp/evidence.png",
      }],
      getPendingChatSend: () => undefined,
      setPendingChatSend: () => {},
      clearDraft: vi.fn(),
      setActiveSession: vi.fn(),
      onBeforeSend: vi.fn(),
      onAfterSend: vi.fn(),
    };
    vi.mocked(submitIntervention).mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    latest = null;
    vi.clearAllMocks();
  });

  function render() {
    act(() => root?.render(
      <Harness args={args} actions={actions} onSendError={onSendError} onSendFailure={onSendFailure} />,
    ));
  }

  it("clears the composer immediately, keeps it editable, and shows a sending bubble", async () => {
    const request = deferred<{
      ok: true;
      delivered: boolean | null;
      reason: string | null;
      consumeWhen: null;
    }>();
    vi.mocked(submitIntervention).mockReturnValue(request.promise);
    render();

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = latest!.send("  keep this draft  ");
    });

    expect(textareaValue).toBe("");
    expect(useDashboardStore.getState().pendingChatSends["session-1"]?.status).toBe("sending");
    expect(sendStatus).toBe("보내는 중");
    expect(inputDisabled).toBe(false);
    expect(sendDisabled).toBe(true);
    expect(args.onBeforeSend).toHaveBeenCalledWith(
      "keep this draft\n\n[첨부 파일 로컬 경로: /tmp/evidence.png]",
    );

    await act(async () => {
      request.resolve({ ok: true, delivered: true, reason: null, consumeWhen: null });
      await sendPromise;
    });

    expect(useDashboardStore.getState().pendingChatSends["session-1"]?.status).toBe("sending");
    expect(args.onAfterSend).toHaveBeenCalledOnce();
  });

  it("keeps failed text in a failed bubble and does not restore it into the composer", async () => {
    vi.mocked(submitIntervention).mockRejectedValue(new TypeError("fetch failed"));
    render();

    await act(async () => {
      await latest!.send("draft to send");
    });

    expect(useDashboardStore.getState().pendingChatSends["session-1"]).toMatchObject({
      status: "failed",
      reason: "전달을 확인하지 못했습니다",
    });
    expect(textareaValue).toBe("");
    expect(pendingReason).toBe("전달을 확인하지 못했습니다");
    expect(onSendError).not.toHaveBeenCalled();
    expect(onSendFailure).toHaveBeenCalledOnce();
    expect(latest?.error).toBeNull();
  });

  it("uses the existing server error message only when an HTTP status is available", async () => {
    vi.mocked(submitIntervention).mockRejectedValue(
      new SubmitInterventionHttpError("세션을 찾을 수 없습니다", 404),
    );
    render();

    await act(async () => {
      await latest!.send("draft to send");
    });

    expect(useDashboardStore.getState().pendingChatSends["session-1"]).toMatchObject({
      status: "failed",
      reason: "전송하지 못했습니다: 세션을 찾을 수 없습니다",
    });
    expect(textareaValue).toBe("");
    expect(onSendError).not.toHaveBeenCalled();
  });

  it("ignores an HTTP failure after the server event already cleared the slot", async () => {
    const request = deferred<{
      ok: true;
      delivered: boolean | null;
      reason: string | null;
      consumeWhen: null;
    }>();
    vi.mocked(submitIntervention).mockReturnValue(request.promise);
    render();

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = latest!.send("draft to send");
    });
    const started = useDashboardStore.getState().pendingChatSends["session-1"]!;
    act(() => useDashboardStore.getState().processEvent({
      type: "user_message",
      user: "dashboard",
      text: started.messageText,
      timestamp: 1_790_000_010,
    } as unknown as import("../../shared/types").SoulSSEEvent, 10));

    await act(async () => {
      request.reject(new TypeError("network disconnected"));
      await sendPromise;
    });

    expect(started.status).toBe("sending");
    expect(useDashboardStore.getState().pendingChatSends["session-1"]).toBeUndefined();
    expect(textareaValue).toBe("");
    expect(onSendError).not.toHaveBeenCalled();
    expect(latest?.error).toBeNull();
  });

  it("retries the same message and attachment paths through the same session route", async () => {
    vi.mocked(submitIntervention)
      .mockResolvedValueOnce({ ok: true, delivered: null, reason: "verdict_unknown", consumeWhen: null })
      .mockResolvedValueOnce({ ok: true, delivered: true, reason: null, consumeWhen: null });
    render();

    await act(async () => {
      await latest!.send("draft to send");
    });
    const failed = useDashboardStore.getState().pendingChatSends["session-1"]!;
    expect(failed.status).toBe("failed");

    await act(async () => {
      await latest!.retry("session-1", failed);
    });

    expect(submitIntervention).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitIntervention).mock.calls[1]?.[0]).toMatchObject({
      sessionKey: "session-1",
      text: "draft to send\n\n[첨부 파일 로컬 경로: /tmp/evidence.png]",
      attachmentPaths: ["/tmp/evidence.png"],
    });
    expect(useDashboardStore.getState().pendingChatSends["session-1"]?.status).toBe("sending");
  });
});
