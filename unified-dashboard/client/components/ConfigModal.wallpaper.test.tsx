/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return {
    ...actual,
    useAuth: () => ({
      isLoading: false,
      authEnabled: true,
      devModeEnabled: false,
      isAuthenticated: true,
      user: { email: "user@example.com", name: "User", isAdmin: false },
      refreshAuthStatus: vi.fn(),
      logout: vi.fn(),
      devLogin: vi.fn(),
    }),
  };
});
vi.mock("../hooks/useConfigSettings", () => ({
  useConfigSettings: () => ({ categories: [], formData: {}, loading: false, saving: false, error: null, result: null, changedKeys: [], hasChanges: false, updateField: vi.fn(), save: vi.fn() }),
}));

import { useDashboardStore } from "@seosoyoung/soul-ui";
import { ConfigModal } from "./ConfigModal";

const PRESETS = [
  ["dawn-ridge", "새벽 능선"],
  ["aurora", "오로라"],
  ["silk-curves", "비단 곡선"],
  ["lake-horizon", "호수 수평선"],
  ["desert-dunes", "사막 언덕"],
  ["misty-forest", "안개 숲"],
  ["moonlit-sea", "달빛 바다"],
  ["milky-way", "은하수"],
] as const;

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  localStorage.clear();
  useDashboardStore.setState({ wallpaper: { mode: "bokeh" }, uploadedBackgroundUrl: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  await act(async () => root.render(<ConfigModal open onOpenChange={vi.fn()} initialTab="appearance" />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const tiles = () => [...document.body.querySelectorAll<HTMLButtonElement>(".config-wallpaper-options button")];
const tile = (label: string) => tiles().find((button) => button.textContent === label);

describe("ConfigModal wallpaper grid", () => {
  it("lists the three styles and the eight bundled wallpapers by name, without a my-photo tile", () => {
    expect(tiles().map((button) => button.textContent)).toEqual(["보케", "메탈", "단색", ...PRESETS.map(([, name]) => name)]);
    expect(document.body.textContent).not.toContain("기본값 복원");
    expect(document.body.textContent).toContain("사진 업로드");
  });

  it("applies a bundled wallpaper as photo mode and marks its tile selected", async () => {
    for (const [id, name] of PRESETS) {
      await act(async () => tile(name)!.click());
      expect(useDashboardStore.getState().wallpaper).toEqual({ mode: "photo", customImage: `/wallpapers/${id}.webp` });
      expect(tiles().filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.textContent)).toEqual([name]);
    }
  });

  it("shows a my-photo tile for an uploaded picture and switches to its address", async () => {
    await act(async () => useDashboardStore.setState({ uploadedBackgroundUrl: "/api/user/background?v=3" }));
    expect(tiles().map((button) => button.textContent).at(-1)).toBe("내 사진");

    await act(async () => tile("내 사진")!.click());

    expect(useDashboardStore.getState().wallpaper).toEqual({ mode: "photo", customImage: "/api/user/background?v=3" });
    expect(tile("내 사진")!.getAttribute("aria-pressed")).toBe("true");
  });
});
