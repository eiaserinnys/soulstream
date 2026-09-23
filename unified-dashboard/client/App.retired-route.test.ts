import { describe, expect, it, vi } from "vitest";

import { redirectRetiredDashboardPathname } from "./dashboard-routes";

describe("redirectRetiredDashboardPathname", () => {
  it.each([
    "/v1",
    "/v1/sessions/session-1",
    "/v2",
    "/v2/pages/page-1",
    "/v3",
    "/v3/projects/project-1",
  ])(
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

  it("converts a parseable retired feed link into the canonical session intent", () => {
    const history = { state: null, replaceState: vi.fn() };
    const updatePathname = vi.fn();

    expect(redirectRetiredDashboardPathname(
      "/v1",
      history,
      updatePathname,
      "https://dashboard.example/v1#/feed/session-a?event=19",
    )).toBe(true);

    expect(history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/?session=session-a&event=19",
    );
    expect(updatePathname).toHaveBeenCalledWith("/");
  });

  it("preserves unrelated return parameters while converting a legacy feed link", () => {
    const history = { state: null, replaceState: vi.fn() };
    const updatePathname = vi.fn();

    redirectRetiredDashboardPathname(
      "/v1",
      history,
      updatePathname,
      "https://dashboard.example/v1?tab=history&keep=1#/feed/session-a?event=19",
    );

    const target = history.replaceState.mock.calls[0]?.[2];
    expect(target).toBe("/?tab=history&keep=1&session=session-a&event=19");
  });

  it.each(["/v1-other", "/v2-other", "/v3-other", "/", "/session-1"])(
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
