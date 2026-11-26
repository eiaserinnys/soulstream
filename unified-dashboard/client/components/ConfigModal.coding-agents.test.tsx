/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ isAdmin: true }));

vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return {
    ...actual,
    useAuth: () => ({
      isLoading: false,
      authEnabled: true,
      devModeEnabled: false,
      isAuthenticated: true,
      user: { email: "admin@example.com", name: "Admin", isAdmin: auth.isAdmin },
      refreshAuthStatus: vi.fn(),
      logout: vi.fn(),
      devLogin: vi.fn(),
    }),
  };
});
vi.mock("../hooks/useConfigSettings", () => ({
  useConfigSettings: () => ({ categories: [], formData: {}, loading: false, saving: false, error: null, result: null, changedKeys: [], hasChanges: false, updateField: vi.fn(), save: vi.fn() }),
}));
vi.mock("./CodingAgentsTab", () => ({ CodingAgentsTab: () => <div data-testid="coding-agents-stub" /> }));
vi.mock("./GitReposTab", () => ({ GitReposTab: () => <div data-testid="git-repos-stub" /> }));
vi.mock("./PersistentSessionsTab", () => ({
  PersistentSessionsTab: (props: { initialPersistentSessionId?: string | null; onSessionSaved?: unknown }) => (
    <div data-testid="persistent-stub" data-session={props.initialPersistentSessionId ?? ""} data-has-saved={String(typeof props.onSessionSaved === "function")} />
  ),
}));

import { ConfigModal } from "./ConfigModal";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  auth.isAdmin = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const navLabels = () => [...document.body.querySelectorAll('[data-testid="config-category-nav"] button')].map((button) => button.textContent);
const render = async (props: Partial<React.ComponentProps<typeof ConfigModal>> = {}) => {
  await act(async () => root.render(<ConfigModal open onOpenChange={vi.fn()} {...props} />));
};

describe("ConfigModal coding agents tab", () => {
  it("shows the tab to administrators in the agents-and-nodes group and opens its body", async () => {
    await render();
    expect(navLabels()).toContain("코딩 에이전트 연결");
    const group = [...document.body.querySelectorAll('[data-testid="config-category-nav"] section')].find((section) => section.querySelector("h3")?.textContent === "에이전트와 노드")!;
    expect([...group.querySelectorAll("button")].map((button) => button.textContent)).toContain("코딩 에이전트 연결");
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="config-category-nav"] button')].find((button) => button.textContent === "코딩 에이전트 연결")!.click());
    expect(document.body.querySelector('[data-testid="coding-agents-stub"]')).not.toBeNull();
    expect(document.body.textContent).toContain("노드마다 Claude, Codex, Antigravity 로그인을 연결합니다.");
  });

  it("puts the Git and repositories tab right after coding agents for administrators only", async () => {
    await render();
    const labels = navLabels();
    expect(labels[labels.indexOf("코딩 에이전트 연결") + 1]).toBe("Git과 저장소");
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="config-category-nav"] button')].find((button) => button.textContent === "Git과 저장소")!.click());
    expect(document.body.querySelector('[data-testid="git-repos-stub"]')).not.toBeNull();
    expect(document.body.textContent).toContain("노드마다 Git 사용자, SSH 키, 저장소를 설정합니다.");
    auth.isAdmin = false;
    await render({ initialTab: "git_repos" });
    expect(navLabels()).not.toContain("Git과 저장소");
    expect(document.body.querySelector('[data-testid="git-repos-stub"]')).toBeNull();
  });

  it("hides the tab from non-administrators and renders nothing for it even if asked to open it", async () => {
    auth.isAdmin = false;
    await render();
    expect(navLabels()).not.toContain("코딩 에이전트 연결");
    await render({ initialTab: "coding_agents" });
    expect(document.body.querySelector('[data-testid="coding-agents-stub"]')).toBeNull();
  });

  it("opens the coding agents tab directly with initialTab", async () => {
    await render({ initialTab: "coding_agents" });
    expect(document.body.querySelector('[data-testid="coding-agents-stub"]')).not.toBeNull();
  });
});

describe("ConfigModal persistent sessions tab", () => {
  it("passes the session to select and the saved callback to the tab", async () => {
    await render({ initialTab: "persistent", initialPersistentSessionId: "pas-1", onPersistentSessionSaved: vi.fn() });
    const stub = document.body.querySelector('[data-testid="persistent-stub"]')!;
    expect(stub.getAttribute("data-session")).toBe("pas-1");
    expect(stub.getAttribute("data-has-saved")).toBe("true");
  });
});
