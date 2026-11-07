import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Prisma, getDb } from "@kytelink/db";
import {
  buildFormSubmissionsCsv,
  defaultFormFields,
  FORM_SUBMISSION_STATUSES,
  formDefinitionSchema,
  MAX_FORM_BUTTON_TEXT_LENGTH,
  MAX_FORM_DESCRIPTION_LENGTH,
  MAX_FORM_SUCCESS_TEXT_LENGTH,
  MAX_FORM_TITLE_LENGTH,
  MAX_SUBMISSION_NOTES_LENGTH,
} from "@kytelink/schemas";
import { router } from "@kytelink/trpc";
import { TRPCError } from "@trpc/server";
import { kyte } from "../trpc/procedures";
import { assertCan } from "../trpc/permissions";
import { kyteIdInput, okSchema } from "./shapes";

// ─── FreeTree Forms + Inbox — concrete tRPC router ─────────────────────────
// Owner-side form configuration + submissions inbox (search/filter/status/
// notes/follow-up/CSV export). The public form config + submit endpoint live
// in apps/api/src/routes/forms.ts (Fastify) — they need public access. The
// embeddable no-JS form HTML lives in apps/api/src/forms/render.ts.
//
// The form itself is one JSON document (formDefinitionSchema); submissions
// carry a JSON payload validated against it at submit time.

