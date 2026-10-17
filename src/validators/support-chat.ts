import { z } from "@hono/zod-openapi";
import { supportConversations } from "../db/schema/support-conversations";
import { supportMessages } from "../db/schema/support-messages";
import { PaginationSchema, rowSchema } from "../openapi";

export const sendMessageSchema = z
  .object({
    body: z.string().max(4000).optional(),
    attachmentUrl: z.string().url().optional(),
  })
  .refine((v) => (v.body && v.body.trim().length > 0) || v.attachmentUrl, {
    message: "Either body or attachmentUrl is required",
  })
  .openapi("SendSupportMessageBody");

export const escalateSchema = z
  .object({
    reason: z.string().max(300).optional(),
  })
  .openapi("EscalateSupportConversationBody");

export const listMessagesSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const staffListSchema = z.object({
  status: z.enum(["bot", "waiting", "assigned", "resolved"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

export const rateConversationSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
  })
  .openapi("RateSupportConversationBody");

/** Optional body for get-or-create; `locale` seeds a NEW conversation only. */
export const openConversationSchema = z
  .object({
    locale: z.string().optional(),
  })
  .openapi("OpenSupportConversationBody");

// ─── Response schemas ────────────────────────────────────────────────
// CONVERSATION_COLUMNS / MESSAGE_COLUMNS select every column of their tables.

export const SupportConversationSchema = rowSchema(supportConversations, "SupportConversation");
// `meta` re-typed from the generic JSON union; rebuilt from `.shape` (not
// `.extend`) so the spec gets a flat object rather than an allOf.
export const SupportMessageSchema = z
  .object({
    ...rowSchema(supportMessages, "SupportMessageRow").shape,
    meta: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi("SupportMessage");

export const SupportConversationResponse = z
  .object({
    conversation: SupportConversationSchema,
    messages: z.array(SupportMessageSchema),
  })
  .openapi("SupportConversationResponse");

export const SupportMessageListResponse = z
  .object({ messages: z.array(SupportMessageSchema), pagination: PaginationSchema })
  .openapi("SupportMessageListResponse");

export const SupportMessageResponse = z
  .object({ message: SupportMessageSchema })
  .openapi("SupportMessageResponse");

export const SupportConversationListResponse = z
  .object({ conversations: z.array(SupportConversationSchema), pagination: PaginationSchema })
  .openapi("SupportConversationListResponse");

export const SupportOkResponse = z.object({ ok: z.boolean() }).openapi("SupportOk");
