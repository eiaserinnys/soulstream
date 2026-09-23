// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionSearch } from "./useSessionSearch";

import {
  DEFAULT_SEARCH_FILTERS,
  buildSessionSearchUrl,
  hasExactNormalizedSessionTitle,
  type SearchFilters,
} from "./useSessionSearch";

vi.mock("@seosoyoung/soul-ui", () => ({
  useUiEventTracker: () => vi.fn(),
}));

let root: Root | null = null;
let current: ReturnType<typeof useSessionSearch>;

function HookProbe() {
  current = useSessionSearch();
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  vi.unstubAllGlobals();
});

describe("buildSessionSearchUrl", () => {
  it("requests product session results without changing the existing search filters", () => {
    const url = new URL(
      buildSessionSearchUrl("needle", DEFAULT_SEARCH_FILTERS, 20),
      "https://dashboard.test",
    );

    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "needle",
      top_k: "20",
      search_session_id: "true",
      include_session_results: "true",
      session_search_mode: "expanded",
      event_categories: "messages,responses",
    });
  });

  it("selects the lexical or expanded stage explicitly", () => {
    const lexical = new URL(
      buildSessionSearchUrl("needle", DEFAULT_SEARCH_FILTERS, 20, "lexical"),
      "https://dashboard.test",
    );
    const expanded = new URL(
      buildSessionSearchUrl("needle", DEFAULT_SEARCH_FILTERS, 20, "expanded"),
      "https://dashboard.test",
    );

    expect(lexical.searchParams.get("session_search_mode")).toBe("lexical");
    expect(expanded.searchParams.get("session_search_mode")).toBe("expanded");
  });

  it("skips the semantic follow-up only for an exact normalized title", () => {
    expect(hasExactNormalizedSessionTitle("피드·검색", [
      { title: "피드 검색" },
    ])).toBe(true);
    expect(hasExactNormalizedSessionTitle("피드검색", [
      { title: "피드 검색 업무 자동선택" },
    ])).toBe(false);
    expect(hasExactNormalizedSessionTitle("의역 질의", [
      { title: "다른 제목" },
    ])).toBe(false);
  });

  it("adds only the explicitly enabled derived-text scopes", () => {
    const filters: SearchFilters = {
      ...DEFAULT_SEARCH_FILTERS,
      includeTurnSummaries: true,
      includeHighlight: false,
      includeStory: true,
    };
    const url = new URL(
      buildSessionSearchUrl("story needle", filters, 7),
      "https://dashboard.test",
    );

    expect(url.searchParams.get("include_turn_summaries")).toBe("true");
    expect(url.searchParams.has("include_highlight")).toBe(false);
    expect(url.searchParams.get("include_story")).toBe("true");
    expect(url.searchParams.get("include_session_results")).toBe("true");
  });
});

