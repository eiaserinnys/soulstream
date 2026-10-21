import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeSweeper } from "../src/worktree/worktree_sweeper.js";

afterEach(() => vi.useRealTimers());
describe("WorktreeSweeper timer", () => {
  it("starts after 10 minutes, repeats hourly, skips overlap and stops", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const sweep = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const worker = new WorktreeSweeper({ sweep, logger });
    worker.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    finish(); await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    finish(); worker.stop();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("logs an unsuccessful run and allows the next scheduled run", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn().mockRejectedValueOnce(new Error("host unavailable")).mockResolvedValue({ candidates: 0 });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const worker = new WorktreeSweeper({ sweep, logger }); worker.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(logger.warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith({ candidates: 0 }, "Worktree sweep finished");
    worker.stop();
  });
});
