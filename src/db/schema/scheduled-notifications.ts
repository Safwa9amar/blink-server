import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { notificationType } from "./enums";
import type { NotificationCopy } from "./notifications";

// Lifecycle of a queued broadcast. `pending` → claimed to `sending` by the cron
// (so overlapping runs never double-send) → `sent`/`failed`. `canceled` is set
// when staff cancels a still-pending row from the dashboard.
export const scheduledNotificationStatus = pgEnum("scheduled_notification_status", [
  "pending",
  "sending",
  "sent",
  "failed",
  "canceled",
]);

// A broadcast notification queued to fire at a future time. The dashboard
// composer enqueues one row here; the cron (POST /cron/scheduled-notifications,
// driven every minute) claims due rows and runs broadcastNotification() — the
// same delivery path "send now" uses, so a scheduled send and an immediate send
// produce identical notifications + recipient rows + Expo pushes.
//
// This is a QUEUE, not the delivered content: once fired, the real rows live in
// `notifications` / `notification_recipients`. We keep the queue row for status
// + audit (recipients/pushed/sent_at/error).
export const scheduledNotifications = pgTable(
  "scheduled_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: notificationType("type").notNull(),
    // Canonical (English) fallback strings, mirroring `notifications`.
    title: text("title").notNull(),
    description: text("description").notNull(),
    // Explicit deep-link override (else derived per-recipient at send time).
    href: text("href"),
    // Localized copy ({ title, description }); null falls back to title/description.
    contentEng: jsonb("content_eng").$type<NotificationCopy>(),
    contentFr: jsonb("content_fr").$type<NotificationCopy>(),
    contentAr: jsonb("content_ar").$type<NotificationCopy>(),
    // Target audience as LOWERCASE user_role values (customer|rider|merchant|agent)
    // — passed straight to broadcastNotification(roles, …).
    targetRoles: text("target_roles").array().notNull(),
    // Delivery channels chosen in the composer (push|inapp|email|sms). `push`
    // toggles the Expo fan-out and `sms` texts the recipients through SMS Gate;
    // the in-app row is always written. Email is recorded, not yet delivered.
    channels: text("channels").array().notNull().default(sql`ARRAY['push']::text[]`),
    // SMS text language when `channels` has "sms" (null = English-first copy).
    smsLang: text("sms_lang").$type<"en" | "fr" | "ar">(),
    // When to fire.
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "string" }).notNull(),
    status: scheduledNotificationStatus("status").notNull().default("pending"),
    // Filled in once fired.
    recipients: integer("recipients").notNull().default(0),
    pushed: integer("pushed").notNull().default(0),
    // Numbers the SMS gateway accepted (sms channel only).
    smsSent: integer("sms_sent").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    error: text("error"),
    // Staff/sender who scheduled it (null for system).
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("scheduled_notifications_sms_lang_check", sql`sms_lang is null or sms_lang in ('en', 'fr', 'ar')`),
    // The due-queue scan: pending rows ordered by when they fire.
    index("idx_scheduled_notifications_due")
      .on(t.scheduledAt)
      .where(sql`status = 'pending'`),
    // No client policies — only the service role (dashboard admin client + the
    // server cron) ever touches this queue. RLS on with zero policies denies all
    // direct (anon/authenticated) access.
    pgPolicy("scheduled_notifications_no_client_access", {
      for: "select",
      using: sql`false`,
    }),
  ]
);