const upsertFormInput = z.object({
  kyteId: z.string().min(1),
  title: z.string().trim().min(1).max(MAX_FORM_TITLE_LENGTH).default("Contact me"),
  description: z.string().trim().max(MAX_FORM_DESCRIPTION_LENGTH).nullable().optional(),
  buttonText: z.string().trim().min(1).max(MAX_FORM_BUTTON_TEXT_LENGTH).default("Send message"),
  successText: z.string().trim().min(1).max(MAX_FORM_SUCCESS_TEXT_LENGTH).optional(),
  fields: formDefinitionSchema.shape.fields,
  notifyEmail: z.string().trim().email().max(320).nullable().optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const listSubmissionsInput = z.object({
  kyteId: z.string().min(1),
  status: z.enum([...FORM_SUBMISSION_STATUSES, "all"]).default("all"),
  includeSpam: z.boolean().default(false),
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

const endpointPath = (token: string) => `/forms/submit/${token}`;

/** Stored fields were validated at write time; parse defensively anyway. */
function parseFields(raw: unknown) {
  const parsed = formDefinitionSchema.safeParse({ fields: raw });
  return parsed.success ? parsed.data.fields : defaultFormFields();
}

function toFormRow(f: any, submissionCount: number) {
  return {
    id: f.id,
    kyteId: f.kyteId,
    title: f.title,
    description: f.description,
    buttonText: f.buttonText,
    successText: f.successText,
    fields: parseFields(f.fields),
    endpointToken: f.endpointToken,
    endpointPath: endpointPath(f.endpointToken),
    notifyEmail: f.notifyEmail,
    active: f.active,
    sortOrder: f.sortOrder,
    submissionCount,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

function toSubmissionRow(s: any) {
  // Stored payloads are validated string maps at submit time; coerce
  // defensively so one bad row can never break the whole inbox.
  const payload: Record<string, string> = {};
  const raw = s.payload as Record<string, unknown> | null;
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") payload[k] = v;
    }
  }
  return {
    id: s.id,
    formId: s.formId,
    payload,
    status: s.status,
    spam: s.spam,
    notes: s.notes,
    followUpAt: s.followUpAt ? s.followUpAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** Escape LIKE wildcards so a search term can never widen the match. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

type RawSubmissionRow = {
  id: string;
  formId: string;
  payload: Record<string, unknown>;
  status: string;
  spam: boolean;
  notes: string | null;
  followUpAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export const formsRouter = router({
  getForm: kyte.input(kyteIdInput).query(async ({ ctx }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const form = await db.formBlock.findUnique({ where: { kyteId: k.id } });
    if (!form) return { form: null };
    const submissionCount = await db.formSubmission.count({ where: { formId: form.id } });
    return { form: toFormRow(form, submissionCount) };
  }),

  upsertForm: kyte.input(upsertFormInput).mutation(async ({ ctx, input }) => {
    assertCan(ctx.access.effectiveRole, "edit_draft");
    const db = getDb();
    const k = ctx.access.kyte!;
    // Zod already validated the field list (ids unique, choice options present,
    // no file field); store the definition as-is.
    const fields = formDefinitionSchema.parse({ fields: input.fields }).fields;
    const form = await db.formBlock.upsert({
      where: { kyteId: k.id },
      create: {
        kyteId: k.id,
        orgId: k.orgId,
        title: input.title,
        description: input.description ?? null,
        buttonText: input.buttonText,
        successText: input.successText ?? "Thanks! I'll get back to you.",
        fields: fields as unknown as Prisma.InputJsonValue,
        notifyEmail: input.notifyEmail ?? null,
        active: input.active,
        sortOrder: input.sortOrder,
      },
      update: {
        title: input.title,
        description: input.description ?? null,
        buttonText: input.buttonText,
        successText: input.successText ?? "Thanks! I'll get back to you.",
        fields: fields as unknown as Prisma.InputJsonValue,
        notifyEmail: input.notifyEmail ?? null,
        active: input.active,
        sortOrder: input.sortOrder,
      },
    });
    const submissionCount = await db.formSubmission.count({ where: { formId: form.id } });
    return toFormRow(form, submissionCount);
  }),

  deleteForm: kyte.input(kyteIdInput).mutation(async ({ ctx }) => {
    assertCan(ctx.access.effectiveRole, "edit_draft");
    const db = getDb();
    const k = ctx.access.kyte!;
    // Submissions cascade-delete with the form (Prisma onDelete: Cascade).
    await db.formBlock.deleteMany({ where: { kyteId: k.id } });
    return okSchema.parse({ ok: true });
  }),

  regenerateEndpoint: kyte.input(kyteIdInput).mutation(async ({ ctx }) => {
    assertCan(ctx.access.effectiveRole, "edit_draft");
    const db = getDb();
    const k = ctx.access.kyte!;
    const form = await db.formBlock.findUnique({ where: { kyteId: k.id } });
    if (!form) throw new TRPCError({ code: "NOT_FOUND", message: "No form block." });
    const endpointToken = randomBytes(24).toString("hex");
    await db.formBlock.update({ where: { id: form.id }, data: { endpointToken } });
    return { endpointToken, endpointPath: endpointPath(endpointToken) };
  }),

  listSubmissions: kyte.input(listSubmissionsInput).query(async ({ ctx, input }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const form = await db.formBlock.findUnique({ where: { kyteId: k.id } });
    if (!form) {
      return {
        submissions: [],
        nextCursor: null,
        counts: { new: 0, contacted: 0, converted: 0, spam: 0, total: 0 },
      };
    }

    const status = input.status === "all" ? null : input.status;
    const search = input.search ? `%${escapeLike(input.search)}%` : null;
    const cursorAt = input.cursor ? new Date(input.cursor) : null;
    if (cursorAt && Number.isNaN(cursorAt.getTime())) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor." });
    }

    // Search has to look inside the JSON payload (any answer value) and the
    // owner's notes — Prisma's client API can't express that, so this one
    // query is raw SQL. Every value is a bound parameter, never interpolated.
    const rows = await db.$queryRaw<RawSubmissionRow[]>(Prisma.sql`
      SELECT "id", "formId", "payload", "status", "spam", "notes", "followUpAt", "createdAt", "updatedAt"
      FROM "FormSubmission"
      WHERE "formId" = ${form.id}
        AND (${status}::text IS NULL OR "status" = ${status})
        AND (${input.includeSpam}::boolean OR NOT "spam")
        AND (${search}::text IS NULL OR "payload"::text ILIKE ${search} ESCAPE '\\' OR "notes" ILIKE ${search} ESCAPE '\\')
        AND (${cursorAt}::timestamptz IS NULL OR "createdAt" < ${cursorAt})
      ORDER BY "createdAt" DESC
      LIMIT ${input.limit + 1}
    `);

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page[page.length - 1];

    const grouped = await db.formSubmission.groupBy({
      by: ["status"],
      where: { formId: form.id },
      _count: { _all: true },
    });
    const spam = await db.formSubmission.count({ where: { formId: form.id, spam: true } });
    const total = await db.formSubmission.count({ where: { formId: form.id } });
    const byStatus = Object.fromEntries(grouped.map((g: any) => [g.status, g._count._all]));

    return {
      submissions: page.map(toSubmissionRow),
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
      counts: {
        new: byStatus.new ?? 0,
        contacted: byStatus.contacted ?? 0,
        converted: byStatus.converted ?? 0,
        spam,
        total,
      },
    };
  }),

  getSubmission: kyte
    .input(z.object({ kyteId: z.string().min(1), submissionId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const k = ctx.access.kyte!;
      const form = await db.formBlock.findUnique({ where: { kyteId: k.id } });
      if (!form) throw new TRPCError({ code: "NOT_FOUND", message: "No form block." });
      const row = await db.formSubmission.findFirst({
        where: { id: input.submissionId, formId: form.id },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such submission." });
      return { submission: toSubmissionRow(row) };
    }),

  updateSubmission: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        submissionId: z.string().min(1),
        status: z.enum(FORM_SUBMISSION_STATUSES).optional(),
        spam: z.boolean().optional(),
        notes: z.string().trim().max(MAX_SUBMISSION_NOTES_LENGTH).nullable().optional(),
        followUpAt: z.string().datetime({ offset: true }).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const form = await db.formBlock.findUnique({ where: { kyteId: k.id } });
      if (!form) throw new TRPCError({ code: "NOT_FOUND", message: "No form block." });
      const existing = await db.formSubmission.findFirst({
        where: { id: input.submissionId, formId: form.id },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "No such submission." });
      const updated = await db.formSubmission.update({
        where: { id: existing.id },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.spam !== undefined ? { spam: input.spam } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.followUpAt !== undefined
            ? { followUpAt: input.followUpAt ? new Date(input.followUpAt) : null }
            : {}),
        },
      });
      return { submission: toSubmissionRow(updated) };
    }),

  deleteSubmission: kyte
    .input(z.object({ kyteId: z.string().min(1), submissionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const form = await db.formBlock.findUnique({ where: { kyteId: k.id } });
      if (!form) throw new TRPCError({ code: "NOT_FOUND", message: "No form block." });
      await db.formSubmission.deleteMany({
        where: { id: input.submissionId, formId: form.id },
      });
      return okSchema.parse({ ok: true });
    }),

  exportCsv: kyte.input(kyteIdInput).query(async ({ ctx }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const form = await db.formBlock.findUnique({ where: { kyteId: k.id } });
    if (!form) throw new TRPCError({ code: "NOT_FOUND", message: "No form block." });

    // Spam rows ARE included — the owner decides what to do with them once
    // exported. Oldest first, so the file reads chronologically.
    const rows = await db.formSubmission.findMany({
      where: { formId: form.id },
      orderBy: { createdAt: "asc" },
    });
    const csv = buildFormSubmissionsCsv(
      parseFields(form.fields),
      rows.map((r: any) => ({
        payload: (r.payload ?? {}) as Record<string, unknown>,
        status: r.status,
        spam: r.spam,
        notes: r.notes,
        followUpAt: r.followUpAt,
        createdAt: r.createdAt,
      })),
    );
    const safeName = (k.username ?? "freetree").replace(/[^a-zA-Z0-9_-]/g, "_");
    return { csv, filename: `${safeName}-form-submissions.csv` };
  }),
});
