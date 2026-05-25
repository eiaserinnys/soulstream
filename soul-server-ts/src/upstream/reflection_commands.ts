import type { McpRuntime } from "../mcp/runtime.js";
import { buildBriefSnapshot } from "../mcp/reflection/self_reflection.js";

export class ReflectionCommandError extends Error {}

export interface ReflectBriefCommandParams {
  requestId: string;
}

export interface ReflectBriefCommandResponse {
  type: "reflect_brief";
  requestId: string;
  ok: true;
  checked_at: string;
  brief: unknown;
}

export class ReflectionCommands {
  constructor(private readonly runtime?: McpRuntime) {}

  async reflectBrief(
    params: ReflectBriefCommandParams,
  ): Promise<ReflectBriefCommandResponse> {
    if (!this.runtime) {
      throw new ReflectionCommandError("reflection runtime is not configured");
    }
    return {
      type: "reflect_brief",
      requestId: params.requestId,
      ok: true,
      checked_at: new Date().toISOString(),
      brief: await buildBriefSnapshot(this.runtime),
    };
  }
}