describe("useSessionSearch staged requests", () => {
  it("publishes lexical rows before expansion and retains them when expansion fails", async () => {
    const lexical = deferred<Response>();
    const expanded = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(lexical.promise)
      .mockReturnValueOnce(expanded.promise);
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root?.render(createElement(HookProbe)));

    let request!: Promise<void>;
    await act(async () => {
      request = current.search("의역 질의");
      await Promise.resolve();
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("session_search_mode=lexical");

    await act(async () => {
      lexical.resolve(jsonResponse({
        results: [],
        navigation_results: [],
        session_results: [sessionResult("lexical-target", "다른 제목")],
      }));
      await lexical.promise;
      await Promise.resolve();
    });

    expect(current.sessionResults.map((result) => result.session_id)).toEqual(["lexical-target"]);
    expect(current.loading).toBe(false);
    expect(current.expansionPending).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("session_search_mode=expanded");

    await act(async () => {
      expanded.resolve(jsonResponse({}, false));
      await request;
    });
    expect(current.sessionResults.map((result) => result.session_id)).toEqual(["lexical-target"]);
    expect(current.expansionFailed).toBe(true);
    expect(current.expansionPending).toBe(false);
    expect(current.loading).toBe(false);
  });

  it("retains lexical rows when expanded HTTP 200 reports partial search", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        results: [],
        navigation_results: [],
        session_results: [sessionResult("lexical-target", "다른 제목")],
      }))
      .mockResolvedValueOnce(jsonResponse({
        results: [],
        navigation_results: [],
        session_results: [sessionResult("partial-replacement", "부분 응답")],
        search_status: {
          query_expansion: { status: "partial", reason: "timeout", latency_ms: 4_500 },
        },
      })));
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root?.render(createElement(HookProbe)));

    await act(async () => {
      await current.search("의역 질의");
    });

    expect(current.sessionResults.map((result) => result.session_id)).toEqual(["lexical-target"]);
    expect(current.expansionFailed).toBe(true);
    expect(current.expansionPending).toBe(false);
    expect(current.loading).toBe(false);
  });

  it("updates the session projection but preserves its initial event link", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        session_results: [{
          ...sessionResult("same-session", "다른 제목"),
          excerpt: "lexical excerpt",
          best_match: { event_id: 11, match_source: "message", excerpt: "lexical excerpt" },
          session_url: "/?session=same-session&event=11",
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        session_results: [{
          ...sessionResult("same-session", "의미 결과 제목"),
          excerpt: "expanded excerpt",
          best_match: { event_id: 22, match_source: "assistant_message", excerpt: "expanded excerpt" },
          session_url: "/?session=same-session&event=22",
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root?.render(createElement(HookProbe)));

    await act(async () => {
      await current.search("의역 질의");
    });

    expect(current.sessionResults).toMatchObject([{
      session_id: "same-session",
      title: "의미 결과 제목",
      best_match: { event_id: 11, match_source: "message" },
      session_url: "/?session=same-session&event=11",
    }]);
  });

  it("invalidates an in-flight expanded response as soon as filters change", async () => {
    const lexical = deferred<Response>();
    const expanded = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(lexical.promise)
      .mockReturnValueOnce(expanded.promise);
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root?.render(createElement(HookProbe)));

    let request!: Promise<void>;
    await act(async () => {
      request = current.search("의역 질의");
      lexical.resolve(jsonResponse({ session_results: [sessionResult("lexical", "다른 제목")] }));
      await lexical.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    const expandedSignal = fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal;

    await act(async () => current.invalidate());
    expect(expandedSignal.aborted).toBe(true);
    expect(current.sessionResults.map((result) => result.session_id)).toEqual(["lexical"]);

    await act(async () => {
      expanded.resolve(jsonResponse({ session_results: [sessionResult("late", "늦은 의미 결과")] }));
      await request;
    });
    expect(current.sessionResults.map((result) => result.session_id)).toEqual(["lexical"]);
    expect(current.expansionPending).toBe(false);
  });

  it("aborts a previous expansion and ignores its late results after a new query", async () => {
    const oldLexical = deferred<Response>();
    const oldExpanded = deferred<Response>();
    const newLexical = deferred<Response>();
    const newExpanded = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldLexical.promise)
      .mockReturnValueOnce(oldExpanded.promise)
      .mockReturnValueOnce(newLexical.promise)
      .mockReturnValueOnce(newExpanded.promise);
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root?.render(createElement(HookProbe)));

    let oldRequest!: Promise<void>;
    await act(async () => {
      oldRequest = current.search("옛 질의");
      await Promise.resolve();
      oldLexical.resolve(jsonResponse({ session_results: [sessionResult("old", "옛 제목")] }));
      await oldLexical.promise;
      await Promise.resolve();
    });
    const oldSignal = fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal;

    let newRequest!: Promise<void>;
    await act(async () => {
      newRequest = current.search("새 질의");
      await Promise.resolve();
      newLexical.resolve(jsonResponse({ session_results: [sessionResult("new", "새 제목 결과")] }));
      await newLexical.promise;
      await Promise.resolve();
    });
    expect(oldSignal.aborted).toBe(true);

    await act(async () => {
      oldExpanded.resolve(jsonResponse({ session_results: [sessionResult("late-old", "늦은 결과")] }));
      await oldRequest;
    });
    expect(current.sessionResults.map((result) => result.session_id)).toEqual(["new"]);
    await act(async () => {
      newExpanded.resolve(jsonResponse({ session_results: [sessionResult("new-expanded", "새 질의 확장 결과")] }));
      await newRequest;
    });
    expect(current.sessionResults.map((result) => result.session_id)).toEqual(["new-expanded"]);
  });
});

function sessionResult(session_id: string, title: string) {
  return {
    session_id,
    title,
    excerpt: "",
    updated_at: null,
    task_id: null,
    task_title: null,
    parent_session_id: null,
    best_match: { event_id: null, match_source: "session_title", excerpt: "" },
    evidence: [],
    session_url: `/?session=${session_id}`,
  };
}

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    json: async () => payload,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}
