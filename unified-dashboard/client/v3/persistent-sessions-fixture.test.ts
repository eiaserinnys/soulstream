import { describe, expect, it } from "vitest";
import { createPersistentSessionsFixture } from "./persistent-sessions-fixture";

/** 검수 창의 가짜 응답이 서버와 같은 방식으로 추론 수준과 모델 변경을 다루는지 확인한다. */
describe("persistent sessions review fixture", () => {
  const call = async (handler: ReturnType<typeof createPersistentSessionsFixture>, path: string, method: string, body?: unknown) => {
    const response = await handler(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json() as any };
  };
  const make = (scenario = "normal") => createPersistentSessionsFixture({ scenario, nodeId: "sample-node", folderId: "sample-folder" });
  const save = (handler: ReturnType<typeof make>, id: string, preset: string, effort: string | null) =>
    call(handler, `/api/persistent-sessions/${id}`, "PUT", { settings: { default_model: { model_preset: preset, reasoning_effort: effort } } });

  it("returns the canonical usage mode and its legacy projection in the list and create defaults", async () => {
    const { json } = await call(make(), "/api/persistent-sessions", "GET");
    expect(Object.keys(json.sessions[0].settings).sort()).toEqual([
      "animate_character",
      "default_model",
      "fallback_model",
      "show_character",
      "show_generation_separator",
      "show_jev_candidates",
      "show_turn_usage",
      "turn_usage_mode",
    ]);
    expect(json.sessions[0].settings.animate_character).toBe(true);
    expect(json.sessions[0].settings.show_turn_usage).toBe(true);
    expect(json.sessions[0].settings.turn_usage_mode).toBe("collapsed");
    expect(json.create_defaults.settings.animate_character).toBe(true);
    expect(json.create_defaults.settings.show_turn_usage).toBe(true);
    expect(json.create_defaults.settings.turn_usage_mode).toBe("collapsed");
    expect(json.create_defaults.settings.show_jev_candidates).toBe(true);
  });

  it("saves only the canonical usage mode and returns the derived legacy visibility", async () => {
    const response = await call(make(), "/api/persistent-sessions/sample-pas-1", "PUT", { settings: { turn_usage_mode: "hidden" } });
    expect(response.json.session.settings.turn_usage_mode).toBe("hidden");
    expect(response.json.session.settings.show_turn_usage).toBe(false);
  });

  it("keeps the recorded effort for the same preset and uses the preset default for a new one", async () => {
    const handler = make();
    // sample-pas-2: 저장값과 현재 모두 sample-sol/high
    const same = await save(handler, "sample-pas-2", "sample-sol", null);
    expect(same.json.session.settings.default_model).toEqual({ model_preset: "sample-sol", reasoning_effort: "high" });
    expect(same.json.model_change).toBe("none");
    const other = await save(handler, "sample-pas-2", "sample-opus", null);
    expect(other.json.session.settings.default_model).toEqual({ model_preset: "sample-opus", reasoning_effort: null });
  });

  it("decides the model change from the (preset, effort) pair against the running model and the pending target", async () => {
    const handler = make();
    // 현재 sample-sol/high 와 같은 쌍이면 변경이 없다.
    expect((await save(handler, "sample-pas-2", "sample-sol", "high")).json.model_change).toBe("none");
    // 프리셋이 같아도 수준이 다르면 다음 실행부터 바뀐다.
    const lower = await save(handler, "sample-pas-2", "sample-sol", "medium");
    expect(lower.json.model_change).toBe("next_execution_start");
    expect(lower.json.session.runtime.pending).toEqual({ target_model_preset: "sample-sol", target_reasoning_effort: "medium" });
    // 같은 대상의 대기가 이미 있으면 다시 요청하지 않는다.
    expect((await save(handler, "sample-pas-2", "sample-sol", "medium")).json.model_change).toBe("none");
    // 다른 쌍이면 대기가 새 대상으로 바뀐다.
    const other = await save(handler, "sample-pas-2", "sample-opus", null);
    expect(other.json.model_change).toBe("next_execution_start");
    expect(other.json.session.runtime.pending).toEqual({ target_model_preset: "sample-opus", target_reasoning_effort: null });
  });

  it("stores the effort given when creating a session and starts it on that model", async () => {
    const handler = make();
    const created = await call(handler, "/api/persistent-sessions", "POST", {
      display_name: "새 세션", agent_id: "roselin", folder_id: "sample-folder", initial_instruction: "",
      settings: { default_model: { model_preset: "sample-sol", reasoning_effort: "low" } },
    });
    expect(created.status).toBe(201);
    expect(created.json.session.settings.default_model).toEqual({ model_preset: "sample-sol", reasoning_effort: "low" });
    expect(created.json.session.runtime.current_model.reasoning_effort).toBe("low");
    // 비우면 프리셋의 기본 수준이다.
    const blank = await call(handler, "/api/persistent-sessions", "POST", {
      display_name: "또 다른 세션", agent_id: "roselin", folder_id: "sample-folder", initial_instruction: "",
      settings: { default_model: { model_preset: "sample-sol", reasoning_effort: null } },
    });
    expect(blank.json.session.settings.default_model.reasoning_effort).toBe("high");
  });

  it("can list a session whose node and agent are unknown", async () => {
    const { json } = await call(make("node-unknown"), "/api/persistent-sessions", "GET");
    const legacy = json.sessions.find((item: any) => item.session_id === "sample-pas-legacy");
    expect(legacy).toMatchObject({ node_id: null, agent_id: null, agent_name: null });
  });

  it("serves instruction reads and mutations with the persistent instruction response wrappers", async () => {
    const handler = make();
    const initial = await call(handler, "/api/persistent-sessions/sample-pas-1/instructions", "GET");
    expect(initial.json.instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "sample-instruction-1", source_turns: ["T195"], origin: "agent" }),
    ]));

    const added = await call(handler, "/api/persistent-sessions/sample-pas-1/instructions", "POST", { text: "직접 추가한 지시" });
    expect(added.status).toBe(201);
    expect(added.json.instruction).toMatchObject({ text: "직접 추가한 지시", source_turns: [], origin: "user" });

    const id = added.json.instruction.id;
    const updated = await call(handler, `/api/persistent-sessions/sample-pas-1/instructions/${id}`, "PUT", { text: "수정한 지시" });
    expect(updated.json.instruction).toMatchObject({ id, text: "수정한 지시", origin: "user" });

    const removed = await call(handler, `/api/persistent-sessions/sample-pas-1/instructions/${id}`, "PUT", { status: "removed" });
    expect(removed.json.instruction).toMatchObject({ id, status: "removed" });
    const active = await call(handler, "/api/persistent-sessions/sample-pas-1/instructions", "GET");
    expect(active.json.instructions.some((item: { id: string }) => item.id === id)).toBe(false);
  });
});
