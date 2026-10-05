import type { PersistentCreateDefaults, PersistentSession } from "../lib/persistent-sessions";

const defaultEffort: Record<string, string | null> = { "sample-sol": "high", "sample-opus": null };
const modelName: Record<string, string> = { "sample-sol": "sample-sol-model", "sample-opus": "sample-opus-model" };

/**
 * In-memory review transport for the four persistent-session routes.
 * 저장은 이 전송 안에서만 일어나며 실제 서버 저장의 증거가 아니다.
 * scenario: normal | load-error(첫 목록 조회 실패) | registration-failure(첫 추가의 등록 단계 실패)
 */
export function createPersistentSessionsFixture({ scenario = "normal", nodeId, folderId }: { scenario?: string; nodeId: string; folderId: string }) {
  const settings = (preset: string) => ({
    default_model: { model_preset: preset, reasoning_effort: defaultEffort[preset] ?? null },
    fallback_model: null,
    show_generation_separator: true,
    show_character: true,
  });
  const build = (id: string, name: string, agentId: string, agentName: string, preset: string, current: string): PersistentSession => ({
    session_id: id,
    display_name: name,
    node_id: nodeId,
    folder_id: folderId,
    agent_id: agentId,
    agent_name: agentName,
    persistent: true,
    settings: settings(preset),
    runtime: {
      current_model: { model_preset: current, reasoning_effort: defaultEffort[current] ?? null, model: modelName[current] ?? null },
      pending: null,
    },
  });
  const first = build("sample-pas-1", "서소영 관제", "roselin", "로젤린", "sample-opus", "sample-sol");
  first.runtime.pending = { target_model_preset: "sample-opus", target_reasoning_effort: null };
  const sessions: PersistentSession[] = [first, build("sample-pas-2", "리뷰 관제", "roselin", "로젤린", "sample-sol", "sample-sol")];
  const defaults: PersistentCreateDefaults = {
    node_id: nodeId,
    preferred_agent_id: "roselin",
    settings: settings("sample-sol"),
    initial_instruction: "새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤 다음 지시를 기다려 주십시오.",
    unavailable_reason: null,
  };
  let firstListFailureAt = 0;
  let registrationFailed = false;
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
      const preset = body.settings.default_model.model_preset as string;
      created += 1;
      const session = build(`sample-pas-new-${created}`, body.display_name, body.agent_id, "로젤린", preset, preset);
      session.folder_id = body.folder_id;
      session.persistent = false;
      sessions.push(session);
      if (scenario === "registration-failure" && !registrationFailed) {
        registrationFailed = true;
        return fail(503, "PERSISTENT_REGISTRATION_FAILED", "예시: 이름과 표시를 등록하지 못했습니다.", {
          created_session: { session_id: session.session_id, display_name: body.display_name },
        });
      }
      session.persistent = true;
      return reply({ session: structuredClone(session), creation: "started", warnings: [] }, 201);
    }
    const session = sessions.find((item) => item.session_id === id);
    if (!session) return fail(404, "SESSION_NOT_FOUND", "예시 세션을 찾을 수 없습니다.");
    if (method === "GET") return reply({ session: structuredClone(session) });
    if (method === "PUT") {
      if (body.enabled === false) { session.persistent = false; return reply({ session: structuredClone(session), model_change: "none" }); }
      if (body.enabled === true) session.persistent = true;
      else if (!session.persistent) return fail(409, "NOT_PERSISTENT", "이미 영구 세션이 아닙니다. 목록을 다시 읽습니다.");
      if (typeof body.display_name === "string") session.display_name = body.display_name;
      let change: "none" | "next_execution_start" = "none";
      const requested = body.settings?.default_model as { model_preset: string; reasoning_effort: string | null } | undefined;
      if (requested) {
        session.settings.default_model = {
          model_preset: requested.model_preset,
          reasoning_effort: requested.reasoning_effort ?? defaultEffort[requested.model_preset] ?? null,
        };
        const pending = session.runtime.pending;
        if (requested.model_preset !== session.runtime.current_model.model_preset && pending?.target_model_preset !== requested.model_preset) {
          session.runtime.pending = { target_model_preset: requested.model_preset, target_reasoning_effort: session.settings.default_model.reasoning_effort };
          change = "next_execution_start";
        }
      }
      return reply({ session: structuredClone(session), model_change: change });
    }
    return fail(405, "INVALID_REQUEST", "예시 API가 지원하지 않는 요청입니다.");
  };
}
