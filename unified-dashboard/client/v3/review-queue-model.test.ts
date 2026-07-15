import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  reviewNavigationSessions,
  reviewQueueSessions,
  reviewSessionPreview,
  reviewSessionTitle,
} from "./review-queue-model";

describe("review queue model", () => {
  it("shows the five most recently updated needs-review sessions in navigation", () => {
    const sessions = [
      ...Array.from({ length: 7 }, (_, index) => session(`review-${index}`, "needs_review", index)),
      session("acknowledged", "acknowledged", 99),
    ];

    expect(reviewNavigationSessions(sessions).map((item) => item.agentSessionId)).toEqual([
      "review-6",
      "review-5",
      "review-4",
      "review-3",
      "review-2",
    ]);
    expect(reviewQueueSessions(sessions)).toHaveLength(7);
  });

  it("never renders a raw multiline prompt or summary beyond 120 code points", () => {
    const value = session("long", "needs_review", 1, `  ${"긴 문장과 JSON\n".repeat(30)}  `);
    value.awaySummary = `  ${"완료 보고\n".repeat(40)}  `;

    expect(reviewSessionTitle(value)).not.toContain("\n");
    expect(reviewSessionPreview(value)).not.toContain("\n");
    expect(Array.from(reviewSessionTitle(value))).toHaveLength(120);
    expect(Array.from(reviewSessionPreview(value))).toHaveLength(120);
    expect(reviewSessionTitle(value).endsWith("…")).toBe(true);
  });
});

function session(
  agentSessionId: string,
  reviewState: "needs_review" | "acknowledged",
  day: number,
  prompt?: string,
): SessionSummary {
  return {
    agentSessionId,
    status: "completed",
    reviewState,
    eventCount: 1,
    prompt,
    updatedAt: new Date(Date.UTC(2026, 6, day + 1)).toISOString(),
  };
}
