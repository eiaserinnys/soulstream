import type { ModelSelection, PersistentCreateDefaults, PersistentInstruction, PersistentSession } from "../lib/persistent-sessions";

const defaultEffort: Record<string, string | null> = { "sample-sol": "high", "sample-opus": null };
const modelName: Record<string, string> = { "sample-sol": "sample-sol-model", "sample-opus": "sample-opus-model" };

/**
 * In-memory review transport for the four persistent-session routes.
 * 저장은 이 전송 안에서만 일어나며 실제 서버 저장의 증거가 아니다.
 * 추론 수준과 모델 변경 판정은 서버와 같다: 지정한 수준은 그대로 저장하고, 비우면 같은 프리셋은 기존 수준을 유지하며
 * 프리셋이 바뀌면 그 프리셋의 기본 수준을 쓴다. 현재 실행 모델이나 같은 대상의 대기와 (프리셋, 수준)이 같으면 변경이 없다.
 * scenario: normal | load-error(첫 목록 조회 실패) | registration-failure(첫 추가의 등록 단계 실패)
 *   | node-unknown(소유 노드를 모르는 기존 세션이 하나 더 있음) | create-lost(첫 추가의 응답을 잃음: 세션은 일반 세션으로 만들어졌다)
 *   | display-save-failure(표시 설정 저장 실패) | display-save-delayed(표시 설정 저장 지연)
 *   | instruction-save-failure(첫 지시 수정 저장 실패)
 */
const sameModel = (a: ModelSelection, b: ModelSelection) =>
  a.model_preset === b.model_preset && (a.reasoning_effort ?? null) === (b.reasoning_effort ?? null);

