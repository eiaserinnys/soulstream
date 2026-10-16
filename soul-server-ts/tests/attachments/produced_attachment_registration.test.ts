import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { open, mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createProducedAttachmentRegistration,
  type ProducedAttachmentExecution,
} from "../../src/attachments/produced_attachment_registration.js";
import { makeTempDir } from "../helpers/temp_dir.js";

const SESSION = "sess-mine";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Layout = { root: string; workspace: string; profile: string; incoming: string; mine: string };

async function makeLayout(): Promise<Layout> {
  const root = await makeTempDir("produced-attachment-");
  const layout = {
    root,
    workspace: join(root, "workspace"),
    profile: join(root, "profile"),
    incoming: join(root, "incoming"),
    mine: join(root, "incoming", SESSION),
  };
  await mkdir(layout.workspace, { recursive: true });
  await mkdir(layout.profile, { recursive: true });
  await mkdir(layout.mine, { recursive: true });
  return layout;
}

function executionFor(layout: Layout, overrides: Partial<ProducedAttachmentExecution> = {}): ProducedAttachmentExecution {
  return {
    sessionId: SESSION,
    nodeId: "node-a",
    outputCommandId: "cmd-1",
    workspaceDir: layout.workspace,
    profileWorkspaceDir: layout.profile,
    ...overrides,
  };
}

function fakeFetch(respond?: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (respond) return respond(String(url), init ?? {});
    const parsed = new URL(String(url));
    const body = init?.body as Uint8Array;
    return Response.json({
      attachment_id: "att-1",
      descriptor: {
        attachment_id: "att-1",
        name: parsed.searchParams.get("name"),
        mime_type: parsed.searchParams.get("mime_type"),
        byte_size: body.byteLength,
        checksum_sha256: parsed.searchParams.get("checksum_sha256"),
        width: null,
        height: null,
        preview_kind: "info",
        preview_mime_type: null,
      },
    });
  });
}

