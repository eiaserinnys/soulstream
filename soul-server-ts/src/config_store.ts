import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type MaybePromise<T> = T | Promise<T>;

export type CommentPreservation = "not_preserved";

export interface ConfigStoreOptions<TConfig> {
  configPath: string;
  snapshotRoot?: string;
  parse: (raw: string) => TConfig;
  stringify: (config: TConfig) => string;
  onAfterApply?: (config: TConfig) => MaybePromise<void>;
}

export interface ConfigReadResult<TConfig> {
  raw: string;
  config: TConfig;
}

export interface ConfigChangePlan<TConfig> {
  configPath: string;
  snapshotRoot: string;
  changed: boolean;
  diff: string;
  config: TConfig;
  commentPreservation: CommentPreservation;
}

export interface ConfigApplyResult<TConfig> extends ConfigChangePlan<TConfig> {
  snapshotPath: string | null;
  appliedAt: string | null;
}

/**
 * Local config apply boundary.
 *
 * The store intentionally serializes through the provided stringify function.
 * For YAML this means raw comments are not preserved on writes. Snapshots keep
 * the exact pre-apply bytes so rollback can restore comments from before a
 * write.
 */
export class ConfigStore<TConfig> {
  private readonly actualConfigPath: string;
  private readonly displayConfigPath: string;
  private readonly snapshotRoot: string;
  private readonly parseRaw: (raw: string) => TConfig;
  private readonly stringifyConfig: (config: TConfig) => string;
  private readonly onAfterApply?: (config: TConfig) => MaybePromise<void>;

  constructor(options: ConfigStoreOptions<TConfig>) {
    this.displayConfigPath = options.configPath;
    this.actualConfigPath = path.resolve(options.configPath);
    this.snapshotRoot = path.resolve(options.snapshotRoot ?? ".local/config-snapshots");
    this.parseRaw = options.parse;
    this.stringifyConfig = options.stringify;
    this.onAfterApply = options.onAfterApply;
  }

  read(): ConfigReadResult<TConfig> {
    const raw = fs.readFileSync(this.actualConfigPath, "utf-8");
    return { raw, config: this.parseRaw(raw) };
  }

  async plan(
    mutate: (current: TConfig) => MaybePromise<TConfig>,
  ): Promise<ConfigChangePlan<TConfig>> {
    const current = this.read();
    const nextConfig = this.normalize(await mutate(current.config));
    const currentCanonicalRaw = this.stringifyConfig(current.config);
    const nextRaw = this.stringifyConfig(nextConfig);
    const changed = currentCanonicalRaw !== nextRaw;
    return {
      configPath: this.displayConfigPath,
      snapshotRoot: this.snapshotRoot,
      changed,
      diff: changed
        ? diffText(current.raw, nextRaw, path.basename(this.actualConfigPath))
        : "",
      config: nextConfig,
      commentPreservation: "not_preserved",
    };
  }

  async apply(
    mutate: (current: TConfig) => MaybePromise<TConfig>,
  ): Promise<ConfigApplyResult<TConfig>> {
    const current = this.read();
    const nextConfig = this.normalize(await mutate(current.config));
    const currentCanonicalRaw = this.stringifyConfig(current.config);
    const nextRaw = this.stringifyConfig(nextConfig);
    const changed = currentCanonicalRaw !== nextRaw;
    const basePlan = {
      configPath: this.displayConfigPath,
      snapshotRoot: this.snapshotRoot,
      changed,
      diff: changed
        ? diffText(current.raw, nextRaw, path.basename(this.actualConfigPath))
        : "",
      config: nextConfig,
      commentPreservation: "not_preserved" as const,
    };
    if (!changed) {
      return { ...basePlan, snapshotPath: null, appliedAt: null };
    }

    const snapshotPath = this.writeSnapshot(current.raw);
    this.writeAtomic(nextRaw);
    await this.onAfterApply?.(nextConfig);
    return {
      ...basePlan,
      snapshotPath,
      appliedAt: new Date().toISOString(),
    };
  }

  async rollback(snapshotPath: string): Promise<ConfigApplyResult<TConfig>> {
    const resolvedSnapshotPath = path.resolve(snapshotPath);
    this.assertManagedSnapshotPath(resolvedSnapshotPath);
    const rollbackRaw = fs.readFileSync(resolvedSnapshotPath, "utf-8");
    const rollbackConfig = this.parseRaw(rollbackRaw);
    const current = this.read();
    const changed = current.raw !== rollbackRaw;
    const basePlan = {
      configPath: this.displayConfigPath,
      snapshotRoot: this.snapshotRoot,
      changed,
      diff: changed
        ? diffText(current.raw, rollbackRaw, path.basename(this.actualConfigPath))
        : "",
      config: rollbackConfig,
      commentPreservation: "not_preserved" as const,
    };
    if (!changed) {
      return { ...basePlan, snapshotPath: null, appliedAt: null };
    }

    const replacementSnapshotPath = this.writeSnapshot(current.raw);
    this.writeAtomic(rollbackRaw);
    await this.onAfterApply?.(rollbackConfig);
    return {
      ...basePlan,
      snapshotPath: replacementSnapshotPath,
      appliedAt: new Date().toISOString(),
    };
  }

  private normalize(config: TConfig): TConfig {
    return this.parseRaw(this.stringifyConfig(config));
  }

  private snapshotDir(): string {
    const name = path.basename(this.actualConfigPath);
    const hash = createHash("sha256")
      .update(this.actualConfigPath)
      .digest("hex")
      .slice(0, 10);
    return path.join(this.snapshotRoot, `${name}-${hash}`);
  }

  private writeSnapshot(raw: string): string {
    const dir = this.snapshotDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${process.pid}-${process.hrtime.bigint()}.yaml`);
    fs.writeFileSync(file, raw, { encoding: "utf-8", mode: 0o600 });
    return file;
  }

  private assertManagedSnapshotPath(snapshotPath: string): void {
    const dir = this.snapshotDir();
    const relative = path.relative(dir, snapshotPath);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
      throw new Error(`rollback snapshot path is outside snapshot root: ${snapshotPath}`);
    }
  }

  private writeAtomic(raw: string): void {
    const dir = path.dirname(this.actualConfigPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(this.actualConfigPath)}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, raw, "utf-8");
      try {
        const stat = fs.statSync(this.actualConfigPath);
        fs.chmodSync(tmp, stat.mode & 0o777);
      } catch {
        // New files keep Node's default mode.
      }
      fs.renameSync(tmp, this.actualConfigPath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

function diffText(before: string, after: string, label: string): string {
  if (before === after) return "";
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const removed = beforeLines.slice(start, beforeEnd + 1);
  const added = afterLines.slice(start, afterEnd + 1);
  const hunkStart = start + 1;
  const beforeCount = Math.max(removed.length, 1);
  const afterCount = Math.max(added.length, 1);
  const lines = [
    `--- ${label}`,
    `+++ ${label}`,
    `@@ -${hunkStart},${beforeCount} +${hunkStart},${afterCount} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  return `${lines.join("\n")}\n`;
}

function splitLines(raw: string): string[] {
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
