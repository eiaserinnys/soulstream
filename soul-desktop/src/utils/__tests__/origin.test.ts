import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Dynamic import: mock 등록 후 import해야 모킹된 invoke를 사용한다.
import { registerDashboardOrigin } from "../origin";

describe("registerDashboardOrigin", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("path/query를 제거한 origin만 invoke로 전달", async () => {
    invokeMock.mockResolvedValue(undefined);
    await registerDashboardOrigin("https://soul.example.me/dashboard?token=abc");
    expect(invokeMock).toHaveBeenCalledWith("set_dashboard_origin", {
      origin: "https://soul.example.me",
    });
  });

  it("port가 포함된 URL도 origin에 port 보존", async () => {
    invokeMock.mockResolvedValue(undefined);
    await registerDashboardOrigin("http://localhost:1420/");
    expect(invokeMock).toHaveBeenCalledWith("set_dashboard_origin", {
      origin: "http://localhost:1420",
    });
  });

  it("잘못된 URL은 throw — invoke 호출 안 함", async () => {
    await expect(registerDashboardOrigin("not a url")).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
