import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  checkReachability,
  describeError,
  describeServerCheck,
  normalizeUrl,
  ServerCheckError,
} from "../url";

describe("normalizeUrl", () => {
  it("preserves an explicitly entered HTTP scheme", () => {
    expect(normalizeUrl("http://localhost:1420/path")).toBe(
      "http://localhost:1420/path",
    );
  });

  it("adds HTTPS when the input has no scheme", () => {
    expect(normalizeUrl("soul.example.me")).toBe("https://soul.example.me");
  });
});

describe("describeServerCheck", () => {
  const url = "https://soul.example.me";

  it("has no message when the server is ok", () => {
    expect(describeServerCheck(url, { kind: "ok" })).toBeNull();
  });

  it("explains an unreachable server", () => {
    expect(describeServerCheck(url, { kind: "unreachable" })).toBe(
      "https://soul.example.me 에 연결할 수 없습니다. 주소와 네트워크를 확인하세요.",
    );
  });

  it("includes the status code for a non-2xx answer", () => {
    expect(describeServerCheck(url, { kind: "http_status", status: 404 })).toBe(
      "https://soul.example.me 가 404 로 응답했습니다. 소울스트림 서버 주소인지 확인하세요.",
    );
  });

  it("explains an answer that is not a Soulstream server", () => {
    expect(describeServerCheck(url, { kind: "not_soulstream" })).toBe(
      "https://soul.example.me 는 소울스트림 서버가 아닙니다. 주소를 확인하세요.",
    );
  });
});

describe("checkReachability", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    invokeMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the Rust check_server command with the timeout and resolves when ok", async () => {
    invokeMock.mockResolvedValue({ kind: "ok" });
    await expect(
      checkReachability("http://127.0.0.1:4105", 5000),
    ).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("check_server", {
      url: "http://127.0.0.1:4105",
      timeoutMs: 5000,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets the user in when Rust cannot connect but the webview can (OS proxy)", async () => {
    invokeMock.mockResolvedValue({ kind: "unreachable" });
    fetchMock.mockResolvedValue({});
    await expect(
      checkReachability("https://a.example", 10000),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://a.example");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "HEAD",
      mode: "no-cors",
    });
  });

  it("shows the unreachable message when neither Rust nor the webview can connect", async () => {
    invokeMock.mockResolvedValue({ kind: "unreachable" });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(checkReachability("https://a.example", 10000)).rejects.toThrow(
      "https://a.example 에 연결할 수 없습니다. 주소와 네트워크를 확인하세요.",
    );
  });

  it("does not ask the webview again after http_status or not_soulstream", async () => {
    fetchMock.mockResolvedValue({});
    invokeMock.mockResolvedValue({ kind: "http_status", status: 404 });
    await expect(checkReachability("https://a.example")).rejects.toThrow("404");
    invokeMock.mockResolvedValue({ kind: "not_soulstream" });
    await expect(checkReachability("https://a.example")).rejects.toThrow(
      "소울스트림 서버가 아닙니다",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with the message for each failed result", async () => {
    invokeMock.mockResolvedValue({ kind: "http_status", status: 502 });
    await expect(checkReachability("https://a.example", 10000)).rejects.toThrow(
      "https://a.example 가 502 로 응답했습니다. 소울스트림 서버 주소인지 확인하세요.",
    );
    invokeMock.mockResolvedValue({ kind: "not_soulstream" });
    await expect(checkReachability("https://a.example")).rejects.toThrow(
      "https://a.example 는 소울스트림 서버가 아닙니다. 주소를 확인하세요.",
    );
  });

  it("rejects with a ServerCheckError when the command itself fails", async () => {
    invokeMock.mockRejectedValue("not allowed");
    const error = await checkReachability("https://a.example").catch((e) => e);
    expect(error).toBeInstanceOf(ServerCheckError);
    expect(error.message).toContain("not allowed");
  });
});

describe("describeError", () => {
  it("shows a ServerCheckError message as is", () => {
    expect(describeError(new ServerCheckError("서버 문구"))).toBe("서버 문구");
  });

  it("wraps other failures", () => {
    expect(describeError("boom")).toBe("연결을 준비하지 못했습니다. (boom)");
  });
});
