import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { parseSseChunk, type SseEnvelope } from "./event_evidence.js";

export class SessionSseCollector {
  readonly envelopes: SseEnvelope[] = [];
  private lastEventId: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
    private readonly outputPath: string,
  ) {}

  async run(sessionId: string, signal: AbortSignal): Promise<void> {
    await mkdir(dirname(this.outputPath), { recursive: true, mode: 0o700 });
    const file = await open(this.outputPath, "a", 0o600);
    try {
      while (!signal.aborted) {
        await this.collectOnce(file, sessionId, signal);
        if (!signal.aborted) await abortableDelay(500, signal);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      await file.close();
    }
  }

  eventTypeCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const envelope of this.envelopes) {
      const type = nestedEventType(envelope.data) ?? envelope.event;
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  }

  hasMcpToolRoundTrip(): boolean {
    let started = false;
    let completed = false;
    for (const envelope of this.envelopes) {
      const event = nestedEvent(envelope.data);
      const rawToolName = event?.toolName ?? event?.tool_name;
      const toolName = typeof rawToolName === "string" ? rawToolName : undefined;
      const isSoulstreamMcp = toolName?.includes("mcp__soulstream")
        || toolName?.includes("mcp/soulstream/");
      if (event?.type === "tool_start" && isSoulstreamMcp) started = true;
      if (event?.type === "tool_result" && isSoulstreamMcp) completed = true;
    }
    return started && completed;
  }

  private async collectOnce(
    file: FileHandle,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.bearerToken}`,
      accept: "text/event-stream",
    };
    if (this.lastEventId) headers["last-event-id"] = this.lastEventId;
    const response = await fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events`,
      { headers, signal },
    );
    if (!response.ok || !response.body) {
      throw new Error(`staging session SSE failed: HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const parsed = parseSseChunk(tail, decoder.decode(result.value, { stream: true }));
      tail = parsed.tail;
      for (const envelope of parsed.frames) {
        this.envelopes.push(envelope);
        if (envelope.id) this.lastEventId = envelope.id;
        await file.appendFile(`${JSON.stringify({
          collectedAt: new Date().toISOString(),
          ...envelope,
        })}\n`);
      }
    }
  }
}

function nestedEvent(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const event = record.event;
  if (event && typeof event === "object" && !Array.isArray(event)) {
    return event as Record<string, unknown>;
  }
  return record;
}

function nestedEventType(data: unknown): string | undefined {
  const event = nestedEvent(data);
  return typeof event?.type === "string" ? event.type : undefined;
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("SSE collection aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
