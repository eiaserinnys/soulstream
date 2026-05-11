/**
 * T-G10 (atom G-10, 2026-05-11): submitLlmContinuation이 dashboard auth context user를
 * body.caller_info v1 dict로 박는다.
 *
 * 회로: useChatInputSend가 useAuth() hook으로 user 추출 → submitLlmContinuation ctx.caller로
 * forward → fetch body.caller_info에 build_browser_caller_info §9 대칭 client-side 조립.
 *
 * caller undefined → body.caller_info 키 부재 (graceful, 서버 측 LlmExecutor system fallback
 * 자연 흡수). caller truthy → 키 추가 (source=browser + display_name/user_id/email/avatar_url).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { submitLlmContinuation } from "./submitLlmContinuation";

describe("submitLlmContinuation — caller_info (R-4 atom G-10)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: "sess-new" }),
    } as unknown as Response);
    // @ts-expect-error — 테스트용 mock
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("caller 전달 시 body.caller_info에 v1 dict 박힘", async () => {
    await submitLlmContinuation({
      tree: null,
      text: "hello LLM",
      provider: "openai",
      model: "gpt-4",
      clientId: "test",
      caller: {
        email: "alice@example.com",
        name: "Alice",
        picture: "https://lh.google.com/alice.jpg",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.caller_info).toEqual({
      source: "browser",
      display_name: "Alice",
      user_id: "alice@example.com",
      email: "alice@example.com",
      avatar_url: "https://lh.google.com/alice.jpg",
    });
  });

  it("caller undefined 시 body.caller_info 키 부재 (서버 측 system fallback)", async () => {
    await submitLlmContinuation({
      tree: null,
      text: "hello",
      provider: "openai",
      model: "gpt-4",
      clientId: "test",
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body).not.toHaveProperty("caller_info");
  });

  it("picture 빈 값 → avatar_url 키 부재 (build_browser_caller_info §9 대칭 falsy filter)", async () => {
    await submitLlmContinuation({
      tree: null,
      text: "hello",
      provider: "anthropic",
      model: "claude",
      caller: {
        email: "bob@example.com",
        name: "Bob",
        picture: "",
      },
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.caller_info).toEqual({
      source: "browser",
      display_name: "Bob",
      user_id: "bob@example.com",
      email: "bob@example.com",
    });
    expect(body.caller_info).not.toHaveProperty("avatar_url");
  });

  it("picture undefined → avatar_url 키 부재", async () => {
    await submitLlmContinuation({
      tree: null,
      text: "hello",
      caller: {
        email: "charlie@example.com",
        name: "Charlie",
        // picture 미지정
      },
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.caller_info).not.toHaveProperty("avatar_url");
  });

  it("기존 body 키(provider/model/messages/client_id)는 보존", async () => {
    await submitLlmContinuation({
      tree: null,
      text: "test message",
      provider: "openai",
      model: "gpt-4-turbo",
      clientId: "client-x",
      caller: { email: "user@example.com", name: "User" },
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.provider).toBe("openai");
    expect(body.model).toBe("gpt-4-turbo");
    expect(body.client_id).toBe("client-x");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[body.messages.length - 1]).toEqual({
      role: "user",
      content: "test message",
    });
  });

  it("응답 session_id를 ok 결과로 반환", async () => {
    const result = await submitLlmContinuation({
      tree: null,
      text: "hi",
      caller: { email: "a@b.c", name: "A" },
    });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe("sess-new");
  });
});
