/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "./AuthProvider";

function AuthProbe() {
  const auth = useAuth();
  return createElement("button", {
    type: "button",
    onClick: () => { void auth.refreshAuthStatus(); },
    "data-testid": "auth-probe",
  }, auth.isLoading ? "loading" : auth.isAuthenticated ? "authenticated" : "signed-out");
}

describe("AuthProvider refresh boundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves initial v1 authentication and lets a 401 handler return to AuthGate login state", async () => {
    let statusReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/config") {
        return Response.json({ authEnabled: true, devModeEnabled: false });
      }
      if (url === "/api/auth/status") {
        statusReads += 1;
        return Response.json(statusReads === 1
          ? { authenticated: true, user: { email: "director@example.com", name: "Director" } }
          : { authenticated: false, user: null });
      }
      throw new Error(`Unexpected auth request: ${url}`);
    }));

    flushSync(() => {
      root.render(createElement(AuthProvider, null, createElement(AuthProbe)));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=auth-probe]")?.textContent).toBe("authenticated");
    });

    container.querySelector<HTMLButtonElement>("[data-testid=auth-probe]")?.click();
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=auth-probe]")?.textContent).toBe("signed-out");
    });
    expect(statusReads).toBe(2);
  });
});
