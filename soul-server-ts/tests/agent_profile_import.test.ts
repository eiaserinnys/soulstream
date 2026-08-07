import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentProfileSchema } from "../src/agent_registry.js";
import {
  buildAgentProfileImportPlan,
  assertAgentProfileImportApproval,
  projectAgentProfileImportDryRun,
} from "../src/agent_profile_import.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("agent profile import planner", () => {
  it("produces a deterministic semantic dry-run without portrait bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-profile-import-"));
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const portraitPath = join(directory, "portrait.png");
    await writeFile(portraitPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const profile = AgentProfileSchema.parse({
      id: "roselin",
      name: "로젤린",
      backend: "codex",
      workspace_dir: "/tmp/roselin",
      portrait_path: portraitPath,
      aliases: ["roselin_codex"],
      atom_contexts: [],
    });

    const plan = await buildAgentProfileImportPlan([profile], []);
    const dryRun = projectAgentProfileImportDryRun(plan);

    expect(dryRun).toMatchObject({
      mode: "dry-run",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      summary: { create: 1, update: 0, unchanged: 0 },
      profiles: [{
        agent_id: "roselin",
        action: "create",
        expected_version: null,
        portrait: {
          action: "put",
          mime: "image/png",
          size: 4,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      }],
    });
    expect(JSON.stringify(dryRun)).not.toContain("dataBase64");
    expect(JSON.stringify(dryRun)).not.toContain(portraitPath);
    expect(() => assertAgentProfileImportApproval(plan, "wrong")).toThrow(
      "approved fingerprint does not match",
    );
    expect(() => assertAgentProfileImportApproval(plan, plan.fingerprint)).not.toThrow();
  });
});
