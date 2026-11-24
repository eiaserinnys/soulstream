import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { AgentLoginServiceError } from "../../src/agent_login/types.js";
import {
  CODEX_URL,
  CODEX_USER_CODE,
  createHarness,
  type Harness,
  waitFor,
} from "./fake_clis.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.service.shutdown();
  harness = undefined;
});

async function startCodex(options: Parameters<typeof createHarness>[0] = {}) {
  harness = await createHarness(options);
  const started = await harness.service.start({ provider: "codex" });
  return { h: harness, started };
}

describe("Codex 로그인 흐름", () => {
  it("기기 코드 출력을 읽어 url_ready로 두고 주소, 코드, expires_at을 채운다", async () => {
    const { h, started } = await startCodex();
    const startedAt = Date.now();
    expect(started).toMatchObject({ provider: "codex", state: "requested", expects_code: false, auth_url: null });

    const flow = await waitFor(() => h.service.status({ login_id: started.login_id }), (value) => value.state === "url_ready");
    expect(flow.auth_url).toBe(CODEX_URL);
    expect(flow.user_code).toBe(CODEX_USER_CODE);
    expect(flow.expects_code).toBe(false);
    expect(Math.abs(Date.parse(flow.expires_at!) - (startedAt + 15 * 60_000))).toBeLessThan(5_000);
    expect(readFileSync(h.codexArgsPath, "utf8").trim()).toBe(JSON.stringify(["login", "--device-auth"]));
  });

  it("승인되어 종료 코드 0이면 verifying을 거쳐 사용량 확인이 통과해야 done이 된다", async () => {
    const { h, started } = await startCodex();
    await waitFor(() => h.service.status({ login_id: started.login_id }), (value) => value.state === "url_ready");
    await writeFile(h.codexSignalPath, "approved");

    const done = await waitFor(() => h.service.status({ login_id: started.login_id }), (value) => value.state === "done");
    expect(done.error).toBeNull();
    expect(h.usage.calls).toEqual(["codex"]);
    // 끝난 흐름의 스냅샷에는 일회용 값이 남지 않는다.
    expect(done.auth_url).toBeNull();
    expect(done.user_code).toBeNull();
  });

  it("사용량 확인이 통과하지 못하면 failed verify_failed", async () => {
    const { h, started } = await startCodex();
    h.usage.status = "error";
    await waitFor(() => h.service.status({ login_id: started.login_id }), (value) => value.state === "url_ready");
    await writeFile(h.codexSignalPath, "approved");

    const failed = await waitFor(() => h.service.status({ login_id: started.login_id }), (value) => value.state === "failed");
    expect(failed.error?.code).toBe("verify_failed");
  });

  it("auth.json이 객체로 읽히지 않으면 사용량 확인이 통과해도 verify_failed", async () => {
    harness = await createHarness();
    harness.setEnv({ FAKE_CODEX_MODE: "approve_no_auth" });
    const started = await harness.service.start({ provider: "codex" });
    await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "url_ready");
    await writeFile(harness.codexSignalPath, "approved");

    const failed = await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "failed");
    expect(failed.error?.code).toBe("verify_failed");
    expect(harness.usage.calls).toEqual([]);
  });

  it("기기 코드 인증이 꺼진 계정이면 failed device_code_disabled", async () => {
    harness = await createHarness();
    harness.setEnv({ FAKE_CODEX_MODE: "disabled" });
    const started = await harness.service.start({ provider: "codex" });
    const failed = await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "failed");
    expect(failed.error?.code).toBe("device_code_disabled");
  });

  it("0이 아닌 종료는 failed cli_exited", async () => {
    harness = await createHarness();
    harness.setEnv({ FAKE_CODEX_MODE: "crash" });
    const started = await harness.service.start({ provider: "codex" });
    const failed = await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "failed");
    expect(failed.error?.code).toBe("cli_exited");
    // 오류 메시지에 CLI 원출력을 싣지 않는다.
    expect(failed.error?.message).not.toContain("something broke");
  });

  it("주소와 코드를 제한 시간 안에 못 읽으면 끝내고 failed cli_exited", async () => {
    harness = await createHarness({ timings: { codexOutputWaitMs: 300 } });
    harness.setEnv({ FAKE_CODEX_MODE: "silent" });
    const started = await harness.service.start({ provider: "codex" });
    const failed = await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "failed");
    expect(failed.error?.code).toBe("cli_exited");
  });

  it("expires_at에서 유예가 지나도 끝나지 않으면 끝내고 failed timeout", async () => {
    harness = await createHarness({ timings: { codexExpiryGraceMs: 200 } });
    harness.setEnv({ FAKE_CODEX_EXPIRES: "0" });
    const started = await harness.service.start({ provider: "codex" });
    const failed = await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "failed");
    expect(failed.error?.code).toBe("timeout");
  });

  it("CLI가 없으면 시작할 때 cli_not_installed로 거절한다", async () => {
    harness = await createHarness({ withCodex: false });
    await expect(harness.service.start({ provider: "codex" })).rejects.toMatchObject({
      name: "AgentLoginServiceError",
      code: "cli_not_installed",
    });
  });

  it("모르는 공급자와 빈 공급자는 거절한다", async () => {
    harness = await createHarness();
    await expect(harness.service.start({ provider: "claude" })).rejects.toMatchObject({ code: "agent_login_unsupported" });
    await expect(harness.service.start({ provider: "" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("Codex는 코드 제출을 받지 않고, 없는 흐름은 login_not_found다", async () => {
    const { h, started } = await startCodex();
    await expect(h.service.submit_code({ login_id: started.login_id, code: "x" })).rejects.toMatchObject({
      code: "code_not_expected",
    });
    await expect(h.service.status({ login_id: "missing" })).rejects.toBeInstanceOf(AgentLoginServiceError);
    await expect(h.service.cancel({ login_id: "missing" })).rejects.toMatchObject({ code: "login_not_found" });
  });
});
