import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtomHttpClient } from "../src/atom/atom_routes.js";
import { registerSkillGuidesRoutes } from "../src/skills/skill_guides_routes.js";
import type { StoredSkillLintReport } from "../src/skills/skill_lint_report_store.js";

const N = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SKILL_ROOT = N(1);
const CATALOG_ROOT = N(2);
const markdowns = {
  [SKILL_ROOT]: `# skills <!-- node:${SKILL_ROOT} -->\n\n## alpha <!-- node:${N(10)} card:${N(11)} depth:1 -->\ndescription: first\nbody_node_id: ${N(12)}\n\n## beta <!-- node:${N(20)} card:${N(21)} depth:1 -->\ndescription: second\nbody_node_id: ${N(22)}\n`,
  [CATALOG_ROOT]: `# catalogs <!-- node:${CATALOG_ROOT} -->\n\n## web <!-- node:${N(30)} card:${N(31)} depth:1 -->\ndescription: web catalog\nbody_node_id: ${N(32)}\naxis: [media]\ncomposition: orthogonal\n`,
} as Record<string, string>;

const httpClient: AtomHttpClient = {
  get: vi.fn(async ({ url }) => {
    const parsed = new URL(url);
    const compile = /^\/api\/tree\/([^/]+)\/compile$/.exec(parsed.pathname);
    if (compile && markdowns[compile[1]!]) return { statusCode: 200, body: { markdown: markdowns[compile[1]!] } };
    if (compile?.[1] === N(12)) return { statusCode: 200, body: { markdown: `# alpha <!-- node:${N(12)} -->\n\nalpha body\n` } };
    if (parsed.pathname === "/api/tree/outline") return { statusCode: 200, body: { nodes: [{ id: N(12), child_count: 0 }] } };
    return { statusCode: 404, body: null };
  }),
  post: vi.fn(async () => ({
    statusCode: 200,
    body: { result: { content: [{ text: JSON.stringify({ id: N(12), parent_node_id: null, card: { version: 3 } }) }] } },
  })),
};

const stored: StoredSkillLintReport = {
  report: {
    generated_at: "2026-11-25T03:30:00+00:00",
    findings: [
      { code: "W101", level: "warning", target: "alpha", message: "alpha is long" },
      { code: "W103", level: "warning", target: "절 제목", message: "duplicated section", affected: ["alpha", "beta"] },
    ],
    skills: [{
      name: "alpha", body_chars: 120, dependencies: ["beta", "web"], block_counts: { call: 1, include: 0, pick: 1 },
      called_by: ["beta"], agent_count: 2, findings: ["W101"],
    }, {
      name: "gamma-not-in-atom", body_chars: 1, dependencies: [], block_counts: { call: 0, include: 0, pick: 0 }, called_by: [], agent_count: 0, findings: [],
    }],
    catalogs: [{ name: "web", axis: ["media"], composition: "orthogonal", used_by: ["alpha"], findings: [] }],
  },
  uploaded_at: "2026-11-25T03:31:00.000Z",
  uploaded_by_session_id: "cron-session",
  uploaded_by_node_id: "node-a",
  verify_job_id: "job-1",
};

async function build(current: StoredSkillLintReport | null, runManual = vi.fn(async () => ({}))) {
  const app = Fastify();
  registerSkillGuidesRoutes(app, {
    store: { get: async () => current, put: async () => current! },
    skills: { enabled: true, serverUrl: "https://atom.test", apiKey: "k", nodeId: SKILL_ROOT, catalogsNodeId: CATALOG_ROOT, typesafeApiKey: "", httpClient },
    recurringJobs: { runManual } as never,
    resolveActor: async () => ({ ownerEmail: "u@example.com" }) as never,
  });
  await app.ready();
  return { app, runManual };
}

let open: Awaited<ReturnType<typeof build>>["app"] | undefined;
afterEach(async () => { await open?.close(); open = undefined; });

describe("skill guides routes", () => {
  it("merges the atom lists with the stored lint report by name", async () => {
    const { app } = await build(stored);
    open = app;
    const body = (await app.inject({ url: "/api/skill-guides" })).json();

    expect(body.skills.map((skill: { name: string }) => skill.name)).toEqual(["alpha", "beta"]);
    expect(body.skills[0]).toMatchObject({
      name: "alpha", description: "first", entry_node_id: N(10), entry_card_id: N(11), body_node_id: N(12),
      lint: {
        body_chars: 120, called_by: ["beta"], agent_count: 2, block_counts: { call: 1, include: 0, pick: 1 },
        links: [{ kind: null, target: "beta", target_kind: "skill" }, { kind: null, target: "web", target_kind: "catalog" }],
      },
    });
    expect(body.skills[0].lint.findings.map((finding: { code: string }) => finding.code).sort()).toEqual(["W101", "W103"]);
    expect(body.skills[0].lint.findings.find((finding: { code: string }) => finding.code === "W101"))
      .toEqual({ code: "W101", level: "warning", message: "alpha is long" });
    // 보고에 없는 스킬은 lint null.
    expect(body.skills[1]).toMatchObject({ name: "beta", lint: null });
    expect(body.catalogs).toEqual([{
      name: "web", description: "web catalog", node_id: N(30), card_id: N(31),
      lint: { axis: ["media"], composition: "orthogonal", used_by: ["alpha"], findings: [] },
    }]);
    expect(body.report).toMatchObject({
      generated_at: stored.report.generated_at, uploaded_at: stored.uploaded_at,
      uploaded_by_session_id: "cron-session", verify_job_id: "job-1",
    });
    expect(body.report.findings).toHaveLength(2);
  });

  it("passes report links through when the report carries them", async () => {
    const withLinks = structuredClone(stored);
    (withLinks.report.skills as Array<Record<string, unknown>>)[0]!.links = [{ kind: "call", target: "beta", target_kind: "skill" }];
    const { app } = await build(withLinks);
    open = app;
    const body = (await app.inject({ url: "/api/skill-guides" })).json();
    expect(body.skills[0].lint.links).toEqual([{ kind: "call", target: "beta", target_kind: "skill" }]);
  });

  it("answers lint null and report null when no report was uploaded", async () => {
    const { app } = await build(null);
    open = app;
    const body = (await app.inject({ url: "/api/skill-guides" })).json();
    expect(body.report).toBeNull();
    expect(body.skills.every((skill: { lint: unknown }) => skill.lint === null)).toBe(true);
    expect(body.catalogs[0].lint).toBeNull();
  });

  it("reads a skill body and answers 404 for an unknown name", async () => {
    const { app } = await build(null);
    open = app;
    const ok = await app.inject({ url: "/api/skill-guides/alpha/body" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ name: "alpha", body_node_id: N(12), markdown: "\nalpha body\n" });
    expect((await app.inject({ url: "/api/skill-guides/nope/body" })).statusCode).toBe(404);
  });

  it("runs the verify job through the recurring job service with 202, or 409 without a job", async () => {
    const withJob = await build(stored);
    open = withJob.app;
    const accepted = await withJob.app.inject({ method: "POST", url: "/api/skill-guides/verify" });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ job_id: "job-1" });
    expect(withJob.runManual).toHaveBeenCalledWith({ ownerEmail: "u@example.com" }, "job-1", expect.stringMatching(/^skill-guides-verify-/));
    await withJob.app.close();

    const noJob = await build({ ...stored, verify_job_id: null });
    open = noJob.app;
    const refused = await noJob.app.inject({ method: "POST", url: "/api/skill-guides/verify" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "no_verify_job" });
    expect(noJob.runManual).not.toHaveBeenCalled();
  });
});
