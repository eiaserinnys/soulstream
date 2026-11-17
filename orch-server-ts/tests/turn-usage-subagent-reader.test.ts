import { describe, expect, it } from "vitest";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { readSubagentUsage } from "../src/control_plane/repositories/turn_usage_subagent_reader.js";

describe("subagent usage query", () => {
  it("selects event types and time before restricting sessions", async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((result, part, index) => {
        const value = values[index];
        return result + part + (value && typeof value === "object" && "text" in value
          ? String(value.text) : index < values.length ? "?" : "");
      }, "");
      queries.push(text);
      return { text, then: (resolve: (rows: unknown[]) => void) => resolve([]) };
    }) as unknown as SqlClient;

    await readSubagentUsage(sql, ["a", "b"], {
      since: new Date("2026-11-10T07:30:00Z"), until: new Date("2026-11-17T07:30:00Z"),
    });

    const query = queries.at(-1)!;
    const picked = query.slice(query.indexOf("WITH picked AS"), query.indexOf("), usage_raw AS"));
    expect(picked).toContain("event_type IN ('complete', 'error')");
    expect(picked).toContain("event_type = 'result' AND (payload->>'success') = 'false'");
    expect(picked).toContain("created_at >=");
    expect(picked).toContain("created_at <");
    expect(picked).not.toMatch(/session_id\s*=\s*ANY/i);
    expect(query.slice(query.indexOf("), usage_raw AS"))).toMatch(/p\.session_id\s*=\s*ANY/i);
  });

  it.each([undefined, new Date("2026-11-10T07:30:00Z")])(
    "restricts list reads to the selected sessions inside picked (since %s)",
    async (since) => {
      const queries: string[] = [];
      const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.reduce((result, part, index) => {
          const value = values[index];
          return result + part + (value && typeof value === "object" && "text" in value
            ? String(value.text) : index < values.length ? "?" : "");
        }, "");
        queries.push(text);
        return { text, then: (resolve: (rows: unknown[]) => void) => resolve([]) };
      }) as unknown as SqlClient;

      await readSubagentUsage(sql, ["a"], {
        since, until: new Date("2026-11-17T07:30:00Z"),
      }, "list");

      const query = queries.at(-1)!;
      const picked = query.slice(query.indexOf("WITH picked AS"), query.indexOf("), usage_raw AS"));
      expect(picked).toMatch(/session_id\s*=\s*ANY/i);
    },
  );
});
