import { existsSync, readFileSync, readdirSync } from "node:fs";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
  on?: {
    pull_request?: { paths?: string[] };
  };
  jobs?: Record<string, {
    steps?: Array<{
      if?: string;
      name?: string;
      run?: string;
      uses?: string;
      with?: Record<string, string>;
    }>;
  }>;
};

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowsDirectory = `${repositoryRoot}.github/workflows`;
const workspacePath = `${repositoryRoot}pnpm-workspace.yaml`;
const lockfilePath = `${repositoryRoot}pnpm-lock.yaml`;
const dashboardPackagePath = `${repositoryRoot}unified-dashboard/package.json`;
const dashboardSmokeConfigPath = `${repositoryRoot}unified-dashboard/playwright.smoke.config.ts`;
const dashboardSmokeTestPath = `${repositoryRoot}unified-dashboard/e2e/smoke.e2e.ts`;
const dashboardE2eReadmePath = `${repositoryRoot}unified-dashboard/e2e/README.md`;
const readmePath = `${repositoryRoot}README.md`;
const installerPath = `${repositoryRoot}install/install.ps1`;
const soulServerPackagePath = `${repositoryRoot}soul-server-ts/package.json`;

const allowedReleaseActions = [
  "actions/checkout",
  "actions/setup-node",
  "actions/upload-artifact",
  "actions/download-artifact",
  "pnpm/action-setup",
  "dtolnay/rust-toolchain",
  "tauri-apps/tauri-action",
];

function matchesOrderedPathFilter(path: string, patterns: string[]): boolean {
  let selected = false;
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith("!");
    const pattern = excluded ? rawPattern.slice(1) : rawPattern;
    if (matchesGlob(path, pattern)) selected = !excluded;
  }
  return selected;
}

function pullRequestWorkflowsFor(changedPath: string) {
  return readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({
      name,
      workflow: parse(readFileSync(`${workflowsDirectory}/${name}`, "utf8")) as Workflow,
    }))
    .filter(({ workflow }) => {
      const patterns = workflow.on?.pull_request?.paths;
      return Array.isArray(patterns) && matchesOrderedPathFilter(changedPath, patterns);
    });
}

function activeWorkspaceRoots(): string[] {
  const workspace = parse(readFileSync(workspacePath, "utf8")) as { packages?: unknown };
  if (!Array.isArray(workspace.packages)) {
    throw new Error("pnpm-workspace.yaml must declare packages");
  }

  return workspace.packages.flatMap((entry) => {
    if (entry === "packages/*") {
      return readdirSync(`${repositoryRoot}packages`, { withFileTypes: true })
        .filter((candidate) => candidate.isDirectory())
        .filter((candidate) => existsSync(`${repositoryRoot}packages/${candidate.name}/package.json`))
        .map((candidate) => `packages/${candidate.name}`);
    }
    if (typeof entry !== "string") throw new Error("workspace package entries must be strings");
    return [entry];
  });
}