export function createPersistentSessionsFixture({ scenario = "normal", nodeId, folderId }: { scenario?: string; nodeId: string; folderId: string }) {
  const settings = (preset: string) => ({
    default_model: { model_preset: preset, reasoning_effort: defaultEffort[preset] ?? null },
    fallback_model: null,
    show_generation_separator: true,
    show_character: true,
    show_jev_candidates: true,
    animate_character: true,
    turn_usage_mode: "collapsed" as const,
    show_turn_usage: true,
  });
  const build = (id: string, name: string, agentId: string | null, agentName: string | null, preset: string, current: string, effort: string | null = defaultEffort[preset] ?? null): PersistentSession => ({
    session_id: id,
    display_name: name,
    node_id: nodeId,
    folder_id: folderId,
    agent_id: agentId,
    agent_name: agentName,
    persistent: true,
    settings: { ...settings(preset), default_model: { model_preset: preset, reasoning_effort: effort } },
    runtime: {
      current_model: { model_preset: current, reasoning_effort: defaultEffort[current] ?? null, model: modelName[current] ?? null },
      pending: null,
    },
  });
  const first = build("sample-pas-1", "서소영 관제", "roselin", "로젤린", "sample-opus", "sample-sol");
  first.runtime.pending = { target_model_preset: "sample-opus", target_reasoning_effort: null };
  const sessions: PersistentSession[] = [first, build("sample-pas-2", "리뷰 관제", "roselin", "로젤린", "sample-sol", "sample-sol")];
  type FixtureInstruction = PersistentInstruction & { status?: "removed" };
  const instructions = new Map<string, FixtureInstruction[]>([[first.session_id, [{
    id: "sample-instruction-1",
    text: "결정에 필요한 근거만 간결하게 알려 줍니다.",
    source_turns: ["T195"],
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: "2026-10-06T11:00:00.000Z",
    origin: "agent",
  }]]]);
  let instructionCounter = 0;
  if (scenario === "node-unknown") {
    const legacy = build("sample-pas-legacy", "옛 영구 세션", null, null, "sample-sol", "sample-sol");
    legacy.node_id = null;
    sessions.push(legacy);
  }
  const defaults: PersistentCreateDefaults = {
    node_id: nodeId,
    preferred_agent_id: "roselin",
    settings: settings("sample-sol"),
    initial_instruction: "새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤 다음 지시를 기다려 주십시오.",
    unavailable_reason: null,
  };
  let firstListFailureAt = 0;
  let registrationFailed = false;
  let createLost = false;
  let displaySaveFailed = false;
  let instructionSaveFailed = false;
  let created = 0;
  const reply = (value: unknown, status = 200) => Response.json(value, { status });
  const fail = (status: number, code: string, text: string, extra: Record<string, unknown> = {}) =>
    reply({ error: { code, message: text }, ...extra }, status);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), "https://sample.invalid").pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const id = path.split("/")[3];

    if (path === "/api/persistent-sessions" && method === "GET") {
      // 개발 빌드의 StrictMode가 효과를 두 번 실행하므로, 첫 실패 직후의 조회도 함께 실패시킨다.
      if (scenario === "load-error" && (firstListFailureAt === 0 || Date.now() - firstListFailureAt < 300)) {
        firstListFailureAt ||= Date.now();
        return fail(503, "NODE_UNAVAILABLE", "예시: 세션 목록을 읽지 못했습니다.");
      }
      const active = sessions.filter((session) => session.persistent);
      return reply({ sessions: structuredClone(active), total: active.length, create_defaults: defaults });
    }
    if (path === "/api/persistent-sessions" && method === "POST") {
      const requested = body.settings.default_model as { model_preset: string; reasoning_effort: string | null };
      const preset = requested.model_preset;
      created += 1;
      // 지정한 추론 수준은 그대로 저장하고, 비우면 프리셋의 기본 수준을 쓴다.
      const effort = requested.reasoning_effort ?? defaultEffort[preset] ?? null;
      const session = build(`sample-pas-new-${created}`, body.display_name, body.agent_id, "로젤린", preset, preset, effort);
      session.runtime.current_model.reasoning_effort = effort;
      session.folder_id = body.folder_id;
      session.persistent = false;
      sessions.push(session);
      if (scenario === "registration-failure" && !registrationFailed) {
        registrationFailed = true;
        return fail(503, "PERSISTENT_REGISTRATION_FAILED", "예시: 이름과 표시를 등록하지 못했습니다.", {
          created_session: { session_id: session.session_id, display_name: body.display_name },
        });
      }
      if (scenario === "create-lost" && !createLost) {
        createLost = true;
        throw new TypeError("Failed to fetch");
      }
      session.persistent = true;
      return reply({ session: structuredClone(session), creation: "started", warnings: [] }, 201);
    }
    const session = sessions.find((item) => item.session_id === id);
    if (!session) return fail(404, "SESSION_NOT_FOUND", "예시 세션을 찾을 수 없습니다.");
    const instructionCollectionPath = `/api/persistent-sessions/${encodeURIComponent(id)}/instructions`;
    if (path === instructionCollectionPath && method === "GET") {
      const active = (instructions.get(id) ?? []).filter((instruction) => instruction.status !== "removed");
      return reply({ instructions: structuredClone(active) });
    }
    if (path === instructionCollectionPath && method === "POST") {
      const instruction: FixtureInstruction = {
        id: `sample-instruction-${++instructionCounter + 1}`,
        text: String(body.text ?? ""),
        source_turns: [],
        created_at: "2026-10-08T00:00:00.000Z",
        updated_at: "2026-10-08T00:00:00.000Z",
        origin: "user",
      };
      instructions.set(id, [instruction, ...(instructions.get(id) ?? [])]);
      return reply({ instruction: structuredClone(instruction) }, 201);
    }
    if (path.startsWith(`${instructionCollectionPath}/`) && method === "PUT") {
      const instructionId = decodeURIComponent(path.slice(instructionCollectionPath.length + 1));
      const current = (instructions.get(id) ?? []).find((instruction) => instruction.id === instructionId);
      if (!current) return fail(404, "INSTRUCTION_NOT_FOUND", "예시 지속 지시를 찾을 수 없습니다.");
      if (scenario === "instruction-save-failure" && typeof body.text === "string" && !instructionSaveFailed) {
        instructionSaveFailed = true;
        return fail(503, "NODE_UNAVAILABLE", "예시: 지속 지시를 저장하지 못했습니다.");
      }
      if (body.status === "removed") {
        current.status = "removed";
        return reply({ instruction: structuredClone(current) });
      }
      if (typeof body.text === "string") {
        current.text = body.text;
        current.updated_at = "2026-10-08T00:00:00.000Z";
      }
      return reply({ instruction: structuredClone(current) });
    }
    if (method === "GET") return reply({ session: structuredClone(session) });
    if (method === "PUT") {
      const displaySettings = body.settings as Record<string, unknown> | undefined;
      if (displaySettings && Object.keys(displaySettings).some((key) => ["show_character", "animate_character", "show_generation_separator", "show_jev_candidates", "turn_usage_mode", "show_turn_usage"].includes(key))) {
        if (scenario === "display-save-failure" && !displaySaveFailed) {
          displaySaveFailed = true;
          return fail(503, "NODE_UNAVAILABLE", "예시: 표시 설정을 저장하지 못했습니다.");
        }
        if (scenario === "display-save-delayed") await new Promise((resolve) => setTimeout(resolve, 1800));
      }
      if (body.enabled === false) { session.persistent = false; return reply({ session: structuredClone(session), model_change: "none" }); }
      if (body.enabled === true) session.persistent = true;
      else if (!session.persistent) return fail(409, "NOT_PERSISTENT", "이미 영구 세션이 아닙니다. 목록을 다시 읽습니다.");
      if (typeof body.display_name === "string") session.display_name = body.display_name;
      for (const key of ["show_character", "animate_character", "show_generation_separator", "show_jev_candidates"] as const) {
        const value = body.settings?.[key];
        if (typeof value === "boolean") session.settings[key] = value;
      }
      const requestedTurnUsageMode = body.settings?.turn_usage_mode;
      const legacyTurnUsageVisible = body.settings?.show_turn_usage;
      if (requestedTurnUsageMode === "collapsed" || requestedTurnUsageMode === "expanded" || requestedTurnUsageMode === "hidden") {
        session.settings.turn_usage_mode = requestedTurnUsageMode;
      } else if (typeof legacyTurnUsageVisible === "boolean") {
        session.settings.turn_usage_mode = legacyTurnUsageVisible ? "collapsed" : "hidden";
      }
      session.settings.show_turn_usage = session.settings.turn_usage_mode !== "hidden";
      let change: "none" | "next_execution_start" = "none";
      const requested = body.settings?.default_model as { model_preset: string; reasoning_effort: string | null } | undefined;
      if (requested) {
        const existing = session.settings.default_model;
        const effort = requested.reasoning_effort
          ?? (existing.model_preset === requested.model_preset ? existing.reasoning_effort : defaultEffort[requested.model_preset] ?? null);
        const target: ModelSelection = { model_preset: requested.model_preset, reasoning_effort: effort };
        session.settings.default_model = target;
        const pending = session.runtime.pending;
        const alreadyPending = pending !== null
          && sameModel({ model_preset: pending.target_model_preset, reasoning_effort: pending.target_reasoning_effort }, target);
        if (!sameModel(session.runtime.current_model, target) && !alreadyPending) {
          session.runtime.pending = { target_model_preset: requested.model_preset, target_reasoning_effort: effort };
          change = "next_execution_start";
        }
      }
      return reply({ session: structuredClone(session), model_change: change });
    }
    return fail(405, "INVALID_REQUEST", "예시 API가 지원하지 않는 요청입니다.");
  };
}
