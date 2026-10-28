import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renameWithTransientRetrySync } from "../atomic_file_rename.js";
import type {
  ClaudeAccountBlocksRecord,
  ClaudeAccountRecord,
  ClaudeAccountsJsonFile,
  ClaudeBindingsJsonFile,
  ClaudeBlocksJsonFile,
} from "./types.js";

export const SHARED_CLAUDE_HOME_ENTRIES = [
  "projects",
  "file-history",
  "tasks",
  "plans",
  "session-env",
  "agent-memory",
] as const;

export const PER_PROFILE_CLAUDE_ENTRIES = [
  ".credentials.json",
  ".claude.json",
  "sessions",
  "debug",
  "cache",
  "locks",
  "shell-snapshots",
] as const;

export class ClaudeAccountProfileSymlinkConflictError extends Error {
  readonly profileDir: string;
  readonly entryName: string;
  readonly conflictingPath: string;

  constructor(params: { profileDir: string; entryName: string; conflictingPath: string }) {
    super(
      `Refusing to overwrite existing non-symlink entry "${params.entryName}" at "${params.conflictingPath}" in Claude profile "${params.profileDir}". Inspect and migrate or remove it manually before linking to ~/.claude/${params.entryName}.`,
    );
    this.name = "ClaudeAccountProfileSymlinkConflictError";
    this.profileDir = params.profileDir;
    this.entryName = params.entryName;
    this.conflictingPath = params.conflictingPath;
  }
}

function ensureDir0700(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Ignore chmod errors on platforms that do not support POSIX permissions
  }
}

function writeJsonAtomic0600(filePath: string, data: unknown): void {
  const parentDir = path.dirname(filePath);
  ensureDir0700(parentDir);
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(parentDir, `.${path.basename(filePath)}.${suffix}.tmp`);
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  try {
    fs.writeFileSync(tmpPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // Ignore on non-POSIX
    }
    renameWithTransientRetrySync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Best-effort cleanup
    }
    throw err;
  }
}

function readJsonOrDefault<T>(filePath: string, defaultValue: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return defaultValue;
    }
    throw err;
  }
}

