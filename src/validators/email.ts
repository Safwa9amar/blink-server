import { z } from "zod";

// Inbox list query for the dashboard (GET /email/threads).
export const emailListSchema = z.object({
  status: z.enum(["open", "assigned", "closed"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

// Staff reply body (POST /email/threads/:id/reply).
export const emailReplySchema = z.object({
  body: z.string().trim().min(1).max(20000),
});
