import { describe, expect, it, vi } from "vitest";

import { redirectV2Pathname } from "./App";

describe("redirectV2Pathname", () => {
  it.each(["/v2", "/v2/pages/page-1"])(
    "replaces %s with /v3 and updates the rendered pathname",
    (pathname) => {
      const history = {
        state: { preserved: true },
        replaceState: vi.fn(),
      };
      const updatePathname = vi.fn();

      expect(redirectV2Pathname(pathname, history, updatePathname)).toBe(true);
      expect(history.replaceState).toHaveBeenCalledWith(
        history.state,
        "",
        "/v3",
      );
      expect(updatePathname).toHaveBeenCalledWith("/v3");
    },
  );

  it.each(["/v2-other", "/v3", "/", "/session-1"])(
    "leaves %s unchanged",
    (pathname) => {
      const history = {
        state: null,
        replaceState: vi.fn(),
      };
      const updatePathname = vi.fn();

      expect(redirectV2Pathname(pathname, history, updatePathname)).toBe(false);
      expect(history.replaceState).not.toHaveBeenCalled();
      expect(updatePathname).not.toHaveBeenCalled();
    },
  );
});