export function ensureProfileSharedSymlinks(
  profileDir: string,
  homeDir: string = os.homedir(),
): void {
  ensureDir0700(profileDir);
  const sharedRoot = path.join(homeDir, ".claude");
  ensureDir0700(sharedRoot);

  // First pass: check for any non-symlink conflicts before mutating anything
  for (const entry of SHARED_CLAUDE_HOME_ENTRIES) {
    const linkPath = path.join(profileDir, entry);
    try {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        throw new ClaudeAccountProfileSymlinkConflictError({
          profileDir,
          entryName: entry,
          conflictingPath: linkPath,
        });
      }
    } catch (err) {
      if (err instanceof ClaudeAccountProfileSymlinkConflictError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }

  // Second pass: create target directories in ~/.claude and link from profileDir
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  for (const entry of SHARED_CLAUDE_HOME_ENTRIES) {
    const targetDir = path.join(sharedRoot, entry);
    ensureDir0700(targetDir);
    const linkPath = path.join(profileDir, entry);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const currentTarget = fs.readlinkSync(linkPath);
        if (path.resolve(profileDir, currentTarget) === path.resolve(targetDir)) {
          continue;
        }
        fs.unlinkSync(linkPath);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
    fs.symlinkSync(targetDir, linkPath, symlinkType);
  }
}

export interface ClaudeAccountStoreOptions {
  accountsDir: string;
  homeDir?: string;
}

export class ClaudeAccountStore {
  readonly accountsDir: string;
  readonly homeDir: string;
  readonly profilesDir: string;
  readonly pendingDir: string;
  readonly retiredDir: string;
  readonly accountsFilePath: string;
  readonly bindingsFilePath: string;
  readonly blocksFilePath: string;

  constructor(options: ClaudeAccountStoreOptions) {
    this.accountsDir = path.resolve(options.accountsDir);
    this.homeDir = path.resolve(options.homeDir ?? os.homedir());
    this.profilesDir = path.join(this.accountsDir, "profiles");
    this.pendingDir = path.join(this.accountsDir, "pending");
    this.retiredDir = path.join(this.accountsDir, "retired");
    this.accountsFilePath = path.join(this.accountsDir, "accounts.json");
    this.bindingsFilePath = path.join(this.accountsDir, "bindings.json");
    this.blocksFilePath = path.join(this.accountsDir, "blocks.json");
  }

  ensureBaseDirs(): void {
    ensureDir0700(this.accountsDir);
    ensureDir0700(this.profilesDir);
    ensureDir0700(this.pendingDir);
    ensureDir0700(this.retiredDir);
  }

  profileDir(accountId: string): string {
    return path.join(this.profilesDir, accountId);
  }

  pendingLoginDir(loginId: string): string {
    return path.join(this.pendingDir, loginId);
  }

  createPendingDir(loginId: string): string {
    this.ensureBaseDirs();
    const dir = this.pendingLoginDir(loginId);
    ensureDir0700(dir);
    return dir;
  }

  ensureProfileSymlinks(accountId: string): void {
    this.ensureBaseDirs();
    const dir = this.profileDir(accountId);
    ensureProfileSharedSymlinks(dir, this.homeDir);
  }

  readAccounts(): ClaudeAccountRecord[] {
    const parsed = readJsonOrDefault<ClaudeAccountsJsonFile>(this.accountsFilePath, {
      version: 1,
      accounts: [],
    });
    if (!Array.isArray(parsed.accounts)) {
      return [];
    }
    return parsed.accounts.map((acc) => ({
      id: String(acc.id),
      email: String(acc.email ?? ""),
      plan: String(acc.plan ?? ""),
      enabled: Boolean(acc.enabled),
      priority:
        typeof acc.priority === "number" && Number.isFinite(acc.priority)
          ? acc.priority
          : null,
      created_at: String(acc.created_at ?? new Date(0).toISOString()),
    }));
  }

  writeAccounts(accounts: ClaudeAccountRecord[]): void {
    const payload: ClaudeAccountsJsonFile = {
      version: 1,
      accounts,
    };
    writeJsonAtomic0600(this.accountsFilePath, payload);
  }

  readBindings(): Record<string, string> {
    const parsed = readJsonOrDefault<ClaudeBindingsJsonFile>(this.bindingsFilePath, {
      version: 1,
      bindings: {},
    });
    if (!parsed.bindings || typeof parsed.bindings !== "object") {
      return {};
    }
    return { ...parsed.bindings };
  }

  writeBindings(bindings: Record<string, string>): void {
    const payload: ClaudeBindingsJsonFile = {
      version: 1,
      bindings,
    };
    writeJsonAtomic0600(this.bindingsFilePath, payload);
  }

  readBlocks(): Record<string, ClaudeAccountBlocksRecord> {
    const parsed = readJsonOrDefault<ClaudeBlocksJsonFile>(this.blocksFilePath, {
      version: 1,
      blocks: {},
    });
    if (!parsed.blocks || typeof parsed.blocks !== "object") {
      return {};
    }
    return { ...parsed.blocks };
  }

  writeBlocks(blocks: Record<string, ClaudeAccountBlocksRecord>): void {
    const payload: ClaudeBlocksJsonFile = {
      version: 1,
      blocks,
    };
    writeJsonAtomic0600(this.blocksFilePath, payload);
  }

  moveDirectoryToRetired(sourceDir: string, prefix: string): string | null {
    if (!fs.existsSync(sourceDir)) {
      return null;
    }
    this.ensureBaseDirs();
    const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const destDir = path.join(this.retiredDir, `${prefix}-${suffix}`);
    renameWithTransientRetrySync(sourceDir, destDir);
    return destDir;
  }

  retireProfileDir(accountId: string): string | null {
    return this.moveDirectoryToRetired(this.profileDir(accountId), accountId);
  }

  retirePendingDir(loginId: string): string | null {
    return this.moveDirectoryToRetired(this.pendingLoginDir(loginId), `pending-${loginId}`);
  }

  promotePendingToProfile(params: {
    loginId: string;
    accountUuid: string;
  }): string {
    this.ensureBaseDirs();
    const pendingPath = this.pendingLoginDir(params.loginId);
    if (!fs.existsSync(pendingPath)) {
      throw new Error(`Pending login directory does not exist: ${pendingPath}`);
    }
    // Validate shared symlink paths in pendingPath before touching target profileDir
    ensureProfileSharedSymlinks(pendingPath, this.homeDir);

    const targetProfileDir = this.profileDir(params.accountUuid);
    if (fs.existsSync(targetProfileDir)) {
      // Also verify existing targetProfileDir has no non-symlink conflict before retiring it
      ensureProfileSharedSymlinks(targetProfileDir, this.homeDir);
      this.moveDirectoryToRetired(targetProfileDir, `${params.accountUuid}-replaced`);
    }

    renameWithTransientRetrySync(pendingPath, targetProfileDir);
    ensureProfileSharedSymlinks(targetProfileDir, this.homeDir);
    return targetProfileDir;
  }
}
