import { describe, expect, it, vi } from "vitest";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import { SkillLintReportStore } from "../src/skills/skill_lint_report_store.js";

/** system_settings 한 줄을 흉내 내는 tagged-template sql. */
function fakeSql() {
  const state: { row: { value: unknown; updated_by: string } | null; writes: number } = { row: null, writes: 0 };
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("SELECT")) return state.row ? [{ value: state.row.value }] : [];
    state.row = { value: values[1], updated_by: String(values[2]) };
    state.writes++;
    return [];
  }) as unknown as ((...args: unknown[]) => Promise<unknown[]>) & { json: (value: unknown) => unknown };
  sql.json = (value) => value;
  return { sql, state };
}

const report = { generated_at: "2026-11-25T03:30:00+00:00", skills: [{ name: "a" }, { name: "b" }], catalogs: [{ name: "c" }] };

function host(store: SkillLintReportStore, runs: Record<string, { jobId: string } | null>): McpHostOptions {
  return {
    skillLintReport: store,
    recurringJobs: { service: { getRunBySessionId: vi.fn(async (id: string) => runs[id] ?? null) } },
  } as unknown as McpHostOptions;
}

const call = (options: McpHostOptions, args: Record<string, unknown>, callerSessionId: string | null) =>
  executeMcpTool(options, "put_skill_lint_report", args, { principal: "internal", callerSessionId, nodeId: "node-a" });

describe("put_skill_lint_report", () => {
  it("overwrites a single report in system_settings and answers with counts", async () => {
    const { sql, state } = fakeSql();
    const store = new SkillLintReportStore(async () => sql as never);
    const result = await call(host(store, {}), { report }, "session-1");

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: true, generated_at: report.generated_at, skill_count: 2, catalog_count: 1,
    });
    expect(state.writes).toBe(1);
    expect(state.row?.value).toMatchObject({
      report, uploaded_by_session_id: "session-1", uploaded_by_node_id: "node-a", verify_job_id: null,
    });
    expect(state.row?.updated_by).toBe("session-1");
  });

  it("links verify_job_id from a recurring run session and keeps it for later manual uploads", async () => {
    const { sql } = fakeSql();
    const store = new SkillLintReportStore(async () => sql as never);
    const options = host(store, { "cron-session": { jobId: "job-1" } });

    await call(options, { report }, "cron-session");
    expect((await store.get())?.verify_job_id).toBe("job-1");

    await call(options, { report: { ...report, skills: [] } }, "plain-session");
    const kept = await store.get();
    expect(kept?.verify_job_id).toBe("job-1");
    expect(kept?.uploaded_by_session_id).toBe("plain-session");
    expect((kept?.report.skills as unknown[]).length).toBe(0);
  });

  it("rejects a report without generated_at and skills", async () => {
    const { sql, state } = fakeSql();
    const result = await call(host(new SkillLintReportStore(async () => sql as never), {}), { report: { skills: [] } }, "s");
    expect(result.isError).toBe(true);
    expect(state.writes).toBe(0);
  });
});