describe("CI maintenance contract", () => {
  it("routes every active workspace and shared package configuration through a PR job", () => {
    const changedPaths = [
      ...activeWorkspaceRoots().map((workspaceRoot) => `${workspaceRoot}/package.json`),
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      ".github/workflows/workspace-validation.yml",
    ];

    for (const changedPath of changedPaths) {
      const selected = pullRequestWorkflowsFor(changedPath);
      const selectedJobs = selected.flatMap(({ workflow }) => Object.keys(workflow.jobs ?? {}));
      expect(selectedJobs, `${changedPath} must select at least one PR validation job`).not.toHaveLength(0);
      expect(selected.map(({ name }) => name), `${changedPath} must select the common workspace job`)
        .toContain("workspace-validation.yml");
    }

    const workflow = parse(readFileSync(`${workflowsDirectory}/workspace-validation.yml`, "utf8")) as Workflow;
    const commands = workflow.jobs?.["workspace-validation"]?.steps
      ?.map((step) => step.run ?? "")
      .join("\n") ?? "";
    expect(commands).toContain("corepack pnpm --filter '*' --recursive --if-present typecheck");
    expect(commands).toContain("corepack pnpm --dir soul-desktop build");
    expect(commands).toContain("corepack pnpm --dir unified-dashboard test:e2e:smoke");

    const failureArtifacts = workflow.jobs?.["workspace-validation"]?.steps
      ?.find((step) => step.name === "Upload dashboard smoke failure artifacts");
    expect(failureArtifacts?.if).toBe("failure()");
    expect(failureArtifacts?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(readFileSync(`${workflowsDirectory}/workspace-validation.yml`, "utf8"))
      .toMatch(/uses:\s+actions\/upload-artifact@[0-9a-f]{40}\s+#\s+v\d+(?:\.\d+)*$/m);
    expect(failureArtifacts?.with).toMatchObject({
      name: "dashboard-smoke-failure-artifacts",
      path: "unified-dashboard/e2e/test-results/smoke",
      "if-no-files-found": "ignore",
    });
  });

  it("declares one reproducible dashboard browser smoke command", () => {
    const dashboardPackage = JSON.parse(readFileSync(dashboardPackagePath, "utf8"));
    expect(dashboardPackage.devDependencies["@playwright/test"]).toBe("1.63.0");
    const lockfile = parse(readFileSync(lockfilePath, "utf8")) as {
      importers?: Record<string, { devDependencies?: Record<string, { specifier?: string }> }>;
    };
    expect(lockfile.importers?.["unified-dashboard"]?.devDependencies?.["@playwright/test"]?.specifier)
      .toBe("1.63.0");
    expect(dashboardPackage.scripts["test:e2e:smoke"])
      .toBe("pnpm build && playwright test --config playwright.smoke.config.ts");

    const smokeConfig = readFileSync(dashboardSmokeConfigPath, "utf8");
    expect(smokeConfig).toContain('trace: "retain-on-failure"');
    expect(smokeConfig).toContain('command: "pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort"');
    expect(readFileSync(dashboardSmokeTestPath, "utf8"))
      .toContain('getByTestId("v3-task-task-alpha")');
    expect(readFileSync(dashboardE2eReadmePath, "utf8"))
      .toContain("pnpm --dir unified-dashboard test:e2e:smoke");
  });

  it("pins only approved release-workflow Actions to full SHAs with readable version tags", () => {
    const observedActions = new Set<string>();
    for (const filename of ["release-desktop.yml", "release-chrome-extension.yml"]) {
      const source = readFileSync(`${workflowsDirectory}/${filename}`, "utf8");
      for (const line of source.split("\n").filter((candidate) => /^\s*(?:-\s*)?uses:\s+/.test(candidate))) {
        const match = line.match(/^\s*(?:-\s*)?uses:\s+([^@\s]+)@([0-9a-f]{40})\s+#\s+(.+?)\s*$/);
        expect(match, `${filename} must pin ${line.trim()} to a commented full SHA`).not.toBeNull();
        const [, action, sha, comment] = match!;
        observedActions.add(action);
        expect(allowedReleaseActions, `${action} must be in the reviewed release Action inventory`)
          .toContain(action);
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(comment).toMatch(/^(?:v\d+(?:\.\d+)*|stable)$/);
      }
    }
    expect([...observedActions].sort()).toEqual([...allowedReleaseActions].sort());
  });

  it("keeps the Node 22.5 and pnpm 10.32.1 support contract aligned", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("Node.js 22.5 or newer");
    expect(readme).toContain("pnpm 10.32.1");

    const installer = readFileSync(installerPath, "utf8");
    expect(installer).toContain('$MINIMUM_NODE_VERSION = [version]"22.5.0"');
    expect(installer).toContain('$PNPM_VERSION = "10.32.1"');

    const soulServerPackage = JSON.parse(readFileSync(soulServerPackagePath, "utf8"));
    expect(soulServerPackage.engines.node).toBe(">=22.5");

    for (const filename of readdirSync(workflowsDirectory)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))) {
      const source = readFileSync(`${workflowsDirectory}/${filename}`, "utf8");
      for (const match of source.matchAll(/node-version:\s*['"]?(\d+)/g)) {
        expect(match[1], `${filename} must use Node 22`).toBe("22");
      }
      if (source.includes("pnpm/action-setup")) {
        expect(source, `${filename} must pin pnpm 10.32.1`).toMatch(
          /uses:\s+pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version:\s+10\.32\.1/,
        );
      }
      if (source.includes("corepack prepare pnpm@")) {
        expect(source, `${filename} must declare pnpm 10.32.1`).toMatch(
          /PNPM_VERSION:\s*['"]10\.32\.1['"]|PNPM_VERSION:\s*10\.32\.1/,
        );
      }
    }
  });
});
