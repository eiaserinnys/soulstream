import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveCentralTemplate } from "./templates.js";

type Server = { id: string; name: string; type: "stdio" | "sse" | "streamable_http"; config: Record<string, unknown> };
type Stage = "config" | "connect" | "initialize" | "list_tools" | "timeout";

export async function testMcpServer(server: Server, env: Record<string, string | undefined>, timeoutMs = 10_000) {
  const start = Date.now();
  let stage: Stage = "config";
  let transport: Transport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const client = new Client({ name: "soulstream-mcp-test", version: "1" });
  try {
    const config = server.config;
    const resolve = (value: unknown): string => {
      if (typeof value === "object" && value !== null && "env" in value && typeof value.env === "string") {
        const result = env[value.env];
        if (!result) throw new Error("Missing environment variable");
        return result;
      }
      if (typeof value !== "string") throw new Error("Invalid configuration value");
      return resolveCentralTemplate(value, env, "MCP configuration");
    };
    const record = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).map(([k, v]) => [k, resolve(v)]));
    if (server.type === "stdio") {
      const fullCommand = typeof config.full_command === "string" ? config.full_command.split(" ") : undefined;
      const command = fullCommand ? fullCommand.shift() : resolve(config.command);
      if (!command) throw new Error("Invalid command");
      transport = new StdioClientTransport({ command, args: fullCommand ?? (Array.isArray(config.args) ? config.args.map(resolve) : []),
        env: { ...getDefaultEnvironment(), ...record(config.env) }, stderr: "ignore",
        ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}) });
    } else {
      const url = new URL(resolve(config.url));
      const options = { requestInit: { headers: record(config.headers) } };
      transport = server.type === "sse" ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
    }
    const run = async () => {
      stage = "connect";
      const startTransport = transport!.start.bind(transport);
      transport!.start = async () => {
        await startTransport();
        if (server.type !== "streamable_http") stage = "initialize";
        const onmessage = transport!.onmessage;
        transport!.onmessage = (message, extra) => {
          if (stage === "connect") stage = "initialize";
          onmessage?.(message, extra);
        };
      };
      await client.connect(transport!);
      stage = "list_tools";
      let cursor: string | undefined;
      let count = 0;
      const tools: string[] = [];
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        count += result.tools.length;
        tools.push(...result.tools.slice(0, Math.max(0, 100 - tools.length)).map(tool => tool.name));
        cursor = result.nextCursor;
      } while (cursor);
      const info = client.getServerVersion();
      return { ok: true as const, latency_ms: Date.now() - start, ...(info ? { server_info: { name: info.name, version: info.version } } : {}),
        tool_count: count, tools };
    };
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stage = "timeout"; reject(new Error("timeout")); }, Math.min(timeoutMs, 13_000));
    })]);
  } catch {
    return { ok: false as const, latency_ms: Date.now() - start, error_stage: stage, error_message: `MCP ${stage} failed` };
  } finally {
    if (timer) clearTimeout(timer);
    if (stage === "timeout" && transport instanceof StdioClientTransport && transport.pid !== null) {
      try { process.kill(transport.pid, "SIGKILL"); } catch { /* process already exited */ }
    }
    await transport?.close().catch(() => {});
  }
}
