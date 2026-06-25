import { z } from "zod";

export const sendMessageSchema = z
  .object({
    body: z.string().max(4000).optional(),
    attachmentUrl: z.string().url().optional(),
  })
  .refine((v) => (v.body && v.body.trim().length > 0) || v.attachmentUrl, {
    message: "Either body or attachmentUrl is required",
  });

export const escalateSchema = z.object({
  reason: z.string().max(300).optional(),
});

export const listMessagesSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const staffListSchema = z.object({
  status: z.enum(["bot", "waiting", "assigned", "resolved"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(30),
});
