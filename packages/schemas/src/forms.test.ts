import { describe, expect, it } from "vitest";
import {
  buildFormSubmissionsCsv,
  defaultFormFields,
  FORM_HONEYPOT_FIELD,
  formDefinitionSchema,
  validateSubmission,
  type FormDefinition,
} from "./forms";

describe("formDefinitionSchema", () => {
  it("accepts the starter form", () => {
    expect(() => formDefinitionSchema.parse({ fields: defaultFormFields() })).not.toThrow();
  });

  it("rejects duplicate field ids", () => {
    const parsed = formDefinitionSchema.safeParse({
      fields: [
        { id: "name", type: "text", label: "Name" },
        { id: "name", type: "email", label: "Email" },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a choice field without options and options on a text field", () => {
    expect(
      formDefinitionSchema.safeParse({
        fields: [{ id: "pick", type: "choice", label: "Pick one" }],
      }).success,
    ).toBe(false);
    expect(
      formDefinitionSchema.safeParse({
        fields: [{ id: "name", type: "text", label: "Name", options: ["a", "b"] }],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty form and more than 20 fields", () => {
    expect(formDefinitionSchema.safeParse({ fields: [] }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, type: "text", label: `F${i}` }));
    expect(formDefinitionSchema.safeParse({ fields: many }).success).toBe(false);
  });

  it("rejects a file field — deferred, no $0 storage answer yet", () => {
    expect(
      formDefinitionSchema.safeParse({
        fields: [{ id: "upload", type: "file", label: "Upload" }],
      }).success,
    ).toBe(false);
  });
});

describe("validateSubmission", () => {
  const def: FormDefinition = formDefinitionSchema.parse({
    fields: [
      { id: "name", type: "text", label: "Name", required: true },
      { id: "email", type: "email", label: "Email", required: true },
      { id: "topic", type: "choice", label: "Topic", options: ["Hello", "Business", "Other"] },
      { id: "message", type: "textarea", label: "Message" },
    ],
  });

  it("accepts a clean submission and trims values", () => {
    const r = validateSubmission(def, {
      name: "  Ada  ",
      email: "ada@example.com",
      topic: "Business",
      message: "Hi!",
    });
    expect(r.ok).toBe(true);
    expect(r.values).toEqual({ name: "Ada", email: "ada@example.com", topic: "Business", message: "Hi!" });
  });

  it("flags missing required fields and bad emails", () => {
    const r = validateSubmission(def, { name: "", email: "not-an-email" });
    expect(r.ok).toBe(false);
    expect(r.errors.name).toBeDefined();
    expect(r.errors.email).toBeDefined();
    expect(r.errors.topic).toBeUndefined(); // optional, left blank
  });

  it("rejects a choice answer that is not one of the options", () => {
    const r = validateSubmission(def, { name: "Ada", email: "ada@example.com", topic: "Spam" });
    expect(r.ok).toBe(false);
    expect(r.errors.topic).toBeDefined();
  });

  it("drops unknown keys — never stored", () => {
    const r = validateSubmission(def, {
      name: "Ada",
      email: "ada@example.com",
      injected: "evil",
      [FORM_HONEYPOT_FIELD]: "",
    });
    expect(r.ok).toBe(true);
    expect(r.values).not.toHaveProperty("injected");
    expect(r.values).not.toHaveProperty(FORM_HONEYPOT_FIELD);
  });

  it("enforces maxLength", () => {
    const short = formDefinitionSchema.parse({
      fields: [{ id: "note", type: "text", label: "Note", maxLength: 5 }],
    });
    const r = validateSubmission(short, { note: "too long for this field" });
    expect(r.ok).toBe(false);
    expect(r.errors.note).toBeDefined();
  });
});

describe("buildFormSubmissionsCsv", () => {
  it("builds field columns in order plus inbox columns, escaping quotes", () => {
    const fields = defaultFormFields();
    const csv = buildFormSubmissionsCsv(fields, [
      {
        payload: { name: 'Ada "The Boss"', email: "ada@example.com", message: "Hi, there" },
        status: "new",
        spam: false,
        notes: null,
        followUpAt: null,
        createdAt: new Date("2026-11-06T12:00:00.000Z"),
      },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("submitted_at,status,spam,Name,Email,Message,notes,follow_up_at");
    expect(lines[1]).toBe(
      '2026-11-06T12:00:00.000Z,new,no,"Ada ""The Boss""",ada@example.com,"Hi, there",,',
    );
  });

  it("marks spam rows and includes notes + follow-up date", () => {
    const fields = defaultFormFields();
    const csv = buildFormSubmissionsCsv(fields, [
      {
        payload: { name: "Bot", email: "bot@spam.example", message: "buy now" },
        status: "new",
        spam: true,
        notes: "Looks automated.",
        followUpAt: new Date("2026-11-10T09:00:00.000Z"),
        createdAt: new Date("2026-11-06T12:00:00.000Z"),
      },
    ]);
    expect(csv).toContain(",yes,Bot,bot@spam.example,buy now,Looks automated.,2026-11-10T09:00:00.000Z");
  });
});
