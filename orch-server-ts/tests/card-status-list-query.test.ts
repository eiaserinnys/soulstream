import { describe, expect, it } from "vitest";
import { parseCardQuery } from "../src/cards/completed_card_query.js";

describe("card status list query", () => {
  it("resolves a comma-separated status into a list and takes the paged branch", () => {
    const query = parseCardQuery({ status: "review,blocked,running" });
    expect(query.statuses).toEqual(["review", "blocked", "running"]);
    expect(query.paged).toBe(true);
  });

  it("trims spaces and drops empty items", () => {
    expect(parseCardQuery({ status: " review , ,blocked," }).statuses).toEqual(["review", "blocked"]);
  });

  it("accepts the paged cursor together with a status list", () => {
    const cursor = Buffer.from(JSON.stringify({ rank: 3, time: "2026-11-01T00:00:00Z", id: "a" })).toString("base64url");
    const query = parseCardQuery({ status: "review,running", cursor });
    expect(query.pagedAfter).toEqual({ rank: 3, time: "2026-11-01T00:00:00Z", id: "a" });
    expect(query.after).toBeUndefined();
  });

  it("keeps a single status and a missing status as before", () => {
    const single = parseCardQuery({ status: "review" });
    expect(single.statuses).toBeUndefined();
    expect(single.status).toBe("review");
    expect(single.paged).toBe(false);
    expect(parseCardQuery({ status: "review", limit: "10" }).paged).toBe(true);
    const none = parseCardQuery({});
    expect(none.statuses).toBeUndefined();
    expect(none.paged).toBe(false);
  });

  it("keeps done on the completed branch", () => {
    const query = parseCardQuery({ status: "done", limit: "10" });
    expect(query.statuses).toBeUndefined();
    expect(query.paged).toBe(false);
  });
});
