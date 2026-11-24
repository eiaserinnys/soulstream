import { afterEach, describe, expect, it } from "vitest";

import {
  BAD_CODE,
  GOOD_CODE,
  GOOGLE_URL,
  createHarness,
  hasScript,
  type Harness,
  waitFor,
} from "./fake_clis.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.service.shutdown();
  harness = undefined;
});

async function startAgy(options: Parameters<typeof createHarness>[0] = {}, env: Record<string, string> = {}) {
  harness = await createHarness(options);
  harness.setEnv(env);
  const started = await harness.service.start({ provider: "antigravity" });
  const status = () => harness!.service.status({ login_id: started.login_id });
  return { h: harness, started, status };
}

describe.skipIf(!hasScript)("Antigravity 로그인 흐름 (진짜 script 아래 가짜 agy)", () => {
  it("선택 화면에 \\r을 한 번 보내고 OSC 8에서 접힌 주소를 통째로 뽑아 url_ready로 둔다", async () => {
    const { h, started, status } = await startAgy();
    const startedAt = Date.now();
    expect(started).toMatchObject({ provider: "antigravity", state: "requested", expects_code: true });

    const flow = await waitFor(status, (value) => value.state === "url_ready");
    expect(flow.auth_url).toBe(GOOGLE_URL);
    expect(flow.user_code).toBeNull();
    expect(flow.expects_code).toBe(true);
    expect(Math.abs(Date.parse(flow.expires_at!) - (startedAt + 15 * 60_000))).toBeLessThan(5_000);
    expect(h.agyEvents().filter((event) => event.event === "selection")).toHaveLength(1);
  });

  it("agy에는 TERM=xterm-256color와 tty가 주어진다", async () => {
    const { h, status } = await startAgy();
    await waitFor(status, (value) => value.state === "url_ready");
    const info = JSON.parse((await import("node:fs")).readFileSync(h.agyPidsPath, "utf8"));
    expect(info).toMatchObject({ term: "xterm-256color", isTTY: true });
  });

  it("url_ready 전에는 코드를 받지 않는다(login_not_ready)", async () => {
    const { h, started } = await startAgy();
    await expect(h.service.submit_code({ login_id: started.login_id, code: GOOD_CODE })).rejects.toMatchObject({
      code: "login_not_ready",
    });
  });

  it("코드를 붙여 넣기 구분과 \\r로 넣고, 성공하면 verifying을 거쳐 done이다", async () => {
    const { h, started, status } = await startAgy();
    await waitFor(status, (value) => value.state === "url_ready");

    const submitted = await h.service.submit_code({ login_id: started.login_id, code: `  ${GOOD_CODE}  ` });
    expect(submitted.state).toBe("code_submitted");

    const done = await waitFor(status, (value) => value.state === "done");
    expect(done.error).toBeNull();
    expect(h.usage.calls).toEqual(["antigravity"]);
    const sent = h.agyEvents().find((event) => event.event === "submitted");
    expect(sent?.raw).toBe(`\x1b[200~${GOOD_CODE}\x1b[201~\r`);
  });

  it("제출 뒤에 또 제출하면 login_not_ready", async () => {
    const { h, started, status } = await startAgy({}, { FAKE_AGY_MODE: "silent_after_submit" });
    await waitFor(status, (value) => value.state === "url_ready");
    await h.service.submit_code({ login_id: started.login_id, code: GOOD_CODE });
    await expect(h.service.submit_code({ login_id: started.login_id, code: GOOD_CODE })).rejects.toMatchObject({
      code: "login_not_ready",
    });
  });

  it("틀린 코드 문구가 보이면 끝내고 failed invalid_code", async () => {
    const { h, started, status } = await startAgy();
    await waitFor(status, (value) => value.state === "url_ready");
    await h.service.submit_code({ login_id: started.login_id, code: BAD_CODE });

    const failed = await waitFor(status, (value) => value.state === "failed");
    expect(failed.error?.code).toBe("invalid_code");
    expect(h.usage.calls).toEqual([]);
  });

  it("제출 뒤 문구가 없어도 감시 시간이 지나면 확인으로 간다", async () => {
    const { h, started, status } = await startAgy({}, { FAKE_AGY_MODE: "silent_after_submit" });
    await waitFor(status, (value) => value.state === "url_ready");
    await h.service.submit_code({ login_id: started.login_id, code: GOOD_CODE });
    const done = await waitFor(status, (value) => value.state === "done");
    expect(done.error).toBeNull();
    expect(h.usage.calls).toEqual(["antigravity"]);
  });

  it("사용량 확인이 통과하지 못하면 failed verify_failed", async () => {
    const { h, started, status } = await startAgy();
    h.usage.status = "not_configured";
    await waitFor(status, (value) => value.state === "url_ready");
    await h.service.submit_code({ login_id: started.login_id, code: GOOD_CODE });
    const failed = await waitFor(status, (value) => value.state === "failed");
    expect(failed.error?.code).toBe("verify_failed");
  });

  it("선택 화면 없이 이미 인증됐다는 문구가 보이면 곧바로 확인으로 간다", async () => {
    const { h, status } = await startAgy({}, { FAKE_AGY_MODE: "already" });
    const done = await waitFor(status, (value) => value.state === "done");
    expect(done.error).toBeNull();
    expect(h.agyEvents().filter((event) => event.event === "selection")).toHaveLength(0);
    expect(h.usage.calls).toEqual(["antigravity"]);
  });

  it("expires_at까지 코드가 오지 않으면 끝내고 failed timeout", async () => {
    const { status } = await startAgy({ timings: { agyLoginTimeoutMs: 1_500 } });
    await waitFor(status, (value) => value.state === "url_ready");
    const failed = await waitFor(status, (value) => value.state === "failed");
    expect(failed.error?.code).toBe("timeout");
  });

  it("안내를 제한 시간 안에 못 읽으면 끝내고 failed cli_exited", async () => {
    const { status } = await startAgy({ timings: { agyOutputWaitMs: 400 } }, { FAKE_AGY_MODE: "mute" });
    const failed = await waitFor(status, (value) => value.state === "failed");
    expect(failed.error?.code).toBe("cli_exited");
  });

  it.each([
    ["빈 문자열", ""],
    ["공백만", "   "],
    ["200자 초과", "a".repeat(201)],
    ["줄바꿈이 낀 코드", "abc\ndef"],
    ["제어 문자", "abc\x1bdef"],
  ])("제출 검증: %s는 invalid_request로 거절하고 상태를 바꾸지 않는다", async (_name, code) => {
    const { h, started, status } = await startAgy();
    await waitFor(status, (value) => value.state === "url_ready");
    await expect(h.service.submit_code({ login_id: started.login_id, code })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect((await status()).state).toBe("url_ready");
    expect(h.agyEvents().filter((event) => event.event === "submitted")).toHaveLength(0);
  });

  it("CLI가 없으면 cli_not_installed로 거절한다", async () => {
    harness = await createHarness({ withAgy: false });
    await expect(harness.service.start({ provider: "antigravity" })).rejects.toMatchObject({
      code: "cli_not_installed",
    });
  });
});
