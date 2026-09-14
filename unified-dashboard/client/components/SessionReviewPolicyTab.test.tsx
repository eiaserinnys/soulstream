/** @vitest-environment jsdom */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionReviewPolicyTab } from "./SessionReviewPolicyTab";

describe("SessionReviewPolicyTab", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("reloads the canonical policy after a CAS conflict", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(policyPayload(1, ["slack"])))
      .mockResolvedValueOnce(jsonResponse({
        detail: { error: { code: "SESSION_REVIEW_POLICY_CONFLICT", message: "conflict" } },
      }, 409))
      .mockResolvedValueOnce(jsonResponse(policyPayload(2, ["slack", "clipper"])));
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(SessionReviewPolicyTab)));
    await settle();

    const input = document.body.querySelector<HTMLInputElement>('[aria-label="추가할 출처 ID"]')!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    flushSync(() => {
      setter.call(input, "external-llm");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickButton("추가");
    clickButton("정책 저장");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const put = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(put[1].method).toBe("PUT");
    expect(JSON.parse(String(put[1].body))).toEqual({
      sourceAllowlist: ["slack", "external-llm"],
      expectedVersion: 1,
    });
    expect(document.body.textContent).toContain("다른 관리자가 먼저 저장해 최신 정책을 다시 불러왔습니다");
    expect(document.body.textContent).toContain("Clipper");
    expect(document.body.textContent).toContain("현재 v2");
  });
});

function clickButton(label: string) {
  const button = Array.from(document.body.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === label);
  expect(button).toBeDefined();
  flushSync(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function policyPayload(version: number, sourceAllowlist: string[]) {
  return {
    policy: {
      key: "session_review_policy",
      sourceAllowlist,
      version,
      updatedAt: "2026-09-14T00:00:00.000Z",
      updatedBy: "admin@example.com",
    },
    conditionalRules: [{
      source: "browser",
      label: "브라우저 직접 요청",
      description: "identified browser",
      condition: "identified_user",
    }],
    sourceCatalog: [
      { source: "slack", label: "Slack", description: "Slack", automatic: false },
      { source: "clipper", label: "Clipper", description: "Clipper", automatic: false },
      { source: "external-llm", label: "외부 LLM", description: "외부", automatic: false },
    ],
  };
}
