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

/**
 * yaml의 단일 agent 엔트리 schema. Python `AgentProfile` dataclass와 키 호환.
 */
export const AgentProfileSchema = z.object({
  id: z.string().min(1, "agent.id required"),
  name: z.string().min(1, "agent.name required"),
  backend: z.enum(["claude", "codex"]),
  workspace_dir: z.string().min(1, "agent.workspace_dir required"),
  max_turns: z.number().int().positive().optional(),
  allowed_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  portrait_path: z.string().optional(),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type AgentBackend = AgentProfile["backend"];

/** yaml 파일 최상위 schema. */
export const AgentsConfigSchema = z.object({
  agents: z.array(AgentProfileSchema).default([]),
});

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

/**
 * agent 프로필 컬렉션. Python `AgentRegistry`와 동일 인터페이스(`get`/`list`/`has`).
 *
 * 본 PR(B-3)은 *불변* registry — 시작 시 1회 로딩 후 갱신 없음. 동적 reload는
 * 후속 카드 (Phase B-3에서 의도적 제외 — design-principles §1 깊이).
 */
export class AgentRegistry {
  private readonly profiles: Map<string, AgentProfile>;

  constructor(profiles: AgentProfile[]) {
    this.profiles = new Map();
    for (const p of profiles) {
      if (this.profiles.has(p.id)) {
        throw new Error(`Duplicate agent id in registry: ${p.id}`);
      }
      this.profiles.set(p.id, p);
    }
  }

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  listForBackends(backends: readonly AgentBackend[]): AgentProfile[] {
    const allowed = new Set(backends);
    return this.list().filter((p) => allowed.has(p.backend));
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  /** 등록된 backend 목록 (중복 제거, registration.supported_backends 산출용). */
  supportedBackends(backends?: readonly AgentBackend[]): string[] {
    const profiles = backends ? this.listForBackends(backends) : this.list();
    const set = new Set<string>();
    for (const p of profiles) set.add(p.backend);
    return Array.from(set);
  }
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
export function loadAgentRegistry(configPath: string): AgentRegistry {
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed: unknown = parseYaml(raw) ?? {};
  const validated = AgentsConfigSchema.parse(parsed);
  return new AgentRegistry(validated.agents);
}
