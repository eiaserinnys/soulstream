import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpRuntime, OrchProxyConfig } from "../../src/mcp/runtime.js";
import { preflightModelPreset } from "../../src/mcp/tools/model_preset_preflight.js";

const orch: OrchProxyConfig = {
  baseUrl: "https://orch.example.test",
  headers: { authorization: "Bearer test-token" },
};

function makeLogger(): McpRuntime["logger"] {
  return { warn: vi.fn() } as unknown as McpRuntime["logger"];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preflightModelPreset", () => {
  it("limit_rejected preset은 사유와 해제 시각을 포함한 오류를 돌려준다", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      model_presets: [{
        id: "claude-opus",
        available: false,
        reason: "limit_rejected",
        reason_label: "5시간 한도 거부 중",
        resets_at: "2026-10-12T04:00:00.000Z",
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const logger = makeLogger();

    await expect(preflightModelPreset({
      nodeId: "node / one",
      orch,
      logger,
      selectedPresetId: "claude-opus",
    })).resolves.toBe(
      "Model preset 'claude-opus' is unavailable on node node / one: 5시간 한도 거부 중 (resets_at: 2026-10-12T04:00:00.000Z)",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://orch.example.test/api/nodes/node%20%2F%20one/model-presets");
    expect(options?.method).toBe("GET");
    expect(options?.body).toBeUndefined();
    expect(options?.headers).toMatchObject(orch.headers);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reason_label과 resets_at이 없으면 기본 사유만 돌려준다", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      model_presets: [{
        id: "codex-max",
        available: false,
        reason: "limit_rejected",
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(preflightModelPreset({
      nodeId: "node-one",
      orch,
      logger: makeLogger(),
      selectedPresetId: "codex-max",
    })).resolves.toBe(
      "Model preset 'codex-max' is unavailable on node node-one: 한도 거부 중",
    );
  });

  it.each([
    { available: true, reason: "quota_exhausted" },
    { available: false, reason: "not_authenticated" },
    { available: false, reason: "env_unresolved" },
  ])("실제 limit_rejected가 아니면 막지 않는다 (%o)", async (availability) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      model_presets: [{ id: "codex-max", reason_label: null, resets_at: null, ...availability }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const logger = makeLogger();

    await expect(preflightModelPreset({
      nodeId: "node-one",
      orch,
      logger,
      selectedPresetId: "codex-max",
    })).resolves.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["non-2xx", () => jsonResponse({ secret_response: "do not log" }, 503)],
    ["malformed JSON", () => new Response("{", { status: 200 })],
    ["missing model_presets", () => jsonResponse({ presets: [] })],
    ["model_presets is not an array", () => jsonResponse({ model_presets: {} })],
    ["selected preset is missing", () => jsonResponse({ model_presets: [] })],
    ["selected preset is malformed", () => jsonResponse({
      model_presets: [{ id: "codex-max", available: "false", reason: "limit_rejected" }],
    })],
  ])("조회 응답 %s는 경고 한 번 뒤 fail-open", async (_case, makeResponse) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(makeResponse());
    vi.stubGlobal("fetch", fetchMock);
    const logger = makeLogger();

    await expect(preflightModelPreset({
      nodeId: "node-one",
      orch,
      logger,
      selectedPresetId: "codex-max",
    })).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("do not log");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("test-token");
  });

  it("orch가 없으면 조회 없이 경고 한 번 뒤 fail-open", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const logger = makeLogger();

    await expect(preflightModelPreset({
      nodeId: "node-one",
      orch: undefined,
      logger,
      selectedPresetId: "codex-max",
    })).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("요청 실패는 경고 한 번 뒤 fail-open하고 재시도하지 않는다", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const logger = makeLogger();

    await expect(preflightModelPreset({
      nodeId: "node-one",
      orch,
      logger,
      selectedPresetId: "codex-max",
    })).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("test-token");
  });

  it("2초 요청 제한을 넘기면 경고 한 번 뒤 fail-open하고 재시도하지 않는다", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, options) =>
      new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          reject(new Error("request signal missing"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const logger = makeLogger();

    await expect(preflightModelPreset({
      nodeId: "node-one",
      orch,
      logger,
      selectedPresetId: "codex-max",
    })).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("selected preset이 없으면 조회와 경고를 생략한다", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const logger = makeLogger();

    await expect(preflightModelPreset({
      nodeId: "node-one",
      orch,
      logger,
      selectedPresetId: undefined,
    })).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
