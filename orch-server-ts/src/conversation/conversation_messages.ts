import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { ConversationError } from "./conversation_types.js";

export type Upload = { name:string; mime:string; data_base64:string };
export type StoredUpload = { path:string; name:string; mime:string; assetId?:string };
type Request = { request_id:string; text:string; attachments:Upload[] };
type Receipt = { request_id:string; status:"pending"|"accepted"|"failed"; error?:{code:string;message:string} };
type Row = { request_id:string; request_hash:string; delivery_id:string; caller_info:Record<string,unknown>; status:Receipt["status"]; uploads:StoredUpload[]; error:Receipt["error"]|null };
export type MessagePorts = {
  caller(request:FastifyRequest, session:string):Promise<Record<string,unknown>>;
  upload(request:FastifyRequest, session:string, file:Upload, uploadId:string):Promise<StoredUpload>;
  intervene(request:FastifyRequest, session:string, body:{text:string;attachment_paths:string[];delivery_id:string}, caller:Record<string,unknown>):Promise<{status:number;body:unknown}>;
  read(request:FastifyRequest, session:string, attachment:{path?:string;assetId?:string}):Promise<Response>;
};
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 30 * 1024 * 1024;
export const MESSAGE_BODY_LIMIT = 48 * 1024 * 1024;
export class ConversationMessageService {
  private readonly inFlight = new Map<string, Promise<Receipt>>();
  constructor(private readonly sql:SqlClient, readonly ports:MessagePorts) {}
  async send(request:FastifyRequest, session:string, input:unknown):Promise<Receipt> {
    const body = parseMessage(input);
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const caller = await this.ports.caller(request,session);
    const rows = await this.sql<Row[]>`INSERT INTO conversation_message_receipts(session_id,request_id,request_hash,delivery_id,caller_info,status)
      VALUES (${session},${body.request_id},${hash},${randomUUID()},${this.sql.json(caller as never)},'pending')
      ON CONFLICT (session_id,request_id) DO NOTHING RETURNING *`;
    const row = rows[0] ?? await this.getRow(session,body.request_id);
    if (row.request_hash !== hash) throw new ConversationError(409,"conflict","Request id is already used for another message");
    if (row.status !== "pending") return receipt(row);
    const key = JSON.stringify([session,body.request_id]);
    let work = this.inFlight.get(key);
    if (!work) {
      work = this.process(request,session,body,row).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key,work);
    }
    return await work;
  }
  async get(session:string, id:string):Promise<Receipt> {
    const [accepted] = await this.sql<Row[]>`UPDATE conversation_message_receipts AS receipt SET status='accepted'
      WHERE receipt.session_id=${session} AND receipt.request_id=${id} AND receipt.status='pending'
      AND EXISTS (SELECT 1 FROM session_deliveries AS delivery WHERE delivery.delivery_id=receipt.delivery_id)
      RETURNING receipt.*`;
    return receipt(accepted ?? await this.getRow(session,id));
  }
  private async getRow(session:string,id:string):Promise<Row> {
    const [row] = await this.sql<Row[]>`SELECT * FROM conversation_message_receipts WHERE session_id=${session} AND request_id=${id}`;
    if (!row) throw new ConversationError(404,"not_found","Message receipt not found");
    return row;
  }
  private async process(request:FastifyRequest, session:string, body:Request, row:Row):Promise<Receipt> {
    const uploads = [...row.uploads];
    let interventionStarted = false;
    try {
      for (let i=uploads.length; i<body.attachments.length; i++) {
        // A stable UUID makes the owned upload commit reusable after a retry.
        const hash = createHash("sha256").update(`${row.delivery_id}:${i}`).digest("hex");
        const uploadId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
        uploads.push(await this.ports.upload(request,session,body.attachments[i]!,uploadId));
        await this.sql`UPDATE conversation_message_receipts SET uploads=${this.sql.json(uploads as never)} WHERE session_id=${session} AND request_id=${body.request_id}`;
      }
      interventionStarted = true;
      const result = await this.ports.intervene(request,session,{text:body.text,attachment_paths:uploads.map(x => x.path),delivery_id:row.delivery_id},row.caller_info);
      if (result.status < 200 || result.status >= 300) throw new Error("Intervention failed");
      await this.sql`UPDATE conversation_message_receipts SET status='accepted' WHERE session_id=${session} AND request_id=${body.request_id}`;
      return {request_id:body.request_id,status:"accepted"};
    } catch (error) {
      request.log.warn({err:error},"conversation message failed");
      // After durable admission the ledger owns recovery, even if dispatch failed.
      if (interventionStarted) {
        const [delivery] = await this.sql<Array<{aggregate_state:string}>>`SELECT aggregate_state FROM session_deliveries WHERE delivery_id=${row.delivery_id}`;
        if (delivery && delivery.aggregate_state !== "dead_letter") {
          await this.sql`UPDATE conversation_message_receipts SET status='accepted' WHERE session_id=${session} AND request_id=${body.request_id}`;
          return {request_id:body.request_id,status:"accepted"};
        }
      }
      const safe = {code:"unavailable",message:"Message could not be sent"};
      await this.sql`UPDATE conversation_message_receipts SET status='failed',error=${this.sql.json(safe)} WHERE session_id=${session} AND request_id=${body.request_id}`;
      return {request_id:body.request_id,status:"failed",error:safe};
    }
  }
}
function receipt(row:Row):Receipt { return {request_id:row.request_id,status:row.status,...(row.error ? {error:row.error} : {})}; }
function parseMessage(input:unknown):Request {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const b = input as Record<string,unknown>;
  if (Object.keys(b).some(k => !["request_id","text","attachments"].includes(k)) || typeof b.request_id !== "string" || !b.request_id.trim() || typeof b.text !== "string") throw invalid();
  const attachments = b.attachments === undefined ? [] : b.attachments;
  if (!Array.isArray(attachments)) throw invalid();
  if (attachments.length > 10) throw limit();
  let total = 0;
  const parsed = attachments.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const a = value as Record<string,unknown>;
    if (Object.keys(a).some(k => !["name","mime","data_base64"].includes(k)) || typeof a.name !== "string" || !a.name.trim() || typeof a.mime !== "string" || (a.mime !== "" && !/^[\x20-\x7e]+$/.test(a.mime)) || typeof a.data_base64 !== "string") throw invalid();
    if (a.data_base64.length > Math.ceil(MAX_FILE / 3) * 4) throw limit();
    const bytes = Buffer.from(a.data_base64,"base64");
    if (bytes.toString("base64") !== a.data_base64) throw invalid();
    const size = bytes.length; total += size;
    if (size > MAX_FILE || total > MAX_TOTAL) throw limit();
    return {name:a.name,mime:a.mime,data_base64:a.data_base64};
  });
  if (!b.text.trim() && !parsed.length) throw invalid();
  return {request_id:b.request_id,text:b.text,attachments:parsed};
}
function invalid() { return new ConversationError(400,"invalid_request","Invalid message"); }
function limit() { return new ConversationError(413,"attachment_limit","Attachment limit exceeded"); }
