import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import {
  AgentRegistry,
  AgentAtomContextSchema,
  AgentsConfigSchema,
  readAgentsConfig,
  type AgentProfile,
} from "./agent_registry.js";

const RemoteAtomContextSchema = z.object({
  node_id: z.string(),
  depth: z.number().int().min(0).optional(),
  titles_only: z.boolean().optional(),
  include_ids: z.boolean().optional(),
  mode: z.string().optional(),
  applies_when: z.record(z.string(), z.unknown()).optional(),
});

const RemoteAliasSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    default_preset: z.string().min(1).optional(),
  }),
]);

export const RemoteAgentProfileSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1),
  atom_contexts: z.array(RemoteAtomContextSchema),
  default_preset: z.string().min(1).nullable(),
  aliases: z.array(RemoteAliasSchema),
  has_portrait: z.boolean(),
  portrait: z.object({
    mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).nullable().optional(),
  version: z.number().int().positive(),
  updated_at: z.string(),
});

const RuntimeResponseSchema = z.object({
  profiles: z.array(RemoteAgentProfileSchema),
});

const CacheSchema = z.object({
  schema_version: z.literal(1),
  fetched_at: z.string(),
  profiles: z.array(RemoteAgentProfileSchema),
});

export type RemoteAgentProfile = z.infer<typeof RemoteAgentProfileSchema>;

export type AgentProfileSourceState = {
  readonly stale: boolean;
  readonly checkedAt: string | null;
  readonly lastError: string | null;
  readonly counts: {
    readonly db: number;
    readonly yaml: number;
  };
};

export type AgentProfileResolution = {
  readonly profile: AgentProfile;
  readonly source: "db" | "yaml";
  readonly stale: boolean;
  readonly hasPortrait: boolean;
  readonly portraitSource: "db" | "yaml" | "none";
};

export interface NewSessionAgentProfileSource {
  readonly resolve: (profileId: string) => Promise<AgentProfileResolution | undefined>;
  readonly list: () => Promise<readonly AgentProfileResolution[]>;
  readonly state: () => AgentProfileSourceState;
}

export type AgentProfileSourceOptions = {
  readonly agentsConfigPath: string;
  readonly cachePath: string;
  readonly runtimeUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly logger: Pick<Logger, "info" | "warn">;
  readonly profileResolver?: (profiles: AgentProfile[]) => AgentProfile[];
  readonly fetchRuntime?: () => Promise<unknown>;
  readonly fetchTimeoutMs?: number;
  readonly now?: () => Date;
};

export class AgentProfileSource implements NewSessionAgentProfileSource {
  private overlays: RemoteAgentProfile[] = [];
  private currentState: AgentProfileSourceState = {
    stale: true,
    checkedAt: null,
    lastError: "agent profile source has not been checked",
    counts: { db: 0, yaml: 0 },
  };
  private refreshInFlight: Promise<void> | null = null;

  constructor(private readonly options: AgentProfileSourceOptions) {}

  async initialize(): Promise<void> {
    await this.refresh();
    this.buildSnapshot();
  }

  async resolve(profileId: string): Promise<AgentProfileResolution | undefined> {
    const snapshot = await this.snapshot();
    const profile = snapshot.registry.get(profileId);
    if (!profile) return undefined;
    return this.resolution(profile, snapshot.dbIds, snapshot.portraits);
  }

  async list(): Promise<readonly AgentProfileResolution[]> {
    const snapshot = await this.snapshot();
    return snapshot.registry.list().map((profile) =>
      this.resolution(profile, snapshot.dbIds, snapshot.portraits));
  }

  state(): AgentProfileSourceState {
    return this.currentState;
  }

  private async snapshot(): Promise<ProfileSnapshot> {
    await this.refresh();
    return this.buildSnapshot();
  }

  private buildSnapshot(): ProfileSnapshot {
    const snapshot = this.createSnapshot(this.overlays);
    this.currentState = {
      ...this.currentState,
      counts: {
        db: snapshot.dbIds.size,
        yaml: snapshot.registry.list().length - snapshot.dbIds.size,
      },
    };
    return snapshot;
  }

  private createSnapshot(overlays: readonly RemoteAgentProfile[]): ProfileSnapshot {
    const yamlProfiles = readAgentsConfig(this.options.agentsConfigPath).agents;
    const merged = mergeProfiles(yamlProfiles, overlays, this.options.logger);
    const resolved = this.options.profileResolver
      ? this.options.profileResolver(merged.profiles)
      : merged.profiles;
    const validated = AgentsConfigSchema.parse({ agents: resolved });
    return {
      registry: new AgentRegistry(validated.agents),
      dbIds: merged.dbIds,
      portraits: merged.portraits,
    };
  }

