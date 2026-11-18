import { isExternalInput, isInternalInput, isKeepalive, isHiddenConversationInput, isShortAcknowledgement, isSilent, isVisibleConversationInput } from "../../../packages/wire-schema/src/conversation_visibility.js";

export type ItemSender = { kind: "external"; label: string };
export type Item = { id: string; kind: "user" | "assistant" | "error" | "notice"; text: string; at: string; attachments: Array<{ id: string; name: string; mime: string }>; sender?: ItemSender };
export type SourceEvent = { id: number; type: string; at: string; payload: Record<string, unknown> };
export type ProjectionState = {
  firstUserMessageSeen: boolean; keepalive: boolean; suppressed: boolean;
  hiddenInputs: string[]; turnHiddenInputs: string[]; visibleInputInTurn: boolean;
  busy: boolean; tool: string | null; streamId: string | null; streamText: string; errorInTurn: boolean;
};
export class ConversationProjection {
  private firstUserMessageSeen = false;
  private keepalive = false;
  private suppressed = false;
  private readonly hiddenInputs = new Set<string>();
  private readonly turnHiddenInputs = new Set<string>();
  private visibleInputInTurn = false;
  private busy = false;
  private tool: string | null = null;
  private streamId: string | null = null;
  private streamText = "";
  private errorInTurn = false;

  constructor(private readonly firstInputIsInitial: boolean) {}
  snapshot(): ProjectionState {
    return { firstUserMessageSeen: this.firstUserMessageSeen, keepalive: this.keepalive, suppressed: this.suppressed,
      hiddenInputs: [...this.hiddenInputs], turnHiddenInputs: [...this.turnHiddenInputs], visibleInputInTurn: this.visibleInputInTurn,
      busy: this.busy, tool: this.tool, streamId: this.streamId, streamText: this.streamText, errorInTurn: this.errorInTurn };
  }
  static restore(firstInputIsInitial: boolean, state: ProjectionState): ConversationProjection {
    const copy = new ConversationProjection(firstInputIsInitial);
    copy.firstUserMessageSeen = state.firstUserMessageSeen;
    copy.keepalive = state.keepalive;
    copy.suppressed = state.suppressed;
    for (const id of state.hiddenInputs) copy.hiddenInputs.add(id);
    for (const id of state.turnHiddenInputs) copy.turnHiddenInputs.add(id);
    copy.visibleInputInTurn = state.visibleInputInTurn;
    copy.busy = state.busy;
    copy.tool = state.tool;
    copy.streamId = state.streamId;
    copy.streamText = state.streamText;
    copy.errorInTurn = state.errorInTurn;
    return copy;
  }
  clone(): ConversationProjection { return ConversationProjection.restore(this.firstInputIsInitial, this.snapshot()); }
  activity() { return { busy: this.busy, tool: this.tool }; }
  hasErrorInTurn() { return this.errorInTurn; }
  allowsLive() { return !this.keepalive; }
  stream() { return { stream_id: this.streamId, text: this.streamId && !isSilent(this.streamText, true) ? this.streamText : null }; }
  setStream(id: string, text: string) { this.streamId = id; this.streamText = text; }
  apply(event: SourceEvent): { item?: Item; activity?: { busy: boolean; tool: string | null } } {
    const { id, type, payload, at } = event;
    const visible = isVisibleConversationInput(type, payload);
    const external = isExternalInput(type, payload);
    const input = type === "user_message" || type === "intervention_sent";
    const internal = isInternalInput(type, payload);
    const hiddenInput = isHiddenConversationInput(type, payload);
    if (visible && !hiddenInput) this.errorInTurn = false;
    const anchor = string(payload.input_id ?? payload.inputId ?? payload.prepared_input_id ?? payload.preparedInputId);
    const makeItem = (kind: Item["kind"], text: string, attachments: Item["attachments"] = []): Item => ({ id: String(id), kind, text, at, attachments });
    if (type === "notification" && typeof payload._conversation_notice === "string") return { item: makeItem("notice", payload._conversation_notice) };
    if (input || type === "notification") {
      if (input) {
        if (hiddenInput) {
          if (isKeepalive(payload) || !this.visibleInputInTurn) {
            this.keepalive = true;
            this.suppressed = true;
            if (anchor) { this.hiddenInputs.add(anchor); this.turnHiddenInputs.add(anchor); }
          }
          return {};
        }
        this.visibleInputInTurn = true;
        this.keepalive = false;
        for (const id of this.turnHiddenInputs) this.hiddenInputs.delete(id);
        this.turnHiddenInputs.clear();
      }
      this.suppressed = internal || hasClosedContext(payload);
      if (input) { this.busy = true; this.tool = null; }
      if (visible) {
        const firstUserMessage = type === "user_message" && !this.firstUserMessageSeen;
        if (type === "user_message") this.firstUserMessageSeen = true;
        if (firstUserMessage && this.firstInputIsInitial) return { activity: this.activity() };
        const attachments = attachmentsFor(payload);
        const text = stripInternal(string(payload._conversation_text) ?? string(payload.text) ?? "");
        if (!text.trim() && !attachments.length) return {};
        const item = makeItem("user", text, attachments);
        return { item: external ? { ...item, sender: externalSender(payload) } : item, activity: this.activity() };
      }
      return {};
    }
    if (type === "error" || type === "assistant_error") {
      this.errorInTurn = true;
      this.visibleInputInTurn = false; this.turnHiddenInputs.clear();
      this.keepalive = false; this.busy = false; this.tool = null; this.streamId = null; this.streamText = "";
      return { item: makeItem("error", string(payload.message) ?? string(payload.error) ?? "턴이 실패했습니다."), activity: this.activity() };
    }
    if (type === "complete") {
      this.errorInTurn = false;
      this.visibleInputInTurn = false; this.turnHiddenInputs.clear();
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
function externalSender(payload: Record<string, unknown>): ItemSender {
  const caller = payload.caller_info ?? payload.callerInfo;
  const displayName = caller && typeof caller === "object" && !Array.isArray(caller)
    ? string((caller as Record<string, unknown>).display_name)?.trim()
    : undefined;
  return { kind: "external", label: displayName || "외부 연동" };
}
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
