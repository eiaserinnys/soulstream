import { describe, expect, it, vi } from "vitest";

import { redirectRetiredDashboardPathname } from "./dashboard-routes";

describe("redirectRetiredDashboardPathname", () => {
  it.each(["/v2", "/v2/pages/page-1", "/v3", "/v3/projects/project-1"])(
    "replaces %s with / and updates the rendered pathname",
    (pathname) => {
      const history = {
        state: { preserved: true },
        replaceState: vi.fn(),
      };
      const updatePathname = vi.fn();

      expect(
        redirectRetiredDashboardPathname(pathname, history, updatePathname),
      ).toBe(true);
      expect(history.replaceState).toHaveBeenCalledWith(
        history.state,
        "",
        "/",
      );
      expect(updatePathname).toHaveBeenCalledWith("/");
    },
  );

  it.each(["/v2-other", "/v3-other", "/", "/v1", "/session-1"])(
    "leaves %s unchanged",
    (pathname) => {
      const history = {
        state: null,
        replaceState: vi.fn(),
      };
      const updatePathname = vi.fn();

      expect(
        redirectRetiredDashboardPathname(pathname, history, updatePathname),
      ).toBe(false);
      expect(history.replaceState).not.toHaveBeenCalled();
      expect(updatePathname).not.toHaveBeenCalled();
    },
  );
});
