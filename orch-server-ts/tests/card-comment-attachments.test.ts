import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import { createCardCommentAttachmentUploader } from "../src/cards/card_comment_attachment_upload.js";
import type { AttachmentCommitRepository } from "../src/attachments/attachment_commit_contract.js";
import type { AttachmentRouteOptions } from "../src/attachments/attachment_routes.js";
import type { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import type {
  CardCommentAttachmentUploadInput,
  FolderRouteOptions,
} from "../src/folders/folder_routes.js";
import type { FastifyRequest } from "fastify";

type Uploader = NonNullable<FolderRouteOptions["uploadCardCommentAttachment"]>;

function fakeCardService(card: Record<string, unknown> = {}, sessions: Array<Record<string, unknown>> = []) {
  const addComment = vi.fn(async (input: Record<string, unknown>) => ({
    id: "comment-1",
    card_id: input.cardId,
    author_kind: input.actorKind,
    author_id: input.actorUserId ?? null,
    session_id: input.actorSessionId ?? null,
    kind: input.kind ?? "comment",
    mode: input.mode ?? null,
    body: input.body,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    delivered_at: null,
    attachment_refs: [],
  }));
  const getCard = vi.fn(async (cardId: string) => cardId === "card-1" ? {
    card: {
      id: "card-1",
      folder_id: "folder-1",
      node_id: "node-1",
      assignee_session_id: "session-1",
      ...card,
    },
    sessions,
    comments: [],
    reports: [],
    questions: [],
    items: [],
  } : null);
  return {
    service: { addComment, getCard } as unknown as CardControlPlaneService,
    addComment,
    getCard,
  };
}

function routeOptions(
  service: CardControlPlaneService,
  upload?: Uploader,
): FolderRouteOptions {
  return {
    provider: { listFolders: () => [{ id: "folder-1" }], listSessionAssignments: () => ({}) },
    accessProvider: { resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }) },
    resolveDashboardUserId: () => "director@example.com",
    cardServiceProvider: async () => service,
    nodeCredentials: null,
    ...(upload === undefined ? {} : { uploadCardCommentAttachment: upload }),
  } as unknown as FolderRouteOptions;
}

const uploaderUrl = "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fsession-1%2Ffile";

function fakeUploader(calls: CardCommentAttachmentUploadInput[]): Uploader {
  return async (_request, input) => {
    calls.push(input);
    return { url: uploaderUrl, name: input.file.name, mime: input.file.mime };
  };
}

async function postComment(upload: Uploader | undefined, payload: Record<string, unknown>,
  service: CardControlPlaneService = fakeCardService().service) {
  const server = Fastify();
  registerCardRoutes(server, routeOptions(service, upload));
  try {
    return await server.inject({ method: "POST", url: "/api/cards/card-1/comments", payload });
  } finally {
    await server.close();
  }
}

