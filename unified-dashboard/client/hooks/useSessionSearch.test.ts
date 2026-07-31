import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEARCH_FILTERS,
  buildSessionSearchUrl,
  type SearchFilters,
} from "./useSessionSearch";

describe("buildSessionSearchUrl", () => {
  it("preserves the existing request shape when derived-text scopes are off", () => {
    const url = new URL(
      buildSessionSearchUrl("needle", DEFAULT_SEARCH_FILTERS, 20),
      "https://dashboard.test",
    );

    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "needle",
      top_k: "20",
      search_session_id: "true",
      event_categories: "messages,responses",
    });
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
  });
});
