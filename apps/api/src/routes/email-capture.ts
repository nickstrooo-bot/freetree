import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "@kytelink/db";
import type { RateLimitClass } from "@kytelink/schemas";
import { getEmailProvider } from "@kytelink/emails";
import { getRedis } from "../redis";
import {
  enforceRateLimit,
  isRedisLike,
  RedisRateLimiter,
  retryAfterOf,
} from "../trpc/rate-limit";
import { getConfig } from "../config";
import { taggedLogger } from "../logger";

const log = taggedLogger("email-capture:routes");

// Double opt-in links expire after 48 hours.
const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;

async function rateLimitOr429(
  app: FastifyInstance,
  req: any,
  reply: any,
  key: RateLimitClass,
): Promise<boolean> {
  const redis = getRedis();
  if (!isRedisLike(redis)) return true;
  try {
    await enforceRateLimit(new RedisRateLimiter(redis), key, { ip: req.ip }, { failOpen: true });
    return true;
  } catch (error) {
    const retryAfter = retryAfterOf(error);
    if (retryAfter !== null) reply.header("retry-after", String(retryAfter));
    await reply.status(429).send({ error: "TOO_MANY_REQUESTS" });
    return false;
  }
}

const subscribeBody = z.object({
  username: z.string().min(1).max(64),
  email: z.string().trim().toLowerCase().email().max(320),
});

function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_WEB_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    "https://getfreetree.com"
  );
}

export function registerEmailCaptureRoutes(app: FastifyInstance): void {
  // ── Public block config for a profile page ───────────────────────────────
  app.get("/email-capture/block/:username", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "email-capture-public"))) return;
    const { username } = req.params as { username: string };
    const db = getDb();
    const kyte = await db.kyte.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
      include: { emailCaptureBlock: true },
    });
    const block = kyte?.emailCaptureBlock;
    if (!kyte || !block || !block.active) return reply.send({ block: null });
    return reply.send({
      block: {
        heading: block.heading,
        description: block.description,
        buttonText: block.buttonText,
        pendingText: block.pendingText,
        successText: block.successText,
      },
    });
  });

  // ── Public signup (creates a pending subscriber, sends confirm email) ───
  app.post("/email-capture/subscribe", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "email-capture-subscribe"))) return;
    const parsed = subscribeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_INPUT" });
    }
    const { username, email } = parsed.data;
    const db = getDb();

    const kyte = await db.kyte.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
      include: { emailCaptureBlock: true, organization: true },
    });
    const block = kyte?.emailCaptureBlock;
    if (!kyte || !block || !block.active) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }

    // Idempotent: if they're already confirmed or pending, just re-send
    // the confirmation (pending) or say they're already subscribed.
    const existing = await db.emailSubscriber.findUnique({
      where: { blockId_email: { blockId: block.id, email } },
    });
    if (existing?.status === "confirmed") {
      return reply.send({ ok: true, alreadySubscribed: true });
    }
    if (existing?.status === "unsubscribed") {
      // Re-subscribing after unsubscribing starts a fresh double opt-in.
      await db.emailSubscriber.delete({ where: { id: existing.id } });
    }

    const confirmToken = randomBytes(32).toString("hex");
    const subscriber =
      existing?.status === "pending"
        ? await db.emailSubscriber.update({
            where: { id: existing.id },
            data: { confirmToken },
          })
        : await db.emailSubscriber.create({
            data: {
              blockId: block.id,
              kyteId: kyte.id,
              orgId: kyte.orgId,
              email,
              status: "pending",
              confirmToken,
            },
          });

    void subscriber; // (kept for clarity; token is what matters below)

    // Send the double opt-in email. If no mail provider is configured,
    // this logs to console and the owner can still see pending signups
    // in their dashboard — nothing crashes.
    const confirmUrl = `${publicBaseUrl()}/email/confirm/${confirmToken}`;
    const ownerName = kyte.displayName ?? kyte.username ?? "FreeTree";
    const textBody = [
      `Hi there,`,
      ``,
      `You asked to join ${ownerName}'s email list on FreeTree.`,
      `Click this link to confirm (expires in 48 hours):`,
      ``,
      confirmUrl,
      ``,
      `Didn't ask for this? Just ignore this email — you won't be subscribed.`,
    ].join("\n");
    try {
      const result = await getEmailProvider().sendEmail({
        to: email,
        subject: `Confirm your subscription to ${ownerName}`,
        text: textBody,
        html: `<p>Hi there,</p><p>You asked to join <strong>${ownerName}</strong>'s email list on FreeTree.</p><p><a href="${confirmUrl}">Click here to confirm</a> (expires in 48 hours).</p><p><small>Didn't ask for this? Just ignore this email — you won't be subscribed.</small></p>`,
      });
      log.info({ to: email, provider: result.provider }, "sent double opt-in email");
    } catch (error) {
      log.warn({ err: error, to: email }, "failed to send confirm email — signup still recorded as pending");
    }

    return reply.send({ ok: true, alreadySubscribed: false });
  });

  // ── Double opt-in confirmation ───────────────────────────────────────────
  app.get("/email-capture/confirm/:token", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "email-capture-public"))) return;
    const { token } = req.params as { token: string };
    const db = getDb();
    const sub = await db.emailSubscriber.findUnique({ where: { confirmToken: token } });
    if (!sub || sub.status !== "pending") {
      return reply.status(404).send({ error: "INVALID_OR_EXPIRED" });
    }
    if (Date.now() - sub.createdAt.getTime() > CONFIRM_TTL_MS) {
      await db.emailSubscriber.delete({ where: { id: sub.id } });
      return reply.status(410).send({ error: "EXPIRED" });
    }
    await db.emailSubscriber.update({
      where: { id: sub.id },
      data: { status: "confirmed", confirmedAt: new Date(), confirmToken: null },
    });
    return reply.send({ ok: true });
  });

  // ── One-click unsubscribe ────────────────────────────────────────────────
  app.get("/email-capture/unsubscribe/:token", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "email-capture-public"))) return;
    const { token } = req.params as { token: string };
    const db = getDb();
    const sub = await db.emailSubscriber.findUnique({ where: { unsubscribeToken: token } });
    if (!sub) return reply.status(404).send({ error: "NOT_FOUND" });
    if (sub.status !== "unsubscribed") {
      await db.emailSubscriber.update({
        where: { id: sub.id },
        data: { status: "unsubscribed", unsubscribedAt: new Date() },
      });
    }
    return reply.send({ ok: true });
  });
}
