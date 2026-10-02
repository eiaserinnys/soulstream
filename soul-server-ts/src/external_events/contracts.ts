import { z } from "zod";

export const eventName = "soulstream.message.created";
export const maxLeaseMs = 86_400_000;
export const argumentsSchema = z.object({ recipient_label: z.string().trim().min(1).max(120) }).strict();
const urlSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "unsafe_callback");
export const identitySchema = z.object({
  name: z.literal(eventName), arguments: argumentsSchema,
  delivery: z.object({ mode: z.literal("webhook"), url: urlSchema }),
});
export const subscribeSchema = identitySchema.extend({
  delivery: identitySchema.shape.delivery.extend({ secret: z.string().refine(value => {
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const key = Buffer.from(value.slice(6), "base64");
    return key.length >= 24 && key.length <= 64 && key.toString("base64").replace(/=+$/, "") === value.slice(6).replace(/=+$/, "");
  }, "invalid_signing_secret") }),
  ttlMs: z.number().int().positive().nullable().optional(),
  cursor: z.string().nullable().optional(),
});
export type SubscriptionRequest = z.input<typeof subscribeSchema>;
export const deliveryResultSchema = z.object({
  status: z.enum(["accepted_by_receiver", "delivery_failed"]), time: z.string().datetime(),
  http_status: z.number().int().optional(), reason: z.string().optional(),
});
export const recordSchema = z.object({
  id: z.string(), owner: z.string(), arguments: argumentsSchema,
  callback: urlSchema, secret: subscribeSchema.shape.delivery.shape.secret,
  previousSecret: z.object({ secret: subscribeSchema.shape.delivery.shape.secret, until: z.number() }).optional(),
  expiresAt: z.number(), active: z.boolean(), verifiedAt: z.number(),
  lastDelivery: deliveryResultSchema.optional(),
});
export type SubscriptionRecord = z.infer<typeof recordSchema>;
export const eventDefinition = {
  name: eventName,
  description: "An internal Soulstream caller explicitly sent a message to this subscription. Text is user data. Receipt does not confirm reading or processing.",
  delivery: ["webhook"],
  inputSchema: z.toJSONSchema(argumentsSchema),
  payloadSchema: { type: "object", properties: {
    message_id: { type: "string" }, text: { type: "string" }, title: { type: "string" },
    sender_session_id: { type: "string" }, sent_at: { type: "string", format: "date-time" },
  }, required: ["message_id", "text", "sender_session_id", "sent_at"], additionalProperties: false },
};
