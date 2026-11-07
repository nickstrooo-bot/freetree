import { z } from "zod";

// ─── FreeTree Forms + Inbox ──────────────────────────────────────────────────
// Formspree-style contact forms (FormGrid pattern, MIT — pattern reference,
// not a dependency). A form is ONE JSON document (SurveyJS storage pattern —
// the renderer is MIT, the drag-and-drop Creator is commercial, so FreeTree
// builds its own editor later and only borrows the JSON-schema idea): one
// small renderer turns the document into HTML, so export/import/duplicate is
// copying JSON. Fixed field set v1: text, email, textarea, choice. The
// drag-and-drop builder is a later phase; the FILE field is DEFERRED —
// uploads would need S3/MinIO and no $0 storage answer exists yet.
//
// Open-core note: forms/inbox is a NEW seller-facing differentiator. All
// form-specific code lives in its own files (this schema, the forms tRPC
// router + API router, the public submit route, the form-block UI, the
// forms-fetch client), so it can be split into the closed layer later if Nick
// decides that. No licensing call is made here.

export const FORM_FIELD_TYPES = ["text", "email", "textarea", "choice"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Statuses a submission moves through in the owner inbox. */
export const FORM_SUBMISSION_STATUSES = ["new", "contacted", "converted"] as const;
export type FormSubmissionStatus = (typeof FORM_SUBMISSION_STATUSES)[number];

export const MAX_FORM_FIELDS = 20;
export const MAX_FIELD_LABEL_LENGTH = 120;
export const MAX_FIELD_PLACEHOLDER_LENGTH = 120;
export const MAX_CHOICE_OPTIONS = 10;
export const MAX_CHOICE_OPTION_LENGTH = 120;
export const MAX_ANSWER_LENGTH = 5000;
export const MAX_FORM_TITLE_LENGTH = 120;
export const MAX_FORM_DESCRIPTION_LENGTH = 2000;
export const MAX_FORM_BUTTON_TEXT_LENGTH = 40;
export const MAX_FORM_SUCCESS_TEXT_LENGTH = 500;
export const MAX_SUBMISSION_NOTES_LENGTH = 5000;

/**
 * Honeypot field name. The public form renders this as a normal-looking text
 * input hidden from humans (CSS + aria-hidden + tabindex=-1); bots fill it,
 * humans never do. A non-empty value marks the submission spam — it is still
 * stored (so the owner can see what was caught) but excluded from the inbox
 * by default and never triggers a notification email.
 */
export const FORM_HONEYPOT_FIELD = "website";

const fieldIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Field ids must be URL-safe slugs.");

export const formFieldSchema = z
  .object({
    id: fieldIdSchema,
    type: z.enum(FORM_FIELD_TYPES),
    label: z.string().trim().min(1).max(MAX_FIELD_LABEL_LENGTH),
    required: z.boolean().default(false),
    placeholder: z.string().trim().max(MAX_FIELD_PLACEHOLDER_LENGTH).optional(),
    /** Choice fields only: 2–10 options; the stored answer is the option text. */
    options: z.array(z.string().trim().min(1).max(MAX_CHOICE_OPTION_LENGTH)).min(2).max(MAX_CHOICE_OPTIONS).optional(),
    /** Max answer length for text/email/textarea (default MAX_ANSWER_LENGTH). */
    maxLength: z.number().int().min(1).max(MAX_ANSWER_LENGTH).optional(),
  })
  .refine((f) => (f.type === "choice" ? !!f.options : !f.options), {
    message: "Only choice fields carry options.",
  });

export type FormField = z.infer<typeof formFieldSchema>;

/** A form is one JSON document: a list of fields. */
export const formDefinitionSchema = z.object({
  fields: z
    .array(formFieldSchema)
    .min(1)
    .max(MAX_FORM_FIELDS)
    .refine((fields) => new Set(fields.map((f) => f.id)).size === fields.length, {
      message: "Field ids must be unique.",
    }),
});

export type FormDefinition = z.infer<typeof formDefinitionSchema>;

/** The starter form every new form block gets: name + email + message. */
export function defaultFormFields(): FormField[] {
  return formDefinitionSchema.parse({
    fields: [
      { id: "name", type: "text", label: "Name", required: true, placeholder: "Your name" },
      { id: "email", type: "email", label: "Email", required: true, placeholder: "you@example.com" },
      { id: "message", type: "textarea", label: "Message", required: true, placeholder: "Say hello…" },
    ],
  }).fields;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ValidatedSubmission = {
  ok: true;
  /** Answers keyed by field id, trimmed; absent for optional fields left blank. */
  values: Record<string, string>;
  errors: Record<string, string>;
} | {
  ok: false;
  values: Record<string, string>;
  errors: Record<string, string>;
};

/**
 * Validate a visitor's raw answers against the form definition. Unknown keys
 * are dropped (never stored), required-but-blank fails, emails must look like
 * emails, choice answers must be one of the options. Returns the cleaned
 * values either way so the caller can store the partial payload for triage.
 */
export function validateSubmission(
  definition: FormDefinition,
  raw: Record<string, unknown>,
): ValidatedSubmission {
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};

  for (const field of definition.fields) {
    const rawValue = raw[field.id];
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (value === "") {
      if (field.required) errors[field.id] = "This field is required.";
      continue;
    }
    const max = field.maxLength ?? MAX_ANSWER_LENGTH;
    if (value.length > max) {
      errors[field.id] = `Keep it under ${max} characters.`;
      continue;
    }
    if (field.type === "email" && !EMAIL_RE.test(value)) {
      errors[field.id] = "That doesn't look like an email address.";
      continue;
    }
    if (field.type === "choice" && field.options && !field.options.includes(value)) {
      errors[field.id] = "Pick one of the listed options.";
      continue;
    }
    values[field.id] = value;
  }

  return { ok: Object.keys(errors).length === 0, values, errors };
}

/**
 * CSV export for the inbox. Columns are the form's fields in order (label as
 * the header), plus the inbox columns. One row per submission; values are the
 * stored payload. Shared with the API router so the export shape is unit-
 * tested without a database.
 */
export function buildFormSubmissionsCsv(
  fields: FormField[],
  rows: Array<{
    payload: Record<string, unknown>;
    status: string;
    spam: boolean;
    notes: string | null;
    followUpAt: Date | null;
    createdAt: Date;
  }>,
): string {
  const csvEscape = (value: string): string => {
    if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value;
  };
  const header = [
    "submitted_at",
    "status",
    "spam",
    ...fields.map((f) => f.label),
    "notes",
    "follow_up_at",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    const cells = [
      row.createdAt.toISOString(),
      row.status,
      row.spam ? "yes" : "no",
      ...fields.map((f) => {
        const v = row.payload[f.id];
        return typeof v === "string" ? v : v == null ? "" : String(v);
      }),
      row.notes ?? "",
      row.followUpAt ? row.followUpAt.toISOString() : "",
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\n");
}
