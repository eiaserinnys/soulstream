/**
 * @vitest-environment jsdom
 */

import * as React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acknowledgeSpy = vi.hoisted(() => vi.fn());

vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return { ...actual, acknowledgeSessionReview: acknowledgeSpy };
});

import { SessionReviewAcknowledgeError } from "@seosoyoung/soul-ui";
import { V2SessionReviewBanner } from "./V2SessionReviewBanner";

const session = {
  agentSessionId: "sess-review",
  status: "completed" as const,
  eventCount: 4,
  reviewRequired: true,
  reviewState: "needs_review" as const,
};

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await settle();
  }
  throw new Error(`Text did not appear: ${text}`);
}

describe("V2SessionReviewBanner", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    acknowledgeSpy.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it.each([
    [true, "Review acknowledged."],
    [false, "Review was already acknowledged."],
  ])("handles changed=%s as a successful explicit outcome", async (changed, message) => {
    acknowledgeSpy.mockResolvedValue({
      status: "ok",
      agentSessionId: session.agentSessionId,
      reviewState: "acknowledged",
      changed,
    });
    const onAcknowledged = vi.fn();
    flushSync(() => root.render(
      <V2SessionReviewBanner session={session} onAcknowledged={onAcknowledged} />,
    ));

    flushSync(() => container.querySelector<HTMLButtonElement>("button")!.click());
    await waitForText(container, message);

    expect(onAcknowledged).toHaveBeenCalledWith(expect.objectContaining({ changed }));
    expect(container.textContent).toContain(message);
  });

  it.each([
    [404, "Session no longer exists"],
    [409, "Review state changed on the server"],
  ])("keeps the review action visible after HTTP %s", async (status, message) => {
    acknowledgeSpy.mockRejectedValue(new SessionReviewAcknowledgeError({
      status,
      code: status === 404 ? "SESSION_NOT_FOUND" : "REVIEW_NOT_PENDING",
      message: "server rejected",
    }));
    flushSync(() => root.render(
      <V2SessionReviewBanner session={session} onAcknowledged={vi.fn()} />,
    ));

    flushSync(() => container.querySelector<HTMLButtonElement>("button")!.click());
    await waitForText(container, message);

    expect(container.textContent).toContain(message);
    expect(container.querySelector<HTMLButtonElement>("button")).not.toBeNull();
  });

  it("keeps the review action visible after a network failure", async () => {
    acknowledgeSpy.mockRejectedValue(new TypeError("offline"));
    flushSync(() => root.render(
      <V2SessionReviewBanner session={session} onAcknowledged={vi.fn()} />,
    ));

    flushSync(() => container.querySelector<HTMLButtonElement>("button")!.click());
    await waitForText(container, "Could not reach the server");

    expect(container.textContent).toContain("Could not reach the server");
    expect(container.querySelector<HTMLButtonElement>("button")).not.toBeNull();
  });

  it("blocks duplicate acknowledgement while one request is in flight", () => {
    acknowledgeSpy.mockReturnValue(new Promise(() => undefined));
    flushSync(() => root.render(
      <V2SessionReviewBanner session={session} onAcknowledged={vi.fn()} />,
    ));

    const button = container.querySelector<HTMLButtonElement>("button")!;
    flushSync(() => {
      button.click();
      button.click();
    });

    expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
  });

  it("ignores a late acknowledgement after the active session changes", async () => {
    let resolveRequest!: (value: {
      status: "ok";
      agentSessionId: string;
      reviewState: "acknowledged";
      changed: boolean;
    }) => void;
    acknowledgeSpy.mockReturnValue(new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const onAcknowledged = vi.fn();
    flushSync(() => root.render(
      <V2SessionReviewBanner session={session} onAcknowledged={onAcknowledged} />,
    ));
    flushSync(() => container.querySelector<HTMLButtonElement>("button")!.click());

    const nextSession = { ...session, agentSessionId: "sess-next" };
    flushSync(() => root.render(
      <V2SessionReviewBanner session={nextSession} onAcknowledged={onAcknowledged} />,
    ));
    await settle();
    resolveRequest({
      status: "ok",
      agentSessionId: session.agentSessionId,
      reviewState: "acknowledged",
      changed: true,
    });
    await settle();

    expect(onAcknowledged).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Review required");
    expect(container.textContent).not.toContain("Review acknowledged.");
  });

  it("does not render for a non-pending review state", () => {
    flushSync(() => root.render(
      <V2SessionReviewBanner
        session={{ ...session, reviewState: "acknowledged" }}
        onAcknowledged={vi.fn()}
      />,
    ));
    expect(container.textContent).toBe("");
  });
});