function makeRegistration(layout: Layout, fetchImpl = fakeFetch()) {
  const registration = createProducedAttachmentRegistration({
    incomingDir: layout.incoming,
    orch: { baseUrl: "http://orch.test", headers: { authorization: "Bearer service-token" } },
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
  return { registration, fetchImpl };
}

describe("createProducedAttachmentRegistration", () => {
  it("resolves a relative path against the workspace and sends original bytes with identity headers", async () => {
    const layout = await makeLayout();
    const bytes = Buffer.from("report body\n");
    await mkdir(join(layout.workspace, "out"));
    await writeFile(join(layout.workspace, "out", "report.md"), bytes);
    const { registration, fetchImpl } = makeRegistration(layout);

    const result = await registration.register({ local_path: "out/report.md" }, executionFor(layout));

    expect(result.attachment_id).toBe("att-1");
    expect(result.descriptor.byte_size).toBe(bytes.byteLength);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(`${parsed.origin}${parsed.pathname}`).toBe("http://orch.test/api/attachments/agent-register");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      name: "report.md",
      mime_type: "text/markdown",
      byte_size: String(bytes.byteLength),
      checksum_sha256: sha256(bytes),
    });
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      authorization: "Bearer service-token",
      "content-type": "application/octet-stream",
      "x-soulstream-agent-session-id": SESSION,
      "x-soulstream-node-id": "node-a",
      "x-soulstream-output-command-id": "cmd-1",
    });
    expect(Buffer.from(init?.body as Uint8Array).equals(bytes)).toBe(true);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(url)).not.toContain(layout.workspace);
  });

  it("allows the workspace, the profile workspace, scratch under the workspace and its own incoming", async () => {
    const layout = await makeLayout();
    await mkdir(join(layout.workspace, ".local"));
    const files = [
      join(layout.workspace, "a.txt"),
      join(layout.profile, "b.txt"),
      join(layout.workspace, ".local", "scratch.txt"),
      join(layout.mine, "c.txt"),
    ];
    for (const file of files) await writeFile(file, "x");
    const { registration, fetchImpl } = makeRegistration(layout);

    for (const file of files) {
      await expect(registration.register({ local_path: file }, executionFor(layout))).resolves.toMatchObject({
        attachment_id: "att-1",
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(files.length);
  });

  it("allows a symlink inside the workspace that points to another file inside it", async () => {
    const layout = await makeLayout();
    await writeFile(join(layout.workspace, "real.txt"), "inside");
    await symlink(join(layout.workspace, "real.txt"), join(layout.workspace, "link.txt"));
    const { registration, fetchImpl } = makeRegistration(layout);

    await registration.register({ local_path: "link.txt" }, executionFor(layout));

    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get("name")).toBe("real.txt");
  });

  it("denies another session's incoming file even when the workspace is its ancestor", async () => {
    const layout = await makeLayout();
    const otherDir = join(layout.incoming, "sess-other");
    await mkdir(otherDir);
    await writeFile(join(otherDir, "secret.txt"), "secret");
    const { registration, fetchImpl } = makeRegistration(layout);

    await expect(
      registration.register({ local_path: join(otherDir, "secret.txt") }, executionFor(layout, { workspaceDir: layout.root })),
    ).rejects.toMatchObject({ code: "ATTACHMENT_PATH_DENIED", statusCode: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("denies a symlink that escapes the workspace and a path outside every root", async () => {
    const layout = await makeLayout();
    const outside = join(layout.root, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(layout.workspace, "escape.txt"));
    const { registration, fetchImpl } = makeRegistration(layout);

    await expect(registration.register({ local_path: "escape.txt" }, executionFor(layout))).rejects.toMatchObject({
      code: "ATTACHMENT_PATH_DENIED",
    });
    await expect(registration.register({ local_path: outside }, executionFor(layout))).rejects.toMatchObject({
      code: "ATTACHMENT_PATH_DENIED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a missing file as not found", async () => {
    const layout = await makeLayout();
    const { registration, fetchImpl } = makeRegistration(layout);

    await expect(registration.register({ local_path: "missing.txt" }, executionFor(layout))).rejects.toMatchObject({
      code: "ATTACHMENT_FILE_NOT_FOUND",
      statusCode: 404,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a directory and a FIFO as not regular files", async () => {
    const layout = await makeLayout();
    await mkdir(join(layout.workspace, "dir"));
    const { registration, fetchImpl } = makeRegistration(layout);

    await expect(registration.register({ local_path: "dir" }, executionFor(layout))).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_REGULAR_FILE",
      statusCode: 422,
    });
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [join(layout.workspace, "pipe")]);
      await expect(registration.register({ local_path: "pipe" }, executionFor(layout))).rejects.toMatchObject({
        code: "ATTACHMENT_NOT_REGULAR_FILE",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a zero-byte file, a Korean name and an unknown extension as opaque bytes", async () => {
    const layout = await makeLayout();
    await writeFile(join(layout.workspace, "보고서.weird"), "");
    const { registration, fetchImpl } = makeRegistration(layout);

    const result = await registration.register({ local_path: "보고서.weird" }, executionFor(layout));

    const parsed = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(parsed.searchParams.get("name")).toBe("보고서.weird");
    expect(parsed.searchParams.get("mime_type")).toBe("application/octet-stream");
    expect(parsed.searchParams.get("byte_size")).toBe("0");
    expect(parsed.searchParams.get("checksum_sha256")).toBe(sha256(new Uint8Array()));
    expect(result.descriptor.byte_size).toBe(0);
  });

  it("uses explicit name, mime_type and card target when given and rejects path-like names", async () => {
    const layout = await makeLayout();
    await writeFile(join(layout.workspace, "raw.bin"), "abc");
    const { registration, fetchImpl } = makeRegistration(layout);

    await registration.register(
      { local_path: "raw.bin", name: "증거 1.bin", mime_type: "application/x-custom", target_scope: { type: "card", id: "card-9" } },
      executionFor(layout),
    );

    const parsed = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(parsed.searchParams.get("name")).toBe("증거 1.bin");
    expect(parsed.searchParams.get("mime_type")).toBe("application/x-custom");
    expect(parsed.searchParams.get("card_id")).toBe("card-9");

    for (const name of ["a/b", "a\\b", "a\nb", "a\rb", "a\0b", ".."]) {
      await expect(registration.register({ local_path: "raw.bin", name }, executionFor(layout))).rejects.toMatchObject({
        code: "ATTACHMENT_INVALID_NAME",
        statusCode: 422,
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a file over 100 MiB from fstat alone, without reading or sending", async () => {
    const layout = await makeLayout();
    const big = join(layout.workspace, "big.bin");
    await writeFile(big, "");
    await truncate(big, 100 * 1024 * 1024 + 1);
    const probe = await open(big, "r");
    const readFile = vi.spyOn(Object.getPrototypeOf(probe), "readFile");
    await probe.close();
    const { registration, fetchImpl } = makeRegistration(layout);

    await expect(registration.register({ local_path: "big.bin" }, executionFor(layout))).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
      statusCode: 413,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    readFile.mockRestore();
  });

  it("preserves the central error code and never reports success when central rejects", async () => {
    const layout = await makeLayout();
    await writeFile(join(layout.workspace, "a.txt"), "x");
    const { registration } = makeRegistration(
      layout,
      fakeFetch(() => Response.json({ code: "ATTACHMENT_PRODUCER_FORBIDDEN", detail: "카드 소속이 아닙니다." }, { status: 403 })),
    );

    const error = await registration.register({ local_path: "a.txt" }, executionFor(layout)).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "ATTACHMENT_PRODUCER_FORBIDDEN", statusCode: 403 });
    expect((error as Error).message).toContain("카드 소속이 아닙니다.");
    expect((error as Error).message).not.toContain("service-token");
  });

  it("maps an unreachable central and a mismatching success response to unavailable", async () => {
    const layout = await makeLayout();
    await writeFile(join(layout.workspace, "a.txt"), "x");
    const unreachable = makeRegistration(layout, fakeFetch(() => Promise.reject(new TypeError("fetch failed"))));
    const mismatched = makeRegistration(
      layout,
      fakeFetch(() =>
        Response.json({ attachment_id: "att-1", descriptor: { attachment_id: "att-2", byte_size: 1, checksum_sha256: sha256(Buffer.from("x")) } }),
      ),
    );

    await expect(unreachable.registration.register({ local_path: "a.txt" }, executionFor(layout))).rejects.toMatchObject({
      code: "ATTACHMENT_REGISTRATION_UNAVAILABLE",
      statusCode: 503,
    });
    await expect(mismatched.registration.register({ local_path: "a.txt" }, executionFor(layout))).rejects.toMatchObject({
      code: "ATTACHMENT_REGISTRATION_UNAVAILABLE",
    });
  });

  it("cancels the central request when the caller aborts", async () => {
    const layout = await makeLayout();
    await writeFile(join(layout.workspace, "a.txt"), "x");
    const { registration } = makeRegistration(
      layout,
      fakeFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const controller = new AbortController();

    const pending = registration.register({ local_path: "a.txt" }, executionFor(layout), controller.signal);
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ code: "ATTACHMENT_REGISTRATION_UNAVAILABLE" });
  });
});
