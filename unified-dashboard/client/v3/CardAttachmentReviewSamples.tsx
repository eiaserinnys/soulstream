import { useEffect, useMemo, useState } from "react";
import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
import type { CardCheckItem, CardDetail, CardItemEvidence } from "@seosoyoung/soul-ui/cards/card-types";
import { attachmentContentUrl } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import { CardCheckItems } from "./CardCheckItems";
import { CardTimeline } from "./CardTimeline";
import { reviewCard, reviewCardItems } from "./components-review-fixtures";
import "./components-review.css";

const cardId = "card-attachment-review";
const context = { type: "card" as const, id: cardId };
const prefix = "card-review-";
const noAction = () => {};
type ReviewAsset = { descriptor: AttachmentDescriptor; body: Blob; previewUrl: string; status?: number };

function asset(id: string, name: string, body: Blob, previewKind: AttachmentDescriptor["preview_kind"], previewUrl?: string, status?: number): ReviewAsset {
  return {
    descriptor: {
      attachment_id: `${prefix}${id}`, name, mime_type: body.type, byte_size: body.size,
      checksum_sha256: null, width: null, height: null, preview_kind: previewKind,
      preview_mime_type: previewKind === "info" ? null : body.type,
    },
    body, previewUrl: previewUrl ?? attachmentContentUrl(`${prefix}${id}`, context), status,
  };
}

function evidence(value: ReviewAsset, availability?: "missing"): CardItemEvidence {
  const id = value.descriptor.attachment_id;
  const originalUrl = attachmentContentUrl(id, context, true);
  return {
    type: value.descriptor.preview_kind === "image" ? "image" : "link",
    label: value.descriptor.name, attachment_id: id, descriptor: value.descriptor, read_context: context,
    url: availability ? "" : value.previewUrl,
    previewUrl: availability ? null : value.previewUrl,
    originalUrl: availability ? "" : originalUrl,
    ...(availability ? { availability } : {}),
  };
}

