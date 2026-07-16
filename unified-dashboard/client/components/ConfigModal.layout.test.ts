/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../config/AppConfigContext", () => ({
  useAppConfig: () => ({
    mode: "orchestrator",
    nodeId: null,
    auth: { enabled: true, provider: "google" },
    features: {
      configModal: true,
      searchModal: true,
      nodePanel: true,
      nodeGuard: false,
    },
  }),
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
    changedKeys: [],
    hasChanges: false,
    updateField: vi.fn(),
    save: vi.fn(),
  }),
}));

import { ConfigModal } from "./ConfigModal";

function renderModal() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(ConfigModal, {
      open: true,
      onOpenChange: vi.fn(),
    }));
  });

  return { container, root };
}

function clickConfigTab(label: string) {
  const tab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
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
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ users: [], folders: [] }),
    })));
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
    expect(popup?.className).toContain("w-[min(960px,calc(100vw-2rem))]");
  });

  it("keeps category tabs on one scrollable row so they do not push content down", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    const nav = document.body.querySelector<HTMLElement>('[data-testid="config-category-nav"]');
    expect(nav).not.toBeNull();
    expect(nav?.className).toContain("overflow-x-auto");
    expect(nav?.className).not.toContain("flex-wrap");
  });

  it("lets config fields collapse to one column before using the two-column desktop layout", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    const fieldRow = document.body.querySelector<HTMLElement>('[data-testid="config-field-row"]');
    expect(fieldRow).not.toBeNull();
    expect(fieldRow?.className).toContain("grid-cols-1");
    expect(fieldRow?.className).toContain("sm:grid-cols-[minmax(0,1fr)_minmax(16rem,1.2fr)]");
  });

  it("renders liquid glass account controls as a separate tab", async () => {
    ({ container, root } = renderModal());
    await settleConfigModal();

    clickConfigTab("리퀴드 글래스");
    await settleConfigModal();

    expect(document.body.textContent).toContain("굴절");
    expect(document.body.textContent).toContain("색수차");
    expect(document.body.textContent).toContain("틴트");
    const saveButton = document.body.querySelector<HTMLButtonElement>('[data-testid="config-save-button"]');
    expect(saveButton?.disabled).toBe(true);
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
});
