import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  buildCodexAppServerArgs,
  createStdioAppServerTransport,
} from "../../../src/engine/codex_app_server/stdio_transport.js";
import type { AppServerJsonMessage } from "../../../src/engine/codex_app_server/transport.js";

class MockChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 1234;
  public killed = false;
  public killSignals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignals.push(String(signal ?? "SIGTERM"));
    return true;
  }
}

function createLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      debug: () => {},
      info: (_obj: unknown, msg?: string) => lines.push(`info:${msg ?? ""}`),
      warn: (_obj: unknown, msg?: string) => lines.push(`warn:${msg ?? ""}`),
      error: (_obj: unknown, msg?: string) => lines.push(`error:${msg ?? ""}`),
    },
  };
}

describe("stdio app-server transport", () => {
  it("builds stdio args by default and leaves unix URL as explicit extension", () => {
    expect(buildCodexAppServerArgs()).toEqual([
      "app-server",
      "--listen",
      "stdio://",
    ]);
    expect(buildCodexAppServerArgs("unix:///tmp/codex.sock")).toEqual([
      "app-server",
      "--listen",
      "unix:///tmp/codex.sock",
    ]);
  });

  it("spawns codex app-server and writes newline framed JSON", async () => {
    const child = new MockChildProcess();
    const writes: string[] = [];
    child.stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")));

    const transport = createStdioAppServerTransport({
      spawnProcess: (command, args) => {
        expect(command).toBe("codex");
        expect(args).toEqual(["app-server", "--listen", "stdio://"]);
        return child;
      },
    });

    await transport.send({ id: "req-1", method: "initialize", params: {} });

    expect(writes).toEqual([
      JSON.stringify({ id: "req-1", method: "initialize", params: {} }) + "\n",
    ]);
  });

  it("parses stdout newline framed JSON across chunk boundaries", () => {
    const child = new MockChildProcess();
    const messages: AppServerJsonMessage[] = [];
    const transport = createStdioAppServerTransport({
      spawnProcess: () => child,
    });
    transport.onMessage((message) => messages.push(message));

    child.stdout.write('{"id":"req-1",');
    child.stdout.write('"result":{"ok":true}}\n{"method":"turn/started","params":{}}\n');

    expect(messages).toEqual([
      { id: "req-1", result: { ok: true } },
      { method: "turn/started", params: {} },
    ]);
  });

  it("reports malformed stdout lines without closing the stream", () => {
    const child = new MockChildProcess();
    const errors: string[] = [];
    const messages: AppServerJsonMessage[] = [];
    const transport = createStdioAppServerTransport({
      spawnProcess: () => child,
    });
    transport.onError((error) => errors.push(error.message));
    transport.onMessage((message) => messages.push(message));

    child.stdout.write("{not-json}\n");
    child.stdout.write('{"id":"req-2","result":{"ok":true}}\n');

    expect(errors[0]).toContain("Malformed Codex app-server JSON");
    expect(messages).toEqual([{ id: "req-2", result: { ok: true } }]);
  });

  it("logs stderr by line", () => {
    const child = new MockChildProcess();
    const { logger, lines } = createLogger();
    createStdioAppServerTransport({
      spawnProcess: () => child,
      logger,
    });

    child.stderr.write("first warning\npartial");
    child.stderr.write(" warning\n");

    expect(lines).toEqual([
      "warn:Codex app-server stderr",
      "warn:Codex app-server stderr",
    ]);
  });

  it("notifies close listeners on process exit and close kills the child", async () => {
    const child = new MockChildProcess();
    const closeErrors: Array<string | undefined> = [];
    const transport = createStdioAppServerTransport({
      spawnProcess: () => child,
      closeGraceMs: 10,
    });
    transport.onClose((error) => closeErrors.push(error?.message));

    const closePromise = transport.close();
    expect(child.killed).toBe(true);
    expect(child.killSignals[0]).toBe("SIGTERM");

    child.emit("exit", 0, null);
    await closePromise;

    expect(closeErrors).toEqual([undefined]);
  });

  it("reports non-zero process exit as close error", () => {
    const child = new MockChildProcess();
    const closeErrors: Array<string | undefined> = [];
    const transport = createStdioAppServerTransport({
      spawnProcess: () => child,
    });
    transport.onClose((error) => closeErrors.push(error?.message));

    child.emit("exit", 2, null);

    expect(closeErrors).toEqual([
      "Codex app-server exited with code 2",
    ]);
  });
});
