/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dirtyState = vi.hoisted(() => ({ value: false }));

const settingsPayload = vi.hoisted(() => ({
  categories: [
    {
      name: "general",
      label: "General Settings",
      fields: [
        {
          key: "general.verbose_logging",
          field_name: "verbose_logging",
          label: "Verbose logging for dashboard diagnostics",
          description: "Long descriptions must not compress the input control into an unusable column.",
          value: false,
          value_type: "bool",
          sensitive: false,
          hot_reloadable: true,
          read_only: false,
        },
      ],
    },
    {
      name: "runtime",
      label: "Runtime",
      fields: [],
    },
  ],
}));

vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return {
    ...actual,
    useAuth: () => ({
      isLoading: false,
      authEnabled: true,
      devModeEnabled: false,
      isAuthenticated: true,
      user: {
        email: "admin@example.com",
        name: "Admin",
        isAdmin: true,
      },
      refreshAuthStatus: vi.fn(),
      logout: vi.fn(),
      devLogin: vi.fn(),
    }),
  };
});

vi.mock("../hooks/useConfigSettings", () => ({
  useConfigSettings: () => ({
    categories: settingsPayload.categories,
    formData: { "general.verbose_logging": "false" },
    loading: false,
    saving: false,
    error: null,
    result: null,
    changedKeys: dirtyState.value ? ["general.verbose_logging"] : [],
    hasChanges: dirtyState.value,
    updateField: vi.fn(),
    save: vi.fn(),
  }),
}));

import { ConfigModal } from "./ConfigModal";
import { useDashboardStore } from "@seosoyoung/soul-ui";

function renderModal() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onOpenChange = vi.fn();

  flushSync(() => {
    root.render(createElement(ConfigModal, {
      open: true,
      onOpenChange,
    }));
  });

  return { container, root, onOpenChange };
}

