import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import * as path from "node:path";

import {
  AttachmentError,
  FileNotFoundError,
  inferContentType,
  isPathUnderBase,
} from "./file_manager.js";

export const MAX_SOURCE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface AttachmentSourceFile {
  content: Buffer;
  filename: string;
  content_type: string;
  size: number;
}

export class AttachmentSourceTooLargeError extends AttachmentError {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentSourceTooLargeError";
  }
}

export interface AttachmentSourceReader {
  readSource(input: { path: string }): Promise<AttachmentSourceFile>;
}

/**
 * Reads an arbitrary workspace file so another node can import it as an
 * attachment. The readable set is the union of the node agents' workspace
 * directories: an absolute path must resolve inside one of those roots, and a
 * relative path is resolved under each root until one exists.
 */
export function createAttachmentSourceReader(options: {
  allowedRoots: () => readonly string[];
  maxBytes?: number;
}): AttachmentSourceReader {
  const maxBytes = options.maxBytes ?? MAX_SOURCE_ATTACHMENT_BYTES;

  return {
    async readSource(input) {
      const file = await resolveAllowedPath(options.allowedRoots(), input.path);
      const content = await readCappedRegularFile(file, maxBytes);
      return {
        content,
        filename: path.basename(file),
        content_type: inferContentType(file),
        size: content.byteLength,
      };
    },
  };
}

async function resolveAllowedPath(
  roots: readonly string[],
  requested: string,
): Promise<string> {
  const realRoots = (await Promise.all(roots.map((root) => realpathOrNull(root))))
    .filter((root): root is string => root !== null);

  let file: string;
  if (path.isAbsolute(requested)) {
    file = await realpathOrNotFound(requested);
  } else {
    const candidates = roots.map((root) => path.resolve(root, requested));
    const resolved = await firstExisting(candidates);
    if (resolved === null) throw new FileNotFoundError("파일이 존재하지 않습니다");
    file = resolved;
  }

  if (!realRoots.some((root) => isPathUnderBase(root, file))) {
    throw new AttachmentError("허용된 작업 폴더 밖의 파일입니다");
  }
  return file;
}

async function firstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const resolved = await realpathOrNull(candidate);
    if (resolved !== null) return resolved;
  }
  return null;
}

async function realpathOrNull(target: string): Promise<string | null> {
  return realpath(target).catch(() => null);
}

async function realpathOrNotFound(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileNotFoundError("파일이 존재하지 않습니다");
    }
    throw err;
  }
}

async function readCappedRegularFile(file: string, maxBytes: number): Promise<Buffer> {
  // O_NONBLOCK keeps open() from waiting on a FIFO; fstat then rejects it.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FileNotFoundError("파일이 존재하지 않습니다");
    if (info.size > maxBytes) {
      throw new AttachmentSourceTooLargeError(
        `파일이 너무 큽니다 (${Math.floor(info.size / 1024 / 1024)}MB > ${Math.floor(maxBytes / 1024 / 1024)}MB)`,
      );
    }
    const content = await handle.readFile();
    if (content.byteLength !== info.size) {
      throw new AttachmentError("파일을 읽는 중 크기가 바뀌었습니다");
    }
    return content;
  } finally {
    await handle.close();
  }
}
