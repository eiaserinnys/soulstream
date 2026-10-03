/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderDialog } from "@seosoyoung/soul-ui/components/FolderDialog";
import { SessionContinueErrorDialog } from "@seosoyoung/soul-ui/components/SessionDialogViews";
import { UserManagementTab } from "./UserManagementTab";

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { supports: () => false });
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) { await act(async () => root.render(node)); }
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  expect(found).toBeTruthy();
  return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function input(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("keeps a small folder draft after failure and guards pending submit/close", async () => {
  const pending = deferred<void>();
  const confirm = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  const close = vi.fn();
  await render(<FolderDialog mode="create" open onOpenChange={close} onConfirm={confirm} />);
  const name = document.querySelector<HTMLInputElement>('input[placeholder="폴더 이름"]')!;
  await input(name, "보존할 폴더");
  await act(async () => {
    const form = name.closest("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(name.disabled).toBe(true);
  await click("취소");
  await click("Close");
  expect(close).not.toHaveBeenCalled();
  await act(async () => pending.reject(new Error("HTTP 503")));
  expect(name.value).toBe("보존할 폴더");
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  await click("만들기");
  expect(confirm).toHaveBeenCalledTimes(2);
  // Parent owns the successful close and board position update.
  expect(close).not.toHaveBeenCalled();
});

it("keeps user form errors inside the dialog and refreshes only after one successful save", async () => {
  const pending = deferred<Response>();
  let writes = 0;
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method) {
      writes++;
      return writes === 1 ? pending.promise : new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ users: [], folders: [{ id: "f1", name: "첫 폴더" }] }));
  });
  await render(<UserManagementTab request={request} />);
  await click("추가");
  const email = document.querySelector<HTMLInputElement>('input')!;
  expect(document.activeElement).toBe(email);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("전체 폴더");
  await input(email, "person@example.test");
  await act(async () => { button("저장").click(); button("저장").click(); });
  expect(writes).toBe(1);
  expect(email.disabled).toBe(true);
  await click("취소");
  await click("Close");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => pending.resolve(new Response(JSON.stringify({ detail: "이미 등록된 이메일입니다" }), { status: 409 })));
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("이미 등록된 이메일");
  expect(email.value).toBe("person@example.test");
  await click("저장");
  expect(writes).toBe(2);
  expect(request.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
});

it("never mounts raw secrets in a session error, whether details are open or closed", async () => {
  const secrets = ["auth-secret", "cookie-secret", "password-secret", "token-secret", "key-secret", "url-user", "url-pass", "query-secret"];
  const error = 'HTTP 403\nAuthorization: Bearer auth-secret\nCookie: sid=cookie-secret\npassword="password-secret" token=token-secret api_key=key-secret\nhttps://url-user:url-pass@example.test/?secret=query-secret';
  const onClose = vi.fn();
  await render(<SessionContinueErrorDialog error={error} onClose={onClose} />);
  const details = document.querySelector("details")!;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  for (let i = 0; i < 3; i++) {
    await act(async () => details.querySelector("summary")!.click());
    for (const secret of secrets) expect(document.body.innerHTML).not.toContain(secret);
  }
  expect(document.body.textContent).toContain("403");
  expect(onClose).not.toHaveBeenCalled();
});
