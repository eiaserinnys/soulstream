import { describe, expect, it, vi } from "vitest";

import { engineEventFrame } from "../../src/runner/frame_protocol.js";
import { ProcessFrameStream } from "../../src/runner/runner_process_frame_stream.js";

describe("ProcessFrameStream", () => {
  it("wakes a waiting consumer when a frame arrives", async () => {
    const stream = new ProcessFrameStream(vi.fn());
    const iterator = stream[Symbol.asyncIterator]();
    const waiting = iterator.next();
    const frame = engineEventFrame({ type: "debug", message: "awake" });

    expect(stream.push(frame, 1)).toBe(true);

    await expect(waiting).resolves.toEqual({ value: frame, done: false });
  });

  it("acknowledges a sequenced frame only when the consumer advances", async () => {
    const acknowledge = vi.fn(async () => {});
    const stream = new ProcessFrameStream(acknowledge);
    const iterator = stream[Symbol.asyncIterator]();
    const frame = engineEventFrame({ type: "debug", message: "one" });
    stream.push(frame, 7);
    stream.finish();

    await expect(iterator.next()).resolves.toEqual({ value: frame, done: false });
    expect(acknowledge).not.toHaveBeenCalled();

    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(7);
  });

  it("does not acknowledge unsequenced frames", async () => {
    const acknowledge = vi.fn(async () => {});
    const stream = new ProcessFrameStream(acknowledge);
    const iterator = stream[Symbol.asyncIterator]();
    stream.push(engineEventFrame({ type: "debug", message: "legacy" }));
    stream.finish();

    await iterator.next();
    await iterator.next();

    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("rejects duplicate sequence numbers and all frames after termination", () => {
    const stream = new ProcessFrameStream(vi.fn());
    const first = engineEventFrame({ type: "debug", message: "first" });
    const duplicate = engineEventFrame({ type: "debug", message: "duplicate" });

    expect(stream.push(first, 3)).toBe(true);
    expect(stream.push(duplicate, 3)).toBe(false);
    stream.finish();
    expect(stream.push(engineEventFrame({ type: "debug", message: "late" }), 4)).toBe(false);
  });

  it("drains queued frames before a clean finish", async () => {
    const stream = new ProcessFrameStream(vi.fn(async () => {}));
    const frames = [
      engineEventFrame({ type: "debug", message: "one" }),
      engineEventFrame({ type: "debug", message: "two" }),
    ];
    frames.forEach((frame, index) => stream.push(frame, index + 1));
    stream.finish();

    const received = [];
    for await (const frame of stream) received.push(frame);

    expect(received).toEqual(frames);
  });

  it("drains queued frames before surfacing a failure", async () => {
    const stream = new ProcessFrameStream(vi.fn(async () => {}));
    const iterator = stream[Symbol.asyncIterator]();
    const frame = engineEventFrame({ type: "debug", message: "before failure" });
    stream.push(frame, 1);
    stream.fail(new Error("runner disappeared"));

    await expect(iterator.next()).resolves.toEqual({ value: frame, done: false });
    await expect(iterator.next()).rejects.toThrow("runner disappeared");
  });

  it("propagates acknowledgement failure before delivering the next frame", async () => {
    const stream = new ProcessFrameStream(async () => {
      throw new Error("ack failed");
    });
    const iterator = stream[Symbol.asyncIterator]();
    stream.push(engineEventFrame({ type: "debug", message: "one" }), 1);
    stream.push(engineEventFrame({ type: "debug", message: "two" }), 2);

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).rejects.toThrow("ack failed");
  });

  it.skip("불변식 8: 첫 terminal 신호 뒤의 신호가 stream 결과를 뒤집지 않는다", async () => {
    const stream = new ProcessFrameStream(vi.fn());
    const iterator = stream[Symbol.asyncIterator]();

    stream.finish();
    stream.fail(new Error("late failure"));

    // 현재는 late failure가 clean finish를 덮는다. 재설계는 하나의 멱등
    // terminal transition으로 첫 결과를 보존해야 한다.
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it.skip("불변식 5·6: 등록 소멸만으로도 대기 중 iterator가 유한 시간 안에 settle된다", () => {
    // 현재 stream은 finish/fail 호출자만 알고 프로세스·등록 소멸을 관찰하지
    // 못한다. 실행 턴 정본이 생기면 이 자리에 무입력 자력 회수 계약을 붙인다.
  });
});
