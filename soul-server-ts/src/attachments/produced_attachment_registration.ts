import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import * as path from "node:path";

import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";

import type { OrchProxyConfig } from "../mcp/runtime.js";
import { inferContentType, isPathUnderBase } from "./file_manager.js";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const REGISTER_PATH = "/api/attachments/agent-register";
const REQUEST_TIMEOUT_MS = 300_000;
const UNAVAILABLE = "ATTACHMENT_REGISTRATION_UNAVAILABLE";

export type RegisterProducedAttachmentInput = {
  local_path: string;
  name?: string;
  mime_type?: string;
  target_scope?: { type: "card"; id: string };
};

export type ProducedAttachmentExecution = {
  sessionId: string;
  nodeId: string;
  outputCommandId: string;
  workspaceDir: string;
  profileWorkspaceDir?: string;
};

export class ProducedAttachmentError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "ProducedAttachmentError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createProducedAttachmentRegistration(options: {
  incomingDir: string;
  orch: OrchProxyConfig;
  fetch: typeof globalThis.fetch;
}): {
  register(
    input: RegisterProducedAttachmentInput,
    execution: ProducedAttachmentExecution,
    signal?: AbortSignal,
  ): Promise<{ attachment_id: string; descriptor: AttachmentDescriptor }>;
} {
  const incomingRoot = path.resolve(options.incomingDir);

  async function register(
    input: RegisterProducedAttachmentInput,
    execution: ProducedAttachmentExecution,
    signal?: AbortSignal,
  ): Promise<{ attachment_id: string; descriptor: AttachmentDescriptor }> {
    const target = await resolveAllowedFile(incomingRoot, input.local_path, execution);
    const name = input.name ?? path.basename(target);
    if (!isValidName(name)) {
      throw new ProducedAttachmentError("ATTACHMENT_INVALID_NAME", 422, "첨부 이름이 올바르지 않습니다.");
    }
    const bytes = await readRegularFile(target);
    const checksum = createHash("sha256").update(bytes).digest("hex");

    const query = new URLSearchParams({
      name,
      mime_type: input.mime_type ?? inferContentType(name),
      byte_size: String(bytes.byteLength),
      checksum_sha256: checksum,
    });
    if (input.target_scope) query.set("card_id", input.target_scope.id);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await options.fetch(`${options.orch.baseUrl}${REGISTER_PATH}?${query}`, {
        method: "POST",
        headers: {
          ...options.orch.headers,
          "content-type": "application/octet-stream",
          "x-soulstream-agent-session-id": execution.sessionId,
          "x-soulstream-node-id": execution.nodeId,
          "x-soulstream-output-command-id": execution.outputCommandId,
        },
        body: bytes,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch {
      throw new ProducedAttachmentError(UNAVAILABLE, 503, "중앙 첨부 등록 서비스에 연결하지 못했습니다.");
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = (payload ?? {}) as { code?: unknown; detail?: unknown };
      throw new ProducedAttachmentError(
        typeof failure.code === "string" ? failure.code : UNAVAILABLE,
        response.status,
        typeof failure.detail === "string" ? failure.detail : `중앙 첨부 등록이 실패했습니다 (HTTP ${response.status}).`,
      );
    }

    const result = payload as { attachment_id?: unknown; descriptor?: AttachmentDescriptor } | null;
    if (
      typeof result?.attachment_id !== "string" ||
      result.descriptor?.attachment_id !== result.attachment_id ||
      result.descriptor.byte_size !== bytes.byteLength ||
      result.descriptor.checksum_sha256 !== checksum
    ) {
      throw new ProducedAttachmentError(UNAVAILABLE, 503, "중앙 첨부 등록 응답이 요청과 일치하지 않습니다.");
    }
    return { attachment_id: result.attachment_id, descriptor: result.descriptor };
  }

  return { register };
}

async function resolveAllowedFile(
  incomingRoot: string,
  localPath: string,
  execution: ProducedAttachmentExecution,
): Promise<string> {
  let file: string;
  try {
    file = await realpath(path.resolve(execution.workspaceDir, localPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProducedAttachmentError("ATTACHMENT_FILE_NOT_FOUND", 404, "첨부할 파일을 찾을 수 없습니다.");
    }
    throw error;
  }

  const [incomingReal, ownIncoming, workspace, profile] = await Promise.all([
    realpathOrNull(incomingRoot),
    realpathOrNull(path.join(incomingRoot, execution.sessionId)),
    realpathOrNull(execution.workspaceDir),
    realpathOrNull(execution.profileWorkspaceDir),
  ]);
  const inOwnIncoming = ownIncoming !== null && isPathUnderBase(ownIncoming, file);
  const denied =
    (incomingReal !== null && isPathUnderBase(incomingReal, file) && !inOwnIncoming) ||
    ![workspace, profile, ownIncoming].some((root) => root !== null && isPathUnderBase(root, file));
  if (denied) {
    throw new ProducedAttachmentError("ATTACHMENT_PATH_DENIED", 403, "허용된 작업 폴더 밖의 파일은 첨부할 수 없습니다.");
  }
  return file;
}

// A root that cannot be resolved is simply not an allowed root.
async function realpathOrNull(root: string | undefined): Promise<string | null> {
  return root === undefined ? null : realpath(root).catch(() => null);
}

async function readRegularFile(file: string): Promise<Buffer> {
  // O_NONBLOCK keeps open() from waiting on a FIFO; fstat then rejects it.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new ProducedAttachmentError("ATTACHMENT_NOT_REGULAR_FILE", 422, "일반 파일만 첨부할 수 있습니다.");
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new ProducedAttachmentError("ATTACHMENT_TOO_LARGE", 413, "첨부 파일은 100MiB 이하여야 합니다.");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== info.size) {
      throw new ProducedAttachmentError("ATTACHMENT_SIZE_MISMATCH", 422, "파일을 읽는 중 크기가 바뀌었습니다.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function isValidName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\r\n\0]/.test(name);
}