/** Actual card renderers; only the sample's namespaced network/download boundary is local. */
export function CardAttachmentReviewSamples() {
  const [assets, setAssets] = useState<ReviewAsset[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(["/icon-192.png", "/icon-512.png"].map(async path => {
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok) throw new Error("Sample image unavailable");
      return response.blob();
    })).then(([small, original]) => {
      if (controller.signal.aborted) return;
      setAssets([
        asset("image-one", "원본 화면.png", original!, "image", "/icon-192.png"),
        asset("image-two", "다음 화면.png", small!, "image", "/icon-192.png"),
        asset("text", "보고.txt", new Blob(["카드에 보관한 원본입니다.\n소스 세션 없이 읽습니다."], { type: "text/plain" }), "text"),
        asset("info", "자료.bin", new Blob([new Uint8Array([0, 1, 2, 3])], { type: "application/octet-stream" }), "info"),
        asset("missing", "없는 파일.txt", new Blob([""], { type: "text/plain" }), "text"),
        asset("forbidden", "권한 제한.txt", new Blob(["읽기 제한"], { type: "text/plain" }), "text", undefined, 403),
        asset("unavailable", "일시 오류.txt", new Blob(["일시 오류"], { type: "text/plain" }), "text", undefined, 503),
      ]);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);

  const fixture = useMemo(() => {
    if (!assets) return null;
    const card = {
      ...reviewCard, id: cardId, title: "카드 첨부",
      request: `[요청 파일](/api/attachments/${prefix}text/content)\n\n[기존 파일](/api/attachments/files?nodeId=review-node&path=%2Freview%2Fnotes.txt)`,
    };
    const item: CardCheckItem = {
      ...reviewCardItems[2]!, id: 1, title: "소스 세션 없이 첨부를 읽습니다", result: null,
      evidence: [
        ...assets.map(value => evidence(value, value.descriptor.attachment_id === `${prefix}missing` ? "missing" : undefined)),
        { type: "link", label: "외부 자료", url: "https://example.com/card-attachment-review" },
      ],
    };
    const other: CardCheckItem = { ...item, id: 2, title: "다른 항목", evidence: [evidence(assets[1]!)] };
    const detail: CardDetail = {
      card, sessions: [], questions: [], notes: [], nowHistory: [],
      reports: [
        { id: "attachment-review-report", title: "첨부 보고", format: "markdown", sessionId: null, createdAt: "2026-10-05T02:00:00Z",
          body: `[보고 파일](/api/attachments/${prefix}text/content)\n\n[일반 파일](/api/attachments/${prefix}info/content)\n\n[결손 파일](/api/attachments/${prefix}missing/content)\n\n[503 파일](/api/attachments/${prefix}unavailable/content)\n\n[외부 안내](https://example.com/card-attachment-review)` },
        { id: "attachment-review-html", title: "HTML 보고", format: "html", sessionId: null, createdAt: "2026-10-05T03:00:00Z", body: "<p>기존 HTML 보고입니다.</p>" },
      ],
      comments: [{ id: "attachment-review-comment", cardId, authorKind: "user", authorId: "review-user", sessionId: null, kind: "comment", createdAt: "2026-10-05T04:00:00Z",
        body: `[세션 첨부](/api/attachments/${prefix}denied/content?context_type=session&context_id=review-session)` }],
    };
    return { card, detail, items: [item, other] };
  }, [assets]);

  useEffect(() => {
    if (!assets) return;
    const originalFetch = window.fetch;
    const findAsset = (url: URL) => assets.find(value => url.pathname === `/api/attachments/${value.descriptor.attachment_id}`
      || url.pathname === `/api/attachments/${value.descriptor.attachment_id}/content`);
    const sampleFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      const legacy = url.pathname === "/api/attachments/files" && url.searchParams.get("nodeId") === "review-node";
      if (url.origin !== window.location.origin || (!url.pathname.startsWith(`/api/attachments/${prefix}`) && !legacy)) return originalFetch(input, init);
      init?.signal?.throwIfAborted();
      if (url.pathname === `/api/attachments/${prefix}denied`) return new Response(null, { status: 403 });
      const value = legacy ? assets[2] : findAsset(url);
      if (!value || value.descriptor.attachment_id === `${prefix}missing`) return new Response(null, { status: 404 });
      if (!legacy && !url.pathname.endsWith("/content")) return Response.json({ descriptor: value.descriptor, upload_status: "committed" });
      if (value.status) return new Response(null, { status: value.status });
      const headers = { "Content-Type": value.body.type, "Content-Length": String(value.body.size) };
      if (init?.method === "HEAD") return new Response(null, { status: 200, headers });
      const range = new Headers(init?.headers).get("Range");
      return new Response(value.body, { status: range ? 206 : 200, headers: { ...headers, ...(range ? { "Content-Range": `bytes 0-${value.body.size - 1}/${value.body.size}` } : {}) } });
    };
    // The production save helper still validates and probes its original API URL.
    // Substitute the sample bytes only at the browser's download navigation boundary.
    const download = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[download]") : null;
      if (!link) return;
      const url = new URL(link.href);
      if (url.origin !== window.location.origin) return;
      const value = url.pathname === "/api/attachments/files" && url.searchParams.get("nodeId") === "review-node" ? assets[2] : findAsset(url);
      if (!value || value.status || value.descriptor.attachment_id === `${prefix}missing`) return;
      event.preventDefault();
      const objectUrl = URL.createObjectURL(value.body);
      const localLink = document.createElement("a");
      localLink.href = objectUrl; localLink.download = link.download;
      document.body.append(localLink); localLink.click(); localLink.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    };
    window.fetch = sampleFetch;
    document.addEventListener("click", download, true);
    return () => {
      if (window.fetch === sampleFetch) window.fetch = originalFetch;
      document.removeEventListener("click", download, true);
    };
  }, [assets]);

  return <main className="v3-components-main glass-strong glass-chrome">
    {fixture ? <div className="v3-components-samples">
      <CardCheckItems items={fixture.items} onConfirmChange={noAction} onTargetItem={noAction} />
      <CardTimeline card={fixture.card} detail={fixture.detail} portraitUrl="/system-portrait.png" pending={false} onAnswer={noAction} />
    </div> : <p className="v3-components-label" role="status">{failed ? "표본을 불러오지 못했습니다." : "불러오는 중…"}</p>}
  </main>;
}
