import { parse as parseQuerystring } from "node:querystring";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "@kytelink/db";
import type { RateLimitClass } from "@kytelink/schemas";
import {
  defaultFormFields,
  FORM_HONEYPOT_FIELD,
  formDefinitionSchema,
  validateSubmission,
} from "@kytelink/schemas";
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
import { hashIp } from "../analytics/ip-hash";
import { renderFormHtml } from "../forms/render";

const log = taggedLogger("forms:routes");

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

const submitBody = z.record(z.string(), z.unknown());

function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_WEB_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    "https://getfreetree.com"
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Notification recipient: the form's notifyEmail, else the org owner's email. */
async function resolveNotifyEmail(form: { orgId: string; notifyEmail: string | null }): Promise<string | null> {
  if (form.notifyEmail) return form.notifyEmail;
  const db = getDb();
  const owner = await db.orgMember.findFirst({
    where: { orgId: form.orgId, role: "OWNER" },
    include: { user: true },
  });
  return owner?.user.email ?? null;
}

export function registerFormsRoutes(app: FastifyInstance): void {
  // The embed form posts like a plain HTML form (no JavaScript), so the API
  // must parse urlencoded bodies. No new dependency — Node's querystring.
  // This is the only urlencoded consumer in the API.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, parseQuerystring(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  // ── Public form config for a profile page ────────────────────────────────
  app.get("/forms/block/:username", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "forms-public"))) return;
    const { username } = req.params as { username: string };
    const db = getDb();
    const kyte = await db.kyte.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
      include: { formBlock: true },
    });
    const form = kyte?.formBlock;
    if (!kyte || !form || !form.active) return reply.send({ form: null });
    const parsed = formDefinitionSchema.safeParse({ fields: form.fields });
    const fields = parsed.success ? parsed.data.fields : defaultFormFields();
    return reply.send({
      form: {
        title: form.title,
        description: form.description,
        buttonText: form.buttonText,
        successText: form.successText,
        fields,
        endpointPath: `/forms/submit/${form.endpointToken}`,
      },
    });
  });

  // ── Embeddable no-JS form (GET returns a standalone <form>) ──────────────
  // Sellers paste this page's markup — or the URL itself in an <iframe> —
  // into any site. The form posts straight to the submit endpoint below.
  app.get("/forms/embed/:token", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "forms-public"))) return;
    const { token } = req.params as { token: string };
    const db = getDb();
    const form = await db.formBlock.findUnique({ where: { endpointToken: token } });
    if (!form || !form.active) return reply.status(404).send({ error: "NOT_FOUND" });
    const parsed = formDefinitionSchema.safeParse({ fields: form.fields });
    const fields = parsed.success ? parsed.data.fields : defaultFormFields();
    const html = renderFormHtml(
      { fields },
      {
        endpointPath: `${getConfig().apiBaseUrl}/forms/submit/${form.endpointToken}`,
        title: form.title,
        description: form.description,
        buttonText: form.buttonText,
      },
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });

  // ── Public submit ────────────────────────────────────────────────────────
  // Accepts JSON (profile page / API clients) and urlencoded (embed form).
  // Honeypot-filled submissions are STORED as spam but answered exactly like
  // a success — revealing the detection would teach bots to dodge it.
  app.post("/forms/submit/:token", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "forms-submit"))) return;
    const { token } = req.params as { token: string };
    const db = getDb();
    const form = await db.formBlock.findUnique({ where: { endpointToken: token } });
    if (!form || !form.active) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    const parsed = formDefinitionSchema.safeParse({ fields: form.fields });
    const fields = parsed.success ? parsed.data.fields : defaultFormFields();
    const definition = { fields };

    const body = submitBody.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: "INVALID_INPUT" });
    }
    const raw = body.data;

    // Honeypot: a human never sees this field; a bot fills it.
    const honeypot = typeof raw[FORM_HONEYPOT_FIELD] === "string" ? raw[FORM_HONEYPOT_FIELD].trim() : "";
    const isSpam = honeypot !== "";

    const validated = validateSubmission(definition, raw);
    if (!validated.ok && !isSpam) {
      return reply.status(400).send({ error: "INVALID_INPUT", errors: validated.errors });
    }

    const submission = await db.formSubmission.create({
      data: {
        formId: form.id,
        kyteId: form.kyteId,
        orgId: form.orgId,
        payload: validated.values as unknown as Record<string, string>,
        spam: isSpam,
        ipHash: req.ip ? hashIp(req.ip) : null,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      },
    });

    // Notify the seller — but never for spam, and never let a mail failure
    // fail the submission (the inbox is the source of truth).
    if (!isSpam) {
      const to = await resolveNotifyEmail(form);
      if (to) {
        const answers = Object.entries(validated.values)
          .map(([key, value]) => {
            const label = fields.find((f) => f.id === key)?.label ?? key;
            return `${label}: ${value}`;
          })
          .join("\n");
        const inboxUrl = `${publicBaseUrl()}/dashboard`;
        const textBody = [
          `You got a new form submission on FreeTree.`,
          ``,
          answers,
          ``,
          `Reply in your inbox: ${inboxUrl}`,
        ].join("\n");
        try {
          const result = await getEmailProvider().sendEmail({
            to,
            subject: `New form submission on FreeTree`,
            text: textBody,
            html: `<p>You got a new form submission on FreeTree.</p><pre>${escapeHtml(answers)}</pre><p><a href="${escapeHtml(inboxUrl)}">Reply in your inbox</a></p>`,
          });
          log.info({ to, provider: result.provider, submissionId: submission.id }, "sent new-submission notification");
        } catch (error) {
          log.warn({ err: error, to, submissionId: submission.id }, "failed to send new-submission notification — submission still recorded");
        }
      } else {
        log.warn({ submissionId: submission.id, kyteId: form.kyteId }, "no notification recipient for form submission");
      }
    }

    // A urlencoded post came from a plain HTML form: answer with a tiny
    // thank-you page instead of JSON (no JavaScript to read the JSON).
    const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      return reply
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><meta charset="utf-8"><title>${escapeHtml(form.successText)}</title><p>${escapeHtml(form.successText)}</p>`,
        );
    }
    return reply.send({ ok: true, successText: form.successText });
  });
}
