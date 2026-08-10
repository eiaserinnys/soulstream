import type { RunnerEventFrame } from "./frame_protocol.js";

interface QueuedFrame {
  frame: RunnerEventFrame;
  frameSeq?: number;
}

export class ProcessFrameStream implements AsyncIterable<RunnerEventFrame> {
  private readonly queue: QueuedFrame[] = [];
  private readonly seenFrameSeq = new Set<number>();
  private waiter: (() => void) | undefined;
  private delivered: QueuedFrame | undefined;
  private ended = false;
  private error: Error | undefined;

  constructor(private readonly acknowledge: (frameSeq: number) => Promise<void>) {}

  push(frame: RunnerEventFrame, frameSeq?: number): boolean {
    if (this.ended || this.error) return false;
    if (frameSeq !== undefined && this.seenFrameSeq.has(frameSeq)) return false;
    if (frameSeq !== undefined) this.seenFrameSeq.add(frameSeq);
    this.queue.push({ frame, ...(frameSeq !== undefined ? { frameSeq } : {}) });
    this.waiter?.();
    this.waiter = undefined;
    return true;
  }

  finish(): void {
    this.ended = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  fail(error: Error): void {
    this.error = error;
    this.waiter?.();
    this.waiter = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunnerEventFrame> {
    while (true) {
      if (this.delivered?.frameSeq !== undefined) {
        await this.acknowledge(this.delivered.frameSeq);
      }
      this.delivered = undefined;
      const next = this.queue.shift();
      if (next) {
        this.delivered = next;
        yield next.frame;
        continue;
      }
      if (this.error) throw this.error;
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
  }
}
