/**
 * 카드 #1266 U5b 바깥 요청 칸의 경계 시험이다(남은 기록 재생, 멈추는 중, 종료를 올리는 중).
 * 칸마다 그 실행 상태를 운영 코드로 만든 뒤 TaskManager의 운영 진입 함수로 요청을 보내 나온
 * 처분을 보고, 정의의 판정 함수가 같은 처분을 내는지도 본다. 시험 이름은 `NODE_REQUEST_TABLE`의
 * `test`와 같아야 하고 `tests/task/state/node_barrier_request.test.ts`가 그 대응을 확인한다.
 */
import { describe, expect, it, vi } from "vitest";

import {
  deferred,
  fakeRunner,
  flush,
  makeWorld,
  phaseOf,
  REGISTRATION_ID,
  registeredRow,
  SESSION_ID,
  sessionRow,
  startReplaying,
  startRunning,
  track,
} from "./card1266_request_cells_harness.js";
import {
  CARD_START_CALLERS,
  cardStartResume,
  deleteTask,
  expectDefinition,
  expectOneTerminal,
  intervene,
  resume,
  startReleasing,
  startRetained,
  startStarting,
  stopTask,
} from "./card1266_request_cells_steps.js";

describe("바깥 요청 칸의 경계 시험 (카드 #1266 U5b)", () => {
  describe("러너의 남은 기록을 올리는 중", () => {
    async function replaying() {
      const frames = deferred();
      // 오프라인 재생 손잡이 뒤에는 러너 프로세스가 없다. 살아 있던 러너도 재생 전에 끝낸다
      // (runner_recovery_disposition.ts). 그래서 멈춤 명령과 엔진 명령 모두 던진다.
      const runner = fakeRunner({
        frames: frames.promise,
        interrupt: async () => {
          throw new Error(`Runner process is unavailable: ${SESSION_ID}`);
        },
        engine: {
          intervene: vi.fn(async () => {
            throw new Error(`Runner process is unavailable: ${SESSION_ID}`);
          }),
        },
      });
      const world = makeWorld(registeredRow(), { runner });
      const { task, recovery } = await startReplaying(world);
      expect(phaseOf(task)).toBe("replaying");
      return { world, task, runner, frames, recovery };
    }

    it("남은 기록을 올리는 중에 멈춤이 오면 멈춤 하나로 닫힌다", async () => {
      const { world, task, runner, frames, recovery } = await replaying();
      expectDefinition("replaying", "stop", "interrupt_and_terminate");

      const stopped = track(stopTask(world));
      await flush();
      frames.resolve();
      await recovery;
      await flush();

      // 멈춤 명령이 실패해 멈춤 확인 실패로 종료를 한 번 올리고 거절(거짓)로 답한다(약속 15).
      expect(stopped.value).toBe(false);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "error_aborted");
      expect(task.status).toBe("error");
    });

    it("남은 기록을 올리는 중에 지시가 오면 대기 줄에 쌓았다가 재생이 끝난 뒤 다시 띄운다", async () => {
      const { world, task, runner, frames, recovery } = await replaying();
      expectDefinition("replaying", "intervene", "deliver_or_queue");

      // 앞선 지시를 넘기는 중에 다음 지시가 와도 차례로 쌓인다(옛 짐작 5번).
      const first = intervene(world, "첫 지시");
      const second = intervene(world, "둘째 지시");
      await expect(first).resolves.toMatchObject({ delivered: false, queued: true });
      await expect(second).resolves.toMatchObject({ delivered: false, queued: true });
      expect(runner.engine.intervene).not.toHaveBeenCalled();
      expect(task.interventionQueue.map((message) => message.text)).toEqual(["첫 지시", "둘째 지시"]);
      expect(world.resumes).toHaveLength(0);

      frames.resolve();
      await recovery;
      await flush();
      expect(world.resumes.map((record) => record.queueAtStart)).toEqual([["첫 지시", "둘째 지시"]]);
    });

    it("남은 기록을 올리는 중에 지우면 멈춘 뒤 지운다", async () => {
      const { world, frames, recovery } = await replaying();
      expectDefinition("replaying", "delete", "stop_then_delete");

      const deleted = track(deleteTask(world));
      await flush();
      frames.resolve();
      await recovery;
      await flush();
      // 멈춤 명령은 실패하지만 종료를 한 번 올린 뒤 줄을 지운다.
      expect(deleted.value).toBe(true);
      expectOneTerminal(world, "error_aborted");
      expect(world.deleteSession).toHaveBeenCalledOnce();
    });

    it("남은 기록을 올리는 중에 재개가 오면 새 실행을 시작하지 않는다", async () => {
      const { world, frames } = await replaying();
      expectDefinition("replaying", "resume", "reject_runner_attached");

      await expect(resume(world)).resolves.toMatchObject({
        state: "already_running",
        execution: { registrationId: REGISTRATION_ID },
      });
      expect(world.resumes).toHaveLength(0);
      frames.resolve();
    });

    it("남은 기록을 올리는 중 넘기기를 기다리던 멈춤은 넘기기가 끝난 뒤 보통 멈춤 길로 닫힌다", async () => {
      const { world, task, runner, frames, recovery } = await replaying();
      // 지시 접수 사건의 영속이 끝나지 않아 넘기기 장벽이 서 있는 동안 멈춤이 온다.
      const accepted = deferred();
      const persist = world.persistenceDouble.enqueueEvent;
      const original = persist.getMockImplementation()!;
      persist.mockImplementation(async (...args: Parameters<typeof original>) => {
        if ((args[1] as { type?: string }).type === "intervention_sent") await accepted.promise;
        return await original(...args);
      });
      const handoff = intervene(world, "넘기는 지시");
      await flush();
      expect(task.interruptBarrierKind).toBe("intervention_handoff");

      const stopped = track(stopTask(world));
      await flush();
      expect(runner.interrupt).not.toHaveBeenCalled();
      accepted.resolve();
      await expect(handoff).resolves.toMatchObject({ queued: true });
      await flush();
      frames.resolve();
      await recovery;
      await flush();

      // 넘기기가 끝난 뒤 보통 멈춤 길을 타고, 위 멈춤 칸과 같이 거절로 닫힌다.
      expect(stopped.value).toBe(false);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "error_aborted");
      expect(task.status).toBe("error");
    });
  });

  describe("멈추는 중", () => {
    async function stopping() {
      const frames = deferred();
      const interrupted = deferred<boolean>();
      const runner = fakeRunner({ frames: frames.promise, interrupt: async () => await interrupted.promise });
      const world = makeWorld(sessionRow(), { runner });
      const task = await startRunning(world);
      const firstStop = track(stopTask(world));
      await flush();
      expect(phaseOf(task)).toBe("stopping");
      return {
        world,
        task,
        runner,
        firstStop,
        async finish() {
          interrupted.resolve(true);
          await flush();
          frames.resolve();
          await flush();
        },
      };
    }

    it("멈추는 중에 멈춤이 오면 앞선 멈춤에 붙는다", async () => {
      const { world, runner, firstStop, finish } = await stopping();
      expectDefinition("stopping", "stop", "join_stop");

      const joined = track(stopTask(world));
      await flush();
      expect(joined.settled).toBe(false);
      await finish();
      expect([firstStop.value, joined.value]).toEqual([true, true]);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
    });

    it("멈추는 중에 지시가 오면 대기 줄에 쌓았다가 멈춤이 끝난 뒤 다시 띄운다", async () => {
      const { world, task, runner, firstStop, finish } = await stopping();
      expectDefinition("stopping", "intervene", "queue_and_restart");

      await expect(intervene(world)).resolves.toMatchObject({ delivered: false, queued: true });
      expect(runner.engine.intervene).not.toHaveBeenCalled();
      // 지시는 멈춤 장벽을 건드리지 않으므로 뒤에 온 멈춤도 앞 멈춤에 붙는다(약속 15).
      expect(task.interruptBarrierKind).toBe("stop");
      const secondStop = track(stopTask(world));
      await flush();
      expect(secondStop.settled).toBe(false);
      expect(world.resumes).toHaveLength(0);

      await finish();
      expect([firstStop.value, secondStop.value]).toEqual([true, true]);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
      // 멈춤이 끝난 뒤 새 턴에 정확히 한 번 들어간다(약속 13).
      expect(world.resumes.map((record) => record.queueAtStart)).toEqual([["새 지시"]]);
      expect(world.resumes[0]!.runnerAtStart).toBeUndefined();
    });

    it("멈추는 중 지시 뒤에 지우면 멈춤을 기다려 지우고 지시로 다시 띄우지 않는다", async () => {
      const { world, runner, firstStop, finish } = await stopping();

      await expect(intervene(world)).resolves.toMatchObject({ delivered: false, queued: true });
      const deleted = track(deleteTask(world));
      await flush();
      expect(world.deleteSession).not.toHaveBeenCalled();

      await finish();
      expect([firstStop.value, deleted.value]).toEqual([true, true]);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
      expect(world.deleteSession).toHaveBeenCalledOnce();
      expect(world.resumes).toHaveLength(0);
    });

    it("멈추는 중에 지우면 멈춤 마무리를 기다린 뒤 지운다", async () => {
      const { world, runner, finish } = await stopping();
      expectDefinition("stopping", "delete", "stop_then_delete");

      const deleted = track(deleteTask(world));
      await flush();
      expect(world.deleteSession).not.toHaveBeenCalled();
      await finish();
      expect(deleted.value).toBe(true);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
      expect(world.deleteSession).toHaveBeenCalledOnce();
    });

    it("멈추는 중에 재개가 오면 멈춤이 끝난 뒤 그 프롬프트로 새 실행을 시작한다", async () => {
      expectDefinition("stopping", "resume", "wait_then_start");
      // 사람이 카드를 시작한 재개와 자동 배정의 재개 둘 다 같은 길이다.
      for (const source of CARD_START_CALLERS) {
        const { world, firstStop, finish } = await stopping();
        const started = track(cardStartResume(world, source));
        await flush();
        expect(started.settled, source).toBe(false);
        await finish();
        expect(firstStop.value, source).toBe(true);
        expectOneTerminal(world, "killed");
        expect(started.value, source).toMatchObject({
          state: "started",
          execution: { registrationId: "registration-resumed-1" },
        });
        expect(world.resumes.map((record) => record.queueAtStart), source)
          .toEqual([["카드 「시험」를 이어서 수행하세요."]]);
      }
    });
    it("멈추는 중에 지시와 카드 착수가 겹치면 착수가 새 실행 하나로 둘 다 받는다", async () => {
      const { world, firstStop, finish } = await stopping();
      await expect(intervene(world)).resolves.toMatchObject({ queued: true });
      const started = track(cardStartResume(world, "system"));
      await flush();
      await finish();

      expect(firstStop.value).toBe(true);
      expectOneTerminal(world, "killed");
      expect(started.value).toMatchObject({ state: "started" });
      expect(world.resumes).toHaveLength(1);
      expect([...world.resumes[0]!.queueAtStart].sort())
        .toEqual(["새 지시", "카드 「시험」를 이어서 수행하세요."].sort());
    });
  });

  describe("종료를 올리는 중", () => {
    async function terminating() {
      const frames = deferred();
      const runner = fakeRunner({ frames: frames.promise });
      const world = makeWorld(sessionRow(), { runner });
      const task = await startRunning(world);
      const terminal = world.holdNextTerminalAnswer();
      frames.resolve();
      await flush();
      expect(phaseOf(task)).toBe("terminating");
      return {
        world,
        task,
        runner,
        async finish() {
          terminal.resolve();
          await flush();
        },
      };
    }

    it("종료를 올리는 중에 멈춤이 오면 거짓을 돌려준다", async () => {
      const { world, runner, finish } = await terminating();
      expectDefinition("terminating", "stop", "reject_not_running");

      await expect(stopTask(world)).resolves.toBe(false);
      await finish();
      expect(runner.interrupt).not.toHaveBeenCalled();
      expectOneTerminal(world, "completed_ok");
    });

    it("종료를 올리는 중에 지시가 오면 종료가 끝난 뒤 다시 띄운다", async () => {
      const { world, finish } = await terminating();
      expectDefinition("terminating", "intervene", "queue_and_restart");

      const resumed = track(intervene(world));
      await flush();
      expect(resumed.settled).toBe(false);
      await finish();
      expect(resumed.value).toEqual({ autoResumed: true });
      expect(world.resumes.map((record) => record.queueAtStart)).toEqual([["새 지시"]]);
      expectOneTerminal(world, "completed_ok");
    });

    it("종료를 올리는 중에 지우면 줄을 지운다", async () => {
      const { world, finish } = await terminating();
      expectDefinition("terminating", "delete", "delete_row");

      await expect(deleteTask(world)).resolves.toBe(true);
      expect(world.deleteSession).toHaveBeenCalledOnce();
      await finish();
      expectOneTerminal(world, "completed_ok");
    });

    it("종료를 올리는 중에 재개가 오면 종료가 끝난 뒤 그 프롬프트로 새 실행을 시작한다", async () => {
      expectDefinition("terminating", "resume", "wait_then_start");
      for (const source of CARD_START_CALLERS) {
        const { world, finish } = await terminating();
        const started = track(cardStartResume(world, source));
        await flush();
        expect(started.settled, source).toBe(false);
        await finish();
        expectOneTerminal(world, "completed_ok");
        expect(started.value, source).toMatchObject({
          state: "started",
          execution: { registrationId: "registration-resumed-1" },
        });
        expect(world.resumes.map((record) => record.queueAtStart), source)
          .toEqual([["카드 「시험」를 이어서 수행하세요."]]);
      }
    });
  });
});
