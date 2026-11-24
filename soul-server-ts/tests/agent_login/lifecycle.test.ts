import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_AGENT_LOGIN_TIMINGS } from "../../src/agent_login/types.js";
import {
  BAD_CODE,
  CODEX_URL,
  CODEX_USER_CODE,
  GOOD_CODE,
  GOOGLE_URL,
  createHarness,
  hasScript,
  isAlive,
  type Harness,
  waitFor,
} from "./fake_clis.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.service.shutdown();
  harness = undefined;
});

const readPids = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;

describe("로그인 흐름 수명주기", () => {
  it("새 흐름이 오면 진행 중인 흐름을 끝내고 그 스냅샷을 failed cancelled_by_new_login으로 둔다", async () => {
    harness = await createHarness();
    const first = await harness.service.start({ provider: "codex" });
    await waitFor(() => harness!.service.status({ login_id: first.login_id }), (value) => value.state === "url_ready");

    const second = await harness.service.start({ provider: "codex" });
    expect(second.login_id).not.toBe(first.login_id);

    const old = await waitFor(() => harness!.service.status({ login_id: first.login_id }), (value) => value.state === "failed");
    expect(old.error?.code).toBe("cancelled_by_new_login");
    expect((await harness.service.status({ login_id: second.login_id })).state).not.toBe("failed");
  });

  it.skipIf(!hasScript)("공급자가 달라도 노드당 하나다(codex 뒤에 antigravity)", async () => {
    harness = await createHarness();
    const first = await harness.service.start({ provider: "codex" });
    await harness.service.start({ provider: "antigravity" });
    const old = await waitFor(() => harness!.service.status({ login_id: first.login_id }), (value) => value.state === "failed");
    expect(old.error?.code).toBe("cancelled_by_new_login");
  });

  it("취소하면 CLI와 그 자손이 남지 않고 스냅샷은 cancelled다", async () => {
    harness = await createHarness();
    harness.setEnv({ FAKE_PIDS_FILE: harness.pidsPath });
    const started = await harness.service.start({ provider: "codex" });
    await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "url_ready");
    const pids = await waitFor(() => { try { return readPids(harness!.pidsPath); } catch { return {}; } }, (value) => "grandchild" in value);
    expect(isAlive(pids.pid!)).toBe(true);
    expect(isAlive(pids.grandchild!)).toBe(true);

    const cancelled = await harness.service.cancel({ login_id: started.login_id });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBeNull();
    await waitFor(() => [isAlive(pids.pid!), isAlive(pids.grandchild!)], (alive) => !alive[0] && !alive[1]);
  });

  it("워커가 끝날 때(shutdown) 진행 중인 흐름의 프로세스를 정리한다", async () => {
    harness = await createHarness();
    harness.setEnv({ FAKE_PIDS_FILE: harness.pidsPath });
    const started = await harness.service.start({ provider: "codex" });
    const pids = await waitFor(() => { try { return readPids(harness!.pidsPath); } catch { return {}; } }, (value) => "grandchild" in value);

    await harness.service.shutdown();
    // 신호를 받은 자손이 init에 거두어지기까지 잠시 걸린다.
    await waitFor(() => [isAlive(pids.pid!), isAlive(pids.grandchild!)], (alive) => !alive[0] && !alive[1]);
    expect((await harness.service.status({ login_id: started.login_id })).state).toBe("cancelled");
  });

  it.skipIf(!hasScript)("agy 취소 때 script와 pty 안의 agy가 남지 않는다", async () => {
    harness = await createHarness();
    const started = await harness.service.start({ provider: "antigravity" });
    await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "url_ready");
    const { pid } = readPids(harness.agyPidsPath);
    expect(isAlive(pid!)).toBe(true);
    expect(harness.activity.isLive("antigravity")).toBe(true);

    expect((await harness.service.cancel({ login_id: started.login_id })).state).toBe("cancelled");
    await waitFor(() => isAlive(pid!), (alive) => !alive);
    expect(harness.activity.isLive("antigravity")).toBe(false);
  });

  it.skipIf(!hasScript)("agy 성공 뒤 확인으로 넘어갈 때도 agy를 끝낸다", async () => {
    harness = await createHarness();
    const started = await harness.service.start({ provider: "antigravity" });
    await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "url_ready");
    const { pid } = readPids(harness.agyPidsPath);
    await harness.service.submit_code({ login_id: started.login_id, code: GOOD_CODE });
    await waitFor(() => harness!.service.status({ login_id: started.login_id }), (value) => value.state === "done");
    expect(isAlive(pid!)).toBe(false);
  });

  it("끝난 흐름의 스냅샷은 보존 기간 동안 읽히고 그 뒤 버려진다", async () => {
    harness = await createHarness({ timings: { retentionMs: 500 } });
    const started = await harness.service.start({ provider: "codex" });
    await harness.service.cancel({ login_id: started.login_id });
    expect((await harness.service.status({ login_id: started.login_id })).state).toBe("cancelled");
    await waitFor(
      () => harness!.service.status({ login_id: started.login_id }).then(() => "kept", () => "gone"),
      (value) => value === "gone",
    );
  });

  it("보존 기간 기본값은 10분이고 기본 제한 시간은 스펙과 같다", () => {
    expect(DEFAULT_AGENT_LOGIN_TIMINGS).toMatchObject({
      retentionMs: 600_000,
      codexOutputWaitMs: 15_000,
      agyOutputWaitMs: 20_000,
      codexExpiryGraceMs: 30_000,
      agyLoginTimeoutMs: 900_000,
      agySubmitWatchMs: 30_000,
      agySuccessSettleMs: 2_000,
      killGracePeriodMs: 5_000,
    });
  });

  it.skipIf(!hasScript)("로그에는 상태 전이만 남고 일회용 코드, 인증 주소, 붙여 넣은 코드가 없다", async () => {
    harness = await createHarness();
    const codex = await harness.service.start({ provider: "codex" });
    await waitFor(() => harness!.service.status({ login_id: codex.login_id }), (value) => value.state === "url_ready");
    const agy = await harness.service.start({ provider: "antigravity" });
    await waitFor(() => harness!.service.status({ login_id: agy.login_id }), (value) => value.state === "url_ready");
    await harness.service.submit_code({ login_id: agy.login_id, code: BAD_CODE });
    await waitFor(() => harness!.service.status({ login_id: agy.login_id }), (value) => value.state === "failed");

    const text = harness.logs.join("\n");
    expect(text).toContain("Agent login state changed");
    for (const secret of [CODEX_URL, "auth.openai.com", CODEX_USER_CODE, GOOGLE_URL, "accounts.google.com", "STATE-SECRET-XYZ", BAD_CODE, GOOD_CODE]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
