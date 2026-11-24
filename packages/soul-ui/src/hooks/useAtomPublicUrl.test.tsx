/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseAtomPublicUrl,
  resetAtomPublicUrlForTests,
  useAtomPublicUrl,
} from "./useAtomPublicUrl";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seen: Array<string | null> = [];
function Probe() {
  seen.push(useAtomPublicUrl());
  return null;
}
const latest = () => seen[seen.length - 1];

const ok = (atom_public_url: unknown) =>
  ({ ok: true, json: async () => ({ atom_public_url }) }) as Response;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useAtomPublicUrl", () => {
  let roots: Root[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetAtomPublicUrlForTests();
    seen.length = 0;
    roots = [];
    fetchMock = vi.fn(async () => ok("https://atom.example.test"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    for (const root of roots) await act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mount(count = 1) {
    for (let i = 0; i < count; i++) {
      const root = createRoot(document.createElement("div"));
      roots.push(root);
      await act(async () => root.render(createElement(Probe)));
    }
  }

  it("reads /api/status once for two components mounted together", async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    await mount(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/status");
    await act(async () => release(ok("https://atom.example.test/")));
    expect(latest()).toBe("https://atom.example.test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous value when a later read fails, and null when the first read fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(latest()).toBeNull();

    resetAtomPublicUrlForTests();
    seen.length = 0;
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(ok("https://atom.example.test"));
    await mount();
    expect(latest()).toBe("https://atom.example.test");

    vi.setSystemTime(Date.now() + 61_000);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => setVisibility("visible"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest()).toBe("https://atom.example.test");

    vi.setSystemTime(Date.now() + 61_000);
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    await act(async () => setVisibility("visible"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(latest()).toBe("https://atom.example.test");
  });

  it("re-reads on visibilitychange only after 60 seconds", async () => {
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 30_000);
    await act(async () => setVisibility("visible"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 31_000);
    fetchMock.mockResolvedValueOnce(ok("https://other.example.test"));
    await act(async () => setVisibility("hidden"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => setVisibility("visible"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest()).toBe("https://other.example.test");
  });

  it("treats a value that is not an http(s) absolute URL as null", async () => {
    for (const value of ["javascript:alert(1)", "ftp://a.example.test", "atom.example.test", "", 42, null]) {
      expect(parseAtomPublicUrl(value)).toBeNull();
    }
    expect(parseAtomPublicUrl("http://127.0.0.1:4200/")).toBe("http://127.0.0.1:4200");

    fetchMock.mockResolvedValue(ok("javascript:alert(1)"));
    await mount();
    expect(latest()).toBeNull();
  });
});
