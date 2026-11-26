/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "../../providers/AuthProvider";
import { AuthGate } from "./AuthGate";
import { buildGoogleAuthUrl } from "./Login";

describe("buildGoogleAuthUrl", () => {
  it("uses the main dashboard as the default OAuth return", () => {
    expect(buildGoogleAuthUrl({ pathname: "/", search: "", hash: "" })).toBe(
      "/api/auth/google",
    );
  });

  it("returns to the main dashboard and preserves its hash deep link", () => {
    expect(buildGoogleAuthUrl({ pathname: "/", search: "", hash: "#/feed/sess-1" })).toBe(
      "/api/auth/google?return_to=%2F%23%2Ffeed%2Fsess-1",
    );
  });

  it("preserves encoded root session and optional event queries through OAuth", () => {
    expect(buildGoogleAuthUrl({
      pathname: "/",
      search: "?session=session%2Fwith%20space&event=42",
      hash: "",
    })).toBe(
      "/api/auth/google?return_to=%2F%3Fsession%3Dsession%252Fwith%2520space%26event%3D42",
    );
    expect(buildGoogleAuthUrl({ pathname: "/", search: "?session=sess-1", hash: "" })).toBe(
      "/api/auth/google?return_to=%2F%3Fsession%3Dsess-1",
    );
  });

  it("keeps retired routes for the app-level replace redirect", () => {
    expect(buildGoogleAuthUrl({ pathname: "/v3", search: "", hash: "" })).toBe(
      "/api/auth/google?return_to=%2Fv3",
    );
  });
});

describe("Login password mode", () => {
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

  function renderGate(fetchStub: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    vi.stubGlobal("fetch", vi.fn(fetchStub));
    flushSync(() => {
      root.render(createElement(AuthProvider, null,
        createElement(AuthGate, {
          loginTitle: "Soul Dashboard",
          children: createElement("div", { "data-testid": "dashboard" }, "dashboard"),
        })));
    });
  }

  function configResponse(passwordLoginEnabled: boolean): Response {
    return Response.json({ authEnabled: true, devModeEnabled: false, passwordLoginEnabled });
  }

  function typePassword(value: string): void {
    const input = container.querySelector<HTMLInputElement>("[data-testid=password-login-input]");
    if (input === null) throw new Error("password input is missing");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function submitPassword(): void {
    const form = container.querySelector("form");
    if (form === null) throw new Error("password form is missing");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("shows one password field instead of the Google button", async () => {
    renderGate(async (input) => {
      const url = String(input);
      if (url === "/api/auth/config") return configResponse(true);
      if (url === "/api/auth/status") {
        return Response.json({ authenticated: false, user: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=password-login-input]")).not.toBeNull();
    });
    expect(container.querySelector("[data-testid=password-login-button]")).not.toBeNull();
    expect(container.querySelector("[data-testid=google-login-button]")).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>("[data-testid=password-login-input]")?.type,
    ).toBe("password");
    expect(
      container.querySelector<HTMLInputElement>("[data-testid=password-login-input]")
        ?.getAttribute("autocomplete"),
    ).toBe("current-password");
  });

  it("posts the password and opens the dashboard after the status refresh", async () => {
    let statusReads = 0;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/config") return configResponse(true);
      if (url === "/api/auth/status") {
        statusReads += 1;
        return Response.json(statusReads === 1
          ? { authenticated: false, user: null }
          : { authenticated: true, user: { email: "owner@local", name: "Owner" } });
      }
      if (url === "/api/auth/password-login") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ password: "hunter2" });
        return Response.json({ success: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderGate(fetchStub);

    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=password-login-input]")).not.toBeNull();
    });
    typePassword("hunter2");
    submitPassword();

    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=dashboard]")).not.toBeNull();
    });
    expect(fetchStub).toHaveBeenCalledWith(
      "/api/auth/password-login",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows an invalid password in the alert area", async () => {
    renderGate(async (input) => {
      const url = String(input);
      if (url === "/api/auth/config") return configResponse(true);
      if (url === "/api/auth/status") {
        return Response.json({ authenticated: false, user: null });
      }
      if (url === "/api/auth/password-login") {
        return Response.json({ detail: "비밀번호가 맞지 않습니다" }, { status: 401 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=password-login-input]")).not.toBeNull();
    });
    typePassword("wrong");
    submitPassword();

    await vi.waitFor(() => {
      expect(container.querySelector("[role=alert]")?.textContent).toBe("비밀번호가 맞지 않습니다");
    });
    expect(container.querySelector("[data-testid=dashboard]")).toBeNull();
  });

  it("keeps the Google button and hides the password field in Google mode", async () => {
    renderGate(async (input) => {
      const url = String(input);
      if (url === "/api/auth/config") return configResponse(false);
      if (url === "/api/auth/status") {
        return Response.json({ authenticated: false, user: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid=google-login-button]")).not.toBeNull();
    });
    expect(container.querySelector("[data-testid=password-login-input]")).toBeNull();
  });

  it("shows only the Tailscale guidance for a rejected identity", async () => {
    renderGate(async (input) => {
      if (String(input) === "/api/auth/config") return Response.json({ authEnabled: true, devModeEnabled: false, tailscaleAuthEnabled: true });
      if (String(input) === "/api/auth/status") return Response.json({ authenticated: false, user: null });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Tailscale에 허용된 계정으로 로그인한 기기에서 이 서버의 Serve 주소로 접속하세요."));
    expect(container.querySelector("[data-testid=google-login-button]")).toBeNull();
    expect(container.querySelector("[data-testid=password-login-input]")).toBeNull();
  });
});
