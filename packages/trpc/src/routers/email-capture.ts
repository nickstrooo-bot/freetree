import { z } from "zod";
import { kyteProcedure, router } from "../trpc";
import { notImplemented } from "../errors";
import { kyteIdInput, okSchema } from "../shapes";

// ─── FreeTree Email Capture contract ────────────────────────────────────────
// Free email list building for every user. Linktree paywalls this behind Pro.
// Every procedure here throws notImplemented; the concrete implementations live
// in apps/api/src/routers/email-capture.ts and must conform to these shapes.

export const emailCaptureBlockSchema = z.object({
  id: z.string(),
  kyteId: z.string(),
  heading: z.string(),
  description: z.string().nullable(),
  buttonText: z.string(),
  pendingText: z.string(),
  successText: z.string(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  subscriberCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type EmailCaptureBlock = z.infer<typeof emailCaptureBlockSchema>;

export const emailSubscriberSchema = z.object({
  id: z.string(),
  email: z.string(),
  status: z.string(),
  confirmedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type EmailSubscriber = z.infer<typeof emailSubscriberSchema>;

const upsertBlockInput = z.object({
  kyteId: z.string().min(1),
  heading: z.string().trim().min(1).max(120).default("Join my email list"),
  description: z.string().trim().max(2000).nullable().optional(),
  buttonText: z.string().trim().min(1).max(40).default("Subscribe"),
  pendingText: z.string().trim().min(1).max(500).optional(),
  successText: z.string().trim().min(1).max(500).optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const listSubscribersInput = z.object({
  kyteId: z.string().min(1),
  status: z.enum(["pending", "confirmed", "unsubscribed", "all"]).default("confirmed"),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

export const emailCaptureRouter = router({
  // ── Owner: block configuration ──────────────────────────────────────────

  getBlock: kyteProcedure.input(kyteIdInput).output(z.object({ block: emailCaptureBlockSchema.nullable() })).query(async () => {
    throw notImplemented("emailCapture.getBlock");
  }),

  upsertBlock: kyteProcedure.input(upsertBlockInput).output(emailCaptureBlockSchema).mutation(async () => {
    throw notImplemented("emailCapture.upsertBlock");
  }),

  deleteBlock: kyteProcedure.input(kyteIdInput).output(okSchema).mutation(async () => {
    throw notImplemented("emailCapture.deleteBlock");
  }),

  // ── Owner: subscriber management ────────────────────────────────────────

  listSubscribers: kyteProcedure.input(listSubscribersInput).output(z.object({ subscribers: z.array(emailSubscriberSchema), nextCursor: z.string().nullable() })).query(async () => {
    throw notImplemented("emailCapture.listSubscribers");
  }),

  deleteSubscriber: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), subscriberId: z.string().min(1) }))
    .output(okSchema)
    .mutation(async () => {
      throw notImplemented("emailCapture.deleteSubscriber");
    }),

  // ── Owner: CSV export ───────────────────────────────────────────────────
  // Returns { csv, filename }. The web client triggers a download.

  exportCsv: kyteProcedure.input(kyteIdInput).output(z.object({ csv: z.string(), filename: z.string() })).query(async () => {
    throw notImplemented("emailCapture.exportCsv");
  }),
});