function clickConfigTab(label: string) {
  const tab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-testid="config-category-nav"] button'))
    .find((button) => button.textContent === label);
  expect(tab).not.toBeUndefined();
  flushSync(() => {
    tab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function settleConfigModal() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ConfigModal layout", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    dirtyState.value = false;
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("session-review-policy")
        ? {
            policy: {
              key: "session_review_policy",
              sourceAllowlist: ["slack", "external-llm"],
              version: 1,
              updatedAt: "2026-09-14T00:00:00.000Z",
              updatedBy: "migration:test",
            },
            conditionalRules: [{
              source: "browser",
              label: "브라우저 직접 요청",
              description: "identified browser",
              condition: "identified_user",
            }],
            sourceCatalog: [
              { source: "slack", label: "Slack", description: "Slack 요청", automatic: false },
              { source: "external-llm", label: "외부 LLM", description: "외부 요청", automatic: false },
            ],
          }
        : { users: [], folders: [], jobs: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
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

  it("keeps the settings modal wide enough without exceeding the viewport", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    const popup = document.body.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
    expect(popup).not.toBeNull();
    expect(popup?.className).toContain("max-w-5xl");
  });

  it("groups personal, execution, and server settings without a hidden horizontal rail", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    const nav = document.body.querySelector<HTMLElement>('[data-testid="config-category-nav"]');
    expect(nav).not.toBeNull();
    expect(nav?.querySelectorAll("section")).toHaveLength(3);
    expect([...nav!.querySelectorAll("h3")].map(el => el.textContent)).toEqual(["개인 환경", "작업과 실행", "서버 관리"]);
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toBe("화면과 읽기");
  });

  it("lets config fields collapse to one column before using the two-column desktop layout", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    clickConfigTab("General Settings");
    await settleConfigModal();
    const fieldRow = document.body.querySelector<HTMLElement>('[data-testid="config-field-row"]');
    expect(fieldRow).not.toBeNull();
    expect(fieldRow?.className).toContain("grid-cols-1");
    expect(fieldRow?.className).toContain("sm:grid-cols-[minmax(0,1fr)_minmax(16rem,1.2fr)]");
  });

  it("progressively reveals advanced glass controls inside appearance", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    clickConfigTab("화면과 읽기");
    expect(document.body.querySelector(".config-advanced")?.hasAttribute("open")).toBe(false);
    await settleConfigModal();

    expect(document.body.textContent).toContain("굴절");
    expect(document.body.textContent).toContain("색수차");
    expect(document.body.textContent).toContain("틴트");
    const saveButton = document.body.querySelector<HTMLButtonElement>('[data-testid="config-save-button"]');
    expect(saveButton).toBeNull();
  });

  it("opens recurring jobs from the orchestrator settings surface", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    clickConfigTab("반복 작업");
    await settleConfigModal();

    expect(document.body.querySelector('[data-testid="recurring-jobs-tab"]')).not.toBeNull();
    expect(document.body.textContent).toContain("새 반복 작업");
    expect(document.body.textContent).toContain("다음 5회 보기");
  });

  it("renders a five-step account chat font-size slider", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    clickConfigTab("화면과 읽기");
    await settleConfigModal();

    expect(document.body.textContent).toContain("채팅 글자 크기");
    expect(document.body.textContent).toContain("기본");
    expect(document.body.textContent).toContain("+4");
    const slider = document.body.querySelector<HTMLElement>('[data-testid="chat-font-size-slider"]');
    expect(slider).not.toBeNull();
    expect(slider?.getAttribute("aria-label")).toBe("채팅 글자 크기");
    const thumb = slider?.querySelector<HTMLInputElement>('input[type="range"]');
    expect(thumb?.getAttribute("aria-label")).toBe("채팅 글자 크기");
  });

  it("keeps the user table inside a horizontal scroll container", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    clickConfigTab("사용자");
    await settleConfigModal();

    const tableScroll = document.body.querySelector<HTMLElement>(
      '[data-testid="user-management-table-scroll"]',
    );
    expect(tableScroll).not.toBeNull();
    expect(tableScroll?.className).toContain("overflow-x-auto");
  });

  it("exposes the DB agent profile editor to administrators", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    clickConfigTab("에이전트");
    await settleConfigModal();

    expect(document.body.querySelector('[data-testid="agent-profile-editor"]')).not.toBeNull();
    expect(document.body.textContent).toContain("편집할 프로필을 선택하거나 새로 만드세요.");
    const saveButton = document.body.querySelector<HTMLButtonElement>('[data-testid="config-save-button"]');
    expect(saveButton).toBeNull();
  });

  it("explains the identified-browser invariant separately from the editable source policy", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    clickConfigTab("요청 검수");
    await settleConfigModal();

    const tab = document.body.querySelector('[data-testid="session-review-policy-tab"]');
    expect(tab).not.toBeNull();
    expect(tab?.textContent).toContain("로그인한 브라우저 요청은 항상 검수합니다");
    expect(tab?.textContent).toContain("새로 만드는 세션부터 모든 노드에 적용됩니다");
    expect(tab?.textContent).toContain("외부 LLM");
    expect(tab?.textContent).toContain("external-llm");
    expect(tab?.textContent).toContain("이 설정은 검수 여부만 바꿉니다");
    expect(tab?.textContent).not.toContain("user_id");
    expect(tab?.textContent).not.toContain("ingress");
    expect(tab?.textContent).not.toContain("MCP");
    expect(tab?.textContent).not.toContain("·");
  });
  it("guards unsaved close, keeps editing, and only discards on an explicit action", async () => {
    dirtyState.value = true;
    const mounted = renderModal();
    ({ container, root } = mounted);
    await settleConfigModal();
    const click = (label: string) => {
      const target = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.trim() === label || el.getAttribute("aria-label") === label)!;
      expect(target).toBeTruthy();
      flushSync(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    };
    click("Close");
    await settleConfigModal();
    expect(mounted.onOpenChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("저장하지 않은 변경이 있습니다");
    click("계속 편집");
    expect(document.body.textContent).not.toContain("저장하지 않은 변경이 있습니다");
    expect(document.body.querySelector('[data-testid="config-save-button"]')).not.toBeNull();
    click("취소");
    click("변경 버리기");
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("preserves wallpaper on cancel/read failure, rejects non-images and permits reselect", async () => {
    const previous = useDashboardStore.getState();
    let fail!: (reason: Error) => void;
    const upload = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; })).mockResolvedValue(undefined);
    useDashboardStore.setState({ setWallpaperCustomImage: upload });
    try {
      ({ container, root } = renderModal());
      await settleConfigModal();
      const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      const change = async (files: File[]) => {
        Object.defineProperty(picker, "files", { configurable: true, value: files });
        flushSync(() => picker.dispatchEvent(new Event("change", { bubbles: true })));
        await settleConfigModal();
      };
      await change([]);
      expect(upload).not.toHaveBeenCalled();
      await change([new File(["invalid"], "text.txt", { type: "text/plain" })]);
      expect(upload).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("이미지 파일");
      const image = new File(["image"], "photo.png", { type: "image/png" });
      await change([image]);
      await change([image]);
      expect(upload).toHaveBeenCalledTimes(1);
      expect([...document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === "처리 중...")?.disabled).toBe(true);
      fail(new Error("읽기 실패"));
      await settleConfigModal();
      expect(document.body.textContent).toContain("배경 이미지를 읽지 못했습니다");
      expect(useDashboardStore.getState().wallpaper).toEqual(previous.wallpaper);
      await change([image]);
      expect(upload).toHaveBeenCalledTimes(2);
      expect(picker.value).toBe("");
    } finally { useDashboardStore.setState({ setWallpaperCustomImage: previous.setWallpaperCustomImage }); }
  });

});
