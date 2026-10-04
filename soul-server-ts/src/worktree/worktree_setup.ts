import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { GitProcessError } from "./worktree_process.js";
import type { WorktreeGit } from "./worktree_git.js";
import type { ManagedWorktreePath, WorktreeSetupMode, WorktreeSetupStatus } from "./worktree_types.js";

export interface WorktreeSetupResult {
  status: WorktreeSetupStatus;
  managedPaths: ManagedWorktreePath[];
  warnings: string[];
}

interface PackageRunner {
  packagePath: string;
  runner: "vitest" | "jest";
}

export function defaultWorktreeSetupMode(repoPath: string): WorktreeSetupMode {
  if (existsSync(join(repoPath, "pnpm-workspace.yaml"))) return "shared_dependencies";
  const manifestPath = join(repoPath, "package.json");
  if (!existsSync(manifestPath)) return "none";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { packageManager?: unknown };
  return manifest.packageManager === "pnpm"
    || (typeof manifest.packageManager === "string" && manifest.packageManager.startsWith("pnpm@"))
    ? "shared_dependencies"
    : "none";
}

export async function setupSharedDependencies(input: {
  projectsRoot: string;
  repoId: string;
  worktreePath: string;
  mode: WorktreeSetupMode;
  operation: "create" | "reuse";
  previouslyManagedPaths?: ManagedWorktreePath[];
}, git: WorktreeGit): Promise<WorktreeSetupResult> {
  if (input.mode === "none") {
    return { status: "not_requested", managedPaths: [], warnings: [] };
  }

  const base = join(input.projectsRoot, input.repoId);
  const pnpmRepository = isPnpmRepository(base);
  const warnings: string[] = [];
  const managedPaths: ManagedWorktreePath[] = [];
  const previous = new Map((input.previouslyManagedPaths ?? []).map((entry) => [entry.path, entry]));
  const sourceByPath = new Map<string, string>();
  for (const source of nodeModulesDirectories(base)) {
    if (pnpmRepository && isIndependentNpmProject(base, dirname(source))) continue;
    sourceByPath.set(normalizeRelative(relative(base, source)), source);
  }

  const runners = packageRunners(input.worktreePath, pnpmRepository);
  const runnersByNodeModulesPath = new Map<string, PackageRunner[]>();
  for (const runner of runners) {
    const nodeModulesPath = normalizeRelative(join(runner.packagePath, "node_modules"));
    const group = runnersByNodeModulesPath.get(nodeModulesPath) ?? [];
    group.push(runner);
    runnersByNodeModulesPath.set(nodeModulesPath, group);
  }

  const candidatePaths = new Set<string>([...sourceByPath.keys(), ...previous.keys(), ...runnersByNodeModulesPath.keys()]);
  for (const relativePath of [...candidatePaths].sort()) {
    const source = sourceByPath.get(relativePath);
    const expected = previous.has(relativePath);
    const runnerRequired = runnersByNodeModulesPath.has(relativePath);
    if (input.operation === "reuse" && !expected && !runnerRequired) continue;

    const link = join(input.worktreePath, relativePath);
    if (!existsSync(dirname(link))) {
      if (expected || runnerRequired) warnings.push(`${relativePath}: worktree node_modules link parent is missing`);
      continue;
    }
    if (!source) {
      if (expected || runnerRequired) warnings.push(`${relativePath}: shared source node_modules is missing`);
      continue;
    }

    try {
      const sourceTarget = realpathSync(source);
      if (input.operation === "create" && !await git.isIgnored(input.worktreePath, `${relativePath}/`)) {
        if (runnerRequired) warnings.push(`${relativePath}: target is not ignored, so shared node_modules cannot be linked`);
        continue;
      }

      if (!pathExists(link)) {
        if (input.operation === "reuse") {
          if (expected || runnerRequired) warnings.push(`${relativePath}: shared node_modules link is missing`);
          continue;
        }
        symlinkSync(sourceTarget, link, process.platform === "win32" ? "junction" : "dir");
      }

      const stat = lstatSync(link);
      const linkTarget = stat.isSymbolicLink() ? realpathSync(link) : null;
      if (!linkTarget || linkTarget !== sourceTarget) {
        if (expected || input.operation === "create" || runnerRequired) {
          warnings.push(`${relativePath}: destination exists and is not the managed link`);
        }
        continue;
      }
      managedPaths.push({ path: relativePath, target: sourceTarget });
    } catch (error) {
      if (error instanceof GitProcessError && error.code === "PROCESS_TIMEOUT") throw error;
      warnings.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const runner of runners) {
    const packageLabel = runner.packagePath || ".";
    const relativeNodeModules = join(runner.packagePath, "node_modules");
    const sourceNodeModules = join(base, relativeNodeModules);
    const targetNodeModules = join(input.worktreePath, relativeNodeModules);
    const sourceRunner = join(sourceNodeModules, ".bin", runnerShimName(runner.runner));
    const targetRunner = join(targetNodeModules, ".bin", runnerShimName(runner.runner));
    if (!pathExists(sourceNodeModules)) {
      warnings.push(`${packageLabel}: shared source node_modules for ${runner.runner} is missing`);
    }
    if (!runnerIsExecutable(sourceRunner)) {
      warnings.push(`${packageLabel}: source ${runner.runner} runner is missing or not executable`);
    }
    if (!runnerLinkMatches(sourceNodeModules, targetNodeModules)) {
      warnings.push(`${packageLabel}: shared node_modules link for ${runner.runner} is missing or does not match its source`);
    }
    if (!runnerIsExecutable(targetRunner)) {
      warnings.push(`${packageLabel}: package-local ${runner.runner} runner is missing or not executable`);
    }
  }

  if (managedPaths.length === 0) {
    warnings.push("shared node_modules setup found no linkable ignored dependency directory; the worktree was preserved");
  }
  return {
    status: warnings.length === 0 ? "ready" : "failed",
    managedPaths,
    warnings,
  };
}

function isPnpmRepository(repoPath: string): boolean {
  return defaultWorktreeSetupMode(repoPath) === "shared_dependencies";
}

function packageRunners(worktreePath: string, pnpmRepository: boolean): PackageRunner[] {
  const found: PackageRunner[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.name !== "package.json") continue;
      const manifest = JSON.parse(readFileSync(path, "utf8")) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const packagePath = normalizeRelative(relative(worktreePath, directory));
      if (pnpmRepository && isIndependentNpmProject(worktreePath, directory)) continue;
      for (const runner of ["vitest", "jest"] as const) {
        if (manifest.dependencies?.[runner] !== undefined || manifest.devDependencies?.[runner] !== undefined) {
          found.push({ packagePath, runner });
        }
      }
    }
  };
  visit(worktreePath);
  return found.sort((left, right) => left.packagePath.localeCompare(right.packagePath) || left.runner.localeCompare(right.runner));
}

function isIndependentNpmProject(repoRoot: string, packagePath: string): boolean {
  let directory = packagePath;
  while (directory !== repoRoot && relative(repoRoot, directory) !== "..") {
    if (existsSync(join(directory, "package-lock.json"))) return true;
    directory = dirname(directory);
  }
  return false;
}

function nodeModulesDirectories(base: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.name === "node_modules") {
        if (entry.isDirectory() || entry.isSymbolicLink()) found.push(path);
        continue;
      }
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(base);
  return found.sort();
}

function normalizeRelative(path: string): string {
  return path.replaceAll("\\", "/");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function runnerLinkMatches(sourceNodeModules: string, targetNodeModules: string): boolean {
  try {
    return lstatSync(targetNodeModules).isSymbolicLink()
      && realpathSync(targetNodeModules) === realpathSync(sourceNodeModules);
  } catch {
    return false;
  }
}

function runnerShimName(runner: PackageRunner["runner"]): string {
  return process.platform === "win32" ? `${runner}.cmd` : runner;
}

function runnerIsExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}
