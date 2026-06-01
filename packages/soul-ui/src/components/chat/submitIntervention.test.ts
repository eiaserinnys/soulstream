/**
 * R-2 fix(2026-05-10) — atom bfdf8f2f (G-1):
 *
 * submitIntervention의 fetch 호출에 `credentials: "include"`가 명시되어 있는지
 * 검증. cross-subdomain 배포 시 cookie(JWT)가 전송되어 server-side가
 * build_browser_caller_info를 정상 조립할 수 있게 한다.
 *
 * 동 리포 `useMessageHistoryBuffer.ts`(L129, L187)와 §9 대칭.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { submitIntervention } from "./submitIntervention";

describe("submitIntervention — credentials: 'include' (R-2 fix G-1)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let queryClient: QueryClient;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    queryClient = new QueryClient();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  });

  it("fetch 옵션에 credentials: 'include'를 명시한다", async () => {
    await submitIntervention({
      sessionKey: "sess-1",
      text: "hello",
      queryClient,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.credentials).toBe("include");
  });

  it("attachmentPaths 동반 호출도 credentials: 'include'를 박는다", async () => {
    await submitIntervention({
      sessionKey: "sess-2",
      text: "with attachment",
      attachmentPaths: ["/tmp/a.png"],
      queryClient,
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.credentials).toBe("include");
    const body = JSON.parse(options.body as string);
    expect(body.text).toBe(
      "with attachment\n\n[첨부 파일 로컬 경로: /tmp/a.png]",
    );
    expect(body.attachmentPaths).toEqual(["/tmp/a.png"]);
  });

  it("기존 body 페이로드(text, user)는 회귀 보존", async () => {
    await submitIntervention({
      sessionKey: "sess-3",
      text: "회귀 보존",
      queryClient,
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(options.body as string);
    expect(body.text).toBe("회귀 보존");
    expect(body.user).toBe("dashboard");
  });
});