  private resolution(
    profile: AgentProfile,
    dbIds: ReadonlySet<string>,
    portraits: ReadonlyMap<string, boolean>,
  ): AgentProfileResolution {
    const dbPortrait = portraits.get(profile.id) === true;
    const yamlPortrait = Boolean(profile.portrait_path);
    return {
      profile,
      source: dbIds.has(profile.id) ? "db" : "yaml",
      stale: this.currentState.stale,
      hasPortrait: dbPortrait || yamlPortrait,
      portraitSource: dbPortrait ? "db" : yamlPortrait ? "yaml" : "none",
    };
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<void> {
    const checkedAt = (this.options.now ?? (() => new Date()))().toISOString();
    try {
      const payload = this.options.fetchRuntime
        ? await this.options.fetchRuntime()
        : await fetchRuntime(
            this.options.runtimeUrl,
            this.options.headers,
            this.options.fetchTimeoutMs ?? 10_000,
          );
      const response = RuntimeResponseSchema.parse(payload);
      this.createSnapshot(response.profiles);
      this.overlays = response.profiles;
      try {
        await writeCache(this.options.cachePath, checkedAt, response.profiles);
      } catch (cacheError) {
        this.options.logger.warn(
          { error: errorMessage(cacheError), cachePath: this.options.cachePath },
          "Fresh agent profile runtime loaded but last-known-good cache could not be persisted",
        );
      }
      this.currentState = {
        stale: false,
        checkedAt,
        lastError: null,
        counts: this.currentState.counts,
      };
    } catch (error) {
      const message = errorMessage(error);
      const cached = await readCache(this.options.cachePath);
      let cacheHit = false;
      if (cached) {
        try {
          this.createSnapshot(cached.profiles);
          this.overlays = cached.profiles;
          cacheHit = true;
        } catch (cacheError) {
          this.overlays = [];
          this.options.logger.warn(
            { error: errorMessage(cacheError), cachePath: this.options.cachePath },
            "Last-known-good agent profile cache is not executable with the current YAML base",
          );
        }
      } else {
        this.overlays = [];
      }
      this.currentState = {
        stale: true,
        checkedAt,
        lastError: message,
        counts: this.currentState.counts,
      };
      this.options.logger.warn(
        { error: message, cachePath: this.options.cachePath, cacheHit },
        "Agent profile runtime unavailable; using last-known-good overlay",
      );
    }
  }
}

type ProfileSnapshot = {
  readonly registry: AgentRegistry;
  readonly dbIds: ReadonlySet<string>;
  readonly portraits: ReadonlyMap<string, boolean>;
};

function mergeProfiles(
  yamlProfiles: readonly AgentProfile[],
  overlays: readonly RemoteAgentProfile[],
  logger: Pick<Logger, "info" | "warn">,
): {
  profiles: AgentProfile[];
  dbIds: Set<string>;
  portraits: Map<string, boolean>;
} {
  const yamlIds = new Set(yamlProfiles.map((profile) => profile.id));
  const overlayById = new Map(overlays.map((profile) => [profile.agent_id, profile]));
  const dbIds = new Set<string>();
  const portraits = new Map<string, boolean>();
  for (const overlay of overlays) {
    if (!yamlIds.has(overlay.agent_id)) {
      logger.warn(
        { agentId: overlay.agent_id },
        "DB-only agent profile is CRUD-visible but not executable without a YAML base",
      );
    }
  }
  const profiles = yamlProfiles.map((profile) => {
    const overlay = overlayById.get(profile.id);
    if (!overlay) return profile;
    dbIds.add(profile.id);
    portraits.set(profile.id, overlay.has_portrait);
    logger.info(
      { agentId: profile.id, version: overlay.version },
      "DB agent profile overrides YAML-owned identity fields",
    );
    const aliases = overlay.aliases.map((alias) =>
      typeof alias === "string" ? { id: alias } : alias);
    const { default_preset: _yamlDefaultPreset, ...base } = profile;
    const merged = {
      ...base,
      name: overlay.name,
      atom_contexts: overlay.atom_contexts.map((context) =>
        AgentAtomContextSchema.parse(context)),
      aliases,
    };
    return overlay.default_preset === null
      ? merged
      : { ...merged, default_preset: overlay.default_preset };
  });
  return { profiles, dbIds, portraits };
}

async function fetchRuntime(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Agent profile runtime returned HTTP ${response.status}`);
  return response.json();
}

async function writeCache(
  path: string,
  fetchedAt: string,
  profiles: readonly RemoteAgentProfile[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify({
      schema_version: 1,
      fetched_at: fetchedAt,
      profiles,
    }, null, 2), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readCache(path: string): Promise<z.infer<typeof CacheSchema> | null> {
  try {
    return CacheSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
