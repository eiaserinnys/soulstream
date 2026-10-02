/**
 * AgentRegistry — yaml 기반 agent 프로필 정본 (Phase B-3).
 *
 * Python `service/agent_registry.py`의 *구조*를 참조하되 *코드 복사 아님*
 * (정본 둘 안티패턴 회피, atom d7a1ad86). TS는 zod 검증 + ESM import 기반.
 *
 * yaml schema는 Python과 *키 호환* — 운영 시 두 서비스가 서로 다른 yaml 파일을
 * 사용 가능하나 같은 키 구조 유지.
 */

import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  AgentBackendSchema,
  type AgentBackend,
} from "@soulstream/model-catalog";

export { AgentBackendSchema } from "@soulstream/model-catalog";
export type { AgentBackend } from "@soulstream/model-catalog";

import { AgentProfileSchema, type AgentProfile } from "@soulstream/agent-profile-contract";
export { AgentProfileSchema, AgentAtomContextSchema, AgentsSdkHostedToolSchema, AgentsSdkMcpServerSchema } from "@soulstream/agent-profile-contract";
export type { AgentProfile, AgentAtomContext, AgentsSdkConfig, AgentsSdkHostedTool, AgentsSdkMcpServer } from "@soulstream/agent-profile-contract";

/** yaml 파일 최상위 schema. */
export const AgentsConfigSchema = z.object({
  agents: z.array(AgentProfileSchema).default([]),
}).superRefine((config, ctx) => {
  const profileIds = new Set<string>();
  for (const [index, agent] of config.agents.entries()) {
    if (profileIds.has(agent.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents", index, "id"],
        message: `Duplicate agent id in registry: ${agent.id}`,
      });
    }
    profileIds.add(agent.id);
  }

  const aliasOwners = new Map<string, string>();
  for (const [agentIndex, agent] of config.agents.entries()) {
    for (const [aliasIndex, alias] of (agent.aliases ?? []).entries()) {
      if (profileIds.has(alias.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", agentIndex, "aliases", aliasIndex, "id"],
          message: `Agent alias conflicts with profile id: ${alias.id}`,
        });
      }
      if (aliasOwners.has(alias.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", agentIndex, "aliases", aliasIndex, "id"],
          message: `Duplicate agent alias in registry: ${alias.id}`,
        });
      } else {
        aliasOwners.set(alias.id, agent.id);
      }
    }
  }
});

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

export interface LoadAgentRegistryOptions {
  profileResolver?: (profiles: AgentProfile[]) => AgentProfile[];
}

/**
 * agent 프로필 컬렉션. Python `AgentRegistry`와 동일 인터페이스(`get`/`list`/`has`).
 *
 * 시작 시 agents.yaml을 1회 로딩하고, MCP agents.yaml 편집 도구는 같은 registry
 * 인스턴스의 `replace()`로 프로필 컬렉션을 갱신한다.
 */
export class AgentRegistry {
  private readonly profiles: Map<string, AgentProfile>;
  private readonly aliases: Map<string, AgentProfile>;

  constructor(profiles: AgentProfile[]) {
    const maps = buildRegistryMaps(profiles);
    this.profiles = maps.profiles;
    this.aliases = maps.aliases;
  }

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id) ?? this.aliases.get(id);
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  replace(profiles: AgentProfile[]): void {
    const next = buildRegistryMaps(profiles);
    this.profiles.clear();
    for (const [id, profile] of next.profiles) this.profiles.set(id, profile);
    this.aliases.clear();
    for (const [id, profile] of next.aliases) this.aliases.set(id, profile);
  }

  /** 등록된 backend 목록 (중복 제거, registration.supported_backends 산출용). */
  supportedBackends(): string[] {
    const profiles = this.list();
    const set = new Set<string>();
    for (const p of profiles) set.add(p.backend);
    return Array.from(set);
  }
}

function buildRegistryMaps(profiles: AgentProfile[]): {
  profiles: Map<string, AgentProfile>;
  aliases: Map<string, AgentProfile>;
} {
  const canonical = new Map<string, AgentProfile>();
  for (const profile of profiles) {
    if (canonical.has(profile.id)) {
      throw new Error(`Duplicate agent id in registry: ${profile.id}`);
    }
    canonical.set(profile.id, profile);
  }

  const aliases = new Map<string, AgentProfile>();
  for (const profile of profiles) {
    for (const alias of profile.aliases ?? []) {
      const defaultPreset =
        "default_preset" in alias ? alias.default_preset : undefined;
      if (canonical.has(alias.id)) {
        throw new Error(`Agent alias conflicts with profile id: ${alias.id}`);
      }
      if (aliases.has(alias.id)) {
        throw new Error(`Duplicate agent alias in registry: ${alias.id}`);
      }
      aliases.set(
        alias.id,
        defaultPreset === undefined
          ? profile
          : { ...profile, default_preset: defaultPreset },
      );
    }
  }
  return { profiles: canonical, aliases };
}

export function readAgentsConfig(configPath: string): AgentsConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed: unknown = parseYaml(raw) ?? {};
  return AgentsConfigSchema.parse(parsed);
}

export function readAgentsConfigRaw(configPath: string): {
  raw: string;
  parsed: AgentsConfig;
} {
  const raw = fs.readFileSync(configPath, "utf-8");
  const data: unknown = parseYaml(raw) ?? {};
  return {
    raw,
    parsed: AgentsConfigSchema.parse(data),
  };
}

/**
 * yaml 파일에서 AgentRegistry를 로딩한다.
 *
 * - 파일 부재: ENOENT throw — 호출자(main.ts)가 catch하여 명확한 stderr 후 exit(1)
 * - yaml 파싱 오류: YAMLParseError throw
 * - schema 위반: ZodError throw
 * - 중복 agent id: Error throw (`AgentRegistry` constructor)
 *
 * 빈 파일·`agents: []`은 정상 — 빈 registry 반환. node_register agents 광고는 빈 배열.
 */
export function loadAgentRegistry(
  configPath: string,
  options: LoadAgentRegistryOptions = {},
): AgentRegistry {
  const validated = readAgentsConfig(configPath);
  const profiles = options.profileResolver
    ? options.profileResolver(validated.agents)
    : validated.agents;
  return new AgentRegistry(profiles);
}
