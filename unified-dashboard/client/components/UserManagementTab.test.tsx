/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { UserManagementTab } from "./UserManagementTab";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USERS = { users: [{ email: "qa@example.test", displayName: "QA", isAdmin: true, allowedFolderIds: [], createdAt: "2026-10-01T00:00:00Z", createdBy: null }], folders: [] };
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 10)); });

it("목록 조회가 실패하면 빈 목록 문구 대신 오류 안내를 보이고, 다시 불러오면 목록이 선다", async () => {
  let failing = true;
  const request = (async () => failing ? Response.json({}, { status: 500 }) : Response.json(USERS)) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<UserManagementTab request={request} />));
    await settle();
    expect(host.textContent).not.toContain("등록된 사용자가 없습니다");
    expect(host.querySelector('[data-testid="user-management-table-scroll"]')).toBeNull();
    const notice = host.querySelector(".v3-error-notice");
    expect(notice?.textContent).toContain("사용자 목록을 불러오지 못했습니다.");
    expect(notice?.querySelector("pre")?.textContent).toBe("HTTP 500");
    expect(notice?.querySelector("button")?.textContent).toBe("다시 불러오기");

    failing = false;
    await act(async () => notice!.querySelector("button")!.click());
    await settle();
    expect(host.querySelector(".v3-error-notice")).toBeNull();
    expect(host.textContent).toContain("qa@example.test");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("조회가 성공했고 사용자가 없으면 빈 목록 문구를 보인다", async () => {
  const request = (async () => Response.json({ users: [], folders: [] })) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<UserManagementTab request={request} />));
    await settle();
    expect(host.textContent).toContain("등록된 사용자가 없습니다");
    expect(host.querySelector(".v3-error-notice")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
