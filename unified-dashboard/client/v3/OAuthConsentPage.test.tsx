/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthConsentPage } from "./OAuthConsentPage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}

describe("OAuthConsentPage", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    window.history.replaceState(null, "", "/oauth/consent?interaction=interaction-1");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("shows only the authenticated account, client, permissions, and login duration", async () => {
    const request = vi.fn<typeof fetch>(async () => jsonResponse({
      email: "director@example.test",
      clientName: "<img src=x onerror=alert(1)>",
      permissions: "작업 대화, 카드와 폴더 읽기",
      csrf: "csrf-value",
    }));

    await act(async () => root.render(<OAuthConsentPage request={request} />));
    await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain("director@example.test")); });

    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("작업 대화, 카드와 폴더 읽기");
    expect(host.textContent).toContain("30일 안에 쓰면 계속 이어짐");
    expect(host.textContent).toContain("허용");
    expect(host.textContent).toContain("취소");
    expect(host.querySelectorAll("form")).toHaveLength(1);
    expect(host.querySelector("form")?.getAttribute("method")).toBe("post");
    expect(host.querySelector('input[name="csrf"]')?.getAttribute("value")).toBe("csrf-value");
    expect(request).toHaveBeenCalledWith("/api/oauth/interaction/interaction-1", expect.objectContaining({
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    }));
  });

  it.each(["allow", "cancel"])("disables both choices while submitting %s and retains the chosen action", async (action) => {
    const request = vi.fn<typeof fetch>(async () => jsonResponse({
      email: "director@example.test", clientName: "Test", permissions: "카드와 폴더 읽기", csrf: "csrf-value",
    }));
    await act(async () => root.render(<OAuthConsentPage request={request} />));
    await act(async () => { await vi.waitFor(() => expect(host.querySelector("form")).not.toBeNull()); });
    const form = host.querySelector("form")!;
    const submitter = form.querySelector<HTMLButtonElement>(`button[value="${action}"]`)!;
    form.addEventListener("submit", event => event.preventDefault());
    await act(async () => { form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter })); });
    expect([...form.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
    expect(new FormData(form).get("action")).toBe(action);
    expect(new FormData(form).get("csrf")).toBe("csrf-value");
    expect(form.querySelector('[role="status"]')).not.toBeNull();
  });

  it.each(["missing", "expired"])("explains how to retry when the interaction is %s", async (kind) => {
    if (kind === "missing") window.history.replaceState(null, "", "/oauth/consent");
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 400 }));
    await act(async () => root.render(<OAuthConsentPage request={request} />));
    await act(async () => { await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull()); });
    expect(host.textContent).toContain("로그인을 시작한 앱에서 다시 시도해 주세요.");
  });
});