describe("POST /api/cards/:id/comments attachments", () => {
  it("텍스트와 이미지 첨부를 업로드해 본문 마크다운 이미지로 합친다", async () => {
    const calls: CardCommentAttachmentUploadInput[] = [];
    const { service, addComment } = fakeCardService();
    const response = await postComment(fakeUploader(calls), {
      body: " 확인 부탁합니다 ",
      idempotencyKey: "comment-key-1",
      kind: "comment",
      attachments: [{ name: "screen.png", mime: "image/png", data_base64: "aGk=" }],
    }, service);

    expect(response.statusCode).toBe(201);
    expect(addComment).toHaveBeenCalledOnce();
    expect(addComment.mock.calls[0]![0]).toMatchObject({
      actorKind: "user",
      actorUserId: "director@example.com",
      cardId: "card-1",
      idempotencyKey: "comment-key-1",
      kind: "comment",
      body: `확인 부탁합니다\n\n![screen.png](${uploaderUrl})`,
    });
    expect(addComment.mock.calls[0]![0]).not.toHaveProperty("attachments");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cardId: "card-1",
      folderId: "folder-1",
      nodeId: "node-1",
      sessionId: "session-1",
      file: { name: "screen.png", mime: "image/png", data_base64: "aGk=" },
    });
    expect(calls[0]!.uploadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("같은 idempotencyKey의 재전송은 같은 업로드 식별자를 쓴다", async () => {
    const calls: CardCommentAttachmentUploadInput[] = [];
    const upload = fakeUploader(calls);
    const payload = {
      body: "재전송",
      idempotencyKey: "comment-key-2",
      attachments: [{ name: "same.png", mime: "image/png", data_base64: "aGk=" }],
    };
    await postComment(upload, payload);
    await postComment(upload, payload);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.uploadId).toBe(calls[1]!.uploadId);
  });

  it("본문 없이 이미지 첨부만 보내도 커멘트를 만든다", async () => {
    for (const body of [undefined, ""]) {
      const calls: CardCommentAttachmentUploadInput[] = [];
      const { service, addComment } = fakeCardService();
      const response = await postComment(fakeUploader(calls), {
        ...(body === undefined ? {} : { body }),
        idempotencyKey: `comment-key-image-${body === undefined ? "omitted" : "empty"}`,
        attachments: [{ name: "photo.png", mime: "image/png", data_base64: "aGk=" }],
      }, service);

      expect(response.statusCode).toBe(201);
      expect(addComment.mock.calls[0]![0]).toMatchObject({
        body: `![photo.png](${uploaderUrl})`,
      });
    }
  });

  it("일반 파일 첨부는 이미지가 아닌 일반 링크로 합친다", async () => {
    const calls: CardCommentAttachmentUploadInput[] = [];
    const { service, addComment } = fakeCardService();
    const response = await postComment(fakeUploader(calls), {
      body: "자료 확인",
      idempotencyKey: "comment-key-3",
      attachments: [{ name: "보고서 최종.pdf", mime: "application/pdf", data_base64: "aGk=" }],
    }, service);

    expect(response.statusCode).toBe(201);
    expect(addComment.mock.calls[0]![0]).toMatchObject({
      body: `자료 확인\n\n[보고서 최종.pdf](${uploaderUrl})`,
    });
  });

  it("첨부 이름의 대괄호와 줄바꿈은 링크를 깨지 않도록 치환한다", async () => {
    const { service, addComment } = fakeCardService();
    const response = await postComment(fakeUploader([]), {
      body: "특수 문자",
      idempotencyKey: "comment-key-4",
      attachments: [{ name: "a[b]\nc.png", mime: "image/png", data_base64: "aGk=" }],
    }, service);

    expect(response.statusCode).toBe(201);
    expect(addComment.mock.calls[0]![0]).toMatchObject({
      body: `특수 문자\n\n![a_b__c.png](${uploaderUrl})`,
    });
  });

  it("텍스트도 첨부도 없으면 422로 거부한다", async () => {
    const calls: CardCommentAttachmentUploadInput[] = [];
    const { service, addComment } = fakeCardService();
    const response = await postComment(fakeUploader(calls), {
      body: "   ",
      idempotencyKey: "comment-key-5",
    }, service);

    expect(response.statusCode).toBe(422);
    expect(addComment).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("첨부가 10개를 넘으면 422로 거부한다", async () => {
    const { service, addComment } = fakeCardService();
    const response = await postComment(fakeUploader([]), {
      body: "너무 많은 첨부",
      idempotencyKey: "comment-key-6",
      attachments: Array.from({ length: 11 }, (_, index) => ({
        name: `file-${index}.png`, mime: "image/png", data_base64: "aGk=",
      })),
    }, service);

    expect(response.statusCode).toBe(422);
    expect(addComment).not.toHaveBeenCalled();
  });

  it("첨부 업로더가 구성되지 않으면 503으로 거부한다", async () => {
    const { service, addComment } = fakeCardService();
    const response = await postComment(undefined, {
      body: "업로더 없음",
      idempotencyKey: "comment-key-7",
      attachments: [{ name: "screen.png", mime: "image/png", data_base64: "aGk=" }],
    }, service);

    expect(response.statusCode).toBe(503);
    expect(addComment).not.toHaveBeenCalled();
  });

  it("카드에 세션이 없으면 첫 연결 세션의 노드와 세션을 쓴다", async () => {
    const calls: CardCommentAttachmentUploadInput[] = [];
    const { service } = fakeCardService(
      { node_id: null, assignee_session_id: null },
      [{ session_id: "session-9", node_id: "node-9" }],
    );
    const response = await postComment(fakeUploader(calls), {
      body: "연결 세션",
      idempotencyKey: "comment-key-8",
      attachments: [{ name: "screen.png", mime: "image/png", data_base64: "aGk=" }],
    }, service);

    expect(response.statusCode).toBe(201);
    expect(calls[0]).toMatchObject({ nodeId: "node-9", sessionId: "session-9" });
  });
});

describe("createCardCommentAttachmentUploader", () => {
  const legacyNode = { id: "node-1" };

  function transport() {
    return {
      uploadAttachment: vi.fn(async (_node: unknown, input: { sessionId: string; filename: string; contentType: string }) => ({
        path: `/incoming/${input.sessionId}/${input.filename}`,
        filename: input.filename,
        size: 2,
        content_type: input.contentType,
      })),
      legacyUploadAttachment: vi.fn(),
      deleteSessionAttachments: vi.fn(),
      downloadAttachment: vi.fn(),
    };
  }

  function attachmentOptions(assetUpload?: AttachmentRouteOptions["assetUpload"]) {
    const attachmentsTransport = transport();
    const options = {
      provider: { getNode: () => legacyNode },
      accessProvider: { resolveAccess: () => ({ restricted: false }), requireSessionAccess: () => {} },
      transport: attachmentsTransport,
      ...(assetUpload === undefined ? {} : { assetUpload }),
    } as unknown as AttachmentRouteOptions;
    return { options, attachmentsTransport };
  }

  const input = {
    cardId: "card-1",
    folderId: "folder-1",
    nodeId: "node-1",
    sessionId: "session-1",
    file: { name: "screen.png", mime: "image/png", data_base64: "aGk=" },
    uploadId: "3f2a1b4c-9d8e-4f6a-a7b8-c9d0e1f2a3b4",
  };

  it("인증 주체가 없으면 노드 캐시 경로만 써서 legacy 파일 URL을 만든다", async () => {
    const { options, attachmentsTransport } = attachmentOptions();
    const upload = createCardCommentAttachmentUploader(options);
    const result = await upload({} as FastifyRequest, input);

    expect(attachmentsTransport.uploadAttachment).toHaveBeenCalledOnce();
    expect(result).toEqual({
      url: "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fsession-1%2Fscreen.png",
      name: "screen.png",
      mime: "image/png",
    });
  });

  it("세션이 없으면 카드 id를 노드 캐시 세션으로 쓴다", async () => {
    const { options, attachmentsTransport } = attachmentOptions();
    const upload = createCardCommentAttachmentUploader(options);
    const result = await upload({} as FastifyRequest, { ...input, sessionId: null });

    expect(attachmentsTransport.uploadAttachment.mock.calls[0]![1]).toMatchObject({ sessionId: "card-1" });
    expect(result.url).toContain(encodeURIComponent("/incoming/card-1/screen.png"));
  });

  it("인증된 사용자의 첨부는 소유자로 커밋하고 별칭 경로의 legacy URL을 돌려준다", async () => {
    const resolveActor = vi.fn(async () => ({ kind: "user" as const, email: "director@example.com" }));
    const registration = {
      registrationScope: { type: "folder" as const, id: "folder-1" },
      sourceNodeId: null,
      sourceSessionId: "session-1",
      outputCommandId: null,
    };
    const requireRegistration = vi.fn(async () => registration);
    const putSmall = vi.fn(async ({ spec, body }: { spec: Record<string, unknown>; body: Uint8Array }) => ({
      attachmentId: spec.attachmentId as string,
      storageKey: "owned/key",
      storageEndpoint: "endpoint",
      storageBucket: "bucket",
      originalName: spec.originalName as string,
      mimeType: spec.mimeType as string,
      byteSize: body.length,
      checksumSha256: "0".repeat(64),
    }));
    const insertLegacyAlias = vi.fn(async (value: { nodeId: string; normalizedPath: string; assetId: string; originalPath: string }) => ({
      ...value,
      availability: "resolved" as const,
    }));
    const repository = {
      findLegacyAliasForUpload: vi.fn(async () => null),
      insertLegacyAlias,
    } as unknown as AttachmentCommitRepository;
    const { options, attachmentsTransport } = attachmentOptions({
      resolveActor,
      requireRegistration,
      commits: { putSmall },
      repository,
    } as unknown as NonNullable<AttachmentRouteOptions["assetUpload"]>);
    const upload = createCardCommentAttachmentUploader(options);
    const result = await upload({} as FastifyRequest, input);

    expect(requireRegistration).toHaveBeenCalledWith(expect.anything(), {
      actor: { kind: "user", email: "director@example.com" },
      sessionId: "session-1",
      folderId: "folder-1",
      mode: "legacy",
      small: true,
    });
    expect(putSmall).toHaveBeenCalledOnce();
    expect(putSmall.mock.calls[0]![0]).toMatchObject({
      spec: {
        attachmentId: input.uploadId,
        owner: { kind: "user_email", key: "director@example.com" },
        registration,
        originalName: "screen.png",
        mimeType: "image/png",
        byteSize: 2,
      },
    });
    expect(insertLegacyAlias).toHaveBeenCalledOnce();
    expect(attachmentsTransport.uploadAttachment).toHaveBeenCalledOnce();
    expect(result).toEqual({
      url: "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fsession-1%2Fscreen.png",
      name: "screen.png",
      mime: "image/png",
    });
  });
});
