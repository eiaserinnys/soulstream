import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { codexHomeDir, ProviderUsageService } from "../../src/auth/provider_usage.js";

describe("Codex home for provider usage", () => {
  it("uses CODEX_HOME when it is set and ~/.codex otherwise", () => {
    expect(codexHomeDir({ CODEX_HOME: "/srv/agent-home/.codex" })).toBe("/srv/agent-home/.codex");
    expect(codexHomeDir({ CODEX_HOME: "  " })).toBe(join(homedir(), ".codex"));
    expect(codexHomeDir({})).toBe(join(homedir(), ".codex"));
  });

  it("reads auth.json from the given Codex home, not from the home folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-usage-codex-home-"));
    try {
      const codexHome = join(root, "agent-home", ".codex");
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "agent-access" } }));
      await mkdir(join(root, "user", ".codex"), { recursive: true });
      await writeFile(join(root, "user", ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "user-access" } }));
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ plan_type: "pro", rate_limit: {} }),
        text: async () => "",
      }) as unknown as Response) as unknown as typeof fetch;

      const service = new ProviderUsageService({ homeDir: join(root, "user"), codexHome, fetchImpl });
      await service.fetchUsage("req-codex-home", "provider_usage_get", "codex");

      const authorizations = vi.mocked(fetchImpl).mock.calls.map(([, init]) =>
        (init?.headers as Record<string, string> | undefined)?.Authorization);
      expect(authorizations).toContain("Bearer agent-access");
      expect(authorizations).not.toContain("Bearer user-access");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
