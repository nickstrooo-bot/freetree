import { z } from "zod";
import {
  FORM_SUBMISSION_STATUSES,
  formDefinitionSchema,
  formFieldSchema,
  MAX_FORM_BUTTON_TEXT_LENGTH,
  MAX_FORM_DESCRIPTION_LENGTH,
  MAX_FORM_SUCCESS_TEXT_LENGTH,
  MAX_FORM_TITLE_LENGTH,
  MAX_SUBMISSION_NOTES_LENGTH,
} from "@kytelink/schemas";
import { kyteProcedure, router } from "../trpc";
import { notImplemented } from "../errors";
import { kyteIdInput, okSchema } from "../shapes";

// ─── FreeTree Forms + Inbox contract ────────────────────────────────────────
// Formspree-style contact forms (FormGrid pattern, MIT). Every procedure here
// throws notImplemented; the concrete implementations live in
// apps/api/src/routers/forms.ts and must conform to these shapes.
//
// The form itself is one JSON document (formDefinitionSchema in
// @kytelink/schemas); submissions are rows with a JSON payload validated
// against it at submit time. The public submit endpoint lives in
// apps/api/src/routes/forms.ts (Fastify) — it needs public access.

export const formBlockSchema = z.object({
  id: z.string(),
  kyteId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  buttonText: z.string(),
  successText: z.string(),
  fields: z.array(formFieldSchema),
  endpointToken: z.string(),
  /** Path of the public submit endpoint, e.g. `/forms/submit/<token>`. */
  endpointPath: z.string(),
  notifyEmail: z.string().nullable(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  submissionCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type FormBlock = z.infer<typeof formBlockSchema>;

export const formSubmissionSchema = z.object({
  id: z.string(),
  formId: z.string(),
  payload: z.record(z.string(), z.string()),
  status: z.enum(FORM_SUBMISSION_STATUSES),
  spam: z.boolean(),
  notes: z.string().nullable(),
  followUpAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type FormSubmission = z.infer<typeof formSubmissionSchema>;

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
  /** Spam-flagged rows are hidden by default; pass true to include them. */
  includeSpam: z.boolean().default(false),
  /** Free text — matches any answer value or the owner's notes. */
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  /** ISO timestamp of the last row on the previous page (newest-first). */
  cursor: z.string().optional(),
});

const submissionCountsSchema = z.object({
  new: z.number().int(),
  contacted: z.number().int(),
  converted: z.number().int(),
  spam: z.number().int(),
  total: z.number().int(),
});

export const formsRouter = router({
  // ── Owner: form configuration ───────────────────────────────────────────

  getForm: kyteProcedure.input(kyteIdInput).output(z.object({ form: formBlockSchema.nullable() })).query(async () => {
    throw notImplemented("forms.getForm");
  }),

  upsertForm: kyteProcedure.input(upsertFormInput).output(formBlockSchema).mutation(async () => {
    throw notImplemented("forms.upsertForm");
  }),

  deleteForm: kyteProcedure.input(kyteIdInput).output(okSchema).mutation(async () => {
    throw notImplemented("forms.deleteForm");
  }),

  /** Rotate the public endpoint token — the old submit URL stops working. */
  regenerateEndpoint: kyteProcedure
    .input(kyteIdInput)
    .output(z.object({ endpointToken: z.string(), endpointPath: z.string() }))
    .mutation(async () => {
      throw notImplemented("forms.regenerateEndpoint");
    }),

  // ── Owner: inbox ────────────────────────────────────────────────────────

  listSubmissions: kyteProcedure
    .input(listSubmissionsInput)
    .output(
      z.object({
        submissions: z.array(formSubmissionSchema),
        nextCursor: z.string().nullable(),
        counts: submissionCountsSchema,
      }),
    )
    .query(async () => {
      throw notImplemented("forms.listSubmissions");
    }),

  getSubmission: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), submissionId: z.string().min(1) }))
    .output(z.object({ submission: formSubmissionSchema }))
    .query(async () => {
      throw notImplemented("forms.getSubmission");
    }),

  updateSubmission: kyteProcedure
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
    .output(z.object({ submission: formSubmissionSchema }))
    .mutation(async () => {
      throw notImplemented("forms.updateSubmission");
    }),

  deleteSubmission: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), submissionId: z.string().min(1) }))
    .output(okSchema)
    .mutation(async () => {
      throw notImplemented("forms.deleteSubmission");
    }),

  // ── Owner: CSV export ───────────────────────────────────────────────────
  // Returns { csv, filename }. Columns are the form's fields in order, plus
  // the inbox columns. Spam rows are included — the owner decides what to do
  // with them once exported.

  exportCsv: kyteProcedure.input(kyteIdInput).output(z.object({ csv: z.string(), filename: z.string() })).query(async () => {
    throw notImplemented("forms.exportCsv");
  }),
});
