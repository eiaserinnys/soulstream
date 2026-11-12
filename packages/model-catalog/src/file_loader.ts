import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseModelCatalogYaml, type ModelCatalogConfig } from "./index.js";

/** Canonical catalogue location inside a repository checkout. */
export const MODEL_CATALOG_RELATIVE_PATH = "packages/model-catalog/data/model-catalog.yaml";

/** Sentinel signature for a path that cannot be stated (deleted file). */
const MISSING_SIGNATURE = "missing";
const STAT_ERROR_SIGNATURE = "stat-error";

export interface ModelCatalogFileLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface OpenModelCatalogFileOptions {
  /** Absolute path to the catalogue file. */
  path: string;
  logger?: ModelCatalogFileLogger;
  /** Polling interval used by {@link ModelCatalogFileStore.start}; default 1000ms. */
  pollIntervalMs?: number;
  /** Extra validation for a loaded catalogue (for example, transport effort support). */
  validate?: (catalog: ModelCatalogConfig) => void;
}

export interface ModelCatalogFileStore {
  /** Last good catalogue; re-reads the file when its dev:ino:size:mtimeMs signature changed. */
  snapshot(): ModelCatalogConfig;
  /** Called only after a valid catalogue replaced the previous one. */
  subscribe(listener: (catalog: ModelCatalogConfig) => void): () => void;
  start(): void;
  close(): void;
}

function signatureOf(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

class ModelCatalogFileStoreImpl implements ModelCatalogFileStore {
  /** Set by {@link open}; a store never escapes without one successful load. */
  private lastGood!: ModelCatalogConfig;
  private lastSignature: string | null = null;
  private lastFailureSignature: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<(catalog: ModelCatalogConfig) => void>();
  private readonly pollIntervalMs: number;

  constructor(private readonly options: OpenModelCatalogFileOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /** First load: missing file, parse error, or a rejected hook throws. */
  open(): void {
    const stat = fs.statSync(this.options.path);
    const raw = fs.readFileSync(this.options.path, "utf-8");
    const config = parseModelCatalogYaml(raw);
    this.options.validate?.(config);
    this.lastGood = config;
    this.lastSignature = signatureOf(stat);
  }

  snapshot(): ModelCatalogConfig {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.options.path);
    } catch (error) {
      if (isMissingFileError(error)) {
        this.noteFailure(MISSING_SIGNATURE, error);
      } else {
        this.noteFailure(STAT_ERROR_SIGNATURE, error);
      }
      return this.lastGood;
    }

    const signature = signatureOf(stat);
    if (signature === this.lastSignature) {
      return this.lastGood;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.options.path, "utf-8");
    } catch (error) {
      this.noteFailure(signature, error);
      return this.lastGood;
    }

    let config: ModelCatalogConfig;
    try {
      config = parseModelCatalogYaml(raw);
      this.options.validate?.(config);
    } catch (error) {
      this.noteFailure(signature, error);
      return this.lastGood;
    }

    this.lastGood = config;
    this.lastSignature = signature;
    this.lastFailureSignature = null;
    for (const listener of [...this.listeners]) listener(config);
    return config;
  }

  subscribe(listener: (catalog: ModelCatalogConfig) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.snapshot();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private noteFailure(signature: string, error: unknown): void {
    const reported = signature === this.lastFailureSignature;
    this.lastSignature = signature;
    this.lastFailureSignature = signature;
    if (reported) return;
    this.options.logger?.error(
      { err: error, catalogPath: this.options.path },
      "Model catalog reload failed; keeping the last successful catalog",
    );
  }
}

/**
 * Open the catalogue file: the first load and validation are synchronous and
 * throw on failure. Later reads keep the last good catalogue.
 */
export function openModelCatalogFile(
  options: OpenModelCatalogFileOptions,
): ModelCatalogFileStore {
  const store = new ModelCatalogFileStoreImpl(options);
  store.open();
  return store;
}

/** Repository root for an entry module living directly under `<app>/src` or `<app>/dist`. */
export function repositoryRootFromEntryUrl(entryUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(entryUrl)), "..", "..");
}

export function modelCatalogPathForRepository(repositoryRoot: string): string {
  return path.join(repositoryRoot, MODEL_CATALOG_RELATIVE_PATH);
}
