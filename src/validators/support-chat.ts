import { z } from "zod";

export const sendMessageSchema = z.object({
  body: z.string().min(1).max(4000),
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
