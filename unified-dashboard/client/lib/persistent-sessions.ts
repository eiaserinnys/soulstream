import type { AgentInfo } from "@seosoyoung/soul-ui";

import { HttpResponseError } from "./http-response-error";

export type ModelSelection = { model_preset: string | null; reasoning_effort: string | null };

export type PersistentSettings = {
  default_model: ModelSelection;
  fallback_model: ModelSelection | null;
  show_generation_separator: boolean;
  show_character: boolean;
  show_jev_candidates: boolean;
};

export type PersistentSession = {
  session_id: string;
  display_name: string | null;
  /** 소유 노드를 알 수 없는 기존 세션은 null이며 서버가 아무것도 저장하지 못한다. */
  node_id: string | null;
  folder_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  persistent: boolean;
  settings: PersistentSettings;
  runtime: {
    current_model: ModelSelection & { model: string | null };
    pending: { target_model_preset: string; target_reasoning_effort: string | null } | null;
  };
};

export type PersistentCreateDefaults = {
  node_id: string;
  preferred_agent_id: string | null;
  settings: PersistentSettings;
  initial_instruction: string;
  unavailable_reason: string | null;
};

export type PersistentSessionList = {
  sessions: PersistentSession[];
  total: number;
  create_defaults: PersistentCreateDefaults;
};

/** 현재 화면이 보내는 설정은 기본 모델 하나뿐이다. 숨은 설정은 서버 값을 보존한다. */
type DefaultModelWrite = { default_model: { model_preset: string; reasoning_effort: string | null } };

export type PersistentSessionWrite = {
  display_name?: string;
  enabled?: boolean;
  settings?: DefaultModelWrite;
};

export type PersistentSessionCreate = {
  display_name: string;
  agent_id: string;
  folder_id: string;
  initial_instruction: string;
  settings: DefaultModelWrite;
};

/** 등록 실패 응답은 만들어진 세션의 ID와 이름을 함께 준다. */
export class PersistentSessionError extends HttpResponseError {
  constructor(
    message: string,
    status: number,
    readonly code: string | null,
    readonly createdSession: { session_id: string; display_name: string | null } | null,
  ) {
    super(message, status);
    this.name = "PersistentSessionError";
  }
}

export function createPersistentSessionsApi(request: typeof fetch = fetch) {
  const root = "/api/persistent-sessions";
  async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await request(root + path, {
      credentials: "same-origin",
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await failure(response);
    return await response.json() as T;
  }
  return {
    list: () => call<PersistentSessionList>(""),
    listAgents: async (nodeId: string): Promise<AgentInfo[]> => {
      const response = await request(`/api/nodes/${encodeURIComponent(nodeId)}/agents`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`에이전트 목록을 불러오지 못했습니다 (${response.status})`);
      return ((await response.json()) as { agents?: AgentInfo[] }).agents ?? [];
    },
    update: (sessionId: string, input: PersistentSessionWrite) =>
      call<{ session: PersistentSession; model_change: "none" | "next_execution_start" }>(`/${encodeURIComponent(sessionId)}`, "PUT", input),
    create: (input: PersistentSessionCreate) =>
      call<{ session: PersistentSession; creation: "started"; warnings: unknown[] }>("", "POST", input),
  };
}

export type PersistentSessionsApi = ReturnType<typeof createPersistentSessionsApi>;

async function failure(response: Response): Promise<PersistentSessionError> {
  let message = `영구 에이전트 세션 요청 실패 (${response.status})`;
  let code: string | null = null;
  let createdSession: PersistentSessionError["createdSession"] = null;
  try {
    const payload = await response.json() as {
      error?: { code?: unknown; message?: unknown };
      created_session?: { session_id?: unknown; display_name?: unknown };
    };
    if (typeof payload.error?.message === "string") message = payload.error.message;
    if (typeof payload.error?.code === "string") code = payload.error.code;
    if (typeof payload.created_session?.session_id === "string") {
      createdSession = {
        session_id: payload.created_session.session_id,
        display_name: typeof payload.created_session.display_name === "string" ? payload.created_session.display_name : null,
      };
    }
  } catch {
    // 본문을 읽을 수 없으면 상태 코드를 담은 기본 문구를 쓴다.
  }
  return new PersistentSessionError(message, response.status, code, createdSession);
}
