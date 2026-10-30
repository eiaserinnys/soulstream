import { isHumanInput, isInternalInput, isKeepalive, isShortAcknowledgement, isSilent } from "../../../packages/wire-schema/src/conversation_visibility.js";

export type Item = { id: string; kind: "user" | "assistant" | "error" | "notice"; text: string; at: string; attachments: Array<{ id: string; name: string; mime: string }> };
export type SourceEvent = { id: number; type: string; at: string; payload: Record<string, unknown> };
export class ConversationProjection {
  private firstHumanSeen = false;
  private keepalive = false;
  private suppressed = false;
  private readonly hiddenInputs = new Set<string>();
  private busy = false;
  private tool: string | null = null;
  private streamId: string | null = null;
  private streamText = "";
  private errorInTurn = false;

  constructor(private readonly firstInputIsInitial: boolean) {}
  activity() { return { busy: this.busy, tool: this.tool }; }
  hasErrorInTurn() { return this.errorInTurn; }
  allowsLive() { return !this.keepalive; }
  stream() { return { stream_id: this.streamId, text: this.streamId && !isSilent(this.streamText, true) ? this.streamText : null }; }
  setStream(id: string, text: string) { this.streamId = id; this.streamText = text; }
  apply(event: SourceEvent): { item?: Item; activity?: { busy: boolean; tool: string | null } } {
    const { id, type, payload, at } = event;
    const human = isHumanInput(type, payload);
    const input = type === "user_message" || type === "intervention_sent";
    const internal = isInternalInput(type, payload);
    const keepalive = input && isKeepalive(payload);
    if (human && !keepalive) this.errorInTurn = false;
    const anchor = string(payload.input_id ?? payload.inputId ?? payload.prepared_input_id ?? payload.preparedInputId);
    const makeItem = (kind: Item["kind"], text: string, attachments: Item["attachments"] = []): Item => ({ id: String(id), kind, text, at, attachments });
    if (input || type === "notification") {
      if (input) {
        this.keepalive = keepalive;
        if (keepalive && anchor) this.hiddenInputs.add(anchor);
      }
      this.suppressed = internal || keepalive || hasClosedContext(payload);
      if (input && !keepalive) { this.busy = true; this.tool = null; }
      if (human && !keepalive) {
        const first = !this.firstHumanSeen;
        this.firstHumanSeen = true;
        if (first && this.firstInputIsInitial) return { activity: this.activity() };
        const attachments = attachmentsFor(payload);
        const text = stripInternal(string(payload._conversation_text) ?? string(payload.text) ?? "");
        return text.trim() || attachments.length ? { item: makeItem("user", text, attachments), activity: this.activity() } : {};
      }
      return {};
    }
    if (type === "error" || type === "assistant_error") {
      this.errorInTurn = true;
      this.keepalive = false; this.busy = false; this.tool = null; this.streamId = null; this.streamText = "";
      return { item: makeItem("error", string(payload.message) ?? string(payload.error) ?? "턴이 실패했습니다."), activity: this.activity() };
    }
    if (type === "complete") {
      this.errorInTurn = false;
      this.keepalive = false; this.busy = false; this.tool = null; this.streamId = null; this.streamText = "";
      return { activity: this.activity() };
    }
    if (this.keepalive || (anchor && this.hiddenInputs.has(anchor))) return {};
    if (type === "assistant_message") {
      this.streamId = null; this.streamText = "";
      const text = string(payload.content) ?? "";
      if (!text.trim() || isSilent(text) || (this.suppressed && isShortAcknowledgement(text))) return {};
      return { item: makeItem("assistant", text) };
    }
    if (type === "tool_start" || type === "tool_result") {
      this.busy = true; this.tool = type === "tool_start" ? string(payload.tool_name) ?? null : null;
      return { activity: this.activity() };
    }
    return {};
  }
  live(type: string, payload: Record<string, unknown>): { stream_id: string; text: string } | undefined {
    if (this.keepalive) return undefined;
    const id = string(payload.streamIdentity) ?? string(payload.item_id) ?? "stream";
    if (type === "text_start") { this.streamId = id; this.streamText = ""; return undefined; }
    if (type !== "text_delta") return undefined;
    const text = string(payload.text) ?? "";
    if (this.streamId !== id) { this.streamId = id; this.streamText = ""; }
    this.streamText = payload.liveTextMode === "replace" ? text : this.streamText + text;
    if (isSilent(this.streamText, true)) return undefined;
    return { stream_id: id, text: this.streamText };
  }
}
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function hasClosedContext(payload: Record<string, unknown>): boolean {
  const context = payload.context_items ?? payload.contextItems ?? payload.context;
  return Array.isArray(context) && context.some(x => x && typeof x === "object" && (x as Record<string, unknown>).key === "persistent_report_closed");
}
function stripInternal(text: string): string {
  return text.split("\n").filter(line => !line.startsWith("[첨부 파일 로컬 경로: ")).join("\n").trimEnd();
}
function attachmentsFor(payload: Record<string, unknown>): Item["attachments"] {
  const assets = Array.isArray(payload._conversation_attachments) ? payload._conversation_attachments as Item["attachments"] : [];
  const paths = Array.isArray(payload.attachments) ? payload.attachments : Array.isArray(payload.attachment_paths) ? payload.attachment_paths : [];
  const metadata = payload._conversation_path_metadata as Record<string, {name:string; mime:string; assetId?:string}> | undefined;
  return [...assets, ...paths.flatMap((value, index) => {
    if (typeof value !== "string") return [];
    const saved = metadata?.[value];
    if (saved?.assetId && assets.some(asset => asset.id === saved.assetId)) return [];
    if (saved) return [{ id: `path:${index}`, name: saved.name, mime: saved.mime }];
    const base = value.split(/[\\/]/).pop() ?? value;
    const name = base.replace(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-(.+)-[0-9a-f]{32}(\.[^.]+)?$/, "$1$2");
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const mime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown", pdf: "application/pdf" };
    return [{ id: `path:${index}`, name, mime: mime[ext] ?? "application/octet-stream" }];
  })];
}
