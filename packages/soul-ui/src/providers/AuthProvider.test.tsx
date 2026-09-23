/**
 * @vitest-environment jsdom
 */

import { StrictMode, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthGate } from "../components/auth/AuthGate";
import { AuthProvider, useAuth } from "./AuthProvider";

function AuthProbe() {
  const auth = useAuth();
  return createElement("button", {
    type: "button",
    onClick: () => { void auth.refreshAuthStatus(); },
    "data-testid": "auth-probe",
  }, auth.isLoading ? "loading" : auth.isAuthenticated ? "authenticated" : "signed-out");
}

function AuthGateProbe() {
  const auth = useAuth();
  return createElement("div", null,
    createElement("span", { "data-testid": "auth-state" }, auth.isAuthenticated ? "authenticated" : "signed-out"),
    createElement("button", {
      type: "button",
      onClick: () => { void auth.refreshAuthStatus(); },
      "data-testid": "refresh-auth",
    }, "refresh"),
    createElement(AuthGate, {
      loginTitle: "Soul Dashboard",
      children: createElement("div", { "data-testid": "dashboard" }, "dashboard"),
    }),
  );
}

function authStatusResponse(authenticated: boolean): Response {
  return Response.json({
    authenticated,
    user: authenticated ? { email: "director@example.com", name: "Director" } : null,
  });
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

  it.each(["/api/sessions", "/api/folders", "/api/planner/today", "/api/auth/token"])(
    "returns to login when %s returns 401 and auth status confirms expiry",
    async (path) => {
      let statusReads = 0;
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/config") {
          return Response.json({ authEnabled: true, devModeEnabled: false });
        }
        if (url === "/api/auth/status") {
          statusReads += 1;
          return authStatusResponse(statusReads === 1);
        }
        if (url === path) return Response.json({ detail: "Authentication required" }, { status: 401 });
        throw new Error(`Unexpected request: ${url}`);
      }));

      flushSync(() => {
        root.render(createElement(AuthProvider, null, createElement(AuthGateProbe)));
      });
      await vi.waitFor(() => {
        expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
      });

      const response = await fetch(path);
      expect(response.status).toBe(401);
      await vi.waitFor(() => {
        expect(container.querySelector("[data-testid=auth-state]")?.textContent).toBe("signed-out");
        expect(container.querySelector("[data-testid=dashboard]")).toBeNull();
      });
      expect(statusReads).toBe(2);

      await fetch(path);
      expect(statusReads).toBe(2);
    },
  );

  it.each([403, 503])("keeps the dashboard open for HTTP %s", async (status) => {
    let statusReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/config") {
        return Response.json({ authEnabled: true, devModeEnabled: false });
      }
      if (url === "/api/auth/status") {
        statusReads += 1;
        return authStatusResponse(true);
      }
      if (url === "/api/planner/today") {
        return Response.json({ detail: "Request failed" }, { status });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    flushSync(() => {
      root.render(createElement(AuthProvider, null, createElement(AuthGateProbe)));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
    });

    const response = await fetch("/api/planner/today");
    expect(response.status).toBe(status);
    expect(statusReads).toBe(1);
    expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
  });

  it("does not sign out when the protected request fails at the network layer", async () => {
    let statusReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/config") {
        return Response.json({ authEnabled: true, devModeEnabled: false });
      }
      if (url === "/api/auth/status") {
        statusReads += 1;
        return authStatusResponse(true);
      }
      if (url === "/api/sessions") throw new TypeError("offline");
      throw new Error(`Unexpected request: ${url}`);
    }));

    flushSync(() => {
      root.render(createElement(AuthProvider, null, createElement(AuthGateProbe)));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
    });

    await expect(fetch("/api/sessions")).rejects.toThrow("offline");
    expect(statusReads).toBe(1);
    expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
  });

  it("keeps authentication when the status check after a 401 fails", async () => {
    let statusReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/config") {
        return Response.json({ authEnabled: true, devModeEnabled: false });
      }
      if (url === "/api/auth/status") {
        statusReads += 1;
        return statusReads === 1
          ? authStatusResponse(true)
          : Response.json({ detail: "Unavailable" }, { status: 503 });
      }
      if (url === "/api/sessions") {
        return Response.json({ detail: "Authentication required" }, { status: 401 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    flushSync(() => {
      root.render(createElement(AuthProvider, null, createElement(AuthGateProbe)));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
    });

    await fetch("/api/sessions");
    await vi.waitFor(() => expect(statusReads).toBe(2));
    expect(container.querySelector("[data-testid=auth-state]")?.textContent).toBe("authenticated");
    expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
  });

  it("shares concurrent 401 checks and keeps the dashboard when auth status confirms the user", async () => {
    let statusReads = 0;
    let resolveRefresh: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/config") {
        return Promise.resolve(Response.json({ authEnabled: true, devModeEnabled: false }));
      }
      if (url === "/api/auth/status") {
        statusReads += 1;
        if (statusReads === 1) return Promise.resolve(authStatusResponse(true));
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      if (["/api/sessions", "/api/folders", "/api/planner/today"].includes(url)) {
        return Promise.resolve(Response.json({ detail: "Not authorized for this resource" }, { status: 401 }));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    flushSync(() => {
      root.render(createElement(AuthProvider, null, createElement(AuthGateProbe)));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
    });

    const responses = await Promise.all([
      fetch("/api/sessions"),
      fetch("/api/folders"),
      fetch("/api/planner/today"),
    ]);
    expect(responses.every((response) => response.status === 401)).toBe(true);
    await vi.waitFor(() => expect(statusReads).toBe(2));
    resolveRefresh?.(authStatusResponse(true));
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=auth-state]")?.textContent).toBe("authenticated");
    });
    expect(statusReads).toBe(2);
    expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
  });

  it("returns to normal session reads after authentication is restored", async () => {
    let statusReads = 0;
    let sessionReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/config") {
        return Response.json({ authEnabled: true, devModeEnabled: false });
      }
      if (url === "/api/auth/status") {
        statusReads += 1;
        return authStatusResponse(statusReads !== 2);
      }
      if (url === "/api/sessions") {
        sessionReads += 1;
        return sessionReads === 1
          ? Response.json({ detail: "Authentication required" }, { status: 401 })
          : Response.json({ sessions: [], total: 0 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    flushSync(() => {
      root.render(createElement(AuthProvider, null, createElement(AuthGateProbe)));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
    });

    await fetch("/api/sessions");
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).toBeNull();
    });
    container.querySelector<HTMLButtonElement>("[data-testid=refresh-auth]")?.click();
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
    });

    const response = await fetch("/api/sessions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: [], total: 0 });
    expect(statusReads).toBe(3);
    expect(sessionReads).toBe(2);
  });

  it("shows the AuthGate login when auth config cannot be loaded", async () => {
    let statusReads = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/config") {
        return Response.json({ detail: "Unavailable" }, { status: 503 });
      }
      if (url === "/api/auth/status") {
        statusReads += 1;
        return authStatusResponse(false);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    flushSync(() => {
      root.render(createElement(AuthProvider, null, createElement(AuthGateProbe)));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=google-login-button]")).not.toBeNull();
    });

    expect(container.querySelector("[data-testid=dashboard]")).toBeNull();
    expect(statusReads).toBe(0);
  });

  it("keeps AuthGate open when auth is disabled and a protected fetch returns 401", async () => {
    let statusReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/config") {
        return Response.json({ authEnabled: false, devModeEnabled: false });
      }
      if (url === "/api/auth/status") {
        statusReads += 1;
        return authStatusResponse(true);
      }
      if (url === "/api/planner/today") {
        return Response.json({ detail: "Not authorized for this resource" }, { status: 401 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    flushSync(() => {
      root.render(createElement(AuthProvider, null, createElement(AuthGateProbe)));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
    });

    const response = await fetch("/api/planner/today");
    expect(response.status).toBe(401);
    await vi.waitFor(() => expect(statusReads).toBe(1));
    expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
  });

  it("restores fetch after StrictMode remount and ignores a 401 that arrives after unmount", async () => {
    let statusReads = 0;
    let resolveSessions: ((response: Response) => void) | undefined;
    const originalFetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/config") {
        return Promise.resolve(Response.json({ authEnabled: true, devModeEnabled: false }));
      }
      if (url === "/api/auth/status") {
        statusReads += 1;
        return Promise.resolve(authStatusResponse(true));
      }
      if (url === "/api/sessions") {
        return new Promise<Response>((resolve) => { resolveSessions = resolve; });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", originalFetch);

    flushSync(() => {
      root.render(createElement(StrictMode, null,
        createElement(AuthProvider, null, createElement(AuthGateProbe)),
      ));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
    });

    const observedFetch = globalThis.fetch;
    expect(observedFetch).not.toBe(originalFetch);
    const pendingSessions = observedFetch("/api/sessions");
    const statusReadsBeforeUnmount = statusReads;
    flushSync(() => root.unmount());
    expect(globalThis.fetch).toBe(originalFetch);
    root = createRoot(container);

    resolveSessions?.(Response.json({ detail: "Authentication required" }, { status: 401 }));
    const response = await pendingSessions;
    expect(response.status).toBe(401);
    expect(statusReads).toBe(statusReadsBeforeUnmount);
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
