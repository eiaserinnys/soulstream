/**
 * 카드 #1266 U5b 바깥 요청 칸의 경계 시험이다(주인 없음, 러너 없이 올린 활성 task, 시동 중,
 * 실행 등록 대기, 턴을 도는 중).
 * 칸마다 그 실행 상태를 운영 코드로 만든 뒤 TaskManager의 운영 진입 함수로 요청을 보내 나온
 * 처분을 보고, 정의의 판정 함수가 같은 처분을 내는지도 본다. 시험 이름은 `NODE_REQUEST_TABLE`의
 * `test`와 같아야 하고 `tests/task/state/node_barrier_request.test.ts`가 그 대응을 확인한다.
 */
import { describe, expect, it, vi } from "vitest";

import {
  deferred,
  fakeRunner,
  flush,
  hydrate,
  makeWorld,
  phaseOf,
  REGISTRATION_ID,
  sessionRow,
  startRegistering,
  startRunning,
  terminalRow,
  track,
} from "./card1266_request_cells_harness.js";
import {
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
  describe("주인 없음", () => {
    it("주인 없음에 멈춤이 오면 이미 수렴한 멈춤으로 참을 돌려준다", async () => {
      const world = makeWorld(terminalRow());
      const task = await hydrate(world);
      expect(phaseOf(task)).toBe("idle");
      expectDefinition("idle", "stop", "already_converged");

      await expect(stopTask(world)).resolves.toBe(true);
      expect(world.terminalReasons()).toEqual([]);
      expect(task.status).toBe("completed");
    });

    it("주인 없음에 지시가 오면 대기 줄에 넣고 다시 띄운다", async () => {
      const world = makeWorld(terminalRow());
      expect(phaseOf(await hydrate(world))).toBe("idle");
      expectDefinition("idle", "intervene", "queue_and_restart");

      await expect(intervene(world)).resolves.toEqual({ autoResumed: true });
      expect(world.resumes.map((record) => record.queueAtStart)).toEqual([["새 지시"]]);
    });

    it("주인 없음을 지우면 종료 기록 없이 줄을 지운다", async () => {
      const world = makeWorld(terminalRow());
      expect(phaseOf(await hydrate(world))).toBe("idle");
      expectDefinition("idle", "delete", "delete_row");

      await expect(deleteTask(world)).resolves.toBe(true);
      expect(world.deleteSession).toHaveBeenCalledOnce();
      expect(world.terminalReasons()).toEqual([]);
    });

    it("주인 없음에 재개가 오면 새 실행을 시작한다", async () => {
      const world = makeWorld(terminalRow());
      expect(phaseOf(await hydrate(world))).toBe("idle");
      expectDefinition("idle", "resume", "start_execution");

      await expect(resume(world)).resolves.toMatchObject({ state: "started" });
      expect(world.resumes).toHaveLength(1);
    });
  });

  describe("러너 없이 올린 활성 task", () => {
    it("러너 없이 올린 활성 task를 멈추면 종료 기록을 만든다", async () => {
      const world = makeWorld(sessionRow());
      const task = await hydrate(world);
      expect(phaseOf(task)).toBe("hydrated_active");
      expectDefinition("hydrated_active", "stop", "terminate_without_runner");

      await expect(stopTask(world)).resolves.toBe(true);
      expectOneTerminal(world, "killed");
      expect(task.status).toBe("interrupted");
    });

    it("러너 없이 올린 활성 task에 지시가 오면 대기 줄에 넣고 다시 띄운다", async () => {
      const world = makeWorld(sessionRow());
      expect(phaseOf(await hydrate(world))).toBe("hydrated_active");
      expectDefinition("hydrated_active", "intervene", "queue_and_restart");

      await expect(intervene(world)).resolves.toEqual({ autoResumed: true });
      expect(world.resumes.map((record) => record.queueAtStart)).toEqual([["새 지시"]]);
      expect(world.terminalReasons()).toEqual([]);
    });

    it("러너 없이 올린 활성 task를 지우면 종료 기록을 만든 뒤 지운다", async () => {
      const world = makeWorld(sessionRow());
      expect(phaseOf(await hydrate(world))).toBe("hydrated_active");
      expectDefinition("hydrated_active", "delete", "terminate_without_runner_then_delete");

      await expect(deleteTask(world)).resolves.toBe(true);
      expectOneTerminal(world, "killed");
      expect(world.deleteSession).toHaveBeenCalledOnce();
    });

    it("러너 없이 올린 활성 task에 재개가 오면 새 실행을 시작한다", async () => {
      const world = makeWorld(sessionRow());
      expect(phaseOf(await hydrate(world))).toBe("hydrated_active");
      expectDefinition("hydrated_active", "resume", "start_execution");

      await expect(resume(world)).resolves.toMatchObject({ state: "started" });
      expect(world.resumes).toHaveLength(1);
    });
  });

  describe("시동 중", () => {
    it("시동 중에 멈춤이 오면 거짓을 돌려준다", async () => {
      const world = makeWorld(terminalRow());
      const { task, release } = await startStarting(world);
      expect(phaseOf(task)).toBe("starting");
      expectDefinition("starting", "stop", "reject_not_running");

      await expect(stopTask(world)).resolves.toBe(false);
      expect(world.terminalReasons()).toEqual([]);
      release();
    });

    it("시동 중에 지시가 오면 시동이 끝날 때까지 붙든다", async () => {
      const world = makeWorld(terminalRow());
      const { task, release } = await startStarting(world);
      expect(phaseOf(task)).toBe("starting");
      expectDefinition("starting", "intervene", "hold_until_started");

      const second = track(intervene(world, "둘째 지시"));
      await flush();
      expect(second.settled).toBe(false);
      release();
      await flush();
      expect(second.settled).toBe(true);
      expect(second.value).not.toEqual({ autoResumed: true });
      expect(task.interventionQueue.map((message) => message.text)).toEqual(["첫 지시", "둘째 지시"]);
    });

    it("시동 중인 task를 지우면 바로 줄을 지운다", async () => {
      const world = makeWorld(terminalRow());
      const { task, release } = await startStarting(world);
      expect(phaseOf(task)).toBe("starting");
      expectDefinition("starting", "delete", "delete_row");

      await expect(deleteTask(world)).resolves.toBe(true);
      expect(world.deleteSession).toHaveBeenCalledOnce();
      expect(world.terminalReasons()).toEqual([]);
      release();
    });

    it("시동 중에 재개가 오면 그 시동에 붙는다", async () => {
      const world = makeWorld(terminalRow());
      const { task, release } = await startStarting(world);
      expect(phaseOf(task)).toBe("starting");
      expectDefinition("starting", "resume", "join_start");

      const joined = track(resume(world));
      await flush();
      expect(joined.settled).toBe(false);
      release();
      await flush();
      expect(joined.value).toMatchObject({
        state: "already_running",
        execution: { registrationId: "registration-start" },
      });
    });
  });

  describe("실행 등록 응답을 기다리는 중", () => {
    it("등록 응답을 기다리는 중에 멈춤이 오면 멈춤 하나로 닫힌다", async () => {
      for (const runnerAlive of [true, false]) {
        const frames = deferred();
        const runner = fakeRunner({
          frames: frames.promise,
          interrupt: runnerAlive
            ? async () => true
            : async () => { throw new Error("runner process is unavailable"); },
        });
        const world = makeWorld(sessionRow(), { runner });
        const { task, registration } = await startRegistering(world);
        expect(phaseOf(task)).toBe("registering");
        expectDefinition("registering", "stop", "interrupt_and_terminate");
        // 통로 하나는 보낸 순서로 응답한다. 등록을 먼저 보냈으므로 등록 응답이 먼저 닿는다.
        const terminal = world.holdNextTerminalAnswer();

        const stopped = track(stopTask(world));
        await flush();
        expect(runner.interrupt).toHaveBeenCalledOnce();
        registration.resolve();
        await flush();
        terminal.resolve();
        frames.resolve();
        await flush();

        expect(stopped.value).toBe(runnerAlive);
        expectOneTerminal(world, runnerAlive ? "killed" : "error_aborted");
        expect(task.status).toBe(runnerAlive ? "interrupted" : "error");
        expect(task.runner).toBeUndefined();
      }
    });

    it("등록 응답을 기다리는 중에 지시가 오면 등록이 끝날 때까지 붙든다", async () => {
      const frames = deferred();
      const runner = fakeRunner({ frames: frames.promise });
      const world = makeWorld(sessionRow(), { runner });
      const { task, registration } = await startRegistering(world);
      expect(phaseOf(task)).toBe("registering");
      expectDefinition("registering", "intervene", "hold_until_started");

      const held = track(intervene(world));
      await flush();
      expect(held.settled).toBe(false);
      registration.resolve();
      await flush();
      expect(held.value).toEqual({ delivered: true });
      expect(runner.engine.intervene).toHaveBeenCalledOnce();
      frames.resolve();
    });

    it("등록 응답을 기다리는 중에 지우면 멈춘 뒤 지운다", async () => {
      const frames = deferred();
      const runner = fakeRunner({ frames: frames.promise });
      const world = makeWorld(sessionRow(), { runner });
      const { task, registration } = await startRegistering(world);
      expect(phaseOf(task)).toBe("registering");
      expectDefinition("registering", "delete", "stop_then_delete");
      const terminal = world.holdNextTerminalAnswer();

      const deleted = track(deleteTask(world));
      await flush();
      expect(world.deleteSession).not.toHaveBeenCalled();
      registration.resolve();
      await flush();
      terminal.resolve();
      frames.resolve();
      await flush();

      expect(deleted.value).toBe(true);
      expectOneTerminal(world, "killed");
      expect(world.deleteSession).toHaveBeenCalledOnce();
    });

    it("등록 응답을 기다리는 중에 재개가 오면 그 시동에 붙는다", async () => {
      const frames = deferred();
      const runner = fakeRunner({ frames: frames.promise });
      const world = makeWorld(sessionRow(), { runner });
      const { task, registration } = await startRegistering(world);
      expect(phaseOf(task)).toBe("registering");
      expectDefinition("registering", "resume", "join_start");

      const joined = track(resume(world));
      await flush();
      expect(joined.settled).toBe(false);
      registration.resolve();
      await flush();
      expect(joined.value).toMatchObject({
        state: "already_running",
        execution: { registrationId: REGISTRATION_ID, executionCommandId: "execute-new" },
      });
      expect(world.resumes).toHaveLength(0);
      frames.resolve();
    });
  });

  describe("러너가 턴을 도는 중", () => {
    async function running() {
      const frames = deferred();
      const runner = fakeRunner({ frames: frames.promise });
      const world = makeWorld(sessionRow(), { runner });
      const task = await startRunning(world);
      expect(phaseOf(task)).toBe("running");
      return { world, task, runner, frames };
    }

    it("턴을 도는 중에 멈춤이 오면 러너를 멈추고 멈춤으로 닫는다", async () => {
      const { world, task, runner, frames } = await running();
      expectDefinition("running", "stop", "interrupt_and_terminate");

      await expect(stopTask(world)).resolves.toBe(true);
      frames.resolve();
      await flush();
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
      expect(task.status).toBe("interrupted");
    });

    it("턴을 도는 중에 지시가 오면 엔진에 넘긴다", async () => {
      const { world, task, runner, frames } = await running();
      expectDefinition("running", "intervene", "deliver_or_queue");

      await expect(intervene(world)).resolves.toEqual({ delivered: true });
      expect(runner.engine.intervene).toHaveBeenCalledOnce();
      expect(task.interventionQueue).toEqual([]);
      frames.resolve();
    });

    it("턴을 도는 중에 지우면 멈춘 뒤 지운다", async () => {
      const { world, runner, frames } = await running();
      expectDefinition("running", "delete", "stop_then_delete");

      await expect(deleteTask(world)).resolves.toBe(true);
      frames.resolve();
      await flush();
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
      expect(world.deleteSession).toHaveBeenCalledOnce();
    });

    it("턴을 도는 중에 재개가 오면 새 실행을 시작하지 않는다", async () => {
      const { world, frames } = await running();
      expectDefinition("running", "resume", "reject_runner_attached");

      await expect(resume(world)).resolves.toMatchObject({ state: "already_running" });
      expect(world.resumes).toHaveLength(0);
      frames.resolve();
    });
  });
});
